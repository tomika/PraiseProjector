/**
 * REST sub-port factories. Each function builds one ClientApi sub-port bound to
 * a shared {@link RestCore} instance, mapping the port operations onto the
 * existing {@link cloudApi} surface (the same endpoints the legacy
 * praiseprojector.ts client and the Electron embedded webserver already speak).
 *
 * No new server-side functionality is introduced here — this is the port-ified
 * form of the REST behaviour the legacy client already implements.
 */

import { cloudApi, isAccessToken, isCloudApiErrorKind, type DisplayUpdateResult } from "../../../../common/cloudApi";
import {
  getLocalBroadcastAddresses,
  getLocalNetworkAddresses,
  onHostDeviceSessionsChanged,
  shutdownHostDevicePpd,
} from "../../../services/hostDevicePpd";
import { openLanSessionUrl } from "../../../services/sessionNavigation";
import { isErrorResponse } from "../../../../common/pp-utils";
import type { Display, OnlineSessionEntry, PlaylistEntry } from "../../../../common/pp-types";
import type { LicenseSection } from "../../../about-licenses";
import { sortSongEntriesByTitle } from "../ClientApi";
import type { AuthApi, DeviceApi, DeviceInfo, DisplayApi, PlaylistApi, SessionApi, SessionFeatureKey, SongApi } from "../ClientApi";
import type { RestCore } from "./RestCore";
import { saveSessionFeatureSetting } from "../sessionFeatureSettings";
import { filterOwnSessionEntries } from "../../../shared/sessionList";
import { subscribeProjectionClientPresence } from "../../../services/projectionClientPresence";
import { transitionInstructionsPatch } from "../../../services/clientViewDisplayUpdate";

const TOKEN_KEY = "sessionId";

function displayUpdateLeaderId(core: RestCore): string | undefined {
  // In App mode only the authenticated default leader may own cloud publishing.
  // A served Client keeps using the host-provided id for its local control path.
  return core.leader?.id ?? (core.mode === "Client" ? core.config.leaderId : undefined);
}

function storeToken(token: string, keep: boolean, login?: string): void {
  try {
    const ls = window.localStorage;
    const ss = window.sessionStorage;
    ls?.removeItem(TOKEN_KEY);
    ss?.removeItem(TOKEN_KEY);
    ls?.removeItem("sessionLogin");
    ss?.removeItem("sessionLogin");
    if (token) {
      const storage = keep ? ls : ss;
      storage?.setItem(TOKEN_KEY, token);
      if (login) storage?.setItem("sessionLogin", login);
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

// Identity is only an expectation sent to the server, never proof of auth.
function readTokenLogin(token: string): string {
  try {
    const saved = window.sessionStorage?.getItem("sessionLogin") || window.localStorage?.getItem("sessionLogin");
    if (saved) return saved;
    const raw = token.replace(/^Bearer /, "");
    if (!raw.startsWith("atk.")) return "";
    const claims = JSON.parse(atob(raw.split(".")[1].replace(/-/g, "+").replace(/_/g, "/"))) as { sub?: unknown };
    return typeof claims.sub === "string" ? claims.sub : "";
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
  await publishPendingState(core);
  if (core.isFollowingPpd()) {
    await core.sendPpdDisplayUpdate({
      command: "display_update",
      id: display.songId,
      from: display.from,
      to: display.to,
      section: display.section,
      abcRange: display.abcRange,
      sectionRepeatCounts: display.sectionRepeatCounts,
      sectionRepeatNonce: display.sectionRepeatNonce,
      transpose: display.transpose,
      capo: display.capo,
      instructions: display.instructions,
    });
    return;
  }
  const leaderId = displayUpdateLeaderId(core);
  await sendDisplayAndSettle(
    core,
    {
      songId: display.songId,
      from: display.from,
      to: display.to,
      section: display.section,
      abcRange: display.abcRange,
      sectionRepeatCounts: display.sectionRepeatCounts,
      sectionRepeatNonce: display.sectionRepeatNonce,
      transpose: display.transpose,
      song: display.song,
      message: display.message,
      instructions: display.instructions,
    },
    leaderId ? { leaderId } : undefined
  );
}

type DisplayUpdateData = Parameters<typeof cloudApi.sendDisplayUpdate>[0];
type DisplayUpdateOptions = Parameters<typeof cloudApi.sendDisplayUpdate>[1];

/** This App publishes to its own cloud session: not a host-served Client (the
 *  host applies its own rules) and not while it watches another session. */
function publishesOwnCloudSession(core: RestCore): boolean {
  return core.mode === "App" && !core.isFollowing();
}

type SongValues = Pick<
  DisplayUpdateData,
  "from" | "to" | "section" | "abcRange" | "sectionRepeatCounts" | "sectionRepeatNonce" | "transpose" | "capo" | "instructions"
>;

/** Every value of the song `display` shows, as a complete update sends them.
 *  `explicit` values win (an instructions save the display does not show yet). */
function songValuesOf(display: Display, explicit?: Partial<SongValues>): SongValues {
  return {
    from: display.from,
    to: display.to,
    section: display.section,
    abcRange: display.abcRange,
    sectionRepeatCounts: display.sectionRepeatCounts,
    sectionRepeatNonce: display.sectionRepeatNonce,
    transpose: display.transpose,
    capo: display.capo ?? -1,
    instructions: display.instructions ?? "",
    ...explicit,
  };
}

/** The values compared as the backend stores them from a complete update. */
function sameSongValues(a: SongValues, b: SongValues): boolean {
  const key = (v: SongValues) =>
    JSON.stringify([
      v.from,
      v.to,
      v.section ?? null,
      v.abcRange ?? null,
      v.sectionRepeatCounts ?? [],
      v.sectionRepeatNonce ?? null,
      v.transpose ?? 0,
      v.capo ?? -1,
      v.instructions ?? "",
    ]);
  return key(a) === key(b);
}

/** Each follow-up update needs a change made while the previous one was on its
 *  way; past this many the session is left unknown and the next action syncs it. */
const MAX_SESSION_FOLLOW_UPS = 4;
const SESSION_UPDATE_TIMEOUT_MS = 15_000;

/** The own session took the values of `songId` too, not only the update: it shows
 *  them, or a later step owns the session by now and its own push settles it. */
function sessionTookValues(core: RestCore, songId: string): boolean {
  return !publishesOwnCloudSession(core) || core.ownSession.shownSongId() === songId || core.getDisplay().songId !== songId;
}

/** Send a display update and keep the own cloud session on this client's values.
 *
 *  There every update is complete and carries the values this client shows now:
 *  for the song the session already shows, the backend keeps any value it is not
 *  sent (another list row of the same song may have set them). When the update
 *  moved the session to another song, the backend ignored the sent transpose,
 *  capo and instructions (it applies the account's saved song preferences, then
 *  the list row's values) and kept the previous song's section repeats; a
 *  same-song update, which never writes the profile's preferences, then sets
 *  them. A highlight or preference made while an update is on its way stays on
 *  this client ({@link sessionTakesPartialUpdate}), so when the latest update
 *  lands on values this client no longer shows, the current ones follow.
 *
 *  `explicit` values win over the display's. Resolves to the first update's
 *  result: whether the backend took it (and the list it carried). A follow-up
 *  that fails leaves the session unknown, so the next highlight or preference
 *  sends the client's values again (and a pending publish stays pending, see
 *  {@link sessionTookValues}). */
async function sendDisplayAndSettle(
  core: RestCore,
  data: DisplayUpdateData,
  options: DisplayUpdateOptions,
  explicit?: Partial<SongValues>
): Promise<DisplayUpdateResult> {
  if (!publishesOwnCloudSession(core)) return cloudApi.sendDisplayUpdate(data, options);
  if (!data.songId) return cloudApi.sendDisplayUpdate(data, { ...options, ordered: true });
  const session = core.ownSession;
  const songId = data.songId;
  // A step made while this push waited for the pending publish shows another
  // song: its own push follows, so this one only keeps the order.
  const current = core.getDisplay().songId === songId;
  let request: DisplayUpdateData = current ? { ...data, ...songValuesOf(core.getDisplay(), explicit) } : data;
  // The backend applies the sent values only to the song it already shows.
  let applies = session.shownSongId() === songId;
  let first: DisplayUpdateResult | undefined;
  for (let followUps = 0; ; followUps++) {
    const update = session.begin();
    let result: DisplayUpdateResult;
    try {
      // Bounded: highlights and preferences wait for it to land.
      const sendOptions = {
        ...options,
        force: true,
        complete: current || options?.complete,
        timeoutMs: SESSION_UPDATE_TIMEOUT_MS,
        ordered: true,
      };
      result = await cloudApi.sendDisplayUpdate(request, sendOptions);
    } catch (error) {
      session.end(update, null);
      if (first === undefined) throw error;
      console.warn("restPorts", "Could not set the song's values on the session", error);
      return first;
    }
    first ??= result;
    // A newer update decides what the session shows, and its push settles it.
    if (!session.isLatest(update)) return first;
    const display = core.getDisplay();
    // A later step owns the session by now: settling this song would move it back.
    if (result !== "DONE" || !current || display.songId !== songId) {
      session.end(update, null);
      return first;
    }
    const wanted = songValuesOf(display, explicit);
    if (applies && sameSongValues(request, wanted)) {
      session.end(update, songId);
      return first;
    }
    if (followUps >= MAX_SESSION_FOLLOW_UPS) {
      session.end(update, null);
      return first;
    }
    // The session shows this song now, so it applies what is sent next.
    applies = true;
    request = { songId, song: "", ...wanted };
  }
}

/** Whether a highlight or preference for `songId` may go out on its own. On the
 *  own session it lands on whatever song the session shows, so only while that
 *  is known to be this song with this client's values. Otherwise it stays on this
 *  client and a complete update carries it: the one on its way checks the
 *  client's values when it lands, or one is sent now (a retry after a failure)
 *  when this client may control the display and no other device took the
 *  session meanwhile. */
async function sessionTakesPartialUpdate(core: RestCore, songId: string): Promise<boolean> {
  if (!publishesOwnCloudSession(core) || !songId) return true;
  const session = core.ownSession;
  const display = core.getDisplay();
  // A later step owns the session by now; its own push follows.
  if (display.songId !== songId) return false;
  if (session.shownSongId() === songId) return true;
  if (session.inFlight() || session.isReleased() || !core.canControlDisplay()) return false;
  const leaderId = displayUpdateLeaderId(core);
  try {
    await sendDisplayAndSettle(core, { songId, from: 0, to: 0, song: display.song, message: display.message }, leaderId ? { leaderId } : undefined);
  } catch (error) {
    console.warn("restPorts", "Could not send this client's song to the session", error);
  }
  return false;
}

/** Push a single changed transpose/capo preference as a MINIMAL id+value
 *  /display_update (legacy preferenceUpdate). Sent only on finalize (picker
 *  close) and only when this context may control the display — a follower keeps
 *  its capo purely local and never pushes. Kept separate from {@link pushDisplay}
 *  so transpose can reach 0 and capo is actually sent (sendDisplayUpdate does
 *  neither). */
async function pushPreference(core: RestCore, pref: { transpose?: number; capo?: number }): Promise<void> {
  if (!core.canControlDisplay()) return;
  // The song this preference was set for, even if a step lands while waiting.
  const display = core.getDisplay();
  await publishPendingState(core);
  if (core.isFollowingPpd()) {
    await core.sendPpdDisplayUpdate({
      command: "song_update",
      id: display.songId,
      from: display.from,
      to: display.to,
      ...pref,
    });
    return;
  }
  // Not on a song the session is not known to show: it would move the session
  // there with other values. A complete update carries the value then, but never
  // saves it as the account's preference: once the session shows the song, the
  // minimal update does.
  if (!(await sessionTakesPartialUpdate(core, display.songId))) {
    await core.ownSession.idle();
    if (core.ownSession.shownSongId() !== display.songId || core.getDisplay().songId !== display.songId) return;
  }
  const leaderId = displayUpdateLeaderId(core);
  const own = publishesOwnCloudSession(core);
  const mark = core.ownSession.mark();
  const result = await cloudApi.sendDisplayPreference({ id: display.songId, ...pref }, leaderId ? { leaderId } : undefined, { ordered: own });
  // Another device moved the session to another song; the backend kept it there.
  if (own && isStale(result)) core.ownSession.release(mark);
}

const isStale = (result: string) => result.trim().replace(/"/g, "").toUpperCase() === "STALE";

/** Push the working playlist as a playlist-only update (legacy
 *  sendPlaylistUpdateRequest). The current song/section fields are carried along so
 *  the cloud session keeps its highlight, but a served host treats it purely as a
 *  playlist change. */
async function pushPlaylist(core: RestCore, playlist: PlaylistEntry[], instructions?: string): Promise<DisplayUpdateResult | undefined> {
  if (!core.canControlDisplay()) return;
  const display = core.getDisplay();
  // Skip only what the pending publish really carried: a list changed while it
  // was in flight (e.g. a reorder) still goes out.
  const published = await publishPendingState(core);
  if (published === playlist && instructions === undefined) return "DONE";
  if (core.isFollowingPpd()) {
    await core.sendPpdDisplayUpdate({
      command: "display_update",
      id: display.songId,
      from: display.from,
      to: display.to,
      section: display.section,
      abcRange: display.abcRange,
      transpose: display.transpose,
      playlist,
    });
    return;
  }
  const leaderId = displayUpdateLeaderId(core);
  // Another device took the session: a list edit sends only the list, never
  // this client's song (only selecting a song takes the session back).
  if (publishesOwnCloudSession(core) && core.ownSession.isReleased()) {
    return cloudApi.sendDisplayUpdate({ songId: "", playlist, song: "" }, { ...(leaderId ? { leaderId } : {}), force: true, ordered: true });
  }
  return sendDisplayAndSettle(
    core,
    {
      songId: display.songId,
      from: display.from,
      to: display.to,
      section: instructions === undefined ? display.section : undefined,
      abcRange: display.abcRange,
      transpose: display.transpose,
      playlist,
      song: "",
      instructions,
    },
    leaderId ? { leaderId } : undefined,
    // The display takes the saved instructions only after this push.
    instructions === undefined ? undefined : transitionInstructionsPatch(instructions)
  );
}

/** Before any push, send the working list and the complete current song that a
 *  `publish: false` write kept on this client. Alone, a push would land on what
 *  the session showed before: the backend takes a new song's transpose, capo and
 *  instructions from ITS playlist, keeps them for a song it already shows, and a
 *  highlight or preference targets the song it projects.
 *
 *  It stays pending until the account's own session takes it: not while this
 *  client watches another session (its state then mirrors that session), nor
 *  after a failed or rejected send — which never stops the caller's own push
 *  either. Without an own leader id the backend resolves the target itself: the
 *  account behind the browser's cookie (a page that did not sign in itself), or
 *  NO_SESSION for an anonymous visitor, who then stays pending — so whenever an
 *  account becomes reachable, its session gets the list first. Concurrent pushes
 *  share one send and keep their order. Resolves to the list the backend took
 *  (null when nothing went out now). */
async function publishPendingState(core: RestCore): Promise<PlaylistEntry[] | null> {
  if (!core.hasUnpublishedState() || !core.canControlDisplay() || core.isFollowing()) return null;
  const leaderId = displayUpdateLeaderId(core);
  const target = leaderId ? { leaderId } : {};
  try {
    return await core.publishPending(async () => {
      const display = core.getDisplay();
      const playlist = core.getPlaylist();
      // With no song shown only the list goes out: the backend keeps its song for
      // an empty id, and explicit values would retune that song.
      if (display.songId) {
        const result = await sendDisplayAndSettle(
          core,
          {
            songId: display.songId,
            from: display.from,
            to: display.to,
            section: display.section,
            abcRange: display.abcRange,
            sectionRepeatCounts: display.sectionRepeatCounts,
            sectionRepeatNonce: display.sectionRepeatNonce,
            transpose: display.transpose,
            capo: display.capo ?? -1,
            playlist,
            song: display.song,
            message: display.message,
            instructions: display.instructions ?? "",
          },
          { ...target, force: true, complete: true }
        );
        // The song's values must have reached the session too, not only the list.
        return result === "DONE" && sessionTookValues(core, display.songId) ? playlist : null;
      }
      // No line range either: the highlight of the song the session keeps stays.
      const result = await cloudApi.sendDisplayUpdate(
        { songId: "", playlist, song: "" },
        { ...target, force: true, ordered: publishesOwnCloudSession(core) }
      );
      return result === "DONE" || result === "SKIPPED" ? playlist : null;
    });
  } catch (error) {
    console.warn("restPorts", "Publishing the pending working list failed; it stays pending", error);
    return null;
  }
}

export function createSongApi(core: RestCore): SongApi {
  return {
    // The list renders one row per songId (React key), so drop repeated hits —
    // older servers' search index could return the same song several times.
    searchSongs: async (text, options) => {
      const seen = new Set<string>();
      // A remote catalogue is filtered by its server, independently of this
      // browser's preferences for its own editable database.
      return (await cloudApi.searchSongs(text, options?.limit, options?.songIds)).filter((entry) => {
        if (seen.has(entry.songId)) return false;
        seen.add(entry.songId);
        return true;
      });
    },
    listAllSongs: async () => {
      const entries = await cloudApi.fetchAllSongs();
      const songs = sortSongEntriesByTitle(entries);
      core.songListEvents.emit(songs);
      return songs;
    },
    getSongData: (songId) => core.loadSongData(songId),
    subscribeSongList: (callback) => core.songListEvents.add(callback),
    checkEditable: (songId) => cloudApi.checkEditable(songId),
    suggestSong: async (songId, version, chordPro) => {
      await cloudApi.suggestSong(songId, version, chordPro);
    },
    fetchPendingCount: () => cloudApi.fetchPendingSongsCount(true),
  };
}

export function createPlaylistApi(core: RestCore): PlaylistApi {
  const applyPlaylist = async (entries: PlaylistEntry[], publish = true) => {
    core.setPlaylist(entries);
    core.patchDisplay({ playlist: entries });
    if (publish) await pushPlaylist(core, entries);
    else core.markUnpublished();
  };
  const entriesForLeader = async (leaderId: string, label?: string) => {
    const profiles = await cloudApi.fetchLeadersProfiles(undefined, { fresh: true });
    const profile = profiles.find((p) => p.leaderId === leaderId);
    const playlist = label != null ? profile?.playlists.find((pl) => pl.label === label) : profile?.playlists[0];
    return playlist?.songs ?? [];
  };
  return {
    getPlaylist: () => core.getPlaylist(),
    setPlaylist: async (entries, options) => applyPlaylist(entries, options?.publish !== false),
    setEntryInstructions: async (songId, instructions, isCurrent) => {
      if (!isCurrent()) return;
      const entries = core.getPlaylist();
      const index = entries.findIndex((entry) => entry.songId === songId);
      if (index < 0) throw new Error("Playlist song is no longer available");
      const playlist = entries.slice();
      playlist[index] = { ...playlist[index], instructions };
      if (displayUpdateLeaderId(core)) {
        const result = await pushPlaylist(core, playlist, core.getDisplay().songId === songId ? instructions : undefined);
        if (result && result !== "DONE" && result !== "SKIPPED" && result !== "NO_SESSION") {
          throw new Error(`Could not publish playlist instructions (${result})`);
        }
      }
      if (!isCurrent()) return;
      const currentPlaylist = core.getPlaylist().map((entry) => (entry.songId === songId ? { ...entry, instructions } : entry));
      core.patchDisplay({ playlist: currentPlaylist, ...(core.getDisplay().songId === songId ? transitionInstructionsPatch(instructions) : {}) });
    },
    clear: async () => applyPlaylist([]),
    getLeaderPlaylists: () => cloudApi.fetchLeadersProfiles(undefined, { fresh: true }),
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
    project: async (request, options) => {
      const data = await core.loadSongData(request.songId);
      // Superseded while loading: neither the local display nor the push may change.
      if (options?.isCurrent?.() === false) return;
      core.setDisplay({
        ...core.getDisplay(),
        songId: request.songId,
        song: data.text,
        system: data.system,
        from: request.from ?? 0,
        to: request.to ?? 0,
        section: request.section,
        abcRange: request.abcRange,
        transpose: request.transpose ?? 0,
        capo: request.capo,
        instructions: request.instructions,
      });
      if (options?.publish !== false) await pushCurrent();
      else core.markUnpublished();
    },
    highlight: async (from, to, section, abcRange) => {
      // Reflect the highlight locally so this client's own song view updates.
      core.patchDisplay({ from, to, section, abcRange });
      const songId = core.getDisplay().songId;
      await publishPendingState(core);
      // A highlight carries no song: on a session that is not known to show this
      // client's song it would mark lines of another song. A complete update
      // carries it then.
      if (!(await sessionTakesPartialUpdate(core, songId))) return;
      if (core.isFollowingPpd()) {
        await core.sendPpdHighlight(from, to, section, abcRange);
        return;
      }
      // Push it through the legacy line-selection channel (`/highlight`), NOT a
      // full display_update. The Electron host's local webserver only moves the
      // projected section from `/highlight?line=…`; a display_update that carries
      // the follower's playlist is treated as a playlist-only update and never
      // changes the projected section. The cloud `/highlight` reads from/to/section
      // (it ignores `line`), so send both forms. Clearing the highlight (0,0) maps
      // to line=-1, mirroring legacy onLineSel(-1).
      // The song id lets the backend refuse lines meant for another song (another
      // device may have moved the session).
      const leader = core.leader?.id ?? core.config.leaderId ?? "";
      const own = publishesOwnCloudSession(core);
      const mark = core.ownSession.mark();
      const clearing = from === 0 && to === 0;
      const result = await cloudApi.sendHighlight({
        line: clearing ? -1 : from,
        from,
        to,
        section,
        abcRange,
        leader,
        deviceId: core.clientId,
        songId,
        ordered: own,
      });
      if (!own) return;
      if (isStale(result)) {
        core.ownSession.release(mark);
        return;
      }
      // A page that did not sign in itself names no leader. A backend that does
      // not resolve the account from the browser's cookie then answers NOPE, and
      // a display update carries the highlight to that account instead.
      if (!leader && result === "NOPE" && songId && core.canControlDisplay()) {
        await sendDisplayAndSettle(core, { songId, from, to, song: "" }, undefined);
      }
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
 *  - an http(s) url → a LAN webserver: open its web client (see
 *    {@link openLanSessionUrl} for why a native shell loads it in place);
 *  - a udp:// or nrb:// url, or NO url → follow it ({@link RestCore.watch} picks the
 *    PPD transport for a locally-discovered peer, else a cloud long-poll).
 * Keying off the scheme (not "is it a discovered peer") is what makes a PPD host that
 * runs no webserver follow over UDP instead of opening a (non-existent) http endpoint.
 */
async function attachSession(core: RestCore, session: OnlineSessionEntry): Promise<void> {
  const url = session.localUrl;
  if (url && /^https?:\/\//i.test(url)) {
    openLanSessionUrl(url);
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
    scanLocalServers: (address, options) => core.scanLocal(address, options),
    localNetworkAddresses: () => getLocalNetworkAddresses(),
    scanAddresses: () => getLocalBroadcastAddresses(),
    searchExternal: async (mode) => {
      const results: OnlineSessionEntry[] = [];
      if (mode === "WEB" || mode === "BOTH") {
        try {
          results.push(...filterOwnSessionEntries(await cloudApi.fetchOnlineSessions({ timeoutMs: 3_000 }), core.leader?.id));
        } catch {
          /* cloud unreachable — surface whatever local discovery found */
        }
      }
      if (mode === "NEARBY" || mode === "BOTH") {
        results.push(...core.collectLocalSessions());
      }
      // No emit here: `results` may mix cloud entries in, while sessionEvents is the
      // LOCAL discovery channel (collectLocalSessions publishes it on its own).
      return results;
    },
    startLocal: () => core.startLocalHost(),
    stopLocal: () => core.stopLocalHost(),
    setFeatureEnabled,
    createOnline: async () => {
      // Online hosting is always owned by the authenticated user's default leader;
      // the leader currently selected for editing must not retarget the session.
      if (!core.leader?.id) throw new Error("A default leader is required for online projection");
      // The session may have been registered anew or changed elsewhere meanwhile.
      core.ownSession.reset();
      const published = await publishPendingState(core);
      await pushDisplay(core, core.getDisplay());
      // Seed the freshly-registered cloud session with the working playlist so
      // followers see it immediately (pushDisplay no longer carries the list),
      // unless the pending-state publish has just sent this very list.
      if (core.getPlaylist().length && published !== core.getPlaylist()) await pushPlaylist(core, core.getPlaylist());
      core.setNetworkState({ status: "leading", transport: "web" });
    },
    watch: (session) => core.watch(session),
    attach: (session) => attachSession(core, session),
    stopWatching: async () => {
      core.stopWatching();
    },
    reconnect: () => core.reconnect(),
    netDisplayUrl: () => core.netDisplayUrl(),
    subscribeNetworkState: (callback) => core.networkEvents.add(callback),
    subscribeConnectedClients: subscribeProjectionClientPresence,
    // Local discovery is event-shaped: republish as each offer/withdrawal lands so the
    // list does not wait for the next poll tick to show a peer that already answered.
    subscribeSessions: (callback) => {
      const unsubscribeEvents = core.sessionEvents.add(callback);
      const unsubscribeDiscovery = onHostDeviceSessionsChanged(() => core.collectLocalSessions());
      return () => {
        unsubscribeEvents();
        unsubscribeDiscovery();
      };
    },
  };
}

export function createAuthApi(core: RestCore): AuthApi {
  let authEpoch = 0;
  let restorePromise: Promise<void> | null = null;
  const beginChange = () => {
    cloudApi.resetSession();
    restorePromise = null;
    return ++authEpoch;
  };
  const applyLeader = (login: string, leaderId: string | undefined): void => {
    core.setAuthed(true, leaderId ? { id: leaderId, name: login } : null);
  };
  return {
    isAuthed: () => cloudApi.isAuthed(),
    currentLeader: () => core.leader,
    login: async (user, password, keepLoggedIn) => {
      const epoch = beginChange();
      storeToken("", false);
      core.setAuthed(false, null);
      cloudApi.setFixedHeader("X-PP-Expected-User", "");
      try {
        cloudApi.setToken(null);
        await cloudApi.logoutSession(core.clientId, { timeoutMs: 4_000, clearCookiesAfterSnapshot: true });
      } catch {
        /* clearing stale auth before an explicit login is best-effort */
      }
      if (epoch !== authEpoch) return;
      const res = await cloudApi.fetchSession(core.clientId, {
        skipRefresh: true,
        authToken: "Basic " + btoa(user + ":" + password),
        timeoutMs: 4_000,
      });
      if (epoch !== authEpoch) return;
      if (isErrorResponse(res)) throw new Error(String(res.error));
      if (res.login !== user || !res.token) throw new Error("Session identity mismatch");
      cloudApi.setToken("Bearer " + res.token);
      cloudApi.setFixedHeader("X-PP-Expected-User", res.login);
      storeToken(res.token, keepLoggedIn, res.login);
      applyLeader(res.login, res.leaderId);
    },
    logout: async () => {
      const epoch = beginChange();
      storeToken("", false);
      core.setAuthed(false, null);
      cloudApi.setFixedHeader("X-PP-Expected-User", "");
      try {
        await cloudApi.logoutSession(core.clientId, { timeoutMs: 4_000, clearCookiesAfterSnapshot: true });
      } catch {
        /* network errors during logout are non-fatal */
      } finally {
        if (epoch === authEpoch) cloudApi.setToken(null);
      }
    },
    restoreSession: () => {
      if (restorePromise) return restorePromise;
      const epoch = authEpoch;
      const request = (async () => {
        const token = readToken();
        if (!token) return;
        const expectedUser = readTokenLogin(token);
        cloudApi.setFixedHeader("X-PP-Expected-User", expectedUser);
        try {
          // fetchSession already renews an access token with the refresh cookie,
          // so only a legacy token needs the separate cookie attempt below.
          const cookieOnly = isAccessToken(token);
          let res;
          try {
            res = await cloudApi.fetchSession(core.clientId, { skipRefresh: true, authToken: cookieOnly ? null : token, timeoutMs: 4_000 });
          } catch (error) {
            if (cookieOnly || epoch !== authEpoch || !isCloudApiErrorKind(error, "auth")) throw error;
            // A short-lived access token can expire while its refresh cookie is
            // still valid. Give the cookie a chance before discarding the login.
            res = await cloudApi.fetchSession(core.clientId, { skipRefresh: true, authToken: null, timeoutMs: 4_000 });
          }
          if (epoch !== authEpoch) return;
          if (isErrorResponse(res)) throw new Error(String(res.error));
          if (!res.token || (expectedUser && res.login !== expectedUser)) throw new Error("Session identity mismatch");
          if (res.token) {
            cloudApi.setToken("Bearer " + res.token);
            storeToken(res.token, !!window.localStorage?.getItem(TOKEN_KEY), res.login);
          }
          cloudApi.setFixedHeader("X-PP-Expected-User", res.login);
          applyLeader(res.login, res.leaderId);
        } catch (error) {
          if (epoch !== authEpoch) return;
          cloudApi.setToken(null);
          if (isCloudApiErrorKind(error, "auth")) storeToken("", false);
          core.setAuthed(false, null);
        }
      })();
      restorePromise = request;
      void request.finally(() => {
        if (restorePromise === request) restorePromise = null;
      });
      return request;
    },
    requestHighlightPermission: async (verifyOnly) => {
      if (core.isFollowingPpd()) return core.requestPpdHighlightPermission(!!verifyOnly);
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
  const parseDeviceInfo = (raw: unknown): DeviceInfo | null => {
    try {
      const parsed: unknown = typeof raw === "string" ? JSON.parse(raw) : raw;
      return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as DeviceInfo) : null;
    } catch {
      return null;
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
    getDeviceInfo: async () => {
      const raw = await Promise.resolve(window.hostDevice?.info?.(-1) ?? "");
      const info = parseDeviceInfo(raw);
      const browserMemory = (navigator as Navigator & { deviceMemory?: number }).deviceMemory;
      const hasHostMemory = !!info?.totalMemory && !!info.freeMemory;
      if (!hasHostMemory && typeof browserMemory === "number" && browserMemory > 0) {
        return { ...(info ?? {}), deviceMemory: browserMemory };
      }
      return info;
    },
    goHome: () => {
      void window.hostDevice?.goHome?.();
    },
  };
  if (window.hostDevice?.exit) {
    device.exit = async () => {
      try {
        await shutdownHostDevicePpd();
      } catch (error) {
        console.warn("ClientView", "PPD shutdown before app exit failed", error);
      }
      await Promise.resolve(window.hostDevice?.exit?.());
    };
  }
  return device;
}
