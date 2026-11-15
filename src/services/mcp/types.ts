/**
 * The seam between the MCP tools and the application.
 *
 * Tools are plain functions over {@link McpHost}; `useMcpBridge` implements the host
 * with the real database, panels and settings, the tests with a fake. Everything that
 * crosses the seam is plain data, so this folder imports no React, Electron or
 * database code (type imports aside).
 */
import type { Settings } from "../../types";

/** read: look only. write: changes the user confirms. control: live projection. */
export type McpAccess = "read" | "write" | "control";

export interface McpSongInfo {
  id: string;
  title: string;
  language: string;
  /** "text" (lyrics only), "music" (chords or a score with lyrics) or "score". */
  kind: string;
  /** Key from the song's {key: …} line; empty when the song does not state one. */
  key: string;
}

export interface McpSongUsage {
  song: McpSongInfo;
  /** Number of dated playlists of the leader that contain the song. */
  count: number;
  /** yyyy-mm-dd of the latest such playlist. */
  lastUsed: string;
  /** The leader's own transposition (semitones) and the key that results from it. */
  transpose: number;
  leaderKey: string;
}

export interface McpSong extends McpSongInfo {
  /** The song in ChordPro. */
  text: string;
  /** Chord system: "G" = German/Hungarian (H, B), "S" = standard (B, Bb). */
  system: string;
  capo: number;
  /** Database version of this copy; 0: created or changed on this computer and not uploaded yet. */
  version: number;
  /** Other versions of the same song (translations, arrangements) the database groups with it. */
  related: McpSongInfo[];
}

/**
 * One uploaded version of a song as the cloud keeps it (the history the app shows). The
 * local database does not store who uploaded a song and when; only the cloud knows it.
 */
export interface McpSongVersion {
  /** ISO time of the upload. */
  uploaded: string;
  /** Uploader's user name; empty when the server does not reveal it to this account. */
  uploader: string;
  /** The text as the app stores it, so it compares with {@link McpSong.text}. */
  text: string;
  system: string;
  language: string;
}

export type McpSongHistory = { versions: McpSongVersion[] } | { error: string };

/** How the application treats a chord written in a song. */
export type McpChordStatus = "recognized" | "chord-shaped" | "not-a-chord";

export interface McpSearchHit {
  song: McpSongInfo;
  /** Why it matched: title, lyrics, … */
  reason: string;
  snippet?: string;
}

export interface McpPlaylistItem {
  songId: string;
  title: string;
  transpose: number;
  /** -1: no capo recommendation. */
  capo: number;
  instructions: string;
}

/** A playlist stored in a leader's profile: the one of a calendar day, or a favorite by name. */
export type McpStoredPlaylistRef = { date: string } | { favorite: string };

export interface McpStoredPlaylist {
  /** The favorite's name, or the date label of a dated list. */
  name: string;
  items: McpPlaylistItem[];
}

/** The stored playlist the working list was last loaded from or saved to. */
export type McpPlaylistSource = { leaderId: string; leader: string } & McpStoredPlaylistRef;

/** Outcome of a playlist file dialog. "pending": a browser file picker is open. */
export type McpFileResult = { status: "done" | "cancelled" | "pending" } | { status: "failed"; error: string };

export interface McpPlaylistState {
  items: McpPlaylistItem[];
  selectedIndex: number;
  /** Null when the list was not loaded from, or saved to, a stored playlist (or was replaced since). */
  source: McpPlaylistSource | null;
  /** True while following another session: the list cannot be edited. */
  readOnly: boolean;
}

export interface McpLeader {
  id: string;
  name: string;
  /** "own": editable profile of this account; "public": read-only mirror. */
  access: "own" | "public";
  /** Calendar days (yyyy-mm-dd) that have a stored playlist. */
  scheduledDates: string[];
  /** Names of the favorite (named, undated) playlists. */
  favorites: string[];
}

export interface McpSection {
  index: number;
  label: string;
  text: string;
}

export interface McpProjectionState {
  /** Empty when no song is loaded for projection. */
  songId: string;
  title: string;
  /** Index of the projected section in `sections`, -1 when nothing is projected. */
  sectionIndex: number;
  sections: McpSection[];
  transpose: number;
  capo: number;
  /** Is the projector (second screen) window open. */
  projectorOpen: boolean | null;
}

export interface McpConnectedClient {
  name: string;
  id: string;
  connected: boolean;
  leaderMode: boolean;
}

export interface McpNetworkStatus {
  webServerAvailable: boolean;
  webServerEnabled: boolean;
  /** URL tablets and phones open in a browser, null when the web server is off. */
  clientUrl: string | null;
  /** URL of the browser projection screen, null when it is off. */
  netDisplayUrl: string | null;
  localAddresses: string[];
  port: number;
  lanClientsOnly: boolean;
  /** Nearby (UDP / Bluetooth) session offered to the PraiseProjector apps. */
  nearbySessionEnabled: boolean;
  allClientsCanLead: boolean;
  clients: McpConnectedClient[];
  /** Sessions of other devices visible on the local network. */
  discoveredSessions: { name: string; leader: string; transport: string }[];
  /** True when this app is following another device's session. */
  followingSession: boolean;
}

export interface McpChordProReport {
  title: string;
  kind: string;
  sectionCount: number;
}

export interface McpUiState {
  /** "full": the operator view with the three panels. "client": the simple musician view. */
  view: "full" | "client";
  /** Panel in front on a narrow window: side (songs and playlist), editor or preview. */
  activePanel: string;
  openDialogs: string[];
  editingSong: boolean;
  selectedSong: McpSongInfo | null;
  followingSession: boolean;
  updateAvailable: boolean;
}

export interface McpDisplayInfo {
  /** Monitors connected to the computer. */
  displayCount: number;
  /** Is a monitor chosen for projection in the preview panel. */
  projectorDisplaySelected: boolean;
  projectorOpen: boolean | null;
}

export type McpShowResult = "shown" | "not-visible" | "other-view" | "unknown";

export type McpViewTarget = "settings" | "sessions" | "sync" | "import" | "song-check" | "tutorial";

export interface McpHost {
  appVersion(): string;
  platform(): string;
  /** UI language in effect. */
  language(): "en" | "hu";
  account(): { username: string | null; signedIn: boolean; guest: boolean };

  getSettings(): Settings | null;
  /** Persists the changes and applies them (web server, projector, …). */
  updateSettings(patch: Partial<Settings>): Promise<void>;

  songCount(): number;
  listSongs(): McpSongInfo[];
  getSong(songId: string): McpSong | null;
  /** Every version the cloud has of the song that this account may see, newest first. */
  getSongHistory(songId: string): Promise<McpSongHistory>;
  /** All hits of the app's own song search, best first. */
  searchSongs(query: string): Promise<McpSearchHit[]>;
  analyzeChordPro(text: string, system: string): McpChordProReport;
  /**
   * "recognized": the app knows the chord in this chord system (it can transpose it and
   * draw its diagram). "chord-shaped": it is stored and shown as written, but the app
   * does not know it. "not-a-chord": the text in the brackets is not a chord at all.
   */
  chordStatus(chord: string, system: string): McpChordStatus;
  /** Chord types the app knows, each with the suffixes that select it ("", "m", "7", "sus4", …). */
  knownChordTypes(): { name: string; suffixes: string[] }[];
  /**
   * What the import wizard turns a chord of a source text into (app notation), given how
   * the source writes B/H and minor chords. Empty: the wizard leaves it as written.
   */
  importerChord(chord: string, sourceUsesH: boolean, lowercaseIsMinor: boolean): string;
  /** The wizard's own guess of the two source conventions: 1 yes, 0 no, -1 undecidable. */
  importerConventions(chords: string[]): { sourceUsesH: number; lowercaseIsMinor: number };
  /**
   * A grid line (chords without brackets): the chords the app finds in it, and the other
   * words between the separators (spaces, |, /, . …), which the app does not take for chords.
   */
  gridChords(line: string, system: string): { chords: string[]; other: string[] };
  /** Opens the import wizard on the given text; the user finishes the import there. */
  importSongText(fileName: string, text: string): boolean;

  listLeaders(): McpLeader[];
  selectedLeader(): { id: string; name: string } | null;
  selectLeader(leaderId: string): void;
  /** How often each song occurs in the leader's dated playlists, most used first. */
  getSongUsage(leaderId: string, since?: string): McpSongUsage[];
  /** The song's key after transposing; empty when the song states no key. */
  songKey(songId: string, transpose: number): string;
  /**
   * The item the user's own "add to playlist" makes of a song: the leader's title,
   * transposition, capo and instructions where the leader has them. Null: no such song.
   */
  newPlaylistItem(leaderId: string | null, songId: string): McpPlaylistItem | null;

  getStoredPlaylist(leaderId: string, ref: McpStoredPlaylistRef): McpStoredPlaylist | null;
  /**
   * Writes a list into a leader's calendar or favorites. The working list and the leader's
   * song preferences stay as they are (custom titles belong to this list only).
   */
  storePlaylist(
    leaderId: string,
    ref: McpStoredPlaylistRef,
    items: McpPlaylistItem[],
    overwrite: boolean
  ): "saved" | "exists" | "invalid-name" | "read-only";

  /** The working list: the playlist loaded in the app, which joined tablets see. */
  getPlaylist(): McpPlaylistState;
  /** Replaces the working list as loading a playlist file does (one undo step, no source). */
  replacePlaylist(items: McpPlaylistItem[]): Promise<void>;
  /**
   * Changes the working list as the user's own edits do (one undo step, the source and the
   * selection kept); `sources[i]` is the current index item i comes from, null for a new one.
   * Nothing is selected or projected.
   */
  editPlaylist(items: McpPlaylistItem[], sources: (number | null)[]): Promise<void>;
  /** Loads a stored playlist into the working list, as the Load dialog does. False: no such list. */
  loadStoredPlaylist(leaderId: string, ref: McpStoredPlaylistRef): Promise<boolean>;
  /**
   * Stores the working list in a leader's profile and makes it the list's source, as the Save
   * dialog does (the items also become the leader's song preferences).
   */
  saveWorkingPlaylist(leaderId: string, ref: McpStoredPlaylistRef): "saved" | "invalid-name" | "read-only" | "failed";
  /** The app's own playlist file dialogs. */
  loadPlaylistFile(): Promise<McpFileResult>;
  savePlaylistFile(): Promise<McpFileResult>;

  getProjection(): Promise<McpProjectionState>;
  /** Loads a song for projection. "playlist": selected in the playlist, "tree": opened from the song list. */
  showSong(songId: string): Promise<"playlist" | "tree" | "not-found">;
  selectSection(index: number): boolean;
  sectionCommand(command: string): boolean;

  getNetworkStatus(): Promise<McpNetworkStatus>;
  openView(target: McpViewTarget, page?: string): boolean;
  getUiState(): McpUiState;
  getDisplayInfo(): Promise<McpDisplayInfo>;
  /**
   * Brings a part of the screen forward and highlights it for a few seconds.
   * "other-view": the element belongs to the view that is not shown now.
   */
  showInApp(targetId: string): Promise<McpShowResult>;
  confirm(title: string, message: string): Promise<boolean>;
}

/** Thrown by a tool to report a problem to the model (not a protocol error). */
export class McpToolError extends Error {}

export interface McpTool {
  name: string;
  title: string;
  description: string;
  inputSchema: Record<string, unknown>;
  access: McpAccess;
  /** Text of the in-app confirmation; null skips it. Only asked for write tools. */
  confirmation?: (args: Record<string, unknown>, host: McpHost) => string | null;
  run: (args: Record<string, unknown>, host: McpHost) => unknown | Promise<unknown>;
}

type Localized = { en: string; hu: string };

/** A task template the user starts from the assistant's prompt list. */
export interface McpPrompt {
  name: string;
  title: Localized;
  description: Localized;
  arguments: { name: string; description: Localized; required: boolean }[];
  /** The message handed to the model. */
  build: (args: Record<string, string>, host: McpHost) => string;
}

export interface McpResource {
  uri: string;
  name: string;
  title: string;
  description: string;
  mimeType: string;
  read: (host: McpHost) => string;
}
