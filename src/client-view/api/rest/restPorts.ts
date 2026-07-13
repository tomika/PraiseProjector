/**
 * REST sub-port factories. Each function builds one ClientApi sub-port bound to
 * a shared {@link RestCore} instance, mapping the port operations onto the
 * existing {@link cloudApi} surface (the same endpoints the legacy
 * praiseprojector.ts client and the Electron embedded webserver already speak).
 *
 * No new server-side functionality is introduced here — this is the port-ified
 * form of the REST behaviour the legacy client already implements.
 */

import { cloudApi } from "../../../../common/cloudApi";
import { getLocalBroadcastAddresses } from "../../../services/hostDevicePpd";
import { isErrorResponse } from "../../../../common/pp-utils";
import type { Display, OnlineSessionEntry, PlaylistEntry } from "../../../../common/pp-types";
import type { LicenseSection } from "../../../about-licenses";
import type { AuthApi, DeviceApi, DisplayApi, PlaylistApi, SessionApi, SessionFeatureKey, SongApi } from "../ClientApi";
import type { RestCore } from "./RestCore";
import { saveSessionFeatureSetting } from "../sessionFeatureSettings";
import { filterOwnSessionEntries } from "../../../shared/sessionList";

const TOKEN_KEY = "sessionId";

function storeToken(token: string, keep: boolean): void {
  try {
    const ls = window.localStorage;
    const ss = window.sessionStorage;
    if (token) {
      if (keep) ls?.setItem(TOKEN_KEY, token);
      else ss?.setItem(TOKEN_KEY, token);
    } else {
      ls?.removeItem(TOKEN_KEY);
      ss?.removeItem(TOKEN_KEY);
    }
  } catch {
    /* storage may be unavailable (private mode); auth still works for the session */
  }
}

function readToken(): string {
  try {
    return window.sessionStorage?.getItem(TOKEN_KEY) || window.localStorage?.getItem(TOKEN_KEY) || "";
  } catch {
    return "";
  }
}

/** Push the current song / section / preference state to the backend — WITHOUT
 *  the working playlist. Pushes only when the current context permits control (a
 *  cloud leader, or a host-authorized served client); a follower/viewer updates
 *  its local display but never pushes.
 *
 *  The playlist is deliberately omitted: the Electron host's webserver routes a
 *  display_update that carries a playlist to the playlist-ONLY branch
 *  (App.tsx remoteDisplayUpdateHandler), so bundling the playlist here would make
 *  every song/section change a silent no-op on a served host (it answers DONE but
 *  never moves the projection). Playlist changes go through {@link pushPlaylist}.
 *  This mirrors the legacy client, which sent song/preference updates and playlist
 *  updates as separate POSTs. */
async function pushDisplay(core: RestCore, display: Display): Promise<void> {
  if (!core.canControlDisplay()) return;
  await cloudApi.sendDisplayUpdate({
    songId: display.songId,
    from: display.from,
    to: display.to,
    section: display.section,
    sectionRepeatCounts: display.sectionRepeatCounts,
    sectionRepeatNonce: display.sectionRepeatNonce,
    transpose: display.transpose,
    leaderId: core.leader?.id ?? core.config.leaderId,
    song: display.song,
    message: display.message,
    instructions: display.instructions,
  });
}

/** Push a single changed transpose/capo preference as a MINIMAL id+value
 *  /display_update (legacy preferenceUpdate). Sent only on finalize (picker
 *  close) and only when this context may control the display — a follower keeps
 *  its capo purely local and never pushes. Kept separate from {@link pushDisplay}
 *  so transpose can reach 0 and capo is actually sent (sendDisplayUpdate does
 *  neither). */
async function pushPreference(core: RestCore, pref: { transpose?: number; capo?: number }): Promise<void> {
  if (!core.canControlDisplay()) return;
  await cloudApi.sendDisplayPreference({
    id: core.getDisplay().songId,
    ...pref,
    leaderId: core.leader?.id ?? core.config.leaderId,
  });
}

/** Push the working playlist as a playlist-only update (legacy
 *  sendPlaylistUpdateRequest). The current song/section fields are carried along so
 *  the cloud session keeps its highlight, but a served host treats it purely as a
 *  playlist change. */
async function pushPlaylist(core: RestCore, playlist: PlaylistEntry[]): Promise<void> {
  if (!core.canControlDisplay()) return;
  const display = core.getDisplay();
  await cloudApi.sendDisplayUpdate({
    songId: display.songId,
    from: display.from,
    to: display.to,
    section: display.section,
    transpose: display.transpose,
    leaderId: core.leader?.id ?? core.config.leaderId,
    playlist,
    song: "",
  });
}

export function createSongApi(core: RestCore): SongApi {
  return {
    searchSongs: (text, options) => cloudApi.searchSongs(text, options?.limit, options?.songIds),
    listAllSongs: async () => {
      const songs = await cloudApi.fetchAllSongs();
      core.songListEvents.emit(songs);
      return songs;
    },
    getSongData: (songId) => core.loadSongData(songId),
    subscribeSongList: (callback) => core.songListEvents.add(callback),
    checkEditable: (songId) => cloudApi.checkEditable(songId),
    suggestSong: async (songId, version, chordPro) => {
      await cloudApi.suggestSong(songId, version, chordPro);
    },
    fetchPendingCount: () => cloudApi.fetchPendingSongsCount(),
  };
}

export function createPlaylistApi(core: RestCore): PlaylistApi {
  const applyPlaylist = async (entries: PlaylistEntry[]) => {
    core.setPlaylist(entries);
    core.patchDisplay({ playlist: entries });
    await pushPlaylist(core, entries);
  };
  const entriesForLeader = async (leaderId: string, label?: string) => {
    const profiles = await cloudApi.fetchLeadersProfiles();
    const profile = profiles.find((p) => p.leaderId === leaderId);
    const playlist = label != null ? profile?.playlists.find((pl) => pl.label === label) : profile?.playlists[0];
    return playlist?.songs ?? [];
  };
  return {
    getPlaylist: () => core.getPlaylist(),
    setPlaylist: async (entries) => applyPlaylist(entries),
    clear: async () => applyPlaylist([]),
    getLeaderPlaylists: () => cloudApi.fetchLeadersProfiles(),
    selectLeaderPlaylist: (leaderId, label) => entriesForLeader(leaderId, label),
    replaceCurrentWithSelected: async (leaderId, label) => applyPlaylist(await entriesForLeader(leaderId, label)),
    upload: async (options) =>
      cloudApi.storeList(!!options?.forced, {
        label: options?.label ?? "",
        scheduled: options?.scheduled ? options.scheduled.getTime() : 0,
        songs: core.getPlaylist().map((entry) => ({
          songId: entry.songId,
          title: entry.title,
          transpose: entry.transpose,
          capo: entry.capo,
          instructions: entry.instructions,
        })),
      }),
    subscribePlaylist: (callback) => core.playlistEvents.add(callback),
  };
}

export function createDisplayApi(core: RestCore): DisplayApi {
  const pushCurrent = () => pushDisplay(core, core.getDisplay());
  return {
    getCurrent: () => core.getDisplay(),
    project: async (request) => {
      const data = await core.loadSongData(request.songId);
      core.setDisplay({
        ...core.getDisplay(),
        songId: request.songId,
        song: data.text,
        system: data.system,
        from: request.from ?? 0,
        to: request.to ?? 0,
        section: request.section,
        transpose: request.transpose ?? 0,
        capo: request.capo,
        instructions: request.instructions,
      });
      await pushCurrent();
    },
    highlight: async (from, to, section) => {
      // Reflect the highlight locally so this client's own song view updates.
      core.patchDisplay({ from, to, section });
      // Push it through the legacy line-selection channel (`/highlight`), NOT a
      // full display_update. The Electron host's local webserver only moves the
      // projected section from `/highlight?line=…`; a display_update that carries
      // the follower's playlist is treated as a playlist-only update and never
      // changes the projected section. The cloud `/highlight` reads from/to/section
      // (it ignores `line`), so send both forms. Clearing the highlight (0,0) maps
      // to line=-1, mirroring legacy onLineSel(-1).
      const clearing = from === 0 && to === 0;
      await cloudApi.sendHighlight({
        line: clearing ? -1 : from,
        from,
        to,
        section,
        leader: core.leader?.id ?? core.config.leaderId ?? "",
        deviceId: core.clientId,
      });
    },
    setTranspose: async (value, commit) => {
      // Reflect it locally for a live preview on every detent; only push the
      // finalized value (picker close) — and as a minimal id+transpose update.
      core.patchDisplay({ transpose: value });
      if (commit) await pushPreference(core, { transpose: value });
    },
    setCapo: async (value, commit) => {
      core.patchDisplay({ capo: value });
      if (commit) await pushPreference(core, { capo: value });
    },
    setInstructions: async (instructions) => {
      core.patchDisplay({ instructions });
      await pushCurrent();
    },
    pushToFollowers: (display) => pushDisplay(core, display),
    subscribeDisplay: (callback) => core.displayEvents.add(callback),
  };
}

/**
 * Attach to a session picked from the discovery list, dispatching by its url SCHEME
 * (legacy found-session selector, praiseprojector.ts:4934-4980 / sessionKind):
 *  - an http(s) url → a LAN webserver: open it in a browser;
 *  - a udp:// or nrb:// url, or NO url → follow it ({@link RestCore.watch} picks the
 *    PPD transport for a locally-discovered peer, else a cloud long-poll).
 * Keying off the scheme (not "is it a discovered peer") is what makes a PPD host that
 * runs no webserver follow over UDP instead of opening a (non-existent) http endpoint.
 */
async function attachSession(core: RestCore, session: OnlineSessionEntry): Promise<void> {
  const url = session.localUrl;
  if (url && /^https?:\/\//i.test(url)) {
    if (typeof window !== "undefined") window.open(url, "_blank");
    return;
  }
  await core.watch(session);
}

export function createSessionApi(core: RestCore): SessionApi {
  const setFeatureEnabled = async (key: SessionFeatureKey, enabled: boolean) => {
    saveSessionFeatureSetting(key, enabled);
    core.refreshCapabilities();
  };
  return {
    scanLocalServers: (address) => core.scanLocal(address),
    scanAddresses: () => getLocalBroadcastAddresses(),
    searchExternal: async (mode) => {
      const results: OnlineSessionEntry[] = [];
      if (mode === "WEB" || mode === "BOTH") {
        try {
          results.push(...filterOwnSessionEntries(await cloudApi.fetchOnlineSessions(), core.leader?.id));
        } catch {
          /* cloud unreachable — surface whatever local discovery found */
        }
      }
      if (mode === "NEARBY" || mode === "BOTH") {
        results.push(...core.collectLocalSessions());
      }
      core.sessionEvents.emit(results);
      return results;
    },
    startLocal: () => core.startLocalHost(),
    stopLocal: () => core.stopLocalHost(),
    setFeatureEnabled,
    createOnline: async (leaderId) => {
      // Force-register the cloud session now (user-chosen): a /display_update carrying
      // the leader id upserts the sessions row, so the leader appears for followers at
      // once rather than only on the next project. Cloud hosting lives within App mode.
      core.config = { ...core.config, leaderId: leaderId ?? core.leader?.id };
      await pushDisplay(core, core.getDisplay());
      // Seed the freshly-registered cloud session with the working playlist so
      // followers see it immediately (pushDisplay no longer carries the list).
      if (core.getPlaylist().length) await pushPlaylist(core, core.getPlaylist());
      core.setNetworkState({ status: "leading" });
    },
    watch: (session) => core.watch(session),
    attach: (session) => attachSession(core, session),
    stopWatching: async () => {
      core.stopFollow();
      core.setNetworkState({ status: "online" });
    },
    reconnect: () => core.reconnect(),
    netDisplayUrl: () => core.netDisplayUrl(),
    subscribeNetworkState: (callback) => core.networkEvents.add(callback),
    subscribeSessions: (callback) => core.sessionEvents.add(callback),
  };
}

export function createAuthApi(core: RestCore): AuthApi {
  const applyLeader = (login: string, leaderId: string | undefined): void => {
    core.setAuthed(true, { id: leaderId ?? login, name: login });
  };
  return {
    isAuthed: () => cloudApi.isAuthed(),
    currentLeader: () => core.leader,
    login: async (user, password, keepLoggedIn) => {
      cloudApi.setFixedHeader("X-PP-Expected-User", "");
      try {
        cloudApi.setToken(null);
        await cloudApi.logoutSession(core.clientId);
      } catch {
        /* clearing stale auth before an explicit login is best-effort */
      }
      cloudApi.setToken("Basic " + btoa(user + ":" + password));
      const res = await cloudApi.fetchSession(core.clientId, { skipRefresh: true });
      if (isErrorResponse(res)) throw new Error(String(res.error));
      cloudApi.setToken("Bearer " + res.token);
      storeToken(res.token, keepLoggedIn);
      applyLeader(res.login, res.leaderId);
    },
    logout: async () => {
      try {
        await cloudApi.logoutSession(core.clientId);
      } catch {
        /* network errors during logout are non-fatal */
      } finally {
        cloudApi.setToken(null);
        storeToken("", false);
        core.setAuthed(false, null);
      }
    },
    restoreSession: async () => {
      const token = readToken();
      if (!token) {
        cloudApi.setToken(null);
        return;
      }
      cloudApi.setToken("Bearer " + token);
      try {
        const res = await cloudApi.fetchSession(core.clientId, { skipRefresh: true });
        if (isErrorResponse(res)) throw new Error(String(res.error));
        if (res.token) cloudApi.setToken("Bearer " + res.token);
        applyLeader(res.login, res.leaderId);
      } catch {
        cloudApi.setToken(null);
        storeToken("", false);
        core.setAuthed(false, null);
      }
    },
    requestHighlightPermission: async (verifyOnly) => {
      const leaderId = core.leader?.id ?? core.config.leaderId ?? "";
      const result = await cloudApi.fetchHighlightPermission(leaderId, core.clientId, !!verifyOnly);
      return result === "GRANTED";
    },
    subscribeAuth: (callback) => core.authEvents.add(callback),
  };
}

export function createDeviceApi(): DeviceApi {
  const prefKey = (key: string) => "pp-pref-" + key;
  const parseLicenseSections = (raw: string): LicenseSection[] => {
    if (!raw) return [];
    try {
      const parsed = JSON.parse(raw) as unknown;
      return Array.isArray(parsed) ? (parsed as LicenseSection[]) : [];
    } catch {
      return [];
    }
  };
  const device: DeviceApi = {
    isFullScreen: () => {
      const native = window.hostDevice?.isFullScreen?.();
      return typeof native === "boolean" ? native : !!document.fullscreenElement;
    },
    toggleFullScreen: async () => {
      const hostDevice = window.hostDevice;
      if (hostDevice?.setFullScreen) {
        const current = hostDevice.isFullScreen ? !!(await hostDevice.isFullScreen()) : false;
        return !!(await hostDevice.setFullScreen(!current));
      }
      try {
        if (document.fullscreenElement) {
          await document.exitFullscreen();
          return false;
        }
        await document.documentElement.requestFullscreen();
        return true;
      } catch {
        return !!document.fullscreenElement;
      }
    },
    keepScreenOn: (enabled) => {
      void window.hostDevice?.keepScreenOn?.(enabled);
    },
    getPreference: (key) => {
      try {
        return window.localStorage?.getItem(prefKey(key)) ?? undefined;
      } catch {
        return undefined;
      }
    },
    setPreference: (key, value) => {
      try {
        window.localStorage?.setItem(prefKey(key), value);
      } catch {
        /* ignore storage errors (private mode / quota) */
      }
    },
    share: (url, title, text) => {
      const hostDevice = window.hostDevice;
      if (hostDevice?.share) {
        void hostDevice.share(url, title ?? "", text ?? "");
        return true;
      }
      if (navigator.share) {
        void navigator.share({ url, title, text });
        return true;
      }
      return false;
    },
    openExternal: (url) => {
      const hostDevice = window.hostDevice;
      if (hostDevice?.openLinkExternal) {
        void hostDevice.openLinkExternal(url);
        return;
      }
      window.open(url, "_blank", "noopener");
    },
    getThirdPartyLicenseSections: async () => {
      const raw = await Promise.resolve(window.hostDevice?.getThirdPartyLicenseSections?.() ?? "");
      return typeof raw === "string" ? parseLicenseSections(raw) : [];
    },
    goHome: () => {
      void window.hostDevice?.goHome?.();
    },
  };
  if (window.hostDevice?.exit) {
    device.exit = () => {
      void window.hostDevice?.exit?.();
    };
  }
  return device;
}
