/**
 * DirectClientApi — the in-process ClientApi adapter for the Electron desktop
 * renderer (the "switch to new client UI" embedding).
 *
 * Unlike RestClientApi (which talks HTTP and owns isolated state), this adapter
 * bridges the port DIRECTLY onto the host app's live state, so the embedded
 * client view shares the SAME current song / display / catalogue as the main UI:
 *   - display  → CurrentSongStore (the same store App.tsx reads/writes; its
 *                subscribeCurrentDisplayChange drives the projector/webserver),
 *   - songs    → the in-memory Database,
 *   - device   → the shared browser/host device helper.
 *
 * Projecting a song here mirrors App.tsx's remote "display_update" path, so the
 * change flows to the projector and is reflected back in the main UI.
 *
 * This adapter is only reached from the desktop bundle (via ClientViewApp); the
 * webserver-served bundle uses RestClientApi and never imports the Database.
 */

import { Database, FormatFoundReason, SongOrder } from "../../../../db-common/Database";
import { Playlist } from "../../../../db-common/Playlist";
import { PlaylistEntry } from "../../../../db-common/PlaylistEntry";
import type { Leader } from "../../../../db-common/Leader";
import { cloudApi } from "../../../../common/cloudApi";
import { getEmptyDisplay } from "../../../../common/pp-utils";
import { formatLocalDateKey, formatLocalDateLabel } from "../../../../common/date-only";
import { getCurrentDisplay, getEditedSong, subscribeCurrentDisplayChange, updateCurrentDisplay } from "../../../state/CurrentSongStore";
import { getSharedSongFilter, setSharedSongFilter, subscribeSharedSongFilter } from "../../../state/SongFilterStore";
import { getSyncStatus, subscribeSyncStatus } from "../../../state/syncStatusStore";
import type { SyncStatus } from "../../../state/syncStatusStore";
import {
  getHostDeviceDiscoveredSessions,
  getLocalBroadcastAddresses,
  isHostDevicePpdAvailable,
  scanHostDeviceSessions,
  startHostDeviceWatching,
  startHostDevicePpdHosting,
  stopHostDeviceWatching,
  stopHostDevicePpdHosting,
} from "../../../services/hostDevicePpd";
import type { Display } from "../../../../common/pp-types";
import type { P2PSessionInfo } from "../../../types/electron";
import { createDeviceApi } from "../rest/restPorts";
import { deriveCapabilities } from "../capabilities";
import type {
  AuthApi,
  ClientCapabilities,
  ClientMode,
  DeviceApi,
  DisplayApi,
  HostViewApi,
  LeaderIdentity,
  NetworkState,
  OnlineSessionEntry,
  PlaylistApi,
  SessionFeatureKey,
  SessionApi,
  SongApi,
  SongEntry,
  Unsubscribe,
} from "../ClientApi";
import type { ClientApi } from "../ClientApi";
import { readSessionToggleSettings, saveSessionFeatureSetting } from "../sessionFeatureSettings";
import { isWebServerRuntimeAvailable } from "../../../services/webServerBridge";
import { filterOwnSessionEntries } from "../../../shared/sessionList";

function toEntry(song: { Id: string; Title: string }): SongEntry {
  return { songId: song.Id, title: song.Title };
}

export interface DirectAuthBridge {
  isAuthed(): boolean;
  login(user: string, password: string, keepLoggedIn: boolean): Promise<void>;
  logout(): Promise<void>;
  restoreSession(): Promise<void>;
}

export class DirectClientApi implements ClientApi {
  readonly mode: ClientMode = "App";

  private songListUnsub: (() => void) | null = null;
  private hostStateUnsub: (() => void) | null = null;
  private readonly capabilityListeners = new Set<(capabilities: ClientCapabilities) => void>();
  private readonly authListeners = new Set<(authed: boolean) => void>();
  // Session/network state for the embed's own hosting (a local PPD session, or an
  // online cloud session). Drives the toolbar indicator + the MoreMenu Start/Stop.
  private readonly networkListeners = new Set<(state: NetworkState) => void>();
  private networkState: NetworkState = { status: "online" };

  // Following a remote session from the embed: a discovered-peer cache (to recover
  // PPD transport details), the cloud long-poll token/abort, and the active target
  // (so reconnect can restart the SAME follow). The followed display is relayed
  // through the host's display pipeline (dispatchDisplayUpdate), so the desktop
  // PROJECTS it exactly like an embed-initiated project — and CurrentSongStore +
  // the full view stay in sync.
  private readonly localSessions = new Map<string, P2PSessionInfo>();
  private followToken = 0;
  private followAbort: AbortController | null = null;
  private ppdWatching = false;
  private lastFollow: { kind: "cloud"; leaderId?: string } | { kind: "ppd"; info: P2PSessionInfo } | null = null;

  readonly song: SongApi = this.createSongApi();
  readonly playlist: PlaylistApi = this.createPlaylistApi();
  readonly display: DisplayApi = this.createDisplayApi();
  readonly session: SessionApi = this.createSessionApi();
  readonly auth: AuthApi = this.createAuthApi();
  readonly device: DeviceApi = createDeviceApi();
  readonly hostView: HostViewApi = this.createHostViewApi();

  private capabilities: ClientCapabilities = this.computeCapabilities();

  constructor(private authBridge?: DirectAuthBridge) {}

  setAuthBridge(authBridge: DirectAuthBridge): void {
    this.authBridge = authBridge;
    this.refreshAuthState();
  }

  // The embedded desktop view (role "AppDirect") drives the host's live display
  // directly, so control + working-playlist editing are inherently granted. The
  // capability RULES live in one place (deriveCapabilities); this only supplies
  // the embed's context: login follows the injected auth bridge, save follows the
  // host's SELECTED leader (parity with the desktop app's save, so it's offered
  // only while a leader is selected), and online hosting follows the
  // external-web-display toggle. It is the Electron renderer, not a PWA.
  private computeCapabilities(): ClientCapabilities {
    return deriveCapabilities({
      role: "AppDirect",
      hasHostBridge: isHostDevicePpdAvailable(),
      hasHostHome: typeof window !== "undefined" && typeof window.hostDevice?.goHome === "function",
      hasWebServerBackend: isWebServerRuntimeAvailable(),
      isPwa: false,
      onlineSession: false,
      authed: this.isAuthed(),
      hasAuthBridge: !!this.authBridge,
      hasSelectedLeader: !!this.getSelectedLeader(),
      externalWebDisplayEnabled: this.isExternalWebDisplayEnabled(),
      ppdSessionEnabled: this.isPpdSessionEnabled(),
      // No follower/leader toggle in an App role.
      leaderRight: false,
      leaderMode: false,
      lockedToSession: false,
    });
  }

  /** The host app's currently selected leader (settings.selectedLeader), resolved
   *  against the local Database — the leader a save writes its schedule to, exactly
   *  like the desktop PlaylistPanel's selectedLeader. Null when none is selected
   *  or the DB is not ready yet. */
  private getSelectedLeader(): Leader | null {
    try {
      const raw = window.localStorage?.getItem("pp-settings");
      const id = raw ? (JSON.parse(raw) as { selectedLeader?: string }).selectedLeader : undefined;
      if (!id) return null;
      const db = Database.getInstance();
      return db.getLeaderById(id) ?? db.getLeaderByName(id) ?? null;
    } catch {
      return null;
    }
  }

  /** The host app's "publish display to the cloud" toggle (Settings.externalWebDisplayEnabled,
   *  persisted in the pp-settings localStorage). Gates the embed's online-session
   *  hosting — start-online is offered only when external web display is enabled. */
  private isExternalWebDisplayEnabled(): boolean {
    return readSessionToggleSettings().externalWebDisplayEnabled;
  }

  private isPpdSessionEnabled(): boolean {
    return readSessionToggleSettings().ppdSessionEnabled;
  }

  private setSessionFeatureEnabled = async (key: SessionFeatureKey, enabled: boolean): Promise<void> => {
    saveSessionFeatureSetting(key, enabled);
    this.refreshHostState();
  };

  private refreshHostState = (): void => {
    this.capabilities = this.computeCapabilities();
    for (const cb of this.capabilityListeners) cb(this.capabilities);
    this.refreshAuthState();
  };

  refreshAuthState(): void {
    // The selected leader is this embed's effective identity; re-emit it so the
    // store's leader (save-dialog title + scheduled-date lookup) tracks changes.
    const authed = this.isAuthed();
    for (const cb of this.authListeners) cb(authed);
  }

  async init(): Promise<void> {
    await Database.waitForReady();
    // The selected leader (→ persist capability + identity) lives in the host
    // app's settings; refresh when it (or the active database) changes.
    window.addEventListener("pp-settings-changed", this.refreshHostState);
    window.addEventListener("pp-database-switched", this.refreshHostState);
    this.hostStateUnsub = () => {
      window.removeEventListener("pp-settings-changed", this.refreshHostState);
      window.removeEventListener("pp-database-switched", this.refreshHostState);
    };
    // Recompute now the DB is ready so the seeded capabilities resolve the leader.
    this.capabilities = this.computeCapabilities();
  }

  dispose(): void {
    this.songListUnsub?.();
    this.songListUnsub = null;
    this.hostStateUnsub?.();
    this.hostStateUnsub = null;
    this.stopFollow();
    void stopHostDevicePpdHosting();
    this.capabilityListeners.clear();
    this.authListeners.clear();
    this.networkListeners.clear();
  }

  getCapabilities(): ClientCapabilities {
    return this.capabilities;
  }

  subscribeCapabilities(callback: (capabilities: ClientCapabilities) => void): Unsubscribe {
    this.capabilityListeners.add(callback);
    callback(this.capabilities);
    return () => this.capabilityListeners.delete(callback);
  }

  // The desktop embed is always in control; the leader/follower toggle is N/A.
  setLeaderMode(): void {}

  // The desktop embed shares the host app's full view, whose UserPanel mirrors the
  // "todo" status into syncStatusStore. Expose it so the client view can badge it —
  // no extra polling: we just read what the full view already computed.
  getSyncStatus(): SyncStatus {
    return getSyncStatus();
  }

  subscribeSyncStatus(callback: (status: SyncStatus) => void): Unsubscribe {
    return subscribeSyncStatus(callback);
  }

  // Drive the host app via the SAME event the webserver clients use, so the main
  // UI's selection/preview/playlist AND the projector all follow along — not just
  // the shared CurrentSongStore (App.tsx remoteDisplayUpdateHandler).
  private dispatchDisplayUpdate(detail: Record<string, unknown>): void {
    window.dispatchEvent(new CustomEvent("pp-cv-display-update", { detail }));
  }

  private createHostViewApi(): HostViewApi {
    return {
      getLoadedSongId: () => getEditedSong()?.Id ?? null,
      syncLoadedSong: (loadedSongId) => {
        window.dispatchEvent(new CustomEvent("pp-cv-sync-host-selection", { detail: loadedSongId }));
      },
    };
  }

  private createDisplayApi(): DisplayApi {
    const dispatch = (detail: Record<string, unknown>) => this.dispatchDisplayUpdate(detail);
    const songId = () => getCurrentDisplay().songId;
    return {
      getCurrent: () => getCurrentDisplay(),
      project: async (request) =>
        dispatch({
          command: "display_update",
          id: request.songId,
          from: request.from ?? 0,
          to: request.to ?? 0,
          section: request.section,
          transpose: request.transpose,
          capo: request.capo,
          instructions: request.instructions,
        }),
      highlight: async (from, to, section) => {
        // When clearing the highlight (from=0, to=0), update CurrentDisplay directly.
        // App.tsx remoteDisplayUpdateHandler skips from/to when from=0 (falsy check),
        // so without this the display.from/to would remain stale after an unhighlight.
        if (from === 0 && to === 0) updateCurrentDisplay({ from: 0, to: 0 });
        dispatch({ command: "display_update", id: songId(), from, to, section });
      },
      // App/embed applies to the in-process host live on every detent; there is
      // no separate server round-trip here, so the finalize (commit) call would
      // only re-dispatch the same value — skip it and act on the preview calls.
      setTranspose: async (value, commit) => {
        if (!commit) dispatch({ command: "song_update", id: songId(), transpose: value });
      },
      setCapo: async (value, commit) => {
        if (!commit) dispatch({ command: "song_update", id: songId(), capo: value });
      },
      setInstructions: async (instructions) => dispatch({ command: "song_update", id: songId(), instructions }),
      pushToFollowers: async () => undefined,
      subscribeDisplay: (callback) => subscribeCurrentDisplayChange(callback),
    };
  }

  private createSongApi(): SongApi {
    const allEntries = () => Database.getInstance().getSongs().map(toEntry);
    return {
      searchSongs: async (text, options) => {
        const query = text.trim();
        if (!query) return [];
        // Use the SAME Database search the desktop song tree (LeftPanel) uses, so
        // the client gets relevancy ordering (LessCostMatch) AND real per-field
        // match snippets (lyrics/meta excerpts with highlights) — not a naive
        // title-only substring scan that returned the title as the "snippet".
        const allowedIds = options?.songIds?.length ? new Set(options.songIds) : undefined;
        const results = await Database.getInstance().filter(query, null, true, true, true, SongOrder.LessCostMatch, undefined, allowedIds);
        return results
          .filter((found) => !allowedIds || allowedIds.has(found.song.Id))
          .slice(0, options?.limit ?? options?.songIds?.length ?? 100)
          .map((found) => ({
            songId: found.song.Id,
            title: found.song.Title,
            found: { type: FormatFoundReason(found.reason), cost: found.cost, snippet: found.snippet },
          }));
      },
      listAllSongs: async () => allEntries(),
      getSongData: async (songId) => {
        const song = Database.getInstance().getSongById(songId);
        return { text: song?.Text ?? "", system: song?.System ?? getEmptyDisplay().system };
      },
      subscribeSongList: (callback) => {
        const db = Database.getInstance();
        const handler = () => callback(allEntries());
        db.emitter.on("db-updated", handler);
        this.songListUnsub = () => db.emitter.off("db-updated", handler);
        return this.songListUnsub;
      },
      checkEditable: async () => false,
      suggestSong: async () => undefined,
      fetchPendingCount: async () => 0,
      // Mirror the filter text to/from the host app's LeftPanel search box, so the
      // embedded client view and the desktop song tree share one filter value.
      hostFilter: {
        get: () => getSharedSongFilter(),
        set: (text) => setSharedSongFilter(text),
        subscribe: (callback) => {
          callback(getSharedSongFilter());
          return subscribeSharedSongFilter(callback);
        },
      },
    };
  }

  private createPlaylistApi(): PlaylistApi {
    // The leader-playlists picker reads from the host's LOCAL Database (the same
    // synced leader profiles the desktop UI uses), not the cloud — Leader.toJSON()
    // yields the wire LeaderDBProfile shape the port expects.
    const profileFor = (leaderId: string) =>
      Database.getInstance()
        .getLeaders()
        .find((leader) => leader.id === leaderId)
        ?.toJSON();
    const playlistOf = (leaderId: string, label?: string) => {
      const profile = profileFor(leaderId);
      return (label != null ? profile?.playlists.find((pl) => pl.label === label) : profile?.playlists[0])?.songs ?? [];
    };
    // Apply a working-playlist change by routing it through the host's display
    // pipeline as a playlist-only display_update, exactly like a webserver client
    // (RestClientApi). This makes App.tsx remoteDisplayUpdateHandler call
    // leftPanelRef.updatePlaylist(), which updates the full desktop view's
    // PlaylistPanel AND syncs CurrentSongStore (via savePlaylist → playlist_id),
    // so the embed's own subscribePlaylist fires too. Writing CurrentSongStore
    // directly here would update the projector but leave the full view stale.
    const applyPlaylist = (entries: ReturnType<typeof playlistOf>) =>
      this.dispatchDisplayUpdate({ command: "display_update", id: getCurrentDisplay().songId, playlist: entries });
    return {
      getPlaylist: () => getCurrentDisplay().playlist ?? [],
      setPlaylist: async (entries) => applyPlaylist(entries),
      clear: async () => applyPlaylist([]),
      getLeaderPlaylists: async () =>
        Database.getInstance()
          .getLeaders()
          .map((leader) => leader.toJSON()),
      selectLeaderPlaylist: async (leaderId, label) => playlistOf(leaderId, label),
      replaceCurrentWithSelected: async (leaderId, label) => applyPlaylist(playlistOf(leaderId, label)),
      // Save the working list to the selected leader's LOCAL schedule (the desktop
      // app's db.schedule path) — there is no cloud here. Return "OVERWRITE" when a
      // dated playlist already exists, mirroring the cloud handshake so the store's
      // confirm-then-forced retry works identically across adapters.
      upload: async (options) => {
        const leader = this.getSelectedLeader();
        if (!leader) return "No leader selected";
        const date = options?.scheduled;
        if (!date) return "OK";
        const exists = leader.getSchedule().some((d) => formatLocalDateKey(d) === formatLocalDateKey(date));
        if (exists && !options.forced) return "OVERWRITE";
        const entries = (getCurrentDisplay().playlist ?? []).map((entry) => PlaylistEntry.fromJSON(entry));
        Database.getInstance().schedule(leader, date, new Playlist(formatLocalDateLabel(date), entries));
        return "OK";
      },
      subscribePlaylist: (callback) => subscribeCurrentDisplayChange((display) => callback(display.playlist ?? [])),
    };
  }

  private setNetworkState(state: NetworkState): void {
    this.networkState = state;
    for (const cb of this.networkListeners) cb(state);
  }

  private createSessionApi(): SessionApi {
    return {
      // The embed can discover nearby PPD peers + cloud sessions (the sessions hub
      // works here too), in addition to HOSTING its own (start/stop below).
      scanLocalServers: async (address) => {
        if (isHostDevicePpdAvailable()) {
          try {
            await scanHostDeviceSessions(address);
          } catch {
            /* scan failures are non-fatal — return whatever is already known */
          }
        }
        return this.collectLocalSessions();
      },
      searchExternal: async (mode) => {
        const results: OnlineSessionEntry[] = [];
        if (mode === "WEB" || mode === "BOTH") {
          try {
            results.push(...filterOwnSessionEntries(await cloudApi.fetchOnlineSessions(), this.currentLeaderIdentity()?.id));
          } catch {
            /* cloud unreachable — surface whatever local discovery found */
          }
        }
        if (mode === "NEARBY" || mode === "BOTH") {
          results.push(...this.collectLocalSessions());
        }
        return results;
      },
      scanAddresses: () => getLocalBroadcastAddresses(),
      // Host a local PPD session via the shared controller (Electron branch →
      // advertiseNearby + the udp.ts host gate). The host loop reads the live
      // projected display so followers mirror what the desktop is projecting.
      startLocal: async () => {
        const started = await startHostDevicePpdHosting(() => getCurrentDisplay());
        if (started) this.setNetworkState({ status: "leading" });
      },
      stopLocal: async () => {
        await stopHostDevicePpdHosting();
        this.setNetworkState({ status: "online" });
      },
      setFeatureEnabled: this.setSessionFeatureEnabled,
      // Host an online (cloud) session: force-register the current projected display
      // under the authed leader (the /display_update upsert makes us discoverable now).
      createOnline: async () => {
        const d = getCurrentDisplay();
        await cloudApi.sendDisplayUpdate({
          songId: d.songId,
          from: d.from,
          to: d.to,
          section: d.section,
          sectionRepeatCounts: d.sectionRepeatCounts,
          sectionRepeatNonce: d.sectionRepeatNonce,
          transpose: d.transpose,
          playlist: d.playlist,
          song: d.song,
          message: d.message,
          instructions: d.instructions,
        });
        this.setNetworkState({ status: "leading" });
      },
      watch: (session) => this.watch(session),
      // Dispatch by url SCHEME (legacy found-session selector): an http(s) url is a
      // LAN webserver → open it; a udp://|nrb:// url or none → follow it.
      attach: async (session) => {
        const url = session.localUrl;
        if (url && /^https?:\/\//i.test(url)) {
          if (typeof window !== "undefined") window.open(url, "_blank");
          return;
        }
        await this.watch(session);
      },
      stopWatching: async () => {
        this.stopFollow();
        // Let the host exit watch mode (clear the followed projection).
        window.dispatchEvent(new CustomEvent("pp-cv-watch-stop"));
        this.setNetworkState({ status: "online" });
      },
      reconnect: async () => {
        const target = this.lastFollow;
        if (!target) return;
        this.stopFollow();
        this.setNetworkState({ status: "startup" });
        if (target.kind === "ppd" && isHostDevicePpdAvailable()) {
          await this.startPpdFollow(target.info);
        } else {
          this.startCloudFollow(target.kind === "cloud" ? target.leaderId : undefined, true);
        }
      },
      // App mode has no follower netdisplay button, so this is never called.
      netDisplayUrl: () => "",
      subscribeNetworkState: (callback) => {
        this.networkListeners.add(callback);
        callback(this.networkState);
        return () => this.networkListeners.delete(callback);
      },
      subscribeSessions: () => () => undefined,
    };
  }

  /** Snapshot the currently-discovered local PPD peers, retaining their transport
   *  details so {@link watch} can recover what a bare OnlineSessionEntry lacks. */
  private collectLocalSessions(): OnlineSessionEntry[] {
    const infos = getHostDeviceDiscoveredSessions();
    this.localSessions.clear();
    for (const info of infos) this.localSessions.set(info.id, info);
    return infos.map((info) => ({ id: info.id, name: info.name, localUrl: info.url || undefined }));
  }

  /** Follow a discovered session: a locally-discovered PPD peer over UDP/Nearby,
   *  otherwise a cloud long-poll. The followed display is projected by the host. */
  private async watch(session: OnlineSessionEntry): Promise<void> {
    this.stopFollow();
    const info = this.localSessions.get(session.id);
    if (info && info.address && isHostDevicePpdAvailable()) {
      await this.startPpdFollow(info);
    } else {
      this.startCloudFollow(session.id, true);
    }
  }

  private async startPpdFollow(info: P2PSessionInfo): Promise<void> {
    this.lastFollow = { kind: "ppd", info };
    this.setNetworkState({ status: "startup" });
    this.ppdWatching = await startHostDeviceWatching(
      info.id,
      { address: info.address ?? "", port: info.port ?? 0, hostId: info.hostId },
      (display) => {
        this.relayFollowedDisplay(display);
        this.setNetworkState({ status: "watching" });
      },
      () => {
        this.ppdWatching = false;
        this.setNetworkState({ status: "offline" });
      }
    );
    if (this.ppdWatching) this.setNetworkState({ status: "watching" });
  }

  /** Long-poll /display_query and project each response, mirroring RestCore's
   *  cloud follow (and App.tsx's WatchOnlineDisplay) but routed through the host. */
  private startCloudFollow(leaderId?: string, forceFirst = false): void {
    this.lastFollow = { kind: "cloud", leaderId };
    const token = ++this.followToken;
    const controller = new AbortController();
    this.followAbort = controller;
    this.setNetworkState({ status: "startup" });

    const loop = async (): Promise<void> => {
      let forced = forceFirst;
      while (token === this.followToken && !controller.signal.aborted) {
        try {
          const { display } = await cloudApi.fetchDisplayQuery(getCurrentDisplay(), { leaderId, signal: controller.signal, forced });
          forced = false;
          if (token !== this.followToken) return;
          this.relayFollowedDisplay(display);
          this.setNetworkState({ status: "watching" });
        } catch (error) {
          if (controller.signal.aborted || token !== this.followToken) return;
          this.setNetworkState({ status: "error", error: error instanceof Error ? error.message : String(error) });
          await new Promise((resolve) => setTimeout(resolve, 2000));
        }
      }
    };
    void loop();
  }

  /** Project a followed display via the host's watch-mode handler (App.tsx
   *  applyDisplay) — the SAME path the full desktop view uses, so an arbitrary
   *  remote song projects (not just songs in the working playlist), and the
   *  projector + CurrentSongStore stay in sync. */
  private relayFollowedDisplay(display: Display): void {
    window.dispatchEvent(new CustomEvent("pp-cv-watch-display", { detail: display }));
  }

  private stopFollow(): void {
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

  private createAuthApi(): AuthApi {
    return {
      isAuthed: () => this.isAuthed(),
      // The embed's "identity" is the host's selected leader (used for the save
      // dialog's title + scheduled-date lookup), not a cloud login.
      currentLeader: () => this.currentLeaderIdentity(),
      login: async (user, password, keepLoggedIn) => {
        if (!this.authBridge) return;
        await this.authBridge.login(user, password, keepLoggedIn);
        this.refreshAuthState();
      },
      logout: async () => {
        if (!this.authBridge) return;
        await this.authBridge.logout();
        this.refreshAuthState();
      },
      restoreSession: async () => {
        if (!this.authBridge) return;
        await this.authBridge.restoreSession();
        this.refreshAuthState();
      },
      requestHighlightPermission: async () => false,
      subscribeAuth: (callback) => {
        this.authListeners.add(callback);
        callback(this.isAuthed());
        return () => this.authListeners.delete(callback);
      },
    };
  }

  private isAuthed(): boolean {
    return this.authBridge?.isAuthed() ?? cloudApi.isAuthed();
  }

  private currentLeaderIdentity(): LeaderIdentity | null {
    const leader = this.getSelectedLeader();
    return leader ? { id: leader.id, name: leader.name } : null;
  }
}
