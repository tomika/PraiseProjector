/**
 * RestCore — shared state and machinery for the REST-backed ClientApi adapter.
 *
 * Holds the current display, the working playlist, session/auth identity, the
 * event emitters that back every `subscribe*` method, and the "follow" loops
 * (cloud long-poll via {@link cloudApi.fetchDisplayQuery} and local PPD via
 * {@link startHostDeviceWatching}). The sub-port factories in ./restPorts.ts
 * operate on a single shared instance of this class.
 *
 * This module is browser-safe in every context the client view runs in: the
 * host-device PPD helpers it uses degrade to no-ops when `window.hostDevice` is
 * absent (a plain browser served by the cloud), exactly like the legacy client.
 */

import { cloudApi } from "../../../../common/cloudApi";
import { getEmptyDisplay } from "../../../../common/pp-utils";
import type { Display, OnlineSessionEntry, PlaylistEntry, SongData, SongEntry } from "../../../../common/pp-types";
import type { P2PSessionInfo } from "../../../types/electron";
import {
  getHostDeviceDiscoveredSessions,
  initHostDevicePpd,
  isHostDevicePpdAvailable,
  scanHostDeviceSessions,
  startHostDeviceWatching,
  startHostDevicePpdHosting,
  stopHostDeviceWatching,
  stopHostDevicePpdHosting,
} from "../../../services/hostDevicePpd";
import { NO_CAPABILITIES } from "../ClientApi";
import type { ClientCapabilities, ClientConfig, ClientMode, LeaderIdentity, NetworkState, Unsubscribe } from "../ClientApi";

const delay = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** Minimal multi-listener event source backing the `subscribe*` ports. */
export class Emitter<T> {
  private readonly listeners = new Set<(value: T) => void>();

  add(listener: (value: T) => void): Unsubscribe {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  emit(value: T): void {
    for (const listener of [...this.listeners]) listener(value);
  }
}

function toOnlineSessionEntry(info: P2PSessionInfo): OnlineSessionEntry {
  return { id: info.id, name: info.name, localUrl: info.url || undefined };
}

/** Shallow structural equality for two working-playlist snapshots — used to skip
 *  redundant playlist emits when a followed display repeats the same list. */
function samePlaylist(a: PlaylistEntry[], b: PlaylistEntry[]): boolean {
  if (a === b) return true;
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    const x = a[i];
    const y = b[i];
    if (x.songId !== y.songId || x.title !== y.title || x.transpose !== y.transpose || x.capo !== y.capo || x.instructions !== y.instructions) {
      return false;
    }
  }
  return true;
}

export class RestCore {
  mode: ClientMode = "App";
  config: ClientConfig = {};
  clientId = "";
  leader: LeaderIdentity | null = null;
  authed = false;

  readonly displayEvents = new Emitter<Display>();
  readonly songListEvents = new Emitter<SongEntry[]>();
  readonly playlistEvents = new Emitter<PlaylistEntry[]>();
  readonly networkEvents = new Emitter<NetworkState>();
  readonly sessionEvents = new Emitter<OnlineSessionEntry[]>();
  readonly authEvents = new Emitter<boolean>();
  readonly capabilityEvents = new Emitter<ClientCapabilities>();

  /** Discovered local (PPD) sessions, keyed by id, retained so {@link watch}
   *  can recover the transport details a bare OnlineSessionEntry lacks. */
  readonly localSessions = new Map<string, P2PSessionInfo>();

  private display: Display = getEmptyDisplay();
  private playlist: PlaylistEntry[] = [];

  private followToken = 0;
  private followAbort: AbortController | null = null;
  private followLeaderId: string | undefined;
  /** What the active follow is tracking, so {@link reconnect} can restart the
   *  SAME target (the legacy goOnline() re-invoked the current watchDisplay). */
  private lastFollow: { kind: "cloud"; leaderId?: string } | { kind: "ppd"; info: P2PSessionInfo } | null = null;
  private ppdWatching = false;
  private capabilities: ClientCapabilities = { ...NO_CAPABILITIES };
  /** The user's leader-mode choice (legacy chkAdmin); gated by the right to lead.
   *  Defaults off — the store restores the persisted choice via setLeaderMode. */
  private leaderMode = false;
  /** Leader-availability as last reported by the backend's /display_query headers
   *  (legacy `leader-available`), or undefined before any header is seen. When set
   *  it overrides the context-derived right, so the server can grant or revoke
   *  leading dynamically. */
  private headerLeaderAvailable: boolean | undefined;

  // ── lifecycle ──────────────────────────────────────────────────────────────

  async init(config: ClientConfig): Promise<void> {
    this.config = config;
    // Two modes: a host-served LAN bundle is a Client (follower); everything else
    // (the standalone website / Android cloud app) is a full App that attaches to
    // cloud sessions itself. There is no separate "cloud client" mode.
    this.mode = config.servedByHost ? "Client" : "App";
    if (config.baseUrl) cloudApi.setBaseUrl(config.baseUrl);
    this.clientId = this.resolveClientId();
    cloudApi.setClientId(this.clientId);
    if (isHostDevicePpdAvailable()) {
      try {
        await initHostDevicePpd();
      } catch {
        /* PPD is optional; absence is non-fatal */
      }
    }
    this.setNetworkState({ status: "startup" });

    // Served-follower context: immediately follow the backend's current display
    // (the local webserver, or a cloud session) so the view mirrors the leader
    // without the user picking a session. Uses the existing /display_query loop.
    //
    // The first query is FORCED so the server replies at once (rather than holding
    // the long-poll open for its full timeout): the toolbar indicator therefore
    // confirms the connection promptly instead of sitting at "startup". The status
    // is NOT set to "watching" optimistically here — the follow loop sets it only
    // once a response actually lands, so the dot reflects the real link state.
    if (config.follow) {
      this.startCloudFollow(config.leaderId, true);
    }
    this.emitCapabilities();
  }

  dispose(): void {
    this.stopFollow();
    void stopHostDevicePpdHosting();
  }

  private resolveClientId(): string {
    const key = "pp-client-id";
    try {
      const existing = window.localStorage?.getItem(key);
      if (existing) return existing;
      const id = globalThis.crypto?.randomUUID?.() ?? Math.random().toString(36).slice(2);
      window.localStorage?.setItem(key, id);
      return id;
    } catch {
      return Math.random().toString(36).slice(2);
    }
  }

  // ── display / playlist state ─────────────────────────────────────────────────

  getDisplay(): Display {
    return this.display;
  }

  setDisplay(next: Display): void {
    const prev = this.display;
    this.display = next;
    this.displayEvents.emit(next);
    // While following, the server embeds the leader's playlist in each display
    // (sent to non-GUEST clients only — guests get it stripped server-side). Fold
    // it into the working/current playlist so it mirrors the leader, exactly like
    // the legacy applyDisplay(). Without this the list stays empty in client mode.
    // Guard on playlist_id / content so we don't re-emit on every long-poll tick
    // (and avoid a feedback loop with local edits, which call setPlaylist before
    // patchDisplay → setDisplay with the same list).
    if (next.playlist && (prev.playlist_id !== next.playlist_id || !samePlaylist(this.playlist, next.playlist))) {
      this.setPlaylist(next.playlist);
    }
  }

  patchDisplay(patch: Partial<Display>): void {
    this.setDisplay({ ...this.display, ...patch });
  }

  getPlaylist(): PlaylistEntry[] {
    return this.playlist;
  }

  setPlaylist(entries: PlaylistEntry[]): void {
    this.playlist = entries;
    this.playlistEvents.emit(entries);
  }

  getCapabilities(): ClientCapabilities {
    return this.capabilities;
  }

  /** Whether display pushes are permitted in the current context. Replaces the
   *  old `isLeading()` gate — see {@link computeCapabilities}. */
  canControlDisplay(): boolean {
    return this.capabilities.canControlDisplay;
  }

  private computeCapabilities(): ClientCapabilities {
    const hasHostBridge = isHostDevicePpdAvailable();
    const isPwa =
      typeof window !== "undefined" &&
      (window.matchMedia?.("(display-mode: standalone)")?.matches === true ||
        (window.navigator as Navigator & { standalone?: boolean }).standalone === true);
    if (this.config.servedByHost) {
      // Electron webserver context (#2): the host gates access by IP allowlist
      // and injects the granted level as window.__ppAccess (→ config.hostAccess).
      // A GUEST is a view-only follower; LEADER/LOCAL may control the display.
      // When the level is unknown (older host that doesn't inject it) fall back
      // to optimistic — the server still ENFORCES on /display_update, so an
      // unauthorized push simply no-ops server-side. Reactively downgrading on a
      // 403 remains a follow-up (needs cloudApi to surface the response status).
      const hasRight = this.headerLeaderAvailable ?? this.config.hostAccess !== "GUEST";
      // The legacy chkAdmin gate: a privileged client only controls when it has
      // ALSO switched leader mode on. The right itself is surfaced separately so
      // the UI can offer the toggle.
      const controllable = hasRight && this.leaderMode;
      return {
        leaderModeAvailable: hasRight,
        canControlDisplay: controllable,
        canEditWorkingPlaylist: controllable,
        canLogin: false,
        canChangeLeader: false,
        canPersistPlaylist: false,
        // Locked to its serving host (auto-follows via config.follow); it never
        // hosts its own session.
        canHostLocalSession: false,
        canHostOnlineSession: false,
        // The full editor (index.html) is served by the same webserver, but only
        // makes sense on a real browser/desktop, not the native host.
        canOpenFullEditor: !hasHostBridge,
        isPwa,
        hasHostBridge,
      };
    }
    // App mode (App·Rest): the standalone website / Android cloud app. The client
    // view IS the full client here, so every affordance is available and it
    // attaches to cloud sessions itself. Always in control — no follower/leader
    // toggle (leaderModeAvailable = false).
    return {
      leaderModeAvailable: false,
      canControlDisplay: true,
      canEditWorkingPlaylist: true,
      canLogin: true,
      canChangeLeader: true,
      canPersistPlaylist: true,
      // Hosting a local PPD session needs a native transport (Android / Electron
      // desktop); a plain browser has none. Hosting an online session needs a
      // leader identity (the cloud session row is keyed by it).
      canHostLocalSession: hasHostBridge,
      canHostOnlineSession: this.authed,
      canOpenFullEditor: !hasHostBridge,
      isPwa,
      hasHostBridge,
    };
  }

  /** Apply the user's leader-mode choice (legacy chkAdmin) and re-emit. The
   *  effective control flags follow only where the right to lead exists. */
  setLeaderMode(enabled: boolean): void {
    if (this.leaderMode === enabled) return;
    this.leaderMode = enabled;
    this.emitCapabilities();
  }

  /** The serving host's net-display URL for the Client follower button (legacy
   *  `${webRoot}/netdisplay?leader=${leaderId}`). The served bundle's origin IS
   *  the host webserver, so we anchor on the configured base / current origin. */
  netDisplayUrl(): string {
    const origin = (this.config.baseUrl ?? (typeof window !== "undefined" ? window.location.origin : "")).replace(/\/$/, "");
    const leaderId = this.config.leaderId ?? this.leader?.id ?? "";
    return `${origin}/netdisplay?leader=${encodeURIComponent(leaderId)}`;
  }

  /** Fold the /display_query `leader-available` header into the capability model
   *  (legacy applyLeaderModeRestrictions on header change). Absent header → no
   *  change, so the context-derived right stands. Re-emits only on a real flip. */
  private applyLeaderHeaders(ppHeaders: Record<string, string> | undefined): void {
    if (!ppHeaders || ppHeaders["leader-available"] === undefined) return;
    const available = ppHeaders["leader-available"] === "true";
    if (this.headerLeaderAvailable === available) return;
    this.headerLeaderAvailable = available;
    this.emitCapabilities();
  }

  private emitCapabilities(): void {
    this.capabilities = this.computeCapabilities();
    this.capabilityEvents.emit(this.capabilities);
  }

  setNetworkState(state: NetworkState): void {
    this.networkEvents.emit(state);
  }

  setAuthed(authed: boolean, leader: LeaderIdentity | null): void {
    this.authed = authed;
    this.leader = leader;
    this.authEvents.emit(authed);
    this.emitCapabilities();
  }

  async loadSongData(songId: string): Promise<SongData> {
    const entries = await cloudApi.fetchSongsById([songId]);
    return entries[0]?.songdata ?? { text: "", system: getEmptyDisplay().system };
  }

  // ── session discovery ────────────────────────────────────────────────────────

  async scanLocal(address?: string): Promise<OnlineSessionEntry[]> {
    if (isHostDevicePpdAvailable()) {
      try {
        await scanHostDeviceSessions(address);
      } catch {
        /* scan failures are non-fatal — return whatever is already known */
      }
    }
    return this.collectLocalSessions();
  }

  collectLocalSessions(): OnlineSessionEntry[] {
    const infos = getHostDeviceDiscoveredSessions();
    this.localSessions.clear();
    for (const info of infos) this.localSessions.set(info.id, info);
    const sessions = infos.map(toOnlineSessionEntry);
    this.sessionEvents.emit(sessions);
    return sessions;
  }

  // ── hosting a session ──────────────────────────────────────────────────────────

  /** Begin hosting a local PPD session (legacy startPpdSession). The host loop pushes
   *  THIS client's current display to followers — see {@link getDisplay}. */
  async startLocalHost(): Promise<void> {
    const started = await startHostDevicePpdHosting(() => this.getDisplay());
    if (started) this.setNetworkState({ status: "leading" });
  }

  /** Stop hosting the local PPD session (legacy stopPpdSession). */
  async stopLocalHost(): Promise<void> {
    await stopHostDevicePpdHosting();
    this.setNetworkState({ status: "online" });
  }

  // ── following a session ──────────────────────────────────────────────────────

  async watch(session: OnlineSessionEntry): Promise<void> {
    this.stopFollow();
    const info = this.localSessions.get(session.id);
    if (info && info.address && isHostDevicePpdAvailable()) {
      await this.startPpdFollow(info);
    } else {
      // Forced first query: confirm the link immediately rather than optimistically
      // showing "watching" before any response (see startCloudFollow).
      this.startCloudFollow(session.id, true);
    }
  }

  /**
   * Immediately re-establish the follow connection — the new-interface analog of
   * the legacy goOnline(). Aborts the in-flight long-poll / backoff and restarts
   * the SAME follow target with a forced first query, so the indicator reports the
   * real state at once. No-op when nothing is being followed.
   */
  async reconnect(): Promise<void> {
    const target = this.lastFollow;
    if (!target) return;
    this.stopFollow();
    // Instant feedback: show "connecting" the moment the user taps the indicator.
    this.setNetworkState({ status: "startup" });
    if (target.kind === "ppd" && isHostDevicePpdAvailable()) {
      await this.startPpdFollow(target.info);
    } else {
      this.startCloudFollow(target.kind === "cloud" ? target.leaderId : undefined, true);
    }
  }

  private async startPpdFollow(info: P2PSessionInfo): Promise<void> {
    this.lastFollow = { kind: "ppd", info };
    this.setNetworkState({ status: "startup" });
    this.ppdWatching = await startHostDeviceWatching(
      info.id,
      { address: info.address ?? "", port: info.port ?? 0, hostId: info.hostId },
      (display) => {
        this.setDisplay(display);
        this.setNetworkState({ status: "watching" });
      },
      () => {
        this.ppdWatching = false;
        this.setNetworkState({ status: "offline" });
      }
    );
    if (this.ppdWatching) this.setNetworkState({ status: "watching" });
  }

  /**
   * Long-poll the backend's /display_query and fold each response into the local
   * display, driving the network indicator honestly: "startup" until a response
   * lands, "watching" on each success, "error" (with a short backoff) on failure.
   * @param forceFirst force the FIRST query so the server replies immediately
   *   (used on startup and reconnect to avoid sitting through a long-poll timeout).
   */
  private startCloudFollow(leaderId?: string, forceFirst = false): void {
    this.lastFollow = { kind: "cloud", leaderId };
    this.followLeaderId = leaderId;
    const token = ++this.followToken;
    const controller = new AbortController();
    this.followAbort = controller;
    // Connecting until the first response confirms (or fails) the link.
    this.setNetworkState({ status: "startup" });

    const loop = async (): Promise<void> => {
      let forced = forceFirst;
      while (token === this.followToken && !controller.signal.aborted) {
        try {
          const { display, ppHeaders } = await cloudApi.fetchDisplayQuery(this.display, {
            leaderId: this.followLeaderId,
            signal: controller.signal,
            forced,
          });
          forced = false;
          if (token !== this.followToken) return;
          this.applyLeaderHeaders(ppHeaders);
          this.setDisplay(display);
          this.setNetworkState({ status: "watching" });
        } catch (error) {
          if (controller.signal.aborted || token !== this.followToken) return;
          this.setNetworkState({ status: "error", error: error instanceof Error ? error.message : String(error) });
          await delay(2000);
        }
      }
    };
    void loop();
  }

  stopFollow(): void {
    this.followToken++;
    if (this.followAbort) {
      try {
        this.followAbort.abort();
      } catch {
        /* ignore abort errors */
      }
      this.followAbort = null;
    }
    if (this.ppdWatching) {
      stopHostDeviceWatching();
      this.ppdWatching = false;
    }
  }
}
