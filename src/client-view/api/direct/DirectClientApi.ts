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
import { getCurrentDisplay, subscribeCurrentDisplayChange, updateCurrentDisplay } from "../../../state/CurrentSongStore";
import { getSharedSongFilter, setSharedSongFilter, subscribeSharedSongFilter } from "../../../state/SongFilterStore";
import { isHostDevicePpdAvailable, startHostDevicePpdHosting, stopHostDevicePpdHosting } from "../../../services/hostDevicePpd";
import { createDeviceApi } from "../rest/restPorts";
import type {
  AuthApi,
  ClientCapabilities,
  ClientMode,
  DeviceApi,
  DisplayApi,
  NetworkState,
  PlaylistApi,
  SessionApi,
  SongApi,
  SongEntry,
  Unsubscribe,
} from "../ClientApi";
import type { ClientApi } from "../ClientApi";

function toEntry(song: { Id: string; Title: string }): SongEntry {
  return { songId: song.Id, title: song.Title };
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

  readonly song: SongApi = this.createSongApi();
  readonly playlist: PlaylistApi = this.createPlaylistApi();
  readonly display: DisplayApi = this.createDisplayApi();
  readonly session: SessionApi = this.createSessionApi();
  readonly auth: AuthApi = this.createAuthApi();
  readonly device: DeviceApi = createDeviceApi();

  private capabilities: ClientCapabilities = this.computeCapabilities();

  // The embedded desktop view drives the host's live display directly, so control
  // + working-playlist editing are inherently granted. Login / leader selection
  // are not its concern (it IS the host), and it is the Electron renderer, not a
  // PWA. canPersistPlaylist is the one dynamic flag: saving writes to the host's
  // SELECTED leader's local schedule (parity with the desktop app's save), so it
  // is offered only while a leader is selected.
  private computeCapabilities(): ClientCapabilities {
    return {
      // The desktop embed is always the leader; there is no follower/leader toggle.
      leaderModeAvailable: false,
      canControlDisplay: true,
      canEditWorkingPlaylist: true,
      canLogin: false,
      canChangeLeader: false,
      canPersistPlaylist: !!this.getSelectedLeader(),
      // It IS the host — there is nothing external to discover or follow.
      canFollowSessions: false,
      // The desktop renderer has the native host bridge, so it can advertise a local
      // PPD session; online (cloud) hosting needs a login (the session is keyed by the
      // leader id). Mirrors the legacy iconStartSession/iconStartOnlineSession gating.
      canHostLocalSession: isHostDevicePpdAvailable(),
      canHostOnlineSession: this.isExternalWebDisplayEnabled(),
      // The embedded desktop view IS the editor's sibling face; switching back is
      // the home button's job, not a navigation to index.html.
      canOpenFullEditor: false,
      isPwa: false,
      hasHostBridge: true,
    };
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
    try {
      const raw = window.localStorage?.getItem("pp-settings");
      return raw ? !!(JSON.parse(raw) as { externalWebDisplayEnabled?: boolean }).externalWebDisplayEnabled : false;
    } catch {
      return false;
    }
  }

  private refreshHostState = (): void => {
    this.capabilities = this.computeCapabilities();
    for (const cb of this.capabilityListeners) cb(this.capabilities);
    // The selected leader is this embed's effective identity; re-emit it so the
    // store's leader (save-dialog title + scheduled-date lookup) tracks changes.
    const authed = cloudApi.isAuthed();
    for (const cb of this.authListeners) cb(authed);
  };

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

  private createDisplayApi(): DisplayApi {
    // Drive the host app via the SAME event the webserver clients use, so the
    // main UI's selection + preview AND the projector all follow along — not just
    // the shared CurrentSongStore (App.tsx remoteDisplayUpdateHandler).
    const dispatch = (detail: Record<string, unknown>) => {
      window.dispatchEvent(new CustomEvent("pp-cv-display-update", { detail }));
    };
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
      setTranspose: async (value) => dispatch({ command: "song_update", id: songId(), transpose: value }),
      setCapo: async (value) => dispatch({ command: "song_update", id: songId(), capo: value }),
      setInstructions: async (instructions) => dispatch({ command: "song_update", id: songId(), instructions }),
      pushToFollowers: async () => undefined,
      subscribeDisplay: (callback) => subscribeCurrentDisplayChange(callback),
    };
  }

  private createSongApi(): SongApi {
    const allEntries = () => Database.getInstance().getSongs().map(toEntry);
    return {
      searchSongs: async (text) => {
        const query = text.trim();
        if (!query) return [];
        // Use the SAME Database search the desktop song tree (LeftPanel) uses, so
        // the client gets relevancy ordering (LessCostMatch) AND real per-field
        // match snippets (lyrics/meta excerpts with highlights) — not a naive
        // title-only substring scan that returned the title as the "snippet".
        const results = await Database.getInstance().filter(query, null, true, true, true, SongOrder.LessCostMatch);
        return results.slice(0, 100).map((found) => ({
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
    return {
      getPlaylist: () => getCurrentDisplay().playlist ?? [],
      // forceEmit: the working playlist is stored on the display, but compareDisplays()
      // (which gates emitDisplayChange) does NOT diff `playlist`, so a playlist-only
      // edit would never notify subscribers — the add/remove would silently no-op.
      setPlaylist: async (entries) => updateCurrentDisplay({ playlist: entries }, { forceEmit: true }),
      clear: async () => updateCurrentDisplay({ playlist: [] }, { forceEmit: true }),
      getLeaderPlaylists: async () =>
        Database.getInstance()
          .getLeaders()
          .map((leader) => leader.toJSON()),
      selectLeaderPlaylist: async (leaderId, label) => playlistOf(leaderId, label),
      replaceCurrentWithSelected: async (leaderId, label) => updateCurrentDisplay({ playlist: playlistOf(leaderId, label) }, { forceEmit: true }),
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
      // The embed doesn't discover/follow others — it only HOSTS (start/stop).
      scanLocalServers: async () => [],
      searchExternal: async () => [],
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
      watch: async () => undefined,
      attach: async () => undefined,
      stopWatching: async () => undefined,
      // The embedded desktop view IS the host — there is no remote link to
      // re-establish, so reconnect is a no-op (its indicator is hidden anyway).
      reconnect: async () => undefined,
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

  private createAuthApi(): AuthApi {
    return {
      isAuthed: () => cloudApi.isAuthed(),
      // The embed's "identity" is the host's selected leader (used for the save
      // dialog's title + scheduled-date lookup), not a cloud login.
      currentLeader: () => {
        const leader = this.getSelectedLeader();
        return leader ? { id: leader.id, name: leader.name } : null;
      },
      login: async () => undefined,
      logout: async () => undefined,
      restoreSession: async () => undefined,
      requestHighlightPermission: async () => false,
      subscribeAuth: (callback) => {
        this.authListeners.add(callback);
        callback(cloudApi.isAuthed());
        return () => this.authListeners.delete(callback);
      },
    };
  }
}
