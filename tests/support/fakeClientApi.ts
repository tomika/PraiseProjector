/**
 * A controllable {@link ClientApi} for store-level tests. It replaces only the
 * backend port: every outgoing call is recorded, every subscription can be
 * driven from the test, and promises can be held back to simulate slow replies.
 */
import { getEmptyDisplay } from "../../common/pp-utils";
import type { Display, PlaylistEntry, SongEntry } from "../../common/pp-types";
import {
  NO_CAPABILITIES,
  type ClientApi,
  type ClientCapabilities,
  type ClientMode,
  type NetworkState,
  type Unsubscribe,
} from "../../src/client-view/api/ClientApi";

export interface RecordedCall {
  method: string;
  args: unknown[];
}

export interface FakeClientApiOptions {
  mode?: ClientMode;
  capabilities?: Partial<ClientCapabilities>;
  /** The backend's projected display (what `display.getCurrent()` returns). */
  display?: Partial<Display>;
  songs?: SongEntry[];
  playlist?: PlaylistEntry[];
  /** Whether the device adapter reports full screen after a toggle. */
  fullScreenResult?: boolean;
  preferences?: Record<string, string>;
}

class Channel<T> {
  private readonly listeners = new Set<(value: T) => void>();
  constructor(private current: T | undefined = undefined) {}
  subscribe = (listener: (value: T) => void): Unsubscribe => {
    this.listeners.add(listener);
    if (this.current !== undefined) listener(this.current);
    return () => this.listeners.delete(listener);
  };
  subscribeLazy = (listener: (value: T) => void): Unsubscribe => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };
  emit(value: T): void {
    this.current = value;
    for (const listener of [...this.listeners]) listener(value);
  }
  get size(): number {
    return this.listeners.size;
  }
}

export interface FakeClientApi {
  api: ClientApi;
  calls: RecordedCall[];
  callsTo(method: string): unknown[][];
  /** The display the backend currently projects. */
  projected: Display;
  emitDisplay(display: Display): void;
  emitCapabilities(capabilities: Partial<ClientCapabilities>): void;
  emitNetwork(state: NetworkState): void;
  /** Holds every following `display.setTranspose/setCapo` call until released. */
  holdDisplayWrites(): () => void;
}

export function createFakeClientApi(options: FakeClientApiOptions = {}): FakeClientApi {
  const calls: RecordedCall[] = [];
  const record = (method: string, ...args: unknown[]): void => {
    calls.push({ method, args });
  };
  let capabilities: ClientCapabilities = { ...NO_CAPABILITIES, ...options.capabilities };
  const fake = {
    projected: { ...getEmptyDisplay(), ...options.display } as Display,
  };
  const displayChannel = new Channel<Display>();
  const capabilityChannel = new Channel<ClientCapabilities>(capabilities);
  const networkChannel = new Channel<NetworkState>({ status: "online" } as NetworkState);
  let holding: Promise<void> | null = null;
  const gate = async () => {
    if (holding) await holding;
  };
  const songs = options.songs ?? [];
  let playlist = options.playlist ?? [];
  // Like the real adapters, a written playlist comes back through the subscription.
  const playlistChannel = new Channel<PlaylistEntry[]>();
  let fullScreen = false;

  const api: ClientApi = {
    mode: options.mode ?? "App",
    storageScope: "local",
    init: async (config) => record("init", config),
    dispose: () => record("dispose"),
    getCapabilities: () => capabilities,
    subscribeCapabilities: capabilityChannel.subscribe,
    setLeaderMode: (enabled) => record("setLeaderMode", enabled),
    song: {
      searchSongs: async (text) => (record("song.searchSongs", text), []),
      listAllSongs: async () => songs,
      getSongData: async (songId) => (record("song.getSongData", songId), { text: `{title:${songId}}\n[C]la`, system: "G" }),
      subscribeSongList: (callback) => new Channel<SongEntry[]>().subscribeLazy(callback),
      checkEditable: async () => false,
      suggestSong: async () => undefined,
      fetchPendingCount: async () => 0,
    },
    playlist: {
      getPlaylist: () => playlist,
      setPlaylist: async (entries) => {
        record("playlist.setPlaylist", entries);
        playlist = entries;
        playlistChannel.emit(entries);
      },
      clear: async () => record("playlist.clear"),
      getLeaderPlaylists: async () => [],
      selectLeaderPlaylist: async () => [],
      replaceCurrentWithSelected: async () => undefined,
      upload: async () => "",
      subscribePlaylist: playlistChannel.subscribeLazy,
    },
    display: {
      getCurrent: () => fake.projected,
      project: async (request, options) => {
        // Like the adapters: a superseded projection changes nothing.
        if (options?.isCurrent?.() === false) return;
        record("display.project", request);
        fake.projected = { ...fake.projected, songId: request.songId, transpose: request.transpose ?? 0, capo: request.capo };
      },
      highlight: async (from, to, section) => record("display.highlight", from, to, section),
      setTranspose: async (value, commit) => {
        record("display.setTranspose", value, commit);
        await gate();
      },
      setCapo: async (value, commit) => {
        record("display.setCapo", value, commit);
        await gate();
      },
      setInstructions: async (instructions) => record("display.setInstructions", instructions),
      pushToFollowers: async (display) => record("display.pushToFollowers", display),
      subscribeDisplay: displayChannel.subscribeLazy,
    },
    session: {
      scanLocalServers: async () => [],
      localNetworkAddresses: async () => [],
      scanAddresses: async () => ({ options: [] }),
      searchExternal: async () => [],
      startLocal: async () => record("session.startLocal"),
      stopLocal: async () => record("session.stopLocal"),
      setFeatureEnabled: async (key, enabled) => record("session.setFeatureEnabled", key, enabled),
      createOnline: async () => record("session.createOnline"),
      watch: async (session) => record("session.watch", session),
      attach: async (session) => record("session.attach", session),
      stopWatching: async () => record("session.stopWatching"),
      reconnect: async () => record("session.reconnect"),
      netDisplayUrl: () => "",
      subscribeNetworkState: networkChannel.subscribe,
      subscribeConnectedClients: (callback) => new Channel<boolean>(false).subscribe(callback),
      subscribeSessions: (callback) => new Channel<never[]>().subscribeLazy(callback),
    },
    auth: {
      isAuthed: () => false,
      currentLeader: () => null,
      login: async () => record("auth.login"),
      logout: async () => record("auth.logout"),
      restoreSession: async () => undefined,
      requestHighlightPermission: async (verifyOnly) => (record("auth.requestHighlightPermission", verifyOnly), false),
      subscribeAuth: (callback) => new Channel<boolean>().subscribeLazy(callback),
    },
    device: {
      isFullScreen: () => fullScreen,
      toggleFullScreen: async () => {
        record("device.toggleFullScreen");
        fullScreen = options.fullScreenResult ?? !fullScreen;
        return fullScreen;
      },
      keepScreenOn: () => undefined,
      getPreference: (key) => options.preferences?.[key],
      setPreference: (key, value) => record("device.setPreference", key, value),
      share: () => false,
      openExternal: (url) => record("device.openExternal", url),
      getThirdPartyLicenseSections: async () => [],
      getDeviceInfo: async () => null,
      goHome: () => record("device.goHome"),
    },
  };

  return {
    api,
    calls,
    callsTo: (method) => calls.filter((call) => call.method === method).map((call) => call.args),
    get projected() {
      return fake.projected;
    },
    set projected(display: Display) {
      fake.projected = display;
    },
    emitDisplay: (display) => {
      fake.projected = display;
      displayChannel.emit(display);
    },
    emitCapabilities: (next) => {
      capabilities = { ...capabilities, ...next };
      capabilityChannel.emit(capabilities);
    },
    emitNetwork: (state) => networkChannel.emit(state),
    holdDisplayWrites: () => {
      let release = () => {};
      holding = new Promise<void>((resolve) => (release = resolve));
      return () => {
        holding = null;
        release();
      };
    },
  };
}
