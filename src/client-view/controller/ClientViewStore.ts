/**
 * ClientViewStore — the framework-agnostic controller (Layer 2).
 *
 * Replaces the legacy praiseprojector.ts `initFields()` web of imperative DOM
 * handlers with a single store that:
 *   - holds the view state (current display, song list, search, playlist,
 *     network/auth status, options-panel visibility, transpose/capo),
 *   - exposes actions that translate user intent into {@link ClientApi} calls,
 *   - subscribes to the API's change feeds and folds them into its snapshot.
 *
 * It knows nothing about React (bound to it via useSyncExternalStore in
 * ./ClientViewContext.tsx) and nothing about the backend (it depends only on the
 * injected ClientApi). The same store therefore drives every runtime context.
 */

import { getEmptyDisplay } from "../../../common/pp-utils";
import { formatLocalDateLabel, parseScheduleDate } from "../../../common/date-only";
import { readThemeSetting, writeThemeSetting } from "../../services/settingsStore";
import { NO_CAPABILITIES } from "../api/ClientApi";
import type {
  ClientApi,
  ClientCapabilities,
  ClientConfig,
  ClientMode,
  Display,
  ExternalSearchMode,
  LeaderDBProfile,
  LeaderIdentity,
  NetworkState,
  OnlineSessionEntry,
  PlaylistEntry,
  SessionFeatureKey,
  SongData,
  SongEntry,
  SongFound,
  Unsubscribe,
} from "../api/ClientApi";

/** Chord-box mode: "" none, GUITAR/PIANO diagram, NO_CHORDS hides chords.
 *  Mirrors praiseprojector.ts `chordBoxType` (incl. the NO_CHORDS pseudo-type). */
export type ChordBoxKind = "" | "GUITAR" | "PIANO" | "NO_CHORDS";

/** Dark-mode preference, cycled auto → light → dark like the original
 *  switchDarkMode(): "auto" follows the OS, "light"/"dark" force it. */
export type DarkMode = "auto" | "light" | "dark";

/** maxText section-tag display: full word, abbreviation, or hidden. */
export type ZoomTagMode = "VISIBLE" | "ABBREV" | "HIDDEN";

/** Which collection the options-panel song list shows: the full database
 *  (searchable), the editable working playlist, or the leader-playlists picker
 *  (load a dated playlist from a leader's cloud profile). Mirrors the legacy
 *  iconDatabase ↔ iconPlaylist switch plus the leader-playlist droplist; only
 *  meaningful where the working playlist is editable
 *  (capabilities.canEditWorkingPlaylist). */
export type ListMode = "database" | "playlist" | "leaderlists";

/** The cycle order the list-mode toggle walks (database → playlist →
 *  leaderlists → database), shared by the toggle button and persistence. */
export const LIST_MODES: readonly ListMode[] = ["database", "playlist", "leaderlists"];

/** Which collection the main song view's prev/next navigation walks. This is
 *  intentionally separate from {@link ListMode}, which only controls what the
 *  options panel is showing. */
export type NavigationMode = "database" | "playlist" | "filter" | "archive";

/** Minimal projection of a navigable song row (a {@link PlaylistEntry} or a
 *  database {@link SongEntry}). The page-turn neighbour preloader needs only the
 *  id plus the per-song transpose/capo to render the reveal faithfully. */
export interface NavEntry {
  songId: string;
  transpose?: number;
  capo?: number;
  /** Per-entry display instructions (playlist entries carry these). Carried into
   *  prev/next projection so the optimistic render matches the backend echo. */
  instructions?: string;
}

const systemPrefersDark = (): boolean => typeof window !== "undefined" && !!window.matchMedia?.("(prefers-color-scheme: dark)").matches;

/** Effective dark flag for a theme preference: "auto" follows the OS. The light/
 *  dark preference itself is the SHARED `pp-settings.theme` key, read/written via
 *  {@link readThemeSetting}/{@link writeThemeSetting} (the same store the full
 *  view's ThemeContext uses), so the two views never diverge. */
const computeIsDark = (theme: DarkMode): boolean => theme === "dark" || (theme === "auto" && systemPrefersDark());

/** Project a database/search row down to the wire {@link PlaylistEntry} shape,
 *  dropping search-only (`found`) and bulk (`songdata`) fields — mirrors the
 *  legacy `strip()` before pushing a playlist update. */
function toPlaylistEntry(song: SongEntry | SongFound | PlaylistEntry): PlaylistEntry {
  return { songId: song.songId, title: song.title, transpose: song.transpose, capo: song.capo, instructions: song.instructions };
}

/**
 * How the current song is rendered. These map 1:1 onto the inputs the legacy
 * `displayChanged()` reads to build the ChordPro `chordFormatFlags` bitmask and
 * call `editor.setDisplayMode(...)`. See SongView for the flag assembly.
 */
export interface DisplaySettings {
  /** Base minor-chord display: 0 = Am, 1 = am (LCMOLL), 3 = a (NOMMOL). */
  chordMode: 0 | 1 | 3;
  /** Render chord modifiers as small superscripts (A^m7). */
  subscript: boolean;
  /** Use B / B♭ notation. */
  bb: boolean;
  /** Simplify complex chords. */
  simplified: boolean;
  /** Suppress duplicated section chords (V1 Am, V2 —). Default on, like legacy. */
  noSecChordDup: boolean;
  /** Auto-transpose chords into the song key (CHORDFORMAT_INKEY). */
  autoTone: boolean;
  /** Chord-box diagram mode. */
  chordBoxType: ChordBoxKind;
  /** Enable capo handling (legacy chkUseCapo). The toolbar control remains
   *  visible; when off, capo value selection is disabled. */
  useCapo: boolean;
  /** Maximise text: hide title/meta, abbreviate tags, fit more per page. */
  maxText: boolean;
  /** maxText (zoom) sub-settings — applied only while maxText is on (the
   *  original zoomPreset). zoomScrollable = full-width SCROLL vs full-page FIT. */
  zoomHideTitle: boolean;
  zoomHideMeta: boolean;
  zoomTagMode: ZoomTagMode;
  zoomScrollable: boolean;
}

const defaultDisplaySettings: DisplaySettings = {
  chordMode: 0,
  subscript: true,
  bb: false,
  simplified: false,
  noSecChordDup: true,
  autoTone: false,
  chordBoxType: "",
  useCapo: true,
  maxText: false,
  zoomHideTitle: true,
  zoomHideMeta: true,
  zoomTagMode: "ABBREV",
  zoomScrollable: false,
};

/**
 * The persisted slice of {@link ClientViewState} — the UI/preference state that
 * survives a reload. It is written (debounced) through the device-preference
 * port and restored in {@link ClientViewStore.init}. Backend-derived collections
 * (songs, search results, sessions, playlist) and volatile flags (dialog
 * visibility, network/auth status, capabilities) are intentionally excluded:
 * they are re-seeded from the backend on every init. Bump {@link PERSIST_VERSION}
 * if the shape changes incompatibly — older snapshots are then dropped, not
 * mis-restored.
 */
interface PersistedClientViewState {
  version: number;
  displaySettings: DisplaySettings;
  optionsOpen: boolean;
  listMode: ListMode;
  navigationMode: NavigationMode;
  showInstructions: boolean;
  highlightOn: boolean;
  highlightControl: boolean;
  highlightOpacity: number;
  searchText: string;
  transpose: number;
  capo: number;
  /** The leader-mode toggle choice, re-applied (where still permitted) on init. */
  leaderMode: boolean;
  /** The projected song to restore when nothing else dictates one (see init). */
  songId: string;
}

/** device-preference key (the port namespaces it, e.g. "pp-pref-client-view-state"). */
const PERSIST_KEY = "client-view-state";
const PERSIST_VERSION = 3;
/** Coalesce rapid state changes into one write (localStorage is synchronous). */
const PERSIST_DEBOUNCE_MS = 400;

export interface ClientViewState {
  mode: ClientMode;
  /** True once {@link ClientViewStore.init} has finished wiring the backend. */
  ready: boolean;
  display: Display;
  songs: SongEntry[];
  searchText: string;
  searchResults: SongFound[];
  searching: boolean;
  playlist: PlaylistEntry[];
  network: NetworkState;
  authed: boolean;
  leader: LeaderIdentity | null;
  /** What the active backend + context permit; gates UI affordances. */
  capabilities: ClientCapabilities;
  /** The user's leader-mode choice (legacy chkAdmin): when on, a privileged
   *  client controls/edits; when off it is a plain follower. Persisted and
   *  pushed to the API on init. Only meaningful — and only shown as a switch —
   *  where capabilities.leaderModeAvailable is true; the backend may still revoke
   *  the right, which drops the effective control flags regardless of this value. */
  leaderMode: boolean;
  sessions: OnlineSessionEntry[];
  optionsOpen: boolean;
  /** Whether the song list shows the database, the working-playlist editor, or
   *  the leader-playlists picker. Only acted on when
   *  capabilities.canEditWorkingPlaylist is true. */
  listMode: ListMode;
  /** Explicit source for the main ChordPro view's prev/next navigation. */
  navigationMode: NavigationMode;
  /** Leader profiles backing the leader-playlists picker (each carries that
   *  leader's dated playlists). Fetched lazily when leaderlists mode opens. */
  leaderProfiles: LeaderDBProfile[];
  /** Whether a leader-profiles fetch is in flight (drives the picker spinner). */
  leaderProfilesLoading: boolean;
  /** The leader currently chosen in the leader-playlists picker, or null. */
  selectedLeaderId: string | null;
  /** The dated playlist label chosen in the picker (the date select), or null. */
  selectedPlaylistLabel: string | null;
  /** The save-playlist date-picker dialog visibility (capabilities.canPersistPlaylist). */
  saveDialogOpen: boolean;
  /** Whether the leader's scheduled dates are being fetched for the save picker. */
  saveDialogLoading: boolean;
  /** Days the current leader already has a saved playlist for — "signed" in the
   *  save picker so the user can see which dates would overwrite. */
  saveScheduledDates: Date[];
  /** The maxText (zoom) settings dialog visibility. */
  zoomDialogOpen: boolean;
  /** The sign-in dialog visibility (cloud context only — capabilities.canLogin). */
  loginDialogOpen: boolean;
  /** The sessions hub (discover/attach + host) visibility — App mode only. */
  sessionsDialogOpen: boolean;
  /** Whether the song's display instructions are overlaid on the song view
   *  (legacy chkInstructions wand toggle). */
  showInstructions: boolean;
  /** Whether highlight is shown in the song view (legacy chkHighlight.checked).
   *  States: off (false/false) → on (true/false) → control (true/true) → off. */
  highlightOn: boolean;
  /** Whether leader highlight control is active — tapping a song section pushes a
   *  highlight to the display/followers. Only true when highlightOn is also true.
   *  In App mode controlled locally; in Client mode requires server permission. */
  highlightControl: boolean;
  /** Whether a highlight-control permission request is in flight (Client mode).
   *  While true the lamp button shows a spinning gear, mirroring the legacy
   *  #highlight_loader shown during queryHighlightPermission. */
  highlightPending: boolean;
  /** Opacity (0..1) applied to the highlighted-line background. Adjustable via
   *  the highlight opacity dialog (long-press on the lamp). Default 1.0. */
  highlightOpacity: number;
  /** Whether the highlight opacity slider dialog is open. */
  highlightOpacityDialogOpen: boolean;
  /** Whether the instructions text editor dialog is open. */
  instructionsEditorOpen: boolean;
  /** Working text inside the open instructions editor. */
  instructionsEditorText: string;
  /** Whether the About dialog is open. */
  aboutOpen: boolean;
  /** The animated-SVG name (images/<name>.svg) of the open confirmation dialog,
   *  or null when none is showing. Mirrors the legacy `confirm(anim)` popup whose
   *  body IS the animated SVG (e.g. "erase", "overwrite"). */
  confirmAnim: string | null;
  displaySettings: DisplaySettings;
  /** The shared light/dark preference (auto/light/dark), mirrored from the
   *  `pp-settings.theme` key the full view also owns. Not persisted in the
   *  client-view snapshot — it is re-read from the shared store on every init. */
  themeSetting: DarkMode;
  /** Effective dark flag derived from {@link themeSetting} + the OS pref. */
  isDark: boolean;
  /** Whether the app is currently in fullscreen (drives the toolbar icon swap). */
  isFullScreen: boolean;
  /** Whether the host can terminate the app (native shells only); gates the
   *  more-menu Exit item. */
  canExit: boolean;
  transpose: number;
  capo: number;
}

/**
 * The follower face (legacy `setLeader(false)`): a Client-mode view with no
 * effective display control. The song list / search / transpose / prev-next are
 * hidden and a single netdisplay button is shown instead. App mode is never a
 * follower; in Client mode this tracks the leader switch — off (or no granted
 * right) ⇒ follower, on ⇒ leader.
 */
export function isFollowerView(state: ClientViewState): boolean {
  return state.mode === "Client" && !state.capabilities.canControlDisplay;
}

// ── mode-derived UI selectors ────────────────────────────────────────────────
// The UI layers gate affordances off these named intents rather than branching on
// `state.mode` directly, so the mode → intent mapping lives in exactly one place
// (mirroring the ClientApi contract note: "the UI branches on capabilities, not on
// mode"). Pure functions of the snapshot, like {@link isFollowerView}.

/** App mode is the only context with a sessions hub (discover / attach / host); a
 *  Client is a fixed-source follower, so the hub is never offered there. */
export function canUseSessions(state: ClientViewState): boolean {
  return state.mode === "App";
}

/** An App that is currently following a remote (cloud) session — temporarily a
 *  follower (legacy ppdWatchMode), unlike the PERMANENT Client follower. */
export function isAppWatching(state: ClientViewState): boolean {
  return state.mode === "App" && state.network.status === "watching";
}

/** The view is mirroring someone else's display — a permanent Client follower OR
 *  an App that chose to watch a session. Drives the view-only toolbar / song view
 *  (no navigation, transpose or song browser). */
export function isViewingRemoteDisplay(state: ClientViewState): boolean {
  return isFollowerView(state) || isAppWatching(state);
}

/** The toolbar network indicator is meaningful only for a host-served Client (a
 *  persistent server link to report); standalone App mode has none to show. */
export function showsNetworkIndicator(state: ClientViewState): boolean {
  return state.mode !== "App";
}

/** Offer the highlight lamp to anyone who can control the display, plus a Client
 *  follower (who can REQUEST highlight permission from the leader). */
export function canUseHighlightLamp(state: ClientViewState): boolean {
  return state.capabilities.canControlDisplay || state.mode === "Client";
}

const SEARCH_DEBOUNCE_MS = 250;

function initialState(): ClientViewState {
  const initialTheme = readThemeSetting();
  return {
    mode: "App",
    ready: false,
    display: getEmptyDisplay(),
    songs: [],
    searchText: "",
    searchResults: [],
    searching: false,
    playlist: [],
    network: { status: "startup" },
    authed: false,
    leader: null,
    capabilities: { ...NO_CAPABILITIES },
    leaderMode: false,
    sessions: [],
    optionsOpen: false,
    listMode: "database",
    navigationMode: "database",
    leaderProfiles: [],
    leaderProfilesLoading: false,
    selectedLeaderId: null,
    selectedPlaylistLabel: null,
    saveDialogOpen: false,
    saveDialogLoading: false,
    saveScheduledDates: [],
    zoomDialogOpen: false,
    loginDialogOpen: false,
    sessionsDialogOpen: false,
    showInstructions: false,
    highlightOn: false,
    highlightControl: false,
    highlightPending: false,
    highlightOpacity: 1.0,
    highlightOpacityDialogOpen: false,
    instructionsEditorOpen: false,
    instructionsEditorText: "",
    aboutOpen: false,
    confirmAnim: null,
    displaySettings: { ...defaultDisplaySettings },
    themeSetting: initialTheme,
    isDark: computeIsDark(initialTheme),
    isFullScreen: false,
    canExit: false,
    transpose: 0,
    capo: 0,
  };
}

export class ClientViewStore {
  private state: ClientViewState = initialState();
  private readonly listeners = new Set<() => void>();
  private readonly unsubscribes: Unsubscribe[] = [];
  private searchTimer: ReturnType<typeof setTimeout> | undefined;
  private searchSeq = 0;
  private disposed = false;
  /** Where "open full editor" navigates; captured from init config. */
  private fullEditorUrl = "index.html";
  /** Whether the viewport is landscape. In landscape the options panel is a
   *  side-by-side split (not an overlay covering the song), so song picks keep it
   *  open. Tracked here (mirrors the CSS orientation media queries) so selection
   *  can close only the portrait overlay. */
  private landscape = typeof window !== "undefined" && !!window.matchMedia?.("(orientation: landscape)").matches;
  /** Debounce timer + dedupe cache + gate for UI-state persistence. Saving stays
   *  OFF until init's restore/seed completes (persistenceReady), so none of the
   *  startup `set()` churn overwrites the snapshot being restored. */
  private persistTimer: ReturnType<typeof setTimeout> | undefined;
  private lastPersistedJson = "";
  private persistenceReady = false;
  /** Resolver for the in-flight {@link confirm} promise (legacy `confirm()`); the
   *  dialog state lives in `confirmAnim`, the resolver is kept off-snapshot. */
  private confirmResolver: ((ok: boolean) => void) | null = null;

  constructor(private readonly api: ClientApi) {}

  // ── useSyncExternalStore bindings (stable identities) ────────────────────────

  readonly subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  readonly getSnapshot = (): ClientViewState => this.state;

  private set(patch: Partial<ClientViewState>): void {
    this.state = { ...this.state, ...patch };
    for (const listener of [...this.listeners]) listener();
    this.schedulePersist();
  }

  // ── lifecycle ────────────────────────────────────────────────────────────────

  async init(config: ClientConfig): Promise<void> {
    if (config.fullEditorUrl) this.fullEditorUrl = config.fullEditorUrl;
    this.wire();
    await this.api.init(config);
    await this.api.auth.restoreSession().catch(() => undefined);
    // Read any persisted UI snapshot up front so both applyPersisted (below) and
    // the landscape auto-open (further down) can branch on it.
    const persisted = this.loadPersisted();
    // Seed from the backend's current state so an already-projected song and the
    // working playlist show immediately (subscribeDisplay only fires on changes).
    const display = this.api.display.getCurrent();
    this.set({
      mode: this.api.mode,
      ready: true,
      authed: this.api.auth.isAuthed(),
      leader: this.api.auth.currentLeader(),
      capabilities: this.api.getCapabilities(),
      display,
      transpose: display.transpose,
      capo: display.capo ?? 0,
      playlist: this.api.playlist.getPlaylist(),
      isFullScreen: this.api.device.isFullScreen(),
      canExit: typeof this.api.device.exit === "function",
    });
    if (config.initialSongId) await this.selectSong(config.initialSongId).catch(() => undefined);
    // Overlay the persisted UI snapshot on top of the backend seed (after the
    // initialSongId projection, so a URL-provided song still wins over a saved one).
    this.applyPersisted(persisted, config);
    // App mode (desktop embed): bind the filter box to the host's LeftPanel filter.
    // Seed from the host's current value (which switches to database when set), then
    // mirror future host changes — setSearchText pushes our edits back, so the two
    // filter boxes stay in lockstep. The shared store dedupes, so this never loops.
    const hostFilter = this.api.song.hostFilter;
    if (hostFilter) {
      const seed = hostFilter.get();
      if (seed !== this.state.searchText) this.setSearchText(seed);
      this.unsubscribes.push(
        hostFilter.subscribe((text) => {
          if (text !== this.state.searchText) this.setSearchText(text);
        })
      );
    }

    if (this.api.mode === "Client") this.setNavigationMode("playlist");

    // Re-apply the restored leader-mode choice to the backend so the effective
    // capabilities reflect it (the API gates it on the still-granted right, and
    // re-emits — picked up by the subscribeCapabilities wiring above).
    this.api.setLeaderMode(this.state.leaderMode);
    void this.loadSongs();
    // A restored leaderlists mode needs its profiles fetched (applyPersisted sets
    // the mode directly, bypassing setListMode's lazy load).
    if (this.state.listMode === "leaderlists") void this.loadLeaderPlaylists();

    // Highlight defaults OFF and is only ever turned on by the user (or by a
    // restored snapshot above) — never auto-enabled from a server grant. When a
    // restored snapshot DID hold highlight control, Client mode requires the
    // leader switch to be on: with it off the restored control drops to a plain
    // visible highlight; with it on, re-confirm the leader still grants control
    // (verifyOnly → no prompt) and relinquish it if not.
    if (this.api.mode === "Client" && this.state.highlightControl) {
      if (!this.state.leaderMode) {
        this.set({ highlightControl: false });
      } else {
        void this.api.auth
          .requestHighlightPermission(true)
          .then((granted) => {
            if (!granted) this.set({ highlightControl: false });
          })
          .catch(() => this.set({ highlightControl: false }));
      }
    }

    // "auto" theme follows the OS preference; recompute when it flips.
    const mql = typeof window !== "undefined" ? window.matchMedia?.("(prefers-color-scheme: dark)") : undefined;
    if (mql) {
      const onChange = () => this.syncTheme();
      mql.addEventListener("change", onChange);
      this.unsubscribes.push(() => mql.removeEventListener("change", onChange));
    }
    // The light/dark preference is SHARED with the full view via the
    // `pp-settings.theme` key: re-read it when the full view changes the theme
    // (same tab → `pp-settings-changed` / `pp-theme-changed`) or another tab does
    // (`storage`), so the two views never diverge.
    if (typeof window !== "undefined") {
      const onThemeChange = () => this.syncTheme();
      window.addEventListener("pp-settings-changed", onThemeChange);
      window.addEventListener("pp-theme-changed", onThemeChange);
      window.addEventListener("storage", onThemeChange);
      this.unsubscribes.push(() => {
        window.removeEventListener("pp-settings-changed", onThemeChange);
        window.removeEventListener("pp-theme-changed", onThemeChange);
        window.removeEventListener("storage", onThemeChange);
      });
    }
    // Track orientation so selection closes only the portrait overlay and first
    // load can auto-open the landscape split panel.
    const orientationMql = typeof window !== "undefined" ? window.matchMedia?.("(orientation: landscape)") : undefined;
    if (orientationMql) {
      this.landscape = orientationMql.matches;
      const onOrientation = () => {
        this.landscape = orientationMql.matches;
      };
      orientationMql.addEventListener("change", onOrientation);
      this.unsubscribes.push(() => orientationMql.removeEventListener("change", onOrientation));
    }
    // On first load in landscape the options panel is a side-by-side split that
    // doesn't cover the song, so open it automatically (it stays closed in
    // portrait, where it would overlay the song). Once the user has a persisted
    // optionsOpen preference, that wins — we don't force it back open.
    if (this.landscape && persisted?.optionsOpen === undefined) this.set({ optionsOpen: true });
    // Keep the fullscreen flag in sync when the user exits via Esc / the browser
    // chrome (no event fires on native hosts; toggleFullScreen updates it there).
    if (typeof document !== "undefined") {
      const onFsChange = () => this.set({ isFullScreen: this.api.device.isFullScreen() });
      document.addEventListener("fullscreenchange", onFsChange);
      this.unsubscribes.push(() => document.removeEventListener("fullscreenchange", onFsChange));
    }
    this.syncTheme();

    // The restore/seed is complete: start persisting from here so no startup
    // `set()` writes over the restored snapshot. Seed lastPersistedJson with the
    // current snapshot so only genuine post-init changes trigger the first write.
    this.lastPersistedJson = JSON.stringify(this.snapshotForPersist());
    this.persistenceReady = true;
    // A reload (F5 / Ctrl+R) can skip React unmount → dispose, so flush the latest
    // snapshot synchronously on unload too (pagehide covers mobile/bfcache).
    if (typeof window !== "undefined") {
      const onUnload = () => this.persistNow();
      window.addEventListener("beforeunload", onUnload);
      window.addEventListener("pagehide", onUnload);
      this.unsubscribes.push(() => {
        window.removeEventListener("beforeunload", onUnload);
        window.removeEventListener("pagehide", onUnload);
      });
    }
  }

  dispose(): void {
    // Idempotent: the embedded ClientViewApp and the provider may both clean up.
    if (this.disposed) return;
    // Reject any in-flight confirmation so its awaiter doesn't hang on teardown.
    this.confirmResolver?.(false);
    this.confirmResolver = null;
    if (this.persistTimer) clearTimeout(this.persistTimer);
    this.persistNow(); // flush any pending change before tearing down
    this.disposed = true;
    if (this.searchTimer) clearTimeout(this.searchTimer);
    for (const unsubscribe of this.unsubscribes) unsubscribe();
    this.unsubscribes.length = 0;
    this.api.dispose();
  }

  // ── UI-state persistence ───────────────────────────────────────────────────────

  /** The persistable projection of the current state (see {@link PersistedClientViewState}). */
  private snapshotForPersist(): PersistedClientViewState {
    const s = this.state;
    return {
      version: PERSIST_VERSION,
      displaySettings: s.displaySettings,
      optionsOpen: s.optionsOpen,
      listMode: s.listMode,
      navigationMode: s.navigationMode,
      showInstructions: s.showInstructions,
      highlightOn: s.highlightOn,
      highlightControl: s.highlightControl,
      highlightOpacity: s.highlightOpacity,
      searchText: s.searchText,
      transpose: s.transpose,
      capo: s.capo,
      leaderMode: s.leaderMode,
      songId: s.display.songId || "",
    };
  }

  /** Read the persisted snapshot, dropping anything from an incompatible version. */
  private loadPersisted(): PersistedClientViewState | undefined {
    try {
      const raw = this.api.device.getPreference(PERSIST_KEY);
      if (!raw) return undefined;
      const parsed = JSON.parse(raw) as Partial<PersistedClientViewState> | null;
      if (!parsed || typeof parsed !== "object" || parsed.version !== PERSIST_VERSION) return undefined;
      return parsed as PersistedClientViewState;
    } catch {
      return undefined;
    }
  }

  /** Overlay a restored snapshot onto the freshly-seeded state. Pure UI/display
   *  preferences are always applied; permission-sensitive (highlight control) and
   *  backend-owned (current song) fields are applied only where it is safe. */
  private applyPersisted(persisted: PersistedClientViewState | undefined, config: ClientConfig): void {
    if (!persisted) return;
    const patch: Partial<ClientViewState> = {};
    if (persisted.displaySettings && typeof persisted.displaySettings === "object") {
      // Merge over defaults so a snapshot missing newer keys still validates.
      patch.displaySettings = { ...defaultDisplaySettings, ...persisted.displaySettings };
    }
    if (typeof persisted.optionsOpen === "boolean") patch.optionsOpen = persisted.optionsOpen;
    if (typeof persisted.leaderMode === "boolean") patch.leaderMode = persisted.leaderMode;
    if (persisted.listMode && LIST_MODES.includes(persisted.listMode)) patch.listMode = persisted.listMode;
    if (
      persisted.navigationMode === "database" ||
      persisted.navigationMode === "playlist" ||
      persisted.navigationMode === "filter" ||
      persisted.navigationMode === "archive"
    ) {
      patch.navigationMode = persisted.navigationMode;
    }
    if (typeof persisted.showInstructions === "boolean") patch.showInstructions = persisted.showInstructions;
    if (typeof persisted.highlightOpacity === "number") patch.highlightOpacity = persisted.highlightOpacity;
    // Highlight visibility is a pure local display preference — restore it in
    // every mode. Control implies a visible highlight (keep the invariant). In
    // Client mode control is permission-sensitive, so a restored `highlightControl`
    // is re-verified against the leader's grant by init's probe below.
    if (typeof persisted.highlightOn === "boolean") patch.highlightOn = persisted.highlightOn;
    if (typeof persisted.highlightControl === "boolean") {
      patch.highlightControl = persisted.highlightControl && (patch.highlightOn ?? this.state.highlightOn);
    }
    this.set(patch);

    // Restore the search box and re-run the search so results reappear. Skipped
    // when the adapter binds the filter to a host LeftPanel (desktop embed): there
    // the host filter is the source of truth and is seeded separately in init.
    if (!this.api.song.hostFilter && typeof persisted.searchText === "string" && persisted.searchText.trim()) {
      this.setSearchText(persisted.searchText);
    }

    // Restore the locally viewed song ONLY when nothing else already dictates
    // one: a URL-provided initialSongId wins, a follower's display is driven by
    // the backend, and an already-seeded display (e.g. the desktop host's current
    // projection) must not be clobbered.
    if (persisted.songId && !config.initialSongId && !config.follow && this.state.capabilities.canControlDisplay && !this.state.display.songId) {
      void this.loadLocalEntry({ songId: persisted.songId, transpose: persisted.transpose ?? 0, capo: persisted.capo }).catch(() => undefined);
    }
  }

  /** Debounced persist (no-op until init has finished restoring/seeding). */
  private schedulePersist(): void {
    if (!this.persistenceReady || this.disposed) return;
    if (this.persistTimer) clearTimeout(this.persistTimer);
    this.persistTimer = setTimeout(() => this.persistNow(), PERSIST_DEBOUNCE_MS);
  }

  /** Write the snapshot now, skipping the write when nothing persistable changed. */
  private persistNow(): void {
    if (!this.persistenceReady) return;
    try {
      const json = JSON.stringify(this.snapshotForPersist());
      if (json === this.lastPersistedJson) return;
      this.lastPersistedJson = json;
      this.api.device.setPreference(PERSIST_KEY, json);
    } catch {
      /* storage may be unavailable (private mode / quota) — non-fatal */
    }
  }

  private wire(): void {
    this.unsubscribes.push(
      this.api.display.subscribeDisplay((display) => this.set({ display, transpose: display.transpose, capo: display.capo ?? 0 })),
      this.api.session.subscribeNetworkState((network) => this.set({ network })),
      this.api.session.subscribeSessions((sessions) => this.set({ sessions })),
      this.api.auth.subscribeAuth((authed) => this.set({ authed, leader: this.api.auth.currentLeader() })),
      this.api.subscribeCapabilities((capabilities) => this.set({ capabilities })),
      this.api.playlist.subscribePlaylist((playlist) => this.set({ playlist })),
      this.api.song.subscribeSongList((songs) => this.set({ songs }))
    );
  }

  private async loadSongs(): Promise<void> {
    try {
      const songs = await this.api.song.listAllSongs();
      this.set({ songs });
    } catch {
      /* a missing database is non-fatal (e.g. not yet synced) */
    }
  }

  async syncNow(): Promise<void> {
    await Promise.allSettled([
      this.loadSongs(),
      this.loadLeaderPlaylists(),
      this.state.network.status === "watching" ? this.api.session.reconnect() : Promise.resolve(),
    ]);
  }

  /** Whether the active backend can run a real database synchronization (upload
   *  local edits + reconcile with the server). True only for the in-process Direct
   *  embed, which shares the host's local Database; the served/cloud Rest adapter
   *  has no local store to reconcile, so the Sync affordance falls back to the
   *  lightweight {@link syncNow} refresh. */
  canFullSync(): boolean {
    return typeof this.api.requestDatabaseSync === "function";
  }

  /** Open the host app's full database-sync flow (Direct embed only). The host
   *  shows its DBSync dialog and returns to the client view when it closes. */
  startFullSync(): void {
    this.api.requestDatabaseSync?.();
  }

  // ── search ───────────────────────────────────────────────────────────────────

  setSearchText(text: string): void {
    const patch: Partial<ClientViewState> = { searchText: text };
    // Searching returns the list to the searchable database: the working-playlist
    // editor and the leader-playlists picker have no search of their own, so a
    // query must show the database results (the legacy filter box lived only in
    // database mode). Empty text leaves the current mode alone.
    if (text.trim() && this.state.listMode !== "database") patch.listMode = "database";
    if (!text.trim() && this.state.navigationMode === "filter") patch.navigationMode = "database";
    this.set(patch);
    // Keep the host app's LeftPanel filter in lockstep (desktop embed / App mode
    // only; a no-op on adapters without a host filter binding).
    this.api.song.hostFilter?.set(text);
    if (this.searchTimer) clearTimeout(this.searchTimer);
    this.searchTimer = setTimeout(() => void this.runSearch(text), SEARCH_DEBOUNCE_MS);
  }

  async runSearch(text: string): Promise<void> {
    const query = text.trim();
    const seq = ++this.searchSeq;
    if (!query) {
      this.set({ searchResults: [], searching: false });
      return;
    }
    this.set({ searching: true });
    try {
      const results = await this.api.song.searchSongs(query);
      if (seq === this.searchSeq) this.set({ searchResults: results, searching: false });
    } catch {
      if (seq === this.searchSeq) this.set({ searchResults: [], searching: false });
    }
  }

  // ── projection / navigation ──────────────────────────────────────────────────

  private setNavigationMode(mode: NavigationMode): void {
    const patch: Partial<ClientViewState> = { navigationMode: mode };
    if (mode === "playlist") patch.listMode = "playlist";
    this.set(patch);
  }

  private closePortraitOptions(): void {
    if (!this.landscape) this.set({ optionsOpen: false });
  }

  async selectSong(songId: string): Promise<void> {
    await this.selectDatabaseSong(songId);
  }

  async selectDatabaseSong(songId: string): Promise<void> {
    this.setNavigationMode("database");
    await this.loadLocalEntry({ songId });
  }

  async selectFilteredSong(songId: string): Promise<void> {
    this.setNavigationMode("filter");
    await this.loadLocalEntry({ songId });
  }

  /** Project a specific working-playlist entry, preserving its per-item
   *  transpose/capo/instructions values (legacy updateTableFromEntries row pick). */
  async selectPlaylistEntry(entry: PlaylistEntry): Promise<void> {
    this.setNavigationMode("playlist");
    await this.projectEntry(entry);
  }

  /** Project a row from a selected archived/leader playlist without adding it to
   *  the working playlist. Prev/next then walks that selected archive list. */
  async selectArchiveEntry(entry: PlaylistEntry): Promise<void> {
    this.setNavigationMode("archive");
    await this.loadLocalEntry(entry);
  }

  private async loadLocalEntry(entry: NavEntry): Promise<void> {
    const data = await this.api.song.getSongData(entry.songId);
    const transpose = entry.transpose ?? 0;
    const capo = entry.capo;
    this.set({
      display: {
        ...this.state.display,
        songId: entry.songId,
        song: data.text,
        system: data.system,
        from: 0,
        to: 0,
        section: -1,
        transpose,
        capo,
        instructions: entry.instructions,
      },
      transpose,
      capo: capo ?? 0,
    });
    this.closePortraitOptions();
  }

  private async projectEntry(entry: NavEntry): Promise<void> {
    await this.api.display.project({
      songId: entry.songId,
      transpose: entry.transpose ?? 0,
      capo: entry.capo,
      instructions: entry.instructions,
    });
    this.closePortraitOptions();
  }

  /** The legacy "▶" quick-load: add the row to the working playlist when it is
   *  editable and not already present, then project it (which returns to the
   *  song view). Since it projects from the playlist affordance, prev/next then
   *  walks the working playlist. */
  async playSong(song: SongEntry | SongFound | PlaylistEntry): Promise<void> {
    const entry = toPlaylistEntry(song);
    if (this.state.capabilities.canEditWorkingPlaylist && !this.state.playlist.some((item) => item.songId === entry.songId)) {
      await this.setPlaylist([...this.state.playlist, entry]);
    }
    await this.selectPlaylistEntry(entry);
  }

  // ── instructions (legacy wand) ─────────────────────────────────────────────────

  /** Show/hide the current song's display instructions overlaid on the song
   *  (legacy chkInstructions). SongView toggles the editor's instruction render
   *  mode accordingly. */
  currentSongIsInPlaylist(): boolean {
    const songId = this.state.display.songId;
    return !!songId && this.state.playlist.some((entry) => entry.songId === songId);
  }

  canUsePlaylistNavigation(): boolean {
    return this.state.capabilities.canControlDisplay && this.state.playlist.length > 0;
  }

  currentSongCanBeAddedToPlaylist(): boolean {
    const songId = this.state.display.songId;
    return this.state.capabilities.canEditWorkingPlaylist && !!songId && !this.currentSongIsInPlaylist();
  }

  /** Return prev/next to the working playlist without re-projecting the current
   *  song. Re-projecting would clear the currently selected section/highlight. */
  async returnCurrentSongToPlaylistNavigation(): Promise<void> {
    if (!this.state.playlist.length || !this.state.capabilities.canControlDisplay) return;
    const projected = this.api.display.getCurrent();
    this.setNavigationMode("playlist");
    this.set({
      display: projected,
      transpose: projected.transpose,
      capo: projected.capo ?? 0,
    });
    this.closePortraitOptions();
  }

  /** Add the currently displayed song to the working playlist, project that new
   *  row, then make the playlist the active navigation source and options list. */
  async addCurrentSongToPlaylistAndProject(): Promise<void> {
    const songId = this.state.display.songId;
    if (!songId || !this.state.capabilities.canEditWorkingPlaylist) return;
    const existing = this.state.playlist.find((entry) => entry.songId === songId);
    const entry = existing ?? this.currentDisplayPlaylistEntry();
    if (!existing) await this.setPlaylist([...this.state.playlist, entry]);
    await this.selectPlaylistEntry(entry);
  }

  private currentDisplayPlaylistEntry(): PlaylistEntry {
    const { display } = this.state;
    const songId = display.songId;
    const known =
      this.state.songs.find((entry) => entry.songId === songId) ??
      this.state.searchResults.find((entry) => entry.songId === songId) ??
      this.selectedLeaderEntries().find((entry) => entry.songId === songId);
    return {
      songId,
      title: known?.title ?? songId,
      transpose: display.transpose,
      capo: display.capo,
      instructions: display.instructions,
    };
  }

  toggleInstructions(on?: boolean): void {
    this.set({ showInstructions: on ?? !this.state.showInstructions });
  }

  // ── highlight control (legacy chkHighlight) ──────────────────────────────────────

  /**
   * Toggle highlight on/off (the lamp's SHORT click — legacy chkHighlight).
   * Turning it off also releases control, since line-selection control without a
   * visible highlight is meaningless.
   *
   * In App mode the user always owns the display, so there is no intermediate
   * "highlight visible but no control" state worth toggling through — a single
   * click goes straight to highlight CONTROL (off ↔ control directly), no
   * permission round-trip needed.
   *
   * In Client mode the display belongs to the host's session, so turning highlight
   * ON only enters control when the LEADER SWITCH is on: it then silently VERIFIES
   * an existing permission grant (verifyOnly → no leader prompt) and, if already
   * granted, auto-enters control — so a leader-mode follower who was previously
   * approved gets control back on a single click. With leader mode off the click
   * just makes the highlight visible locally and never controls the display.
   * Requesting a NEW grant (which prompts the leader) remains the separate
   * toggleHighlightControl gesture.
   */
  toggleHighlight(): void {
    if (this.state.highlightOn) {
      this.set({ highlightOn: false, highlightControl: false });
      return;
    }
    if (this.state.capabilities.canControlDisplay) {
      this.set({ highlightOn: true, highlightControl: true });
      return;
    }
    this.set({ highlightOn: true });
    // Auto-reclaiming control on a single click is gated on the leader switch: a
    // follower who hasn't turned leader mode on just shows the highlight locally
    // and never enters control, even if a prior server grant still stands. Taking
    // control deliberately remains the long-press toggleHighlightControl gesture.
    if (this.state.mode === "Client" && this.state.leaderMode) {
      void this.api.auth
        .requestHighlightPermission(true)
        .then((granted) => {
          // Only adopt control if highlight is still on (user may have toggled off
          // again while the verify was in flight).
          if (granted && this.state.highlightOn) this.set({ highlightControl: true });
        })
        .catch(() => undefined);
    }
  }

  /**
   * Toggle highlight CONTROL — the lamp's LONG-press / right-click. Entering
   * control also turns the highlight on (control implies a visible highlight).
   *
   * Anyone who can control the display takes highlight control LOCALLY, with no
   * permission round-trip: App mode (own session) and an admin-served Client (a
   * leader-mode follower whose IP/MAC is allowlisted — canControlDisplay is true)
   * both control by right, and the host auto-grants their /highlight pushes.
   * Only a non-controlling Client follower (canControlDisplay false) must ask the
   * leader: that goes through the server permission flow (verify → request), which
   * the host approves via a confirm dialog. Highlight is ORTHOGONAL to leading —
   * granted via the separate /highlight flow — so a plain follower can hold it too.
   * Leaving control keeps the highlight on (only a short click turns it off).
   */
  toggleHighlightControl(): void {
    const { highlightControl, mode, capabilities } = this.state;
    if (highlightControl) {
      this.set({ highlightControl: false });
      return;
    }
    if (capabilities.canControlDisplay) {
      this.set({ highlightOn: true, highlightControl: true });
    } else if (mode === "Client") {
      void this.requestHighlightPermission();
    }
  }

  /** Push a highlight range to the display/followers (the tapped lyrics section). */
  async pushHighlight(from: number, to: number, section?: number): Promise<void> {
    await this.api.display.highlight(from, to, section);
  }

  /** Clear the current highlight. */
  async unhighlight(): Promise<void> {
    await this.api.display.highlight(0, 0);
  }

  openHighlightOpacityDialog(): void {
    this.set({ highlightOpacityDialogOpen: true });
  }

  closeHighlightOpacityDialog(): void {
    this.set({ highlightOpacityDialogOpen: false });
  }

  setHighlightOpacity(value: number): void {
    this.set({ highlightOpacity: Math.max(0, Math.min(1, value)) });
  }

  /** Acquire highlight control from the server (Client mode). First VERIFIES an
   *  existing grant silently; only if not already granted does it send an actual
   *  REQUEST (which prompts the leader). Control is entered ONLY when the server
   *  returns GRANTED — a DENIED/pending response leaves the state at "on" (mirrors
   *  legacy queryHighlightPermission, where applyLineSelectionControl(false) keeps
   *  line selection off until a grant arrives). */
  async requestHighlightPermission(): Promise<void> {
    // The request leg prompts the leader on the other device, so it can take a
    // few seconds — show the spinning gear meanwhile (legacy #highlight_loader).
    this.set({ highlightPending: true });
    try {
      let granted = await this.api.auth.requestHighlightPermission(true);
      if (!granted) granted = await this.api.auth.requestHighlightPermission(false);
      if (granted) this.set({ highlightOn: true, highlightControl: true });
    } catch {
      /* permission request failures are non-fatal — stay at "on" */
    } finally {
      this.set({ highlightPending: false });
    }
  }

  openInstructionsEditor(): void {
    this.set({ instructionsEditorOpen: true, instructionsEditorText: this.state.display.instructions ?? "" });
  }

  closeInstructionsEditor(): void {
    this.set({ instructionsEditorOpen: false });
  }

  setInstructionsEditorText(text: string): void {
    this.set({ instructionsEditorText: text });
  }

  async saveInstructions(text: string): Promise<void> {
    await this.api.display.setInstructions(text || undefined);
    this.set({ instructionsEditorOpen: false });
  }

  /** The ordered collection prev/next navigation walks. It is explicit so a song
   *  that exists in several lists does not silently switch navigation source. */
  private navList(): NavEntry[] {
    switch (this.state.navigationMode) {
      case "playlist":
        return this.state.playlist;
      case "filter":
        return this.state.searchResults;
      case "archive":
        return this.selectedLeaderEntries();
      case "database":
      default:
        return this.state.songs;
    }
  }

  /** The neighbouring song in the active navigation list (see {@link navList}) in
   *  the given direction, or undefined at the ends / when the current song is not
   *  found. Public so the song view can pre-render the neighbour for the page-turn
   *  animation, and so the toolbar can know whether a turn is possible. */
  neighbourEntry(next: boolean): NavEntry | undefined {
    const list = this.navList();
    const index = list.findIndex((entry) => entry.songId === this.state.display.songId);
    if (index < 0) return undefined;
    return list[next ? index + 1 : index - 1];
  }

  /** Full ChordPro text + chord system for a song, via the active backend.
   *  Used by the song view to pre-render the page-turn neighbours. */
  getSongData(songId: string): Promise<SongData> {
    return this.api.song.getSongData(songId);
  }

  async nextSong(): Promise<void> {
    const entry = this.neighbourEntry(true);
    if (entry) await this.selectNeighbour(entry);
  }

  async prevSong(): Promise<void> {
    const entry = this.neighbourEntry(false);
    if (entry) await this.selectNeighbour(entry);
  }

  /** Project a prev/next neighbour carrying its per-entry transpose/capo/instructions.
   *  Unlike a bare selectSong({ songId }), this makes the OPTIMISTIC local render
   *  already match the state the backend echoes back via display_query — otherwise
   *  the song flashes at its default (transpose 0) until the long-poll correction
   *  lands. This is why playlist selection (which carries these) never flashed but
   *  prev/next did. Mirrors selectPlaylistEntry. */
  private async selectNeighbour(entry: NavEntry): Promise<void> {
    if (this.state.navigationMode === "playlist") await this.projectEntry(entry);
    else await this.loadLocalEntry(entry);
  }

  async setTranspose(value: number): Promise<void> {
    this.set({ transpose: value });
    await this.api.display.setTranspose(value);
  }

  async setCapo(value: number): Promise<void> {
    this.set({ capo: value });
    await this.api.display.setCapo(value);
  }

  // ── playlist ─────────────────────────────────────────────────────────────────

  async setPlaylist(entries: PlaylistEntry[]): Promise<void> {
    await this.api.playlist.setPlaylist(entries);
  }

  async clearPlaylist(): Promise<void> {
    // Legacy iconClearList → confirm("erase") before emptying the working list.
    if (!(await this.confirm("erase"))) return;
    await this.api.playlist.clear();
  }

  /** Switch the song list between the database, the working-playlist editor and
   *  the leader-playlists picker. Caller gates the affordance on
   *  capabilities.canEditWorkingPlaylist. Entering leaderlists lazily loads the
   *  leader profiles (refreshing them, like the legacy updatePlaylistDroplist). */
  setListMode(mode: ListMode): void {
    const patch: Partial<ClientViewState> = { listMode: mode };
    if (mode === "database" || mode === "playlist") patch.navigationMode = mode;
    this.set(patch);
    if (mode === "leaderlists") void this.loadLeaderPlaylists();
  }

  // ── leader playlists picker (legacy selPlaylists droplist) ───────────────────────

  /** Fetch the leader profiles backing the picker and seed the leader/date
   *  selection (most recent leader + their newest dated playlist), preserving the
   *  current selection when it still exists. Mirrors legacy updatePlaylistDroplist
   *  / updateLeaderPlaylist. Non-fatal on failure (offline / not authed). */
  async loadLeaderPlaylists(): Promise<void> {
    this.set({ leaderProfilesLoading: true });
    try {
      // Only leaders that actually have dated playlists are worth listing — a
      // leader with an empty schedule would give an empty date select.
      const profiles = (await this.api.playlist.getLeaderPlaylists()).filter((profile) => profile.playlists.length > 0);
      this.set({ leaderProfiles: profiles, leaderProfilesLoading: false });
      this.reconcileLeaderSelection(profiles);
    } catch {
      this.set({ leaderProfilesLoading: false });
    }
  }

  /** Keep the chosen leader/date valid against a fresh profile set: keep the
   *  current pick when it still exists, otherwise fall back to the first leader
   *  and that leader's newest playlist label. */
  private reconcileLeaderSelection(profiles: LeaderDBProfile[]): void {
    const leaderId = profiles.some((p) => p.leaderId === this.state.selectedLeaderId) ? this.state.selectedLeaderId : (profiles[0]?.leaderId ?? null);
    const labels = profiles.find((p) => p.leaderId === leaderId)?.playlists.map((pl) => pl.label) ?? [];
    const label =
      this.state.selectedPlaylistLabel && labels.includes(this.state.selectedPlaylistLabel) ? this.state.selectedPlaylistLabel : (labels[0] ?? null);
    this.set({ selectedLeaderId: leaderId, selectedPlaylistLabel: label });
  }

  /** The dated playlists offered by the currently selected leader, newest first
   *  (labels are `YYYY.MM.DD` date strings, so a reverse string sort is by date). */
  leaderPlaylistOptions(): { label: string }[] {
    const playlists = this.state.leaderProfiles.find((p) => p.leaderId === this.state.selectedLeaderId)?.playlists ?? [];
    return [...playlists].sort((a, b) => -a.label.localeCompare(b.label)).map((pl) => ({ label: pl.label }));
  }

  /** The songs of the currently selected leader + dated playlist (the rows the
   *  picker shows for "pick items"). Empty when nothing is selected. */
  selectedLeaderEntries(): PlaylistEntry[] {
    const profile = this.state.leaderProfiles.find((p) => p.leaderId === this.state.selectedLeaderId);
    const playlist = profile?.playlists.find((pl) => pl.label === this.state.selectedPlaylistLabel);
    return playlist?.songs ?? [];
  }

  /** Choose a leader in the picker; resets the date to that leader's newest. */
  selectLeader(leaderId: string): void {
    const labels = this.leaderProfilesFor(leaderId);
    this.set({ selectedLeaderId: leaderId, selectedPlaylistLabel: labels[0] ?? null });
  }

  /** Choose a dated playlist (the date select). */
  selectLeaderDate(label: string): void {
    this.set({ selectedPlaylistLabel: label });
  }

  private leaderProfilesFor(leaderId: string): string[] {
    const playlists = this.state.leaderProfiles.find((p) => p.leaderId === leaderId)?.playlists ?? [];
    return [...playlists].sort((a, b) => -a.label.localeCompare(b.label)).map((pl) => pl.label);
  }

  /** Replace the working playlist wholesale with the selected leader playlist
   *  (legacy replaceCurrentPlaylistWithSelected) and return to the song view. */
  async replaceWithLeaderPlaylist(): Promise<void> {
    const entries = this.selectedLeaderEntries();
    if (!entries.length) return;
    // Legacy replacePlaylist → confirm("overwrite") before clobbering the working list.
    if (!(await this.confirm("overwrite"))) return;
    const next = entries.map(toPlaylistEntry);
    await this.setPlaylist(next);
    this.setNavigationMode("playlist");
    // If the projected song isn't part of the freshly loaded list, jump to its
    // first song (legacy replaceCurrentPlaylistWithSelected returned to the song
    // view on the new list). Only when this client may drive the display.
    const currentId = this.state.display.songId;
    if (this.state.capabilities.canControlDisplay && !next.some((entry) => entry.songId === currentId)) {
      await this.selectPlaylistEntry(next[0]);
    }
  }

  /** Add a database/search result to the end of the working playlist, or remove
   *  it if already present — the legacy add-checkbox toggle. */
  async togglePlaylistEntry(song: SongEntry | SongFound | PlaylistEntry): Promise<void> {
    const list = this.state.playlist;
    const index = list.findIndex((entry) => entry.songId === song.songId);
    const next = index >= 0 ? list.filter((_, i) => i !== index) : [...list, toPlaylistEntry(song)];
    await this.setPlaylist(next);
  }

  /** Patch one working-playlist row (title/transpose/capo/instructions). */
  async updatePlaylistEntry(index: number, patch: Partial<Pick<PlaylistEntry, "title" | "transpose" | "capo" | "instructions">>): Promise<void> {
    if (index < 0 || index >= this.state.playlist.length) return;
    const next = this.state.playlist.slice();
    next[index] = { ...next[index], ...patch };
    await this.setPlaylist(next);
  }

  /** Move a working-playlist row from one position to another (drag reorder).
   *  Indices are into the current snapshot; out-of-range moves are ignored. */
  async reorderPlaylist(from: number, to: number): Promise<void> {
    const list = this.state.playlist.slice();
    if (from < 0 || from >= list.length) return;
    const [item] = list.splice(from, 1);
    const target = Math.max(0, Math.min(to, list.length));
    list.splice(target, 0, item);
    await this.setPlaylist(list);
  }

  /** Remove the working-playlist row at the given index (trash drop). */
  async removeFromPlaylist(index: number): Promise<void> {
    if (index < 0 || index >= this.state.playlist.length) return;
    await this.setPlaylist(this.state.playlist.filter((_, i) => i !== index));
  }

  // ── options panel ────────────────────────────────────────────────────────────

  toggleOptions(open?: boolean): void {
    this.set({ optionsOpen: open ?? !this.state.optionsOpen });
  }

  /** Flip leader mode (legacy chkAdmin). Persisted via the snapshot; the API
   *  folds it into the effective control capabilities (where the right exists). */
  toggleLeaderMode(on?: boolean): void {
    const next = on ?? !this.state.leaderMode;
    this.set({ leaderMode: next });
    this.api.setLeaderMode(next);
  }

  /** Navigate to the serving host's net-display page — the follower's "open
   *  netdisplay" button (legacy btnNetDisplay → `${webRoot}/netdisplay?leader=…`).
   *  Only the host webservers expose this route, i.e. Client follower view. */
  openNetDisplay(): void {
    const url = this.api.session.netDisplayUrl();
    if (url && typeof window !== "undefined") window.location.assign(url);
  }

  openZoomDialog(): void {
    this.set({ zoomDialogOpen: true });
  }

  closeZoomDialog(): void {
    this.set({ zoomDialogOpen: false });
  }

  async toggleFullScreen(): Promise<void> {
    const isFullScreen = await this.api.device.toggleFullScreen();
    this.set({ isFullScreen });
  }

  // ── more-menu actions ──────────────────────────────────────────────────────────

  // ── save playlist (date picker) ──────────────────────────────────────────────

  /** Open the save-playlist date picker and fetch the current leader's already-
   *  scheduled dates so they can be "signed" in the calendar. Caller must gate on
   *  capabilities.canPersistPlaylist. Mirrors the legacy iconStore calendar flow
   *  (praiseprojector.ts ~L1300: load the leader's playlists, mark their dates). */
  async openSaveDialog(): Promise<void> {
    this.set({ saveDialogOpen: true, saveDialogLoading: true, saveScheduledDates: [] });
    try {
      const leaderId = this.state.leader?.id;
      const profiles = await this.api.playlist.getLeaderPlaylists();
      const profile = leaderId ? profiles.find((p) => p.leaderId === leaderId) : undefined;
      // A playlist's date is its `scheduled` field, falling back to parsing the
      // YYYY.MM.DD label (the legacy store_list label format).
      const dates = (profile?.playlists ?? []).map((pl) => pl.scheduled ?? parseScheduleDate(pl.label)).filter((d): d is Date => d != null);
      // Bail if the dialog was closed while the fetch was in flight.
      if (this.state.saveDialogOpen) this.set({ saveScheduledDates: dates, saveDialogLoading: false });
    } catch {
      if (this.state.saveDialogOpen) this.set({ saveDialogLoading: false });
    }
  }

  closeSaveDialog(): void {
    this.set({ saveDialogOpen: false, saveDialogLoading: false });
  }

  /** Persist the working playlist to the backend, scheduled for `date` (cloud
   *  leader only). On an OVERWRITE response, confirm and retry forced — the
   *  faithful port of legacy uploadList(). Caller must gate on
   *  capabilities.canPersistPlaylist. */
  async confirmSave(date: Date): Promise<void> {
    this.closeSaveDialog();
    const label = formatLocalDateLabel(date);
    const result = await this.api.playlist.upload({ label, scheduled: date });
    if (result === "OVERWRITE") {
      if (await this.confirm("overwrite")) {
        await this.api.playlist.upload({ label, scheduled: date, forced: true });
      }
    }
  }

  /** Show the About dialog (version + license references), mirroring the legacy
   *  client's in-app about box rather than navigating away to the website. */
  openAbout(): void {
    this.set({ aboutOpen: true });
  }

  closeAbout(): void {
    this.set({ aboutOpen: false });
  }

  // ── confirmation dialog (legacy `confirm(anim)`) ─────────────────────────────────

  /** Show the animated-SVG confirmation popup and resolve true on OK, false on
   *  cancel/dismiss. `anim` is the legacy images/<anim>.svg message name (e.g.
   *  "erase", "overwrite"). Mirrors praiseprojector.ts `confirm()`. */
  confirm(anim: string): Promise<boolean> {
    // Defensive: if one is somehow already open, dismiss it as cancelled first.
    this.confirmResolver?.(false);
    return new Promise<boolean>((resolve) => {
      this.confirmResolver = resolve;
      this.set({ confirmAnim: anim });
    });
  }

  /** Resolve the open confirmation dialog (OK = true; Cancel / backdrop / Esc =
   *  false) and close it. */
  resolveConfirm(ok: boolean): void {
    const resolve = this.confirmResolver;
    this.confirmResolver = null;
    this.set({ confirmAnim: null });
    resolve?.(ok);
  }

  /** Open an external URL through the host (external browser on native shells). */
  openExternalUrl(url: string): void {
    this.api.device.openExternal(url);
  }

  /** Navigate from the focused client view to the full multi-panel editor. */
  openFullEditor(): void {
    if (typeof window === "undefined") return;
    window.location.assign(this.fullEditorUrl);
  }

  /** Terminate the app on hosts that support it (gated by state.canExit). */
  exitApp(): void {
    this.api.device.exit?.();
  }

  setDisplaySetting<K extends keyof DisplaySettings>(key: K, value: DisplaySettings[K]): void {
    this.set({ displaySettings: { ...this.state.displaySettings, [key]: value } });
  }

  /** Cycle the chord-box mode: none → guitar → piano → no-chords (legacy order). */
  cycleChordBox(): void {
    const order: ChordBoxKind[] = ["", "GUITAR", "PIANO", "NO_CHORDS"];
    const current = this.state.displaySettings.chordBoxType;
    this.setDisplaySetting("chordBoxType", order[(order.indexOf(current) + 1) % order.length]);
  }

  /** Cycle the SHARED light/dark preference auto → light → dark (the original's
   *  switchDarkMode order). Writes the `pp-settings.theme` key the full view also
   *  owns, so the choice stays in lockstep across both views. */
  cycleDarkMode(): void {
    const order: DarkMode[] = ["auto", "light", "dark"];
    const next = order[(order.indexOf(this.state.themeSetting) + 1) % order.length];
    writeThemeSetting(next);
    this.syncTheme();
  }

  /** Re-read the shared `pp-settings.theme` preference and recompute the effective
   *  dark flag. Called on init, on OS-preference flips, and whenever the full view
   *  (or another tab) changes the theme. */
  private syncTheme(): void {
    const themeSetting = readThemeSetting();
    const isDark = computeIsDark(themeSetting);
    if (themeSetting !== this.state.themeSetting || isDark !== this.state.isDark) {
      this.set({ themeSetting, isDark });
    }
  }

  // ── auth ─────────────────────────────────────────────────────────────────────

  openLoginDialog(): void {
    this.set({ loginDialogOpen: true });
  }

  closeLoginDialog(): void {
    this.set({ loginDialogOpen: false });
  }

  async login(user: string, password: string, keepLoggedIn: boolean): Promise<void> {
    await this.api.auth.login(user, password, keepLoggedIn);
    this.set({ authed: this.api.auth.isAuthed(), leader: this.api.auth.currentLeader() });
  }

  async logout(): Promise<void> {
    await this.api.auth.logout();
    this.set({ authed: false, leader: null });
  }

  // ── sessions ─────────────────────────────────────────────────────────────────

  openSessionsDialog(): void {
    this.set({ sessionsDialogOpen: true });
  }

  closeSessionsDialog(): void {
    this.set({ sessionsDialogOpen: false });
  }

  async refreshSessions(mode: ExternalSearchMode = "BOTH", address?: string): Promise<void> {
    // Trigger a fresh local (UDP/nearby) scan on the chosen broadcast address before
    // collecting — searchExternal's NEARBY leg only reads already-discovered peers.
    if (address && (mode === "BOTH" || mode === "NEARBY")) {
      await this.api.session.scanLocalServers(address);
    }
    const sessions = await this.api.session.searchExternal(mode);
    this.set({ sessions });
  }

  /** Candidate scan-address options ({ value, label }) + default for the picker. */
  getScanAddresses(): Promise<{ options: { value: string; label: string }[]; default?: string }> {
    return this.api.session.scanAddresses();
  }

  async watchSession(session: OnlineSessionEntry): Promise<void> {
    await this.api.session.watch(session);
  }

  /** Attach to a discovered session, dispatched by type (PPD/cloud follow, or open a
   *  LAN server's URL) — the found-session selector. See {@link SessionApi.attach}. */
  async attachSession(session: OnlineSessionEntry): Promise<void> {
    await this.api.session.attach(session);
  }

  async stopWatching(): Promise<void> {
    await this.api.session.stopWatching();
  }

  /** Begin hosting a local PPD session so nearby devices can follow (legacy
   *  startPpdSession). App mode + a host bridge only (canHostLocalSession). */
  async startLocalSession(): Promise<void> {
    await this.api.session.startLocal();
  }

  /** Stop hosting the local PPD session (legacy stopPpdSession). */
  async stopLocalSession(): Promise<void> {
    await this.api.session.stopLocal();
  }

  async setSessionFeatureEnabled(key: SessionFeatureKey, enabled: boolean): Promise<void> {
    await this.api.session.setFeatureEnabled(key, enabled);
  }

  /** Host an online (cloud) session — register as a leader others can follow. App
   *  mode + authed only (canHostOnlineSession). */
  async startOnlineSession(): Promise<void> {
    await this.api.session.createOnline();
  }

  /** Force an immediate reconnect to the followed server (the legacy goOnline()),
   *  wired to the toolbar network indicator's click. The adapter drives the
   *  network status back through subscribeNetworkState. */
  async reconnect(): Promise<void> {
    await this.api.session.reconnect();
  }
}
