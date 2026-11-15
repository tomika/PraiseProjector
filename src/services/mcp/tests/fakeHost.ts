/** An in-memory McpHost for the tool and protocol tests. */
import type { Settings } from "../../../types";
import { chordStatus, gridChords, importerChord, importerConventions, knownChordTypes } from "../appChords";
import type {
  McpFileResult,
  McpHost,
  McpLeader,
  McpNetworkStatus,
  McpPlaylistItem,
  McpPlaylistSource,
  McpSong,
  McpSongHistory,
  McpSongUsage,
  McpStoredPlaylistRef,
  McpUiState,
} from "../types";

export interface FakeState {
  settings: Partial<Settings>;
  songs: McpSong[];
  leaders: McpLeader[];
  selectedLeaderId: string | null;
  playlist: McpPlaylistItem[];
  /** The working list's source (what the app remembers it was loaded from or saved to). */
  source: McpPlaylistSource | null;
  /** Stored lists by `leaderId/date` or `leaderId/★name`. */
  stored: Map<string, { name: string; items: McpPlaylistItem[] }>;
  /** Leader song preferences by `leaderId/songId`. */
  preferences: Map<string, Partial<McpPlaylistItem>>;
  history: Record<string, McpSongHistory>;
  usage: Record<string, McpSongUsage[]>;
  network: McpNetworkStatus;
  ui: McpUiState;
  account: { username: string | null; signedIn: boolean; guest: boolean };
  displayCount: number;
  fileResult: McpFileResult;
  confirmAnswer: boolean;
  confirmations: string[];
  calls: string[];
}

export const song = (id: string, title: string, text: string, key = ""): McpSong => ({
  id,
  title,
  language: "hu",
  kind: "music",
  key,
  text,
  system: "G",
  capo: 0,
  version: 7,
  related: [],
});

export const storedKey = (leaderId: string, ref: McpStoredPlaylistRef) =>
  "date" in ref ? `${leaderId}/${ref.date}` : `${leaderId}/★${ref.favorite.toLowerCase()}`;

export function fakeState(overrides: Partial<FakeState> = {}): FakeState {
  return {
    settings: {
      mcpAllowChanges: true,
      mcpAllowLiveControl: false,
      mcpConfirmChanges: true,
      iWebEnabled: true,
      webServerPort: 19740,
      lastSyncDate: "2026-11-01T10:00:00Z",
    },
    songs: [
      song("s1", "A jó pásztor", "{title: A jó pásztor}\n{key: G}\n[G]Az Úr az én [D]pásztorom,\nnem szűköl[C]ködöm.", "G"),
      song("s2", "Örvendj", "{title: Örvendj}\n[D]Örvendj és vi[A]gadj!\n# megjegyzés: nyáj"),
      song("s3", "The flock", "{title: The flock}\n{key: Am}\nHe leads his [Am]flock", "Am"),
    ],
    leaders: [
      { id: "own1", name: "Kiss Tamás", access: "own", scheduledDates: ["2026-10-04"], favorites: [] },
      { id: "pub1", name: "Lantos András", access: "public", scheduledDates: ["2026-09-06", "2026-09-13"], favorites: [] },
    ],
    selectedLeaderId: "own1",
    playlist: [],
    source: null,
    stored: new Map(),
    preferences: new Map(),
    history: {},
    usage: {},
    network: {
      webServerAvailable: true,
      webServerEnabled: true,
      clientUrl: "http://192.168.1.20:19740/",
      netDisplayUrl: null,
      localAddresses: ["192.168.1.20"],
      port: 19740,
      lanClientsOnly: true,
      nearbySessionEnabled: true,
      allClientsCanLead: true,
      clients: [{ name: "Tablet", id: "Tablet@1", connected: true, leaderMode: false }],
      discoveredSessions: [],
      followingSession: false,
    },
    ui: {
      view: "full",
      activePanel: "side",
      openDialogs: [],
      editingSong: false,
      selectedSong: null,
      followingSession: false,
      updateAvailable: false,
    },
    account: { username: "tamas", signedIn: true, guest: false },
    displayCount: 2,
    fileResult: { status: "done" },
    confirmAnswer: true,
    confirmations: [],
    calls: [],
    ...overrides,
  };
}

export function fakeHost(state: FakeState): McpHost {
  const info = ({ id, title, language, kind, key }: McpSong) => ({ id, title, language, kind, key });
  const leader = (id: string) => state.leaders.find((candidate) => candidate.id === id);
  const newPlaylistItem = (leaderId: string | null, songId: string): McpPlaylistItem | null => {
    const found = state.songs.find((candidate) => candidate.id === songId);
    if (!found) return null;
    const preference = leaderId ? state.preferences.get(`${leaderId}/${songId}`) : undefined;
    return { songId, title: found.title, transpose: 0, capo: -1, instructions: "", ...preference };
  };
  return {
    appVersion: () => "9.9.9",
    platform: () => "test",
    language: () => "en",
    account: () => state.account,
    getSettings: () => state.settings as Settings,
    updateSettings: async (patch) => {
      Object.assign(state.settings, patch);
    },
    songCount: () => state.songs.length,
    listSongs: () => state.songs.map(info),
    getSong: (id) => state.songs.find((candidate) => candidate.id === id) ?? null,
    getSongHistory: async (id) => {
      state.calls.push(`history:${id}`);
      return state.history[id] ?? { versions: [] };
    },
    searchSongs: async (query) =>
      state.songs
        .filter((candidate) => candidate.title.toLowerCase().includes(query.toLowerCase()))
        .map((candidate) => ({ song: info(candidate), reason: "TITLE" })),
    analyzeChordPro: () => ({ title: "", kind: "music", sectionCount: 1 }),
    chordStatus,
    knownChordTypes,
    importerChord,
    importerConventions,
    gridChords,
    importSongText: (fileName) => {
      state.calls.push(`import:${fileName}`);
      return true;
    },
    listLeaders: () => state.leaders,
    selectedLeader: () => {
      const selected = state.selectedLeaderId ? leader(state.selectedLeaderId) : undefined;
      return selected ? { id: selected.id, name: selected.name } : null;
    },
    selectLeader: (id) => {
      state.selectedLeaderId = id;
    },
    getSongUsage: (leaderId) => state.usage[leaderId] ?? [],
    songKey: (songId, transpose) => {
      const key = state.songs.find((candidate) => candidate.id === songId)?.key ?? "";
      return key && transpose ? `${key}+${transpose}` : key;
    },
    newPlaylistItem,
    getStoredPlaylist: (leaderId, ref) => state.stored.get(storedKey(leaderId, ref)) ?? null,
    storePlaylist: (leaderId, ref, items, overwrite) => {
      if (leader(leaderId)?.access !== "own") return "read-only";
      if ("favorite" in ref && (!ref.favorite.trim() || ref.favorite.includes("/"))) return "invalid-name";
      const key = storedKey(leaderId, ref);
      if (state.stored.has(key) && !overwrite) return "exists";
      state.stored.set(key, { name: "date" in ref ? ref.date.replace(/-/g, ".") : ref.favorite, items });
      return "saved";
    },
    getPlaylist: () => ({ items: state.playlist, selectedIndex: -1, source: state.source, readOnly: state.ui.followingSession }),
    replacePlaylist: async (items) => {
      state.calls.push("replace");
      state.playlist = items;
      state.source = null;
    },
    editPlaylist: async (items, sources) => {
      state.calls.push(`edit:${sources.map((source) => (source === null ? "new" : source)).join(",")}`);
      state.playlist = items;
    },
    loadStoredPlaylist: async (leaderId, ref) => {
      const stored = state.stored.get(storedKey(leaderId, ref));
      if (!stored) return false;
      state.playlist = stored.items.map((item) => ({ ...item }));
      state.source = { leaderId, leader: leader(leaderId)!.name, ...ref };
      return true;
    },
    saveWorkingPlaylist: (leaderId, ref) => {
      if (leader(leaderId)?.access !== "own") return "read-only";
      state.stored.set(storedKey(leaderId, ref), {
        name: "date" in ref ? ref.date : ref.favorite,
        items: state.playlist.map((item) => ({ ...item })),
      });
      state.source = { leaderId, leader: leader(leaderId)!.name, ...ref };
      return "saved";
    },
    loadPlaylistFile: async () => {
      state.calls.push("file:load");
      return state.fileResult;
    },
    savePlaylistFile: async () => {
      state.calls.push("file:save");
      return state.fileResult;
    },
    getProjection: async () => ({ songId: "", title: "", sectionIndex: -1, sections: [], transpose: 0, capo: -1, projectorOpen: false }),
    showSong: async (id) => {
      state.calls.push(`show:${id}`);
      return "tree";
    },
    selectSection: () => true,
    sectionCommand: (command) => {
      state.calls.push(`section:${command}`);
      return true;
    },
    getNetworkStatus: async () => state.network,
    openView: (target, page) => {
      state.calls.push(`open:${target}${page ? `:${page}` : ""}`);
      return true;
    },
    getUiState: () => state.ui,
    getDisplayInfo: async () => ({ displayCount: state.displayCount, projectorDisplaySelected: true, projectorOpen: false }),
    showInApp: async (id) => (id === "full/playlist" ? "shown" : "unknown"),
    confirm: async (_title, message) => {
      state.confirmations.push(message);
      return state.confirmAnswer;
    },
  };
}
