/**
 * ClientApi — the portable contract between the PraiseProjector client view
 * (UI + controller layers) and whatever backend serves it.
 *
 * This is a *port* in the ports-and-adapters sense. The UI and controller layers
 * depend ONLY on this interface and on `@praiseprojector/common` types — never on
 * Electron, Node, the in-process `Database`, `CurrentSongStore`, or
 * `window.hostDevice` directly. That discipline is what lets the exact same
 * client view run in three contexts with only the adapter swapped:
 *
 *   - Electron desktop renderer        → DirectClientApi (in-process, optional)
 *   - Remote browser served by the     → RestClientApi   (HTTP to the embedded
 *     Electron embedded webserver         webserver; the canonical adapter)
 *   - Standalone web / Android client  → RestClientApi   (HTTP to the cloud)
 *
 * Adapters live under ./rest (canonical) and ./direct (optional optimization).
 * The adapter is chosen once, at the bootstrap entry point; nothing above this
 * layer knows or cares which one is in use.
 */

import type {
  ChordSystemCode,
  Display,
  LeaderDBProfile,
  OnlineSessionEntry,
  PlaylistEntry,
  SongData,
  SongEntry,
  SongFound,
} from "../../../common/pp-types";

// ═══════════════════════════════════════════════════════════════════════════════
//  Shared primitives
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Where the client is getting its data from.
 *  - `App`: a full client — the desktop embed (`DirectClientApi`) or the
 *    standalone website/Android cloud app (`RestClientApi`, not served by a host).
 *    Always in control; it attaches to cloud sessions itself. There is no separate
 *    "cloud client" mode — that role is App.
 *  - `Client`: a host-served LAN follower (`RestClientApi` with `servedByHost`),
 *    bound to one fixed source. View-only unless the server grants leading.
 * The *behaviour* per mode is an adapter concern — the UI branches on capabilities,
 * not on `mode` (the one exception is the follower/netdisplay view; see
 * `isFollowerView`).
 */
export type ClientMode = "App" | "Client";

/**
 * Host-granted access level for a webserver-served client, as classified by the
 * Electron embedded webserver (`getClientType`) and injected into the served
 * page as `window.__ppAccess`. GUEST is a view-only follower; LEADER/LOCAL may
 * control the display. See {@link ClientConfig.hostAccess}.
 */
export type HostAccessLevel = "GUEST" | "LEADER" | "LOCAL";

/** Disposes a subscription created by one of the `subscribe*` methods. */
export type Unsubscribe = () => void;

/** Identity of the active leader/user, or `null` when not authenticated. */
export interface LeaderIdentity {
  id: string;
  name: string;
}

/** High-level network/session status surfaced to the toolbar indicator. */
export type NetworkStatus = "startup" | "offline" | "online" | "watching" | "leading" | "error";

export interface NetworkState {
  status: NetworkStatus;
  /** Human-readable detail for the `error` status. */
  error?: string;
}

/**
 * What the active backend + runtime context permit the UI to do. These are
 * adapter-DECLARED, never derived from {@link ClientMode}: the Rest adapter
 * computes them from the host-granted access level (Electron webserver) or the
 * cloud auth state; the Direct adapter declares them statically. The UI gates
 * affordances off these flags, not off the backend identity.
 */
export interface ClientCapabilities {
  /**
   * Client mode only: the host grants the right to lead (served host access ≠
   * GUEST, or the /display_query `leader-available` header), so the leader-mode
   * switch is offered. The switch's on/off state then gates canControlDisplay /
   * canEditWorkingPlaylist. Always `false` in App mode — a full client is always
   * in control, with no follower toggle. Mirrors the legacy leaderModeAvailable.
   * See {@link ClientApi.setLeaderMode}.
   */
  leaderModeAvailable: boolean;
  /** May push display changes (project/highlight/transpose) to the backend. App:
   *  true. Client: leaderModeAvailable && leader-mode-on. */
  canControlDisplay: boolean;
  /** May edit the working playlist that drives the display. Same rule as
   *  canControlDisplay. */
  canEditWorkingPlaylist: boolean;
  /**
   * May authenticate against the cloud. True only for the standalone website /
   * Android cloud app (App·Rest). False in the desktop embed (the surrounding
   * Electron app owns login) and in Client mode (host-gated, no login).
   */
  canLogin: boolean;
  /** May choose/create a different leader identity. App·Rest only (see canLogin). */
  canChangeLeader: boolean;
  /** May persist named playlists to a leader/profile target in the active adapter. */
  canPersistPlaylist: boolean;
  /**
   * May host a local PPD session (advertise + serve display to nearby followers).
   * **App mode only**, and only where a native host bridge is present (Android, or
   * the Electron desktop) — a plain browser has no UDP/Nearby transport. False in
   * Client mode and in the desktop embed. See {@link SessionApi.startLocal}.
   */
  canHostLocalSession: boolean;
  /**
   * May host an online (cloud) session — register itself as a leader others can
   * follow. **App mode only**, and only when authenticated (the session row is
   * keyed by the leader id). See {@link SessionApi.createOnline}.
   */
  canHostOnlineSession: boolean;
  /**
   * May navigate to the full multi-panel editor (index.html). True in a real
   * browser/desktop where that editor is usable and reachable; false on the
   * native host (Android) and in the desktop embed (which IS the editor and
   * offers a home button instead).
   */
  canOpenFullEditor: boolean;
  /** Running as an installed PWA (standalone display-mode). */
  isPwa: boolean;
  /** A native host bridge (`window.hostDevice` / Android) is present. */
  hasHostBridge: boolean;
  /** A local webserver backend is reachable for iWeb-style browser clients. */
  hasWebServerBackend: boolean;
}

/** Locked-down capability set — the safe default before {@link ClientApi.init}
 *  resolves one (and the baseline a follower/guest sees). */
export const NO_CAPABILITIES: ClientCapabilities = {
  leaderModeAvailable: false,
  canControlDisplay: false,
  canEditWorkingPlaylist: false,
  canLogin: false,
  canChangeLeader: false,
  canPersistPlaylist: false,
  canHostLocalSession: false,
  canHostOnlineSession: false,
  canOpenFullEditor: false,
  isPwa: false,
  hasHostBridge: false,
  hasWebServerBackend: false,
};

/** One-time configuration passed to {@link ClientApi.init}. */
export interface ClientConfig {
  /**
   * Base URL of the REST backend (the serving webserver origin, or the cloud).
   * Ignored by the in-process Direct adapter. When omitted, the Rest adapter
   * derives it from `window.location.origin` (see src/config.ts).
   */
  baseUrl?: string;
  /** Leader id of the source this client binds to — the session to follow (Client)
   *  or host (App). Used for the follow loop and the follower netdisplay URL. */
  leaderId?: string;
  /** Song to open on launch (parsed from the entry URL), if any. */
  initialSongId?: string;
  /** Playlist to open on launch (parsed from the entry URL), if any. */
  initialPlaylistId?: string;
  /**
   * Auto-follow the backend's current display on startup — the served-follower
   * use case. The adapter begins long-polling /display_query immediately so the
   * view mirrors whatever the leader is projecting, without the user choosing a
   * session.
   */
  follow?: boolean;
  /**
   * The bundle is served by a host that gates access itself (the Electron
   * embedded webserver, by IP allowlist). Drives the capability model: control
   * is host-granted and login does not apply. Absent for the cloud-backed
   * client, where capabilities follow the authenticated leader identity.
   */
  servedByHost?: boolean;
  /**
   * The host-granted access level for a served client, injected by the Electron
   * webserver as `window.__ppAccess`. Drives the served-context capability model
   * so a GUEST viewer is not offered display control. Absent for the cloud-backed
   * client and for older hosts that don't inject it — in that case the served
   * client stays optimistically controllable, which is safe because the server
   * still ENFORCES control on `/display_update`.
   */
  hostAccess?: HostAccessLevel;
  /**
   * Where the "open full editor" affordance navigates (the multi-panel
   * index.html). Defaults to "index.html" relative to the current page; the
   * standalone entry may override it from `window.__ppEditorUrl`.
   */
  fullEditorUrl?: string;
}

// ═══════════════════════════════════════════════════════════════════════════════
//  Sub-port: songs & search
// ═══════════════════════════════════════════════════════════════════════════════

export interface SearchOptions {
  /** Maximum number of results to return. */
  limit?: number;
  /**
   * Force a local-database filter instead of a server search. Defaults to true
   * in App mode and false in Client mode; set explicitly to override the mode
   * default.
   */
  localOnly?: boolean;
}

/**
 * Two-way binding to the host app's song-list filter text — the desktop embed's
 * main-UI LeftPanel search box. Present ONLY on the in-process Direct adapter
 * (App mode in the Electron renderer); the Rest adapter omits it, since a
 * served/cloud client has no host LeftPanel to mirror. It lets the embedded
 * client view's filter box and the desktop song tree share one filter value
 * (see {@link SongApi.hostFilter} and ClientViewStore.setSearchText).
 */
export interface HostFilterApi {
  /** The host's current filter text. */
  get(): string;
  /** Push the filter text to the host (updates the LeftPanel search box). */
  set(text: string): void;
  /** Subscribe to host filter changes; fires once with the current value. */
  subscribe(callback: (text: string) => void): Unsubscribe;
}

export interface SongApi {
  /** App mode: filter the local database. Client: server-side search. */
  searchSongs(text: string, options?: SearchOptions): Promise<SongFound[]>;
  /** The full song catalogue available to the current backend. */
  listAllSongs(): Promise<SongEntry[]>;
  /** Full ChordPro text + chord system for a single song. */
  getSongData(songId: string): Promise<SongData>;
  /** Emits whenever the available song list changes (sync, DB switch, …). */
  subscribeSongList(callback: (songs: SongEntry[]) => void): Unsubscribe;

  /** Optional two-way binding to the host app's LeftPanel filter; present only on
   *  the desktop embed (App·Direct). See {@link HostFilterApi}. */
  hostFilter?: HostFilterApi;

  // — leader / editor extras (mode- and permission-gated) —
  /** Whether the current user may edit the given song. */
  checkEditable(songId: string): Promise<boolean>;
  /** Submit an edited ChordPro body for review/approval. */
  suggestSong(songId: string, version: number, chordPro: string): Promise<void>;
  /** Count of songs awaiting the current user's review (the "todo" badge). */
  fetchPendingCount(): Promise<number>;
}

// ═══════════════════════════════════════════════════════════════════════════════
//  Sub-port: playlist
// ═══════════════════════════════════════════════════════════════════════════════

export interface UploadListOptions {
  label?: string;
  /** Schedule the list for a specific date (leader feature). */
  scheduled?: Date;
  /** Overwrite an existing list with the same label/date without prompting. */
  forced?: boolean;
}

export interface PlaylistApi {
  /** The current working playlist (synchronous snapshot). */
  getPlaylist(): PlaylistEntry[];
  /** Replace the working playlist — covers reorder, add, remove and trash. */
  setPlaylist(entries: PlaylistEntry[]): Promise<void>;
  /** Empty the working playlist. */
  clear(): Promise<void>;
  /** Leader playlists available from the backend, for the leader/date pickers
   *  (each profile carries that leader's dated playlists). */
  getLeaderPlaylists(): Promise<LeaderDBProfile[]>;
  /** Load a leader playlist's entries (does not replace the working list). When
   *  `label` is given the matching dated playlist is returned, else the first. */
  selectLeaderPlaylist(leaderId: string, label?: string): Promise<PlaylistEntry[]>;
  /** Replace the working playlist with the selected leader playlist (a specific
   *  dated `label`, or the leader's first when omitted). */
  replaceCurrentWithSelected(leaderId: string, label?: string): Promise<void>;
  /**
   * Persist the working playlist to the backend (optionally scheduled). Returns
   * the backend result: "OK" on success, "OVERWRITE" when a list already exists
   * for that label/date (the caller confirms, then retries with `forced`), or an
   * error string. The in-process Direct adapter has no remote store and returns
   * "OK".
   */
  upload(options?: UploadListOptions): Promise<string>;
  /** Emits whenever the working playlist changes. */
  subscribePlaylist(callback: (entries: PlaylistEntry[]) => void): Unsubscribe;
}

// ═══════════════════════════════════════════════════════════════════════════════
//  Sub-port: display / projection (the heart of the app)
// ═══════════════════════════════════════════════════════════════════════════════

/** A request to project a song at a given position. Unifies legacy
 *  `App.requestSong` / `loadSong` call sites. */
export interface ProjectRequest {
  songId: string;
  from?: number;
  to?: number;
  section?: number;
  transpose?: number;
  capo?: number;
  instructions?: string;
}

export interface DisplayApi {
  /** The current display snapshot (song + position + transpose/capo/…). */
  getCurrent(): Display;
  /** Project a song at a position. The canonical "show this" operation. */
  project(request: ProjectRequest): Promise<void>;
  /** Highlight a lyric range / section within the current song. */
  highlight(from: number, to: number, section?: number): Promise<void>;
  setTranspose(value: number): Promise<void>;
  setCapo(value: number): Promise<void>;
  setInstructions(instructions: string | undefined): Promise<void>;
  /**
   * When LEADING: push the given display to followers (cloud session + PPD
   * peers + the embedded webserver). No-op when not leading.
   */
  pushToFollowers(display: Display): Promise<void>;
  /**
   * When FOLLOWING: receive remote display updates (cloud long-poll and/or PPD
   * `display` op). The callback fires for every accepted remote change.
   */
  subscribeDisplay(callback: (display: Display) => void): Unsubscribe;
}

// ═══════════════════════════════════════════════════════════════════════════════
//  Sub-port: sessions & network discovery
// ═══════════════════════════════════════════════════════════════════════════════

export type ExternalSearchMode = "NEARBY" | "WEB" | "BOTH";
export type SessionFeatureKey = "externalWebDisplayEnabled" | "iWebEnabled" | "ppdSessionEnabled";

export interface SessionApi {
  /** Scan the LAN for local PraiseProjector servers (UDP/PPD). */
  scanLocalServers(address?: string): Promise<OnlineSessionEntry[]>;
  /**
   * Candidate scan-address options for the picker ({ value, label } per active NIC,
   * label = interface name + broadcast), plus the preferred default value. Sourced
   * from the host bridge (Electron multi-NIC lister / Android getNetworkInterfaces).
   * Empty where there is no local transport (a plain browser).
   */
  scanAddresses(): Promise<{ options: { value: string; label: string }[]; default?: string }>;
  /** Discover external sessions via nearby transports and/or the cloud. */
  searchExternal(mode: ExternalSearchMode): Promise<OnlineSessionEntry[]>;
  /** Begin hosting a local PPD broadcast session. */
  startLocal(): Promise<void>;
  /** Stop hosting the local PPD session. */
  stopLocal(): Promise<void>;
  /** Persist a session feature toggle and let the active adapter sync its backend. */
  setFeatureEnabled(key: SessionFeatureKey, enabled: boolean): Promise<void>;
  /** Create (and switch into) a cloud-hosted online session. */
  createOnline(leaderId?: string): Promise<void>;
  /** Follow a session — drives {@link DisplayApi.subscribeDisplay}. */
  watch(session: OnlineSessionEntry): Promise<void>;
  /**
   * Attach to a session picked from the discovery list, dispatching by its type
   * (the legacy found-session selector, praiseprojector.ts:4934-4980): a LAN server
   * (an `http(s)://` localUrl that is not a discovered PPD peer) opens its URL in a
   * browser; a PPD/nearby or cloud session is followed via {@link watch}.
   */
  attach(session: OnlineSessionEntry): Promise<void>;
  /** Stop following the current session. */
  stopWatching(): Promise<void>;
  /**
   * Immediately (re)establish the follow connection — the new-interface analog of
   * the legacy `goOnline()`. Aborts any in-flight long-poll / retry backoff and
   * re-issues a FORCED query so the toolbar indicator confirms (or fails) the link
   * at once, instead of waiting out a long-poll timeout. No-op when nothing is
   * being followed (e.g. standalone App mode or while leading).
   */
  reconnect(): Promise<void>;
  /**
   * The serving host's net-display URL for the follower's "open netdisplay" button
   * (legacy `${webRoot}/netdisplay?leader=${leaderId}`). Returns an empty string
   * where there is no host route (App mode / the Direct embed) — the button is
   * only shown in Client follower view, so this is only meaningfully called there.
   */
  netDisplayUrl(): string;
  /** Emits whenever the network/session status changes. */
  subscribeNetworkState(callback: (state: NetworkState) => void): Unsubscribe;
  /** Emits whenever the set of discovered sessions changes. */
  subscribeSessions(callback: (sessions: OnlineSessionEntry[]) => void): Unsubscribe;
}

// ═══════════════════════════════════════════════════════════════════════════════
//  Sub-port: authentication & identity
// ═══════════════════════════════════════════════════════════════════════════════

export interface AuthApi {
  /** Whether a leader/user is currently authenticated. */
  isAuthed(): boolean;
  /** The active leader identity, or `null` when not authenticated. */
  currentLeader(): LeaderIdentity | null;
  login(user: string, password: string, keepLoggedIn: boolean): Promise<void>;
  logout(): Promise<void>;
  /** Restore a persisted session token on startup, if present. */
  restoreSession(): Promise<void>;
  /**
   * Ask the leader's device for permission to control highlighting.
   * `verifyOnly` checks an existing grant without prompting.
   */
  requestHighlightPermission(verifyOnly?: boolean): Promise<boolean>;
  /** Emits whenever the authentication state changes. */
  subscribeAuth(callback: (authed: boolean) => void): Unsubscribe;
}

// ═══════════════════════════════════════════════════════════════════════════════
//  Sub-port: device / host bridge
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Wraps native host capabilities (`window.hostDevice` in the legacy client,
 * Electron preload APIs in the desktop app). Rest-served browser clients
 * implement the unsupported members as no-ops, exactly as the legacy client
 * degrades when `window.hostDevice` is absent.
 */
export interface DeviceApi {
  isFullScreen(): boolean;
  toggleFullScreen(): Promise<boolean>;
  keepScreenOn(enabled: boolean): void;
  getPreference(key: string): string | undefined;
  setPreference(key: string, value: string): void;
  /** Returns false when sharing is unsupported on the host. */
  share(url: string, title?: string, text?: string): boolean;
  openExternal(url: string): void;
  /** Present when the host can terminate the app (native shells only). */
  exit?(): void;
  /** Navigate back to the host home/launcher. */
  goHome(): void;
}

// ═══════════════════════════════════════════════════════════════════════════════
//  Aggregate port
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * The complete backend surface required by the client view. Implemented by the
 * Rest adapter (canonical) and, optionally, the Direct in-process adapter.
 */
export interface ClientApi {
  /** Which data source the active backend represents. */
  readonly mode: ClientMode;

  /** One-time startup. Resolves once the backend is ready to serve requests. */
  init(config: ClientConfig): Promise<void>;
  /** Tear down subscriptions, timers and transports. */
  dispose(): void;

  /** The current capability snapshot (adapter-declared). */
  getCapabilities(): ClientCapabilities;
  /** Emits whenever the capability set changes (login, access change, …);
   *  fires once with the current value on subscribe. */
  subscribeCapabilities(callback: (capabilities: ClientCapabilities) => void): Unsubscribe;
  /**
   * Set the user's leader-mode choice (the legacy chkAdmin toggle). Only takes
   * effect where {@link ClientCapabilities.leaderModeAvailable} is true; the
   * adapter folds it into canControlDisplay / canEditWorkingPlaylist /
   * canPersistPlaylist and re-emits capabilities. A no-op on adapters that don't
   * offer the toggle (the desktop embed). The choice is persisted by the caller
   * and re-applied on startup; the backend may still revoke the right.
   */
  setLeaderMode(enabled: boolean): void;

  readonly song: SongApi;
  readonly playlist: PlaylistApi;
  readonly display: DisplayApi;
  readonly session: SessionApi;
  readonly auth: AuthApi;
  readonly device: DeviceApi;
}

/** Re-exported wire types so layers above import view DTOs from one module. */
export type { ChordSystemCode, Display, LeaderDBProfile, OnlineSessionEntry, PlaylistEntry, SongData, SongEntry, SongFound };
