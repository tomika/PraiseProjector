/** An in-memory McpHost for the tool and protocol tests. */
import type { Settings } from "../../../types";
import { chordStatus, gridChords, importerChord, importerConventions, knownChordTypes } from "../appChords";
import { estimateSongKey } from "../songKey";
import { analyzeInstructions, songStructure } from "../songStructure";
import type {
  McpFileResult,
  McpHost,
  McpLeader,
  McpNetworkStatus,
  McpPlaylistItem,
  McpPlaylistSource,
  McpSong,
  McpSongHistory,
  McpSongInfo,
  McpSongPreference,
  McpSongPreferenceType,
  McpSongUsage,
  McpStoredPlaylistRef,
  McpSyncPending,
  McpUiState,
} from "../types";
import { McpToolError } from "../types";

export interface FakeState {
  settings: Partial<Settings>;
  songs: McpSong[];
  leaders: McpLeader[];
  selectedLeaderId: string | null;
  databaseIdentity: object | null;
  playlistId: string;
  playlist: McpPlaylistItem[];
  /** The working list's source (what the app remembers it was loaded from or saved to). */
  source: McpPlaylistSource | null;
  /** Stored lists by `leaderId/date` or `leaderId/★name`. */
  stored: Map<string, { name: string; items: McpPlaylistItem[] }>;
  /** Leader song preferences by `leaderId/songId`. */
  preferences: Map<string, Partial<Omit<McpPlaylistItem, "songId">> & { type?: McpSongPreferenceType }>;
  preferenceSaveFailures: number;
  syncPending: McpSyncPending;
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
  state: { marked: !!/^# notes:(.*)$/m.exec(text)?.[1].trim(), changedLocally: false, preference: null },
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
    databaseIdentity: {},
    playlistId: "working",
    playlist: [],
    source: null,
    stored: new Map(),
    preferences: new Map(),
    preferenceSaveFailures: 0,
    syncPending: { songs: 0, profiles: 0, needsSync: false },
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
      songList: null,
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
  const pendingPreferenceSaves = new WeakSet<object>();
  const info = ({ id, title, language, kind, key, state, version }: McpSong): McpSongInfo => ({
    id,
    title,
    language,
    kind,
    key,
    state: { ...state, changedLocally: version === 0 },
  });
  const leader = (id: string) => state.leaders.find((candidate) => candidate.id === id);
  const newPlaylistItem = (leaderId: string | null, songId: string): McpPlaylistItem | null => {
    const found = state.songs.find((candidate) => candidate.id === songId);
    if (!found) return null;
    const preference = leaderId ? state.preferences.get(`${leaderId}/${songId}`) : undefined;
    return {
      songId,
      title: preference?.title || found.title,
      transpose: preference?.transpose ?? 0,
      capo: preference?.capo ?? -1,
      instructions: preference?.instructions ?? "",
    };
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
    getSyncPending: () => (state.databaseIdentity ? state.syncPending : null),
    listSongs: () => state.songs.map(info),
    getSong: (id) => {
      const found = state.songs.find((candidate) => candidate.id === id);
      return found ? { ...found, ...info(found) } : null;
    },
    getSongHistory: async (id) => {
      state.calls.push(`history:${id}`);
      return state.history[id] ?? { versions: [] };
    },
    searchSongs: async (query, _leaderId, songIds) => {
      const eligible = songIds ? new Set(songIds) : null;
      const matched = state.songs.filter(
        (candidate) => (!eligible || eligible.has(candidate.id)) && candidate.title.toLowerCase().includes(query.toLowerCase())
      );
      const limit = state.settings.searchMaxResults ?? 0;
      return (limit > 0 ? matched.slice(0, limit) : matched).map((candidate) => ({ song: info(candidate), reason: "TITLE" }));
    },
    analyzeChordPro: (text, system) => ({
      title: "",
      kind: "music",
      sectionCount: 1,
      repeatedSections: songStructure(text, system).repeatedSections,
      keyEstimate: estimateSongKey(text, system),
    }),
    songStructure: (id) => {
      const found = state.songs.find((candidate) => candidate.id === id);
      return found ? songStructure(found.text, found.system) : null;
    },
    songKeyEstimate: (id) => {
      const found = state.songs.find((candidate) => candidate.id === id);
      return found ? estimateSongKey(found.text, found.system) : null;
    },
    analyzeInstructions: (id, instructions) => {
      const found = state.songs.find((candidate) => candidate.id === id);
      return found ? analyzeInstructions(found.text, found.system, instructions) : null;
    },
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
    getSongPreferences: (leaderId, songIds) => {
      const preferences: Record<string, McpSongPreference> = Object.create(null);
      for (const songId of songIds) {
        const entry = state.preferences.get(`${leaderId}/${songId}`);
        if (!entry) continue;
        const { title = "", transpose = 0, capo = -1, type = "neutral", instructions = "" } = entry;
        if (type !== "neutral" || title || transpose || capo >= 0 || instructions) {
          preferences[songId] = { title, transpose, capo, type, hasInstructions: !!instructions };
        }
      }
      return preferences;
    },
    setSongPreferences: async (leaderId, changedIds, type) => {
      const db = state.databaseIdentity;
      if (!db || (!changedIds.length && !pendingPreferenceSaves.has(db))) return;
      for (const id of changedIds) {
        const key = `${leaderId}/${id}`;
        const { type: _oldType, ...overrides } = state.preferences.get(key) ?? {};
        if (type === "neutral" && !Object.keys(overrides).length) state.preferences.delete(key);
        else state.preferences.set(key, { ...overrides, ...(type === "neutral" ? {} : { type }) });
      }
      state.calls.push("preferences:save");
      if (state.preferenceSaveFailures > 0) {
        state.preferenceSaveFailures--;
        pendingPreferenceSaves.add(db);
        throw new McpToolError("Saving failed; retry the same set_song_preference request.", "SAVE_FAILED");
      }
      pendingPreferenceSaves.delete(db);
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
    databaseIdentity: () => state.databaseIdentity,
    getPlaylist: () => ({
      items: state.playlist,
      selectedIndex: -1,
      source: state.source,
      readOnly: state.ui.followingSession,
      editContext: { panel: state, leader: state.selectedLeaderId, playlistId: state.playlistId, origin: JSON.stringify(state.source) },
    }),
    replacePlaylist: async (items) => {
      state.calls.push("replace");
      state.playlist = items;
      state.source = null;
      state.playlistId += "!";
    },
    editPlaylist: async (items, sources, storeInstructions = []) => {
      state.calls.push(`edit:${sources.map((source) => (source === null ? "new" : source)).join(",")}`);
      state.playlist = items;
      for (const index of storeInstructions) {
        const key = `${state.selectedLeaderId}/${items[index].songId}`;
        state.preferences.set(key, { ...state.preferences.get(key), instructions: items[index].instructions });
      }
    },
    loadStoredPlaylist: async (leaderId, ref) => {
      const stored = state.stored.get(storedKey(leaderId, ref));
      if (!stored) return false;
      state.playlist = stored.items.map((item) => ({ ...item }));
      state.source = { leaderId, leader: leader(leaderId)!.name, ...ref };
      state.playlistId += "!";
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
    getProjection: async () => ({
      songId: "",
      title: "",
      sectionIndex: -1,
      sections: [],
      transpose: 0,
      capo: -1,
      instructions: "",
      projectInstructions: state.settings.projectInstructions === true,
      projectorOpen: false,
    }),
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
