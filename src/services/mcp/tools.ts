/**
 * The MCP tools: what an assistant can see and do in PraiseProjector.
 *
 * Every tool is a function over {@link McpHost}. Access levels: "read" tools are always
 * available, "write" tools need the user's permission (and usually a confirmation in
 * the app), "control" tools drive the live projection and have their own switch.
 */
import { createTwoFilesPatch } from "diff";
import { isFavoriteScheduleDate } from "../../../common/favorite-playlists";
import type { Settings } from "../../types";
import { HelpLanguage, HelpSources, buildHelpTopics, foldText, searchHelp } from "./help";
import { SETTINGS_PAGES, describeSettings, validateSettingsPatch } from "./settingsCatalog";
import { chordsOf, gridLinesOf, songDirectives, songLines, songMetadata } from "./songMeta";
import {
  McpChordStatus,
  McpHost,
  McpLeader,
  McpPlaylistItem,
  McpPlaylistState,
  McpResource,
  McpSong,
  McpSongHistory,
  McpSongInfo,
  McpSongVersion,
  McpStoredPlaylistRef,
  McpTool,
  McpToolError,
  McpViewTarget,
} from "./types";

export interface McpContent {
  strings: Record<HelpLanguage, Record<string, string>>;
  help: HelpSources;
}

type Args = Record<string, unknown>;

const SECTION_COMMANDS: Record<string, string> = {
  first: "next-first",
  last: "next-last",
  previous: "next-up",
  next: "next-down",
  "previous-block": "next-previous-block",
  "next-block": "next-next-block",
  "block-start": "project-current-block-start",
  "project-next": "project-next-or-repeat",
  clear: "clear-projected-selection",
};

const VIEW_TARGETS: readonly McpViewTarget[] = ["settings", "sessions", "sync", "import", "song-check", "tutorial"];
const REGEX_TIME_BUDGET_MS = 1500;
const MAX_PLAYLIST_ITEMS = 200;
const MAX_PLAYLIST_OPERATIONS = 50;

const object = (properties: Record<string, unknown>, required: string[] = []) => ({
  type: "object",
  properties,
  required,
  additionalProperties: false,
});
const NO_ARGS = { type: "object", additionalProperties: false };

const OFFSET_SCHEMA = { type: "integer", minimum: 0, description: "Results to skip: the nextOffset of the previous answer. Default 0." };

const ITEM_FIELD_SCHEMA = {
  title: {
    type: "string",
    description: "Title shown in the list (free text, for this list only). Default: the leader's title for the song, or its own.",
  },
  transpose: { type: "integer", minimum: -11, maximum: 11, description: "Semitones. Default: the leader's setting for the song, or 0." },
  capo: { type: "integer", minimum: -1, maximum: 11, description: "Recommended capo fret, -1 for none. Default: the leader's setting, or none." },
  instructions: { type: "string", description: "Display instructions (section order). Usually left out." },
};

const PLAYLIST_ITEM_SCHEMA = object(
  { songId: { type: "string", description: "Song id from search_songs, find_songs, query_songs or a playlist." }, ...ITEM_FIELD_SCHEMA },
  ["songId"]
);

const OPERATION_SCHEMA = {
  type: "object",
  properties: {
    op: { type: "string", enum: ["add", "remove", "move", "update"] },
    songId: { type: "string", description: "add: the song." },
    position: { type: "integer", minimum: 0, description: "add: index the new item gets. Default: the end." },
    index: { type: "integer", minimum: 0, description: "remove, update: index of the item." },
    from: { type: "integer", minimum: 0, description: "move: index of the item." },
    to: { type: "integer", minimum: 0, description: "move: index it ends up at." },
    ...ITEM_FIELD_SCHEMA,
  },
  required: ["op"],
  additionalProperties: false,
};

const STORED_REF_SCHEMA = {
  leader: { type: "string", description: "Leader name or id. Default: the selected leader." },
  date: { type: "string", description: "Calendar day, yyyy-mm-dd." },
  favorite: { type: "string", description: "Name of a favorite playlist (instead of date)." },
};

function text(args: Args, key: string, required = true): string {
  const value = args[key];
  if (typeof value === "string" && value.trim()) return value.trim();
  if (required) throw new McpToolError(`'${key}' is required.`);
  return "";
}

function integer(args: Args, key: string, fallback: number, min: number, max: number): number {
  const value = args[key];
  if (value === undefined || value === null) return fallback;
  if (typeof value !== "number" || !Number.isInteger(value) || value < min || value > max) {
    throw new McpToolError(`'${key}' must be a whole number between ${min} and ${max}.`);
  }
  return value;
}

function dateKey(args: Args, key: string, required = true): string {
  const value = text(args, key, required);
  if (!value) return "";
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  const date = match ? new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3])) : null;
  if (!date || date.getMonth() !== Number(match![2]) - 1 || date.getDate() !== Number(match![3])) {
    throw new McpToolError(`'${key}' must be a calendar date written as yyyy-mm-dd.`);
  }
  return value;
}

/** A day a stored playlist can belong to (favorites occupy a reserved period). */
function calendarDay(args: Args, key: string): string {
  const value = dateKey(args, key, false);
  if (value && isFavoriteScheduleDate(new Date(`${value}T00:00:00`))) {
    throw new McpToolError(`'${key}': the app reserves this period for favorite playlists. Name a favorite with 'favorite' instead.`);
  }
  return value;
}

interface Paging {
  /** Number of all results. */
  total: number;
  offset: number;
  returned: number;
  /** Offset of the next page, null after the last one. */
  nextOffset: number | null;
}

function pagingArgs(args: Args, defaultLimit: number, maxLimit: number) {
  return { offset: integer(args, "offset", 0, 0, 1_000_000), limit: integer(args, "limit", defaultLimit, 1, maxLimit) };
}

export function pageOf<T>(all: readonly T[], offset: number, limit: number): { paging: Paging; items: T[] } {
  const items = all.slice(offset, offset + limit);
  const next = offset + items.length;
  return { paging: { total: all.length, offset, returned: items.length, nextOffset: next < all.length ? next : null }, items };
}

/** The fixed order of song lists: title, then id, so pages never overlap. */
const byTitle = (a: McpSongInfo, b: McpSongInfo) => a.title.localeCompare(b.title) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

const infoOf = ({ id, title, language, kind, key }: McpSong): McpSongInfo => ({ id, title, language, kind, key });

/** A leader by id or (accent- and case-insensitive, possibly partial) name. */
export function resolveLeader(host: McpHost, reference: string): McpLeader {
  const leaders = host.listLeaders();
  if (!reference) {
    const selected = host.selectedLeader();
    const leader = selected && leaders.find((candidate) => candidate.id === selected.id);
    if (!leader) throw new McpToolError("No leader is selected in the app. Name a leader (see list_leaders).");
    return leader;
  }
  const wanted = foldText(reference);
  const exact = leaders.filter((leader) => leader.id === reference || foldText(leader.name) === wanted);
  const found = exact.length ? exact : leaders.filter((leader) => foldText(leader.name).includes(wanted));
  // The same person may exist as an own profile and as its public mirror.
  const own = found.filter((leader) => leader.access === "own");
  const candidates = own.length ? own : found;
  if (candidates.length === 1) return candidates[0];
  if (!candidates.length) throw new McpToolError(`No leader matches '${reference}'. Use list_leaders to see the names.`);
  throw new McpToolError(`'${reference}' matches several leaders: ${candidates.map((leader) => leader.name).join(", ")}. Use the exact name.`);
}

function ownLeader(host: McpHost, reference: string): McpLeader {
  const leader = resolveLeader(host, reference);
  if (leader.access !== "own") {
    throw new McpToolError(`${leader.name} is a public, read-only profile. Use one of the user's own leader profiles (list_leaders).`);
  }
  return leader;
}

/** The stored playlist the arguments name: a calendar day or a favorite. */
function storedRef(args: Args, fileAllowed = false): McpStoredPlaylistRef {
  const favorite = text(args, "favorite", false);
  const date = calendarDay(args, "date");
  if (favorite && date) throw new McpToolError("Give either 'date' or 'favorite', not both.");
  if (favorite) return { favorite };
  if (date) return { date };
  throw new McpToolError(
    `Name the stored playlist: 'date' (yyyy-mm-dd) or 'favorite' (its name)${fileAllowed ? ", or give file: true for a playlist file" : ""}.`
  );
}

const describeRef = (ref: McpStoredPlaylistRef) => ("date" in ref ? `the playlist of ${ref.date}` : `the favorite "${ref.favorite}"`);

const sameRef = (a: McpStoredPlaylistRef, b: McpStoredPlaylistRef) =>
  "date" in a ? "date" in b && a.date === b.date : "favorite" in b && foldText(a.favorite) === foldText(b.favorite);

/** A short fingerprint of a playlist's content: it changes whenever an item is added, removed, moved or edited. */
export function playlistRevision(items: readonly McpPlaylistItem[]): string {
  const source = JSON.stringify(items.map((item) => [item.songId, item.title, item.transpose, item.capo, item.instructions]));
  let hash = 0x811c9dc5;
  for (let index = 0; index < source.length; index++) {
    hash ^= source.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return `${items.length}-${(hash >>> 0).toString(16).padStart(8, "0")}`;
}

function optionalString(fields: Args, key: string): string | undefined {
  const value = fields[key];
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "string") throw new McpToolError(`'${key}' must be a text.`);
  return value;
}

/** An item with the given fields changed; an empty title means the default title. */
function withFields(item: McpPlaylistItem, fields: Args, defaultTitle: () => string): McpPlaylistItem {
  const title = optionalString(fields, "title");
  const instructions = optionalString(fields, "instructions");
  return {
    songId: item.songId,
    title: title === undefined ? item.title : title.trim() || defaultTitle(),
    transpose: integer(fields, "transpose", item.transpose, -11, 11),
    capo: integer(fields, "capo", item.capo, -1, 11),
    instructions: instructions ?? item.instructions,
  };
}

/** A new item as the user's own "add" makes it (the leader's settings), with the given fields applied. */
function newItem(host: McpHost, fields: Args, leaderId: string | null, label: string): McpPlaylistItem {
  const songId = text(fields, "songId");
  const base = host.newPlaylistItem(leaderId, songId);
  if (!base) throw new McpToolError(`${label}: there is no song with id '${songId}'.`);
  return withFields(base, fields, () => base.title);
}

function playlistItems(host: McpHost, value: unknown, leaderId: string | null): McpPlaylistItem[] {
  if (!Array.isArray(value)) throw new McpToolError("'items' must be a list of playlist items.");
  if (value.length > MAX_PLAYLIST_ITEMS) throw new McpToolError(`A playlist can have at most ${MAX_PLAYLIST_ITEMS} items.`);
  return value.map((raw, position) => newItem(host, raw && typeof raw === "object" ? (raw as Args) : {}, leaderId, `Item ${position + 1}`));
}

const sameItem = (a: McpPlaylistItem, b: McpPlaylistItem) =>
  a.songId === b.songId && a.title === b.title && a.transpose === b.transpose && a.capo === b.capo && a.instructions === b.instructions;

function itemDetails(item: McpPlaylistItem): string {
  const details = [
    item.transpose ? `transpose ${item.transpose > 0 ? "+" : ""}${item.transpose}` : "",
    item.capo >= 0 ? `capo ${item.capo}` : "",
    item.instructions ? "own section order" : "",
  ].filter(Boolean);
  return details.length ? ` (${details.join(", ")})` : "";
}

const listLines = (items: readonly McpPlaylistItem[]) => items.map((item, index) => `${index + 1}. ${item.title}${itemDetails(item)}`).join("\n");

export interface PlaylistEdit {
  items: McpPlaylistItem[];
  /** For each resulting item, the index in the edited list it comes from; null for a new item. */
  sources: (number | null)[];
  /** The resulting list with marks (+ new, ✎ changed, ↕ moved) and the removed items, for the confirmation. */
  summary: string;
}

/**
 * Applies add / remove / move / update operations in order, each to the result of the
 * previous one. Throws (and changes nothing) when any operation is invalid.
 */
export function editPlaylistItems(host: McpHost, current: readonly McpPlaylistItem[], operations: unknown, leaderId: string | null): PlaylistEdit {
  if (!Array.isArray(operations) || !operations.length) throw new McpToolError("'operations' must be a non-empty list.");
  if (operations.length > MAX_PLAYLIST_OPERATIONS) throw new McpToolError(`At most ${MAX_PLAYLIST_OPERATIONS} operations at once.`);
  type Row = { item: McpPlaylistItem; source: number | null; added: boolean; moved: boolean; edited: boolean };
  const rows: Row[] = current.map((item, index) => ({ item, source: index, added: false, moved: false, edited: false }));
  const removed: string[] = [];

  operations.forEach((raw, position) => {
    const op = (raw && typeof raw === "object" ? raw : {}) as Args;
    const label = `Operation ${position + 1} (${String(op.op)})`;
    const at = (key: string, max: number, fallback?: number): number => {
      const value = op[key];
      if (value === undefined && fallback !== undefined) return fallback;
      if (max < 0) throw new McpToolError(`${label}: the list is empty at this point.`);
      if (typeof value !== "number" || !Number.isInteger(value) || value < 0 || value > max) {
        throw new McpToolError(`${label}: '${key}' must be a whole number from 0 to ${max} (the list has ${rows.length} items at this point).`);
      }
      return value;
    };
    switch (op.op) {
      case "add": {
        const item = newItem(host, op, leaderId, label);
        rows.splice(at("position", rows.length, rows.length), 0, { item, source: null, added: true, moved: false, edited: false });
        break;
      }
      case "remove": {
        const [row] = rows.splice(at("index", rows.length - 1), 1);
        if (!row.added) removed.push(row.item.title);
        break;
      }
      case "move": {
        const from = at("from", rows.length - 1);
        const to = at("to", rows.length - 1);
        const [row] = rows.splice(from, 1);
        rows.splice(to, 0, row);
        if (from !== to && !row.added) row.moved = true;
        break;
      }
      case "update": {
        const row = rows[at("index", rows.length - 1)];
        // As in the playlist: an emptied title goes back to the song's own title.
        const updated = withFields(row.item, op, () => host.getSong(row.item.songId)?.title ?? row.item.title);
        if (!sameItem(updated, row.item)) {
          row.item = updated;
          if (!row.added) row.edited = true;
        }
        break;
      }
      default:
        throw new McpToolError(`${label}: 'op' must be add, remove, move or update.`);
    }
  });
  if (rows.length > MAX_PLAYLIST_ITEMS) throw new McpToolError(`A playlist can have at most ${MAX_PLAYLIST_ITEMS} items.`);

  const lines = rows.map((row, index) => {
    const mark = row.added ? "+ " : row.edited ? "✎ " : row.moved ? "↕ " : "";
    return `${index + 1}. ${mark}${row.item.title}${row.added || row.edited ? itemDetails(row.item) : ""}`;
  });
  if (removed.length) lines.push("", `Removed: ${removed.map((title) => `− ${title}`).join(", ")}`);
  return { items: rows.map((row) => row.item), sources: rows.map((row) => row.source), summary: lines.join("\n") };
}

const describeItems = (host: McpHost, items: readonly McpPlaylistItem[]) =>
  items.map((item, index) => ({ index, ...item, key: host.songKey(item.songId, item.transpose) }));

/** Where the working list came from, and whether it still equals that stored list. */
function sourceOf(host: McpHost, playlist: McpPlaylistState) {
  const source = playlist.source;
  if (!source) return null;
  const ref: McpStoredPlaylistRef = "date" in source ? { date: source.date } : { favorite: source.favorite };
  const stored = host.getStoredPlaylist(source.leaderId, ref);
  return {
    leaderId: source.leaderId,
    leader: source.leader,
    ...ref,
    unchangedSinceLoaded: !!stored && playlistRevision(stored.items) === playlistRevision(playlist.items),
  };
}

/** A warning for the confirmation when replacing the working list loses changes not saved anywhere. */
function unsavedWarning(host: McpHost, playlist: McpPlaylistState): string {
  if (!playlist.items.length) return "";
  const source = sourceOf(host, playlist);
  if (source?.unchangedSinceLoaded) return "";
  const where = source
    ? `The current list was changed since it was loaded from ${describeRef(source)} of ${source.leader}; the changes are not saved there.`
    : "The current list is not saved anywhere.";
  return `\n\n${where} (Ctrl+Z in the playlist brings it back.)`;
}

/** A note when a stored list about to change is the one the working list was loaded from. */
function workingCopyNote(host: McpHost, leaderId: string, ref: McpStoredPlaylistRef): string {
  const source = host.getPlaylist().source;
  if (!source || source.leaderId !== leaderId || !sameRef(source, ref)) return "";
  return "The playlist loaded in the app was loaded from this list and stays as it is. If the user saves it there again (the app offers it before synchronizing), it replaces this change.";
}

function workingPlaylistView(host: McpHost) {
  const playlist = host.getPlaylist();
  return {
    items: describeItems(host, playlist.items),
    selectedIndex: playlist.selectedIndex,
    revision: playlistRevision(playlist.items),
    source: sourceOf(host, playlist),
    readOnly: playlist.readOnly,
  };
}

function assertEditable(host: McpHost): McpPlaylistState {
  const playlist = host.getPlaylist();
  if (playlist.readOnly) throw new McpToolError("The app is following another session, so its playlist cannot be changed.");
  return playlist;
}

function assertRevision(items: readonly McpPlaylistItem[], revision: string, what: string): void {
  const now = playlistRevision(items);
  if (revision !== now) {
    throw new McpToolError(
      `${what} changed since you read it (its revision is now ${now}). Read it again and repeat the change on the current content.`
    );
  }
}

/** Lyrics of a ChordPro text: chords, directives and comments removed. */
export function lyricsOf(chordPro: string): string[] {
  const lines: string[] = [];
  // Grid, tablature and score blocks are not lyrics (the app's song model skips them too).
  for (const { kind, line: raw } of songLines(chordPro)) {
    const line = raw.trim();
    if (kind !== "text" || !line || line.startsWith("#")) continue;
    const lyric = line
      .replace(/\[[^\]]*\]/g, "")
      .replace(/\s+/g, " ")
      .trim();
    if (lyric) lines.push(lyric);
  }
  return lines;
}

/** Every chord of a song: the bracketed ones and the chords of its grid blocks. */
export function songChords(host: McpHost, chordPro: string, system: string): string[] {
  const chords = new Set(chordsOf(chordPro));
  for (const line of gridLinesOf(chordPro)) for (const chord of host.gridChords(line, system).chords) chords.add(chord);
  return [...chords];
}

/** Words in grid blocks that are not chords (grids hold chords and separators only). */
export function gridText(host: McpHost, chordPro: string, system: string): string[] {
  const words = new Set<string>();
  for (const line of gridLinesOf(chordPro)) for (const word of host.gridChords(line, system).other) words.add(word);
  return [...words];
}

/** A pattern whose backtracking can explode ("(a+)+", "(.*)*"): refused, not run. */
export function isRiskyPattern(pattern: string): boolean {
  return /\((?:[^()\\]|\\.)*[+*](?:[^()\\]|\\.)*\)\s*(?:[+*]|\{\d+,\d*\})/.test(pattern) || /(?:\.\*){3,}/.test(pattern);
}

/** Folds the literal parts of a pattern; escapes (\S, \p{L}) keep their meaning. */
export function foldPattern(pattern: string): string {
  return pattern.replace(/\\[pP]\{[^}]*\}|\\.|[^\\]+/gsu, (part) => (part.startsWith("\\") ? part : foldText(part)));
}

interface FindOptions {
  pattern: string;
  scope: "lyrics" | "title" | "chordpro";
  ignoreAccents: boolean;
  offset: number;
  limit: number;
}

export function findSongs(host: McpHost, options: FindOptions, now: () => number = Date.now) {
  if (options.pattern.length > 300) throw new McpToolError("The pattern is too long (300 characters at most).");
  if (isRiskyPattern(options.pattern)) {
    throw new McpToolError("This pattern nests repetitions (like (a+)+) and could freeze the app. Rewrite it without a repeated group that repeats.");
  }
  let regex: RegExp;
  try {
    regex = new RegExp(options.ignoreAccents ? foldPattern(options.pattern) : options.pattern, "iu");
  } catch (error) {
    throw new McpToolError(`Not a valid regular expression: ${error instanceof Error ? error.message : String(error)}`);
  }
  const prepare = (line: string) => (options.ignoreAccents ? foldText(line) : line);
  const started = now();
  const songs = host.listSongs().sort(byTitle);
  const matches: { song: McpSongInfo; lines: string[] }[] = [];
  let searched = 0;
  let timedOut = false;
  for (const info of songs) {
    if (now() - started > REGEX_TIME_BUDGET_MS) {
      timedOut = true;
      break;
    }
    searched++;
    let lines: string[];
    if (options.scope === "title") lines = [info.title];
    else {
      const song = host.getSong(info.id);
      if (!song) continue;
      lines = options.scope === "lyrics" ? lyricsOf(song.text) : song.text.split(/\r?\n/);
    }
    const hits = lines.filter((line) => regex.test(prepare(line)));
    if (hits.length) matches.push({ song: info, lines: hits.slice(0, 3) });
  }
  const page = pageOf(matches, options.offset, options.limit);
  return {
    ...page.paging,
    ...(timedOut
      ? {
          incomplete: `Stopped after ${searched} of ${songs.length} songs: the search took too long, so the total and the pages cover only those. Use a simpler pattern.`,
        }
      : {}),
    songs: page.items,
  };
}

export interface Finding {
  severity: "problem" | "hint";
  finding: string;
  fix: string;
}

const OLD_SYNC_DAYS = 30;

/** The usual reasons a user is stuck, each with the way out. */
export async function diagnose(host: McpHost, now: () => number = Date.now): Promise<Finding[]> {
  const findings: Finding[] = [];
  const add = (severity: Finding["severity"], finding: string, fix: string) => findings.push({ severity, finding, fix });
  const settings = host.getSettings();
  const account = host.account();
  const ui = host.getUiState();

  if (!account.signedIn || account.guest) {
    add(
      "hint",
      "Nobody is signed in (guest mode): the song database cannot be synchronized with the cloud and changes stay on this computer.",
      "Sign in with the user control at the top of the side panel (show_in_app target 'full/profile-database')."
    );
  }
  if (!host.songCount()) {
    add("problem", "The song database is empty.", "Sign in and synchronize (open_view target 'sync'), or import songs (open_view target 'import').");
  } else if (account.signedIn && !account.guest) {
    const last = settings?.lastSyncDate ? Date.parse(settings.lastSyncDate) : NaN;
    if (Number.isNaN(last))
      add("hint", "The database has never been synchronized with the cloud on this computer.", "Synchronize: open_view target 'sync'.");
    else if (now() - last > OLD_SYNC_DAYS * 86400000) {
      add(
        "hint",
        `The last synchronization was on ${new Date(last).toISOString().slice(0, 10)}; songs may be out of date.`,
        "Synchronize: open_view target 'sync'."
      );
    }
  }
  if (!host.selectedLeader()) {
    add(
      "hint",
      "No leader profile is selected, so playlists cannot be saved to a calendar and personal song settings (transpose, capo) are not kept.",
      host.listLeaders().some((leader) => leader.access === "own")
        ? "Select a leader in the side panel, or with select_leader."
        : "Create a leader profile on the Leaders page of the settings (open_view target 'settings', page 'leaders')."
    );
  }
  if (ui.followingSession) {
    add(
      "hint",
      "The app is following another device's session, so its own playlist and projection controls are locked.",
      "Leave the session in the sessions dialog (open_view target 'sessions')."
    );
  }

  const network = await host.getNetworkStatus();
  if (network.webServerAvailable) {
    if (!network.webServerEnabled) {
      add(
        "problem",
        "The web server is off: tablets and phones cannot open the songs in a browser and the browser projection screen does not work.",
        "Turn on 'iWebEnabled' (update_settings, or settings page 'webserver')."
      );
    } else if (!network.localAddresses.length) {
      add(
        "problem",
        "The computer has no local network address, so other devices cannot reach it.",
        "Connect the computer to the same Wi-Fi or wired network as the tablets."
      );
    } else if (!network.clients.some((client) => client.connected)) {
      add(
        "hint",
        `No tablet or phone is connected. They join by opening ${network.clientUrl} in a browser on the same network (the web server page of the settings shows it as a QR code).`,
        "If a device cannot open the address: both must be on the same network, and the firewall of this computer must allow the port " +
          network.port +
          "."
      );
    }
    if (!network.nearbySessionEnabled) {
      add(
        "hint",
        "The nearby session is off: the PraiseProjector apps on phones and tablets will not find this computer automatically.",
        "Turn on 'ppdSessionEnabled' (update_settings)."
      );
    }
  }

  const display = await host.getDisplayInfo();
  if (display.displayCount < 2 && !settings?.externalWebDisplayEnabled) {
    add(
      "hint",
      "Only one screen is connected, so there is no second screen to project on.",
      "Connect the projector as an extended (not mirrored) display, or use the browser projection screen: turn on 'externalWebDisplayEnabled' and open the net display address on the device that drives the projector."
    );
  } else if (display.displayCount >= 2 && !display.projectorDisplaySelected) {
    add(
      "hint",
      "A second screen is connected but none is chosen for projection.",
      "Choose the projector screen in the preview panel (show_in_app target 'full/projection')."
    );
  }

  if (ui.updateAvailable)
    add("hint", "An application update is available.", "Install it from the update notice, or on the About page of the settings.");
  return findings;
}

function chordSystem(args: Args, host: McpHost): "G" | "S" {
  const requested = args.chordSystem;
  if (requested === "G" || requested === "S") return requested;
  return host.getSettings()?.defaultChordSystem === "S" ? "S" : "G";
}

/** Each chord as the app sees it, and what the import wizard would make of it. */
export function checkChords(
  host: McpHost,
  chords: string[],
  system: "G" | "S",
  conventions: { sourceUsesH?: boolean; lowercaseIsMinor?: boolean } = {}
) {
  const guess = host.importerConventions(chords);
  // The wizard asks the user when it cannot decide; here the undecided case follows the chord system.
  const sourceUsesH = conventions.sourceUsesH ?? (guess.sourceUsesH === -1 ? system === "G" : guess.sourceUsesH === 1);
  const lowercaseIsMinor = conventions.lowercaseIsMinor ?? guess.lowercaseIsMinor === 1;
  return {
    chordSystem: system,
    importer: {
      sourceUsesH,
      lowercaseIsMinor,
      howDecided: {
        sourceUsesH:
          conventions.sourceUsesH !== undefined ? "given" : guess.sourceUsesH === -1 ? "undecidable from these chords, assumed" : "guessed",
        lowercaseIsMinor:
          conventions.lowercaseIsMinor !== undefined ? "given" : guess.lowercaseIsMinor === -1 ? "undecidable from these chords, assumed" : "guessed",
      },
      resultNotation: "German/Hungarian (H, B)",
    },
    chords: chords.map((chord) => {
      const becomes = host.importerChord(chord, sourceUsesH, lowercaseIsMinor);
      return {
        chord,
        status: host.chordStatus(chord, system),
        importer: becomes ? { becomes, status: host.chordStatus(becomes, "G") } : "not handled: the wizard leaves it as written",
      };
    }),
  };
}

export const SONG_PROBLEMS = ["unrecognized-chords", "not-a-chord", "grid-text", "missing-key", "missing-title", "no-lyrics"] as const;
export type SongProblem = (typeof SONG_PROBLEMS)[number];
type SongProblems = Partial<Record<SongProblem, string[] | true>>;
const PROBLEM_SCAN_BUDGET_MS = 4000;

/** Problems found per song, kept while the song's text is the same (so a stopped scan can go on). */
export type ProblemCache = Map<string, { text: string; system: string; problems: SongProblems; unrecognized: string[] }>;

function songProblems(host: McpHost, info: McpSongInfo, song: McpSong): { problems: SongProblems; unrecognized: string[] } {
  const problems: SongProblems = {};
  const chords = songChords(host, song.text, song.system);
  const withStatus = (status: McpChordStatus) => chords.filter((chord) => host.chordStatus(chord, song.system) === status);
  const unrecognized = withStatus("chord-shaped");
  if (unrecognized.length) problems["unrecognized-chords"] = unrecognized;
  const broken = withStatus("not-a-chord");
  if (broken.length) problems["not-a-chord"] = broken.map((chord) => `[${chord}]`);
  if (chords.length && !info.key) problems["missing-key"] = true;
  if (!info.title.trim()) problems["missing-title"] = true;
  const words = gridText(host, song.text, song.system);
  if (words.length) problems["grid-text"] = words;
  if (info.kind !== "score" && !lyricsOf(song.text).length) problems["no-lyrics"] = true;
  return { problems, unrecognized };
}

export function findSongProblems(
  host: McpHost,
  wanted: readonly SongProblem[],
  paging: { offset: number; limit: number },
  now: () => number = Date.now,
  cache: ProblemCache = new Map()
) {
  const totals: Record<string, number> = Object.fromEntries(wanted.map((kind) => [kind, 0]));
  const found: { song: McpSongInfo; problems: SongProblems }[] = [];
  const unknownChordUse = new Map<string, number>();
  const songs = host.listSongs().sort(byTitle);
  const started = now();
  let scanned = 0;
  let incomplete = false;
  for (const info of songs) {
    const song = host.getSong(info.id);
    if (!song) continue;
    let entry = cache.get(info.id);
    if (!entry || entry.text !== song.text || entry.system !== song.system) {
      if (now() - started > PROBLEM_SCAN_BUDGET_MS) {
        incomplete = true;
        break;
      }
      entry = { text: song.text, system: song.system, ...songProblems(host, info, song) };
      cache.set(info.id, entry);
    }
    scanned++;
    if (wanted.includes("unrecognized-chords")) {
      for (const chord of entry.unrecognized) unknownChordUse.set(chord, (unknownChordUse.get(chord) ?? 0) + 1);
    }
    const problems: SongProblems = {};
    for (const kind of wanted) {
      const problem = entry.problems[kind];
      if (problem) problems[kind] = problem;
    }
    const kinds = Object.keys(problems);
    if (!kinds.length) continue;
    for (const kind of kinds) totals[kind]++;
    found.push({ song: info, problems });
  }
  const page = pageOf(found, incomplete ? 0 : paging.offset, paging.limit);
  return {
    songsInDatabase: songs.length,
    songsScanned: scanned,
    ...(incomplete
      ? {
          incomplete:
            "The scan stopped at its time budget: totals and the list cover the scanned songs only, and the list cannot be paged yet. Call again with the same arguments: songs already checked are remembered, so the scan goes on where it stopped.",
        }
      : {}),
    songsWithProblems: totals,
    mostUsedUnrecognizedChords: [...unknownChordUse.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 30)
      .map(([chord, count]) => ({ chord, songs: count })),
    ...page.paging,
    ...(incomplete ? { nextOffset: null } : {}),
    songs: page.items,
  };
}

/** Songs by what is recorded in them: metadata lines, language, kind, key. */
export function querySongs(host: McpHost, args: Args) {
  const pattern = text(args, "meta", false);
  if (pattern.length > 300) throw new McpToolError("The pattern is too long (300 characters at most).");
  if (pattern && isRiskyPattern(pattern)) throw new McpToolError("This pattern nests repetitions and could freeze the app. Simplify it.");
  let regex: RegExp | null = null;
  try {
    regex = pattern ? new RegExp(foldPattern(pattern), "iu") : null;
  } catch (error) {
    throw new McpToolError(`Not a valid regular expression: ${error instanceof Error ? error.message : String(error)}`);
  }
  const field = foldText(text(args, "field", false));
  const language = text(args, "language", false).toLowerCase();
  const kind = text(args, "kind", false);
  const needsText = !!regex || !!field;
  const { offset, limit } = pagingArgs(args, 50, 200);

  const matches: { song: McpSongInfo; matched?: string[] }[] = [];
  for (const info of host.listSongs().sort(byTitle)) {
    if (language && info.language.toLowerCase() !== language) continue;
    if (kind && info.kind !== kind) continue;
    if (typeof args.hasKey === "boolean" && !!info.key !== args.hasKey) continue;
    let matched: string[] | undefined;
    if (needsText) {
      const song: McpSong | null = host.getSong(info.id);
      if (!song) continue;
      const lines = [{ name: "title", value: info.title }, ...songDirectives(song.text)]
        .filter((entry) => !field || entry.name === field)
        .map((entry) => `${entry.name}: ${entry.value}`);
      matched = regex ? lines.filter((line) => regex.test(foldText(line))) : lines;
      if (!matched.length) continue;
    }
    matches.push(matched ? { song: info, matched: matched.slice(0, 5) } : { song: info });
  }
  const page = pageOf(matches, offset, limit);
  return { ...page.paging, songs: page.items };
}

export type LocalCopyState = "same-as-cloud" | "older-than-cloud" | "changed-locally" | "differs-from-cloud" | "not-on-server" | "unknown";

export interface UploadInfo {
  /** ISO time of the newest version in the cloud (what synchronizing gives). */
  lastUploaded: string | null;
  /** Who uploaded it; null when unknown or not revealed to this account (see note). */
  lastUploader: string | null;
  /** ISO time of the oldest version this account may see. */
  firstUploaded: string | null;
  versionCount: number | null;
  /** How the copy on this computer relates to the cloud versions. */
  localCopy: LocalCopyState;
  /** Why something is missing, or what the user can do. */
  note?: string;
}

const sameVersion = (song: McpSong, version: McpSongVersion) =>
  version.text === song.text && version.system === song.system && version.language === song.language;

const newestFirst = (versions: readonly McpSongVersion[]) => [...versions].sort((a, b) => b.uploaded.localeCompare(a.uploaded));

/** Upload facts of a song from its cloud history, with the reason when they are missing. */
export function describeUpload(song: McpSong, history: McpSongHistory): UploadInfo {
  const none = { lastUploaded: null, lastUploader: null, firstUploaded: null };
  if ("error" in history) return { ...none, versionCount: null, localCopy: "unknown", note: `The cloud could not be asked: ${history.error}` };
  const versions = newestFirst(history.versions);
  if (!versions.length) {
    return {
      ...none,
      versionCount: 0,
      localCopy: "not-on-server",
      note:
        song.version === 0
          ? "Created or changed on this computer and never uploaded: it gets an upload date at the next synchronization."
          : "The cloud has no version of this song that this account may see (it belongs to another group, or it was deleted there).",
    };
  }
  const newest = versions[0];
  const match = versions.findIndex((version) => sameVersion(song, version));
  const localCopy: LocalCopyState =
    match === 0 ? "same-as-cloud" : match > 0 ? "older-than-cloud" : song.version === 0 ? "changed-locally" : "differs-from-cloud";
  const notes = [
    localCopy === "older-than-cloud" ? "A newer version is in the cloud; synchronizing brings it to this computer." : "",
    localCopy === "changed-locally" ? "Changed on this computer; the change is uploaded at the next synchronization." : "",
    localCopy === "differs-from-cloud" ? "The copy on this computer matches none of the cloud versions; synchronize." : "",
    newest.uploader ? "" : "The cloud does not reveal to this account who uploaded the newest version.",
  ].filter(Boolean);
  return {
    lastUploaded: newest.uploaded,
    lastUploader: newest.uploader || null,
    firstUploaded: versions[versions.length - 1].uploaded,
    versionCount: versions.length,
    localCopy,
    ...(notes.length ? { note: notes.join(" ") } : {}),
  };
}

const HISTORY_TTL_MS = 10 * 60 * 1000;
const HISTORY_TIMEOUT_MS = 10_000;
const HISTORY_CACHE_SIZE = 500;
const UPLOAD_BUDGET_MS = 25_000;
const UPLOAD_CONCURRENCY = 4;
const MAX_UPLOAD_SONGS = 50;

function withTimeout<T>(promise: Promise<T>, ms: number, fallback: T): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<T>((resolve) => {
    timer = setTimeout(() => resolve(fallback), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

/** Cloud histories for a while, per song and local version (a synchronization starts afresh). */
export function createHistoryLookup(now: () => number = Date.now) {
  const cache = new Map<string, { at: number; versions: McpSongVersion[] }>();
  return async (host: McpHost, song: McpSong): Promise<McpSongHistory> => {
    const key = `${song.id}@${song.version}`;
    const hit = cache.get(key);
    if (hit && now() - hit.at < HISTORY_TTL_MS) return { versions: hit.versions };
    const result = await withTimeout(host.getSongHistory(song.id), HISTORY_TIMEOUT_MS, { error: "the cloud did not answer in time" });
    if ("versions" in result) {
      cache.delete(key);
      cache.set(key, { at: now(), versions: result.versions });
      if (cache.size > HISTORY_CACHE_SIZE) cache.delete(cache.keys().next().value as string);
    }
    return result;
  };
}

type HistoryLookup = ReturnType<typeof createHistoryLookup>;

/** Upload facts of several songs, asked from the cloud a few at a time within a time budget. */
export async function uploadInfos(host: McpHost, songs: readonly McpSong[], lookup: HistoryLookup, now: () => number = Date.now) {
  const started = now();
  const results: ({ song: McpSongInfo } & UploadInfo)[] = new Array(songs.length);
  let next = 0;
  const worker = async () => {
    while (next < songs.length) {
      const index = next++;
      const song = songs[index];
      results[index] =
        now() - started > UPLOAD_BUDGET_MS
          ? {
              song: infoOf(song),
              ...describeUpload(song, { error: "not asked, the time budget ran out; ask again for this song" }),
            }
          : { song: infoOf(song), ...describeUpload(song, await lookup(host, song)) };
    }
  };
  await Promise.all(Array.from({ length: Math.min(UPLOAD_CONCURRENCY, songs.length) }, worker));
  return results;
}

/** A unified line diff of two song texts (2 lines of context), or null when they are the same. */
export function songDiff(a: { label: string; text: string }, b: { label: string; text: string }): string | null {
  if (a.text === b.text) return null;
  return createTwoFilesPatch(a.label, b.label, `${a.text}\n`, `${b.text}\n`, undefined, undefined, { context: 2 }).replace(/^=+\r?\n/, "");
}

export function createMcpTools(content: McpContent): McpTool[] {
  const strings = (host: McpHost) => content.strings[host.language()] ?? content.strings.en;
  const topics = (host: McpHost, args: Args) => {
    const language = args.language === "en" || args.language === "hu" ? args.language : host.language();
    return buildHelpTopics(content.help, language);
  };
  const changes = (args: Args) => (args.changes && typeof args.changes === "object" && !Array.isArray(args.changes) ? (args.changes as Args) : {});
  const history = createHistoryLookup();
  const problemCache: ProblemCache = new Map();

  const requireSong = (host: McpHost, songId: string): McpSong => {
    const song = host.getSong(songId);
    if (!song) throw new McpToolError(`There is no song with id '${songId}'.`);
    return song;
  };
  const versionsOf = async (host: McpHost, song: McpSong): Promise<McpSongVersion[]> => {
    const result = await history(host, song);
    if ("error" in result) throw new McpToolError(`The song's history is not available: ${result.error}`);
    return newestFirst(result.versions);
  };
  /** The local copy of a song, or one of its cloud versions (0 = newest). */
  const songText = async (host: McpHost, songId: string, version: number | null) => {
    const song = requireSong(host, songId);
    if (version === null) return { label: `${song.title} (this computer)`, text: song.text };
    const versions = await versionsOf(host, song);
    const chosen = versions[version];
    if (!chosen) throw new McpToolError(`'${song.title}' has ${versions.length} cloud versions (0…${versions.length - 1}).`);
    return { label: `${song.title} (cloud version ${version}, ${chosen.uploaded})`, text: chosen.text };
  };
  const optionalVersion = (args: Args, key: string) => (args[key] === undefined || args[key] === null ? null : integer(args, key, 0, 0, 1000));

  /** The working list's leader for item defaults: the selected one, as for the user's own "add". */
  const workingLeaderId = (host: McpHost) => host.selectedLeader()?.id ?? null;

  const stored = (host: McpHost, args: Args, own: boolean, fileAllowed = false) => {
    const leader = own ? ownLeader(host, text(args, "leader", false)) : resolveLeader(host, text(args, "leader", false));
    const ref = storedRef(args, fileAllowed);
    return { leader, ref, list: host.getStoredPlaylist(leader.id, ref) };
  };
  const storedItems = (host: McpHost, args: Args, leaderId: string) => {
    const items = playlistItems(host, args.items, leaderId);
    if (!items.length) throw new McpToolError("The playlist is empty.");
    return items;
  };
  /** Checks an edit before the user is asked to confirm it, and again when it runs. */
  const workingEdit = (host: McpHost, args: Args) => {
    const current = assertEditable(host);
    assertRevision(current.items, text(args, "revision"), "The playlist");
    return editPlaylistItems(host, current.items, args.operations, workingLeaderId(host));
  };
  const storedEdit = (host: McpHost, args: Args) => {
    const { leader, ref, list } = stored(host, args, true);
    if (!list) throw new McpToolError(`${leader.name} has no such playlist. list_leaders shows the stored dates and favorites.`);
    assertRevision(list.items, text(args, "revision"), "The stored playlist");
    // A favorite keeps its stored name (the reference may differ in case or accents).
    const target: McpStoredPlaylistRef = "favorite" in ref ? { favorite: list.name } : ref;
    return { leader, target, edit: editPlaylistItems(host, list.items, args.operations, leader.id) };
  };

  const storeResult = (result: ReturnType<McpHost["storePlaylist"]>, leader: McpLeader, ref: McpStoredPlaylistRef) => {
    switch (result) {
      case "saved":
        return;
      case "exists":
        throw new McpToolError(
          `${leader.name} already has ${describeRef(ref)}. Ask the user, then repeat with overwrite=true, or choose another one.`
        );
      case "read-only":
        throw new McpToolError(`${leader.name} is a public, read-only profile. Use one of the user's own leader profiles (list_leaders).`);
      default:
        throw new McpToolError("Not a valid favorite name: it must not be empty, contain '/', or be longer than 80 characters.");
    }
  };

  return [
    {
      name: "get_app_status",
      title: "Application status",
      description:
        "Overview of the running PraiseProjector: version, UI language, signed-in account, selected leader, size of the song database and the playlist, what this connection is allowed to do. Call it first.",
      inputSchema: NO_ARGS,
      access: "read",
      run: (_args, host) => {
        const settings = host.getSettings();
        const playlist = host.getPlaylist();
        const source = sourceOf(host, playlist);
        return {
          version: host.appVersion(),
          platform: host.platform(),
          uiLanguage: host.language(),
          account: host.account(),
          selectedLeader: host.selectedLeader()?.name ?? null,
          songCount: host.songCount(),
          playlist: {
            items: playlist.items.length,
            loadedFrom: source ? `${source.leader}: ${describeRef(source)}` : null,
            readOnly: playlist.readOnly,
          },
          lastSync: settings?.lastSyncDate ?? null,
          permissions: {
            changes: settings?.mcpAllowChanges === true,
            liveControl: settings?.mcpAllowLiveControl === true,
            changesNeedConfirmationInApp: settings?.mcpConfirmChanges !== false,
          },
        };
      },
    },
    {
      name: "search_help",
      title: "Search the user guide",
      description:
        "Searches the application's own tutorial and button descriptions (full view, client view for musicians' tablets and phones, sessions, playlists, projection, synchronization, import). Use it for any 'how do I…' question and quote the names it uses. Returns the best matching topics with their full text.",
      inputSchema: object(
        {
          query: { type: "string", description: "Keywords in the language of the texts, e.g. 'playlist calendar' or 'lejátszási lista naptár'." },
          language: { type: "string", enum: ["en", "hu"], description: "Language of the help texts. Default: the app's UI language." },
          limit: { type: "integer", minimum: 1, maximum: 10, description: "Default 4." },
        },
        ["query"]
      ),
      access: "read",
      run: (args, host) => {
        const found = searchHelp(topics(host, args), text(args, "query"), integer(args, "limit", 4, 1, 10));
        return found.length ? found : "No topic matches. Try other keywords, or list_help_topics to see every topic.";
      },
    },
    {
      name: "list_help_topics",
      title: "List the user guide topics",
      description: "Titles and ids of every help topic, grouped by area (full-view, client-view, buttons). Read one with get_help_topic.",
      inputSchema: object({ language: { type: "string", enum: ["en", "hu"] } }),
      access: "read",
      run: (args, host) => topics(host, args).map(({ id, area, title }) => ({ id, area, title })),
    },
    {
      name: "get_help_topic",
      title: "Read a user guide topic",
      description: "Full text of one help topic.",
      inputSchema: object({ id: { type: "string" }, language: { type: "string", enum: ["en", "hu"] } }, ["id"]),
      access: "read",
      run: (args, host) => {
        const id = text(args, "id");
        const topic = topics(host, args).find((candidate) => candidate.id === id);
        if (!topic) throw new McpToolError(`No help topic '${id}'. See list_help_topics.`);
        return topic;
      },
    },
    {
      name: "list_settings",
      title: "List settings",
      description:
        "Settings with their current value, allowed values, and the page and label under which the user finds them in the Settings dialog. Filter by page or search text; without a filter every setting is returned.",
      inputSchema: object({
        page: { type: "string", description: "Settings page id, e.g. general, webserver, netdisplay, projecting, sections, clients, client-view." },
        search: { type: "string", description: "Text to look for in keys, labels and descriptions." },
      }),
      access: "read",
      run: (args, host) => {
        const list = describeSettings(host.getSettings(), strings(host), { page: text(args, "page", false), search: text(args, "search", false) });
        return list.length ? list : "No setting matches. Call list_settings without a filter to see all.";
      },
    },
    {
      name: "update_settings",
      title: "Change settings",
      description:
        "Changes one or more settings by key (keys and allowed values: list_settings). Takes effect immediately, including the web server and projection. Invalid values change nothing.",
      inputSchema: object(
        { changes: { type: "object", description: 'Setting key → new value, e.g. {"keepAwake": true, "webServerPort": 19740}.' } },
        ["changes"]
      ),
      access: "write",
      confirmation: (args, host) => {
        const labels = new Map(describeSettings(null, strings(host)).map((item) => [item.key, `${item.pageLabel} → ${item.label}`]));
        const lines = Object.entries(changes(args)).map(([key, value]) => `${labels.get(key) ?? key}: ${JSON.stringify(value)}`);
        return `Change these settings?\n\n${lines.join("\n")}`;
      },
      run: async (args, host) => {
        const patch = validateSettingsPatch(changes(args));
        await host.updateSettings(patch);
        const applied = host.getSettings() as Partial<Settings> | null;
        return { changed: Object.fromEntries(Object.keys(patch).map((key) => [key, applied?.[key as keyof Settings]])) };
      },
    },
    {
      name: "search_songs",
      title: "Search songs",
      description:
        "The application's own song search (titles and lyrics, tolerant of typos, ranked best first). Best when you know words of the title or the text. For a description of the content use find_songs with several alternative words. Page through long results with offset.",
      inputSchema: object(
        { query: { type: "string" }, limit: { type: "integer", minimum: 1, maximum: 100, description: "Default 20." }, offset: OFFSET_SCHEMA },
        ["query"]
      ),
      access: "read",
      run: async (args, host) => {
        const { offset, limit } = pagingArgs(args, 20, 100);
        const page = pageOf(await host.searchSongs(text(args, "query")), offset, limit);
        return { ...page.paging, songs: page.items };
      },
    },
    {
      name: "find_songs",
      title: "Find songs by pattern",
      description:
        "Regular-expression search over every song, line by line. Use it to find songs from a description of their content: combine word stems and synonyms with |, e.g. 'pászt|nyáj|juh' or 'shepherd|flock|sheep'. Returns the matching lines so you can judge the songs; read the best candidates with get_song. Matching ignores case, and accents by default (write the pattern without accents or with them, both work). Songs come in title order; page with offset.",
      inputSchema: object(
        {
          pattern: { type: "string", description: "JavaScript regular expression (Unicode). No nested repetitions like (a+)+." },
          scope: {
            type: "string",
            enum: ["lyrics", "title", "chordpro"],
            description:
              "lyrics (default): text without chords. title: titles only. chordpro: raw source lines, e.g. to find a chord '\\[F#m\\]' or a directive.",
          },
          ignoreAccents: { type: "boolean", description: "Default true: á matches a, ő matches o." },
          limit: { type: "integer", minimum: 1, maximum: 100, description: "Songs to return. Default 30." },
          offset: OFFSET_SCHEMA,
        },
        ["pattern"]
      ),
      access: "read",
      run: (args, host) => {
        const scope = args.scope === "title" || args.scope === "chordpro" ? args.scope : "lyrics";
        return findSongs(host, {
          pattern: text(args, "pattern"),
          scope,
          ignoreAccents: args.ignoreAccents !== false && scope !== "chordpro",
          ...pagingArgs(args, 30, 100),
        });
      },
    },
    {
      name: "query_songs",
      title: "Filter songs by metadata",
      description:
        "Lists songs by what is recorded in them rather than by their lyrics: author, artist, composer, copyright and any other {name: value} line of the song, language, kind, key. Example: songs by Hillsong or Pintér Béla → meta 'hillsong|pinter bela'. All given filters must match. Songs come in title order; page with offset. Upload dates and uploaders are kept in the cloud, not in the song: ask get_upload_info for the songs found.",
      inputSchema: object({
        meta: {
          type: "string",
          description:
            "Regular expression matched against the title and every metadata line ('artist: Hillsong Worship'), ignoring case and accents.",
        },
        field: { type: "string", description: "Only look at this metadata name (artist, composer, copyright, …; 'title' for the title)." },
        language: { type: "string", description: "Song language code, e.g. hu, en." },
        kind: { type: "string", enum: ["text", "music", "score"] },
        hasKey: { type: "boolean", description: "true: only songs that state a key; false: only songs that do not." },
        limit: { type: "integer", minimum: 1, maximum: 200, description: "Default 50." },
        offset: OFFSET_SCHEMA,
      }),
      access: "read",
      run: (args, host) => querySongs(host, args),
    },
    {
      name: "get_song",
      title: "Read a song",
      description:
        "A song in ChordPro (chords in square brackets inside the lyrics) with its title, language, key, chord system, parsed metadata (authors, copyright, …), first lyric lines, the other versions of the same song (translations: 'related') and its upload facts from the cloud ('upload': when and by whom the newest version was uploaded, the first upload, and how the copy on this computer relates to them; 'note' says why something is missing). The metadata and first line are what you need to look the song up elsewhere, e.g. to find a recording; a related version in another language often carries the original title.",
      inputSchema: object({ songId: { type: "string" } }, ["songId"]),
      access: "read",
      run: async (args, host) => {
        const song = requireSong(host, text(args, "songId"));
        const { version: _version, ...visible } = song;
        return {
          ...visible,
          metadata: songMetadata(song.text),
          firstLines: lyricsOf(song.text).slice(0, 2),
          upload: describeUpload(song, await history(host, song)),
        };
      },
    },
    {
      name: "get_upload_info",
      title: "When songs were uploaded",
      description:
        "Upload facts of up to 50 songs from the cloud, sorted newest first: when the newest version was uploaded and by whom, when the first one was, and how the copy on this computer relates to them. Songs without the date (see localCopy and note) come last, by title. Use it for 'which is the newest' and 'what was uploaded recently' questions on songs found with the other tools; page through more songs in several calls.",
      inputSchema: object(
        {
          songIds: { type: "array", items: { type: "string" }, description: "Up to 50 song ids." },
          sort: { type: "string", enum: ["lastUploaded", "firstUploaded"], description: "Default lastUploaded (the newest version)." },
        },
        ["songIds"]
      ),
      access: "read",
      run: async (args, host) => {
        const ids = args.songIds;
        if (!Array.isArray(ids) || !ids.length || !ids.every((id) => typeof id === "string"))
          throw new McpToolError("'songIds' must be a list of song ids.");
        if (ids.length > MAX_UPLOAD_SONGS) throw new McpToolError(`At most ${MAX_UPLOAD_SONGS} songs at once.`);
        const songs = [...new Set(ids as string[])].map((id) => requireSong(host, id));
        const field = args.sort === "firstUploaded" ? "firstUploaded" : "lastUploaded";
        const infos = (await uploadInfos(host, songs, history)).sort((a, b) => {
          const x = a[field];
          const y = b[field];
          if (x && y) return y.localeCompare(x) || byTitle(a.song, b.song);
          if (x || y) return x ? -1 : 1;
          return byTitle(a.song, b.song);
        });
        return { order: `Newest ${field} first; songs without one come last, by title.`, songs: infos };
      },
    },
    {
      name: "get_song_history",
      title: "Versions of a song",
      description:
        "Every version of a song the cloud keeps and this account may see, newest first (version 0), with the upload time, the uploader and which one equals the copy on this computer. Give 'version' to read the full text of one. compare_songs shows what changed between two versions.",
      inputSchema: object(
        { songId: { type: "string" }, version: { type: "integer", minimum: 0, description: "Return the full text of this version." } },
        ["songId"]
      ),
      access: "read",
      run: async (args, host) => {
        const song = requireSong(host, text(args, "songId"));
        const versions = await versionsOf(host, song);
        const describe = (version: McpSongVersion, index: number) => ({
          version: index,
          uploaded: version.uploaded,
          uploader: version.uploader || null,
          sameAsThisComputer: sameVersion(song, version),
        });
        const wanted = optionalVersion(args, "version");
        if (wanted !== null) {
          const chosen = versions[wanted];
          if (!chosen) throw new McpToolError(`'${song.title}' has ${versions.length} cloud versions (0…${versions.length - 1}).`);
          return { song: infoOf(song), ...describe(chosen, wanted), text: chosen.text };
        }
        return {
          song: infoOf(song),
          upload: describeUpload(song, { versions }),
          versions: versions.map((version, index) => ({ ...describe(version, index), firstLine: lyricsOf(version.text)[0] ?? "" })),
        };
      },
    },
    {
      name: "compare_songs",
      title: "Compare two song texts",
      description:
        "What differs between two texts, as a unified line diff: the copy of a song on this computer, one of its cloud versions (get_song_history), or another song (e.g. a related version). Without the other song and version it compares this computer's copy with the newest cloud version.",
      inputSchema: object(
        {
          songId: { type: "string" },
          version: { type: "integer", minimum: 0, description: "Cloud version of songId. Default: the copy on this computer." },
          otherSongId: { type: "string", description: "Default: songId." },
          otherVersion: {
            type: "integer",
            minimum: 0,
            description: "Cloud version of the other song. Default: the copy on this computer, or version 0 when comparing a song with itself.",
          },
        },
        ["songId"]
      ),
      access: "read",
      run: async (args, host) => {
        const songId = text(args, "songId");
        const otherSongId = text(args, "otherSongId", false) || songId;
        const version = optionalVersion(args, "version");
        const otherVersion = optionalVersion(args, "otherVersion") ?? (otherSongId === songId && version === null ? 0 : null);
        if (otherSongId === songId && version === otherVersion) throw new McpToolError("Name two different texts to compare.");
        const a = await songText(host, songId, version);
        const b = await songText(host, otherSongId, otherVersion);
        const diff = songDiff(a, b);
        return diff === null ? { a: a.label, b: b.label, identical: true } : { a: a.label, b: b.label, diff };
      },
    },
    {
      name: "check_chords",
      title: "Check chords",
      description:
        "Tells how the app treats chords, each in one of three classes. recognized: the app knows it in the chord system (transposes it, draws its diagram). chord-shaped: saved and shown as written, but unknown to the app, so it is not transposed reliably. not-a-chord: the bracket text is not a chord. Separately it reports what the import wizard's automatic normalization makes of each chord as written in a source text ('fisz', 'a' for A minor, 'Bb', 'h-moll' style): the wizard understands more spellings than the database notation allows, but fewer chord types, and always writes German/Hungarian notation (H, B). A chord the wizard does not handle stays as written. So 'the importer accepts it' and 'the app recognizes it' are different questions: check both.",
      inputSchema: object(
        {
          chords: { type: "array", items: { type: "string" }, description: "Chords without brackets, e.g. ['F#m7', 'fisz', 'Asus', 'H/D#']." },
          chordSystem: {
            type: "string",
            enum: ["G", "S"],
            description: "G: German/Hungarian (H, B). S: standard (B, Bb). Default: the app's setting.",
          },
          sourceUsesH: { type: "boolean", description: "Importer: the source writes H for B natural. Default: guessed from the chords." },
          lowercaseIsMinor: { type: "boolean", description: "Importer: a lowercase root means minor. Default: guessed from the chords." },
        },
        ["chords"]
      ),
      access: "read",
      run: (args, host) => {
        if (!Array.isArray(args.chords) || !args.chords.every((chord) => typeof chord === "string"))
          throw new McpToolError("'chords' must be a list of texts.");
        if (args.chords.length > 500) throw new McpToolError("At most 500 chords at once.");
        return checkChords(host, args.chords as string[], chordSystem(args, host), {
          sourceUsesH: typeof args.sourceUsesH === "boolean" ? args.sourceUsesH : undefined,
          lowercaseIsMinor: typeof args.lowercaseIsMinor === "boolean" ? args.lowercaseIsMinor : undefined,
        });
      },
    },
    {
      name: "list_chord_types",
      title: "Chord types the app knows",
      description:
        "The chord types the app recognizes, each with the suffixes written after the root note that select it (m, 7, maj7, sus4, dim, …). A chord is recognized when it is a root note of the chord system, one of these suffixes, and optionally a slash bass note. Use check_chords to test concrete chords.",
      inputSchema: NO_ARGS,
      access: "read",
      run: (_args, host) => ({
        roots: {
          G: "German/Hungarian: C D E F G A H, B = B flat; sharps with #, flats with b",
          S: "Standard: C D E F G A B, Bb = B flat; sharps with #, flats with b",
        },
        types: host.knownChordTypes(),
      }),
    },
    {
      name: "validate_chordpro",
      title: "Check a ChordPro text",
      description:
        "Reads a ChordPro text the way the app does: title, kind, number of sections and lyric lines, metadata, and every chord with its class (see check_chords: recognized / chord-shaped / not-a-chord). Use it on a text before import_song and fix what is not recognized.",
      inputSchema: object(
        {
          text: { type: "string" },
          chordSystem: {
            type: "string",
            enum: ["G", "S"],
            description: "G: German/Hungarian (H, B). S: standard (B, Bb). Default: the app's setting.",
          },
        },
        ["text"]
      ),
      access: "read",
      run: (args, host) => {
        const source = text(args, "text");
        const system = chordSystem(args, host);
        const chords = songChords(host, source, system);
        const byStatus = (status: McpChordStatus) => chords.filter((chord) => host.chordStatus(chord, system) === status);
        return {
          ...host.analyzeChordPro(source, system),
          chordSystem: system,
          lyricLines: lyricsOf(source).length,
          metadata: songMetadata(source),
          chords: { recognized: byStatus("recognized"), chordShapedButUnknown: byStatus("chord-shaped"), notAChord: byStatus("not-a-chord") },
          // Grids hold bare chords and separators only; the app would transpose letters of these words.
          gridWordsThatAreNotChords: gridText(host, source, system),
        };
      },
    },
    {
      name: "find_song_problems",
      title: "Find songs with problems",
      description:
        "Scans the whole database for songs that need attention: chords the app does not recognize (so they are not transposed reliably), bracket texts that are not chords, words in grid sections (grids hold bare chords and separators only; the app would transpose letters of such words), songs with chords but no stated key, songs without a title or without lyrics. Returns totals per problem and the affected songs in title order (page with offset). A large database may need more than one call to finish: the answer says so. The user fixes a song by opening it in the editor.",
      inputSchema: object({
        problems: {
          type: "array",
          items: { type: "string", enum: SONG_PROBLEMS },
          description: "Which problems to look for. Default: all.",
        },
        limit: { type: "integer", minimum: 1, maximum: 200, description: "Songs to list. Default 40." },
        offset: OFFSET_SCHEMA,
      }),
      access: "read",
      run: (args, host) => {
        const wanted = Array.isArray(args.problems)
          ? (args.problems as unknown[]).filter((kind): kind is SongProblem => SONG_PROBLEMS.includes(kind as SongProblem))
          : [];
        return findSongProblems(host, wanted.length ? wanted : SONG_PROBLEMS, pagingArgs(args, 40, 200), Date.now, problemCache);
      },
    },
    {
      name: "import_song",
      title: "Import a song",
      description:
        "Opens the app's import wizard with a song text (ChordPro, plain lyrics with chord lines above them, ABC or MusicXML). The user reviews and saves it there; nothing is saved by this call. When transcribing from a picture: copy lyrics and chord names exactly as written (Hungarian sheets use H and B), do not add or correct anything.",
      inputSchema: object(
        {
          text: { type: "string" },
          format: { type: "string", enum: ["chordpro", "text", "abc", "musicxml"], description: "Default chordpro." },
          title: { type: "string", description: "Used for the file name shown in the wizard." },
        },
        ["text"]
      ),
      access: "write",
      run: (args, host) => {
        const extension = { chordpro: "chp", text: "txt", abc: "abc", musicxml: "musicxml" }[text(args, "format", false) || "chordpro"] ?? "chp";
        const name =
          (text(args, "title", false) || "song")
            .replace(/[\\/:*?"<>|\s]+/g, " ")
            .trim()
            .slice(0, 80) || "song";
        if (!host.importSongText(`${name}.${extension}`, text(args, "text")))
          throw new McpToolError("The import wizard could not be opened right now.");
        return "The import wizard is open in PraiseProjector. The user has to review and finish the import there.";
      },
    },
    {
      name: "list_leaders",
      title: "List leaders",
      description:
        "Worship leader profiles: the user's own (editable) and public ones (read-only), each with the dates of its stored playlists and the names of its favorite playlists. Also tells which leader is selected.",
      inputSchema: NO_ARGS,
      access: "read",
      run: (_args, host) => ({ selected: host.selectedLeader()?.name ?? null, leaders: host.listLeaders() }),
    },
    {
      name: "select_leader",
      title: "Select the leader",
      description: "Makes a leader profile the active one (its song preferences and calendar are used).",
      inputSchema: object({ leader: { type: "string", description: "Leader name or id." } }, ["leader"]),
      access: "write",
      confirmation: (args, host) => `Switch the leader to ${resolveLeader(host, text(args, "leader")).name}?`,
      run: (args, host) => {
        const leader = resolveLeader(host, text(args, "leader"));
        host.selectLeader(leader.id);
        return `Selected leader: ${leader.name}`;
      },
    },
    {
      name: "get_leader_song_usage",
      title: "A leader's most used songs",
      description:
        "How often each song occurs in a leader's dated playlists, most used first, with the song's key and the key the leader plays it in (own transposition applied). Favorite playlists are not counted. Page with offset.",
      inputSchema: object({
        leader: { type: "string", description: "Leader name or id. Default: the selected leader." },
        limit: { type: "integer", minimum: 1, maximum: 200, description: "Default 20." },
        offset: OFFSET_SCHEMA,
        since: { type: "string", description: "Only playlists from this date (yyyy-mm-dd) on." },
      }),
      access: "read",
      run: (args, host) => {
        const leader = resolveLeader(host, text(args, "leader", false));
        const since = dateKey(args, "since", false);
        const { offset, limit } = pagingArgs(args, 20, 200);
        const page = pageOf(host.getSongUsage(leader.id, since || undefined), offset, limit);
        return {
          leader: leader.name,
          playlistsCounted: leader.scheduledDates.filter((date) => !since || date >= since).length,
          ...page.paging,
          songs: page.items,
        };
      },
    },
    {
      name: "get_playlist",
      title: "Read the working playlist",
      description:
        "The working list: the playlist loaded in the app, which joined tablets see, with the selected item. It is a copy: stored playlists (a leader's calendar days and favorites) and playlist files are loaded into it and saved from it, and changing one never changes the other. 'source' names the stored list it was loaded from or saved to and whether it still equals it (the app reminds the user before synchronizing when it does not). edit_playlist needs the 'revision'.",
      inputSchema: NO_ARGS,
      access: "read",
      run: (_args, host) => workingPlaylistView(host),
    },
    {
      name: "replace_playlist",
      title: "Replace the working playlist",
      description:
        "Replaces the working list with a new one, as loading a playlist file does; the user can undo it with Ctrl+Z in the playlist. Items without title, transpose, capo or instructions get the selected leader's own settings for the song, as when the user adds it. To change some items of the list use edit_playlist; to prepare a list without touching the working list use create_stored_playlist.",
      inputSchema: object(
        {
          items: { type: "array", items: PLAYLIST_ITEM_SCHEMA },
          revision: { type: "string", description: "Optional: the revision from get_playlist; nothing happens if the list changed meanwhile." },
        },
        ["items"]
      ),
      access: "write",
      confirmation: (args, host) => {
        const current = assertEditable(host);
        const revision = text(args, "revision", false);
        if (revision) assertRevision(current.items, revision, "The playlist");
        const items = playlistItems(host, args.items, workingLeaderId(host));
        return `Replace the current playlist with these ${items.length} songs?\n\n${listLines(items)}${unsavedWarning(host, current)}`;
      },
      run: async (args, host) => {
        const current = assertEditable(host);
        const revision = text(args, "revision", false);
        if (revision) assertRevision(current.items, revision, "The playlist");
        await host.replacePlaylist(playlistItems(host, args.items, workingLeaderId(host)));
        return workingPlaylistView(host);
      },
    },
    {
      name: "edit_playlist",
      title: "Change the working playlist",
      description:
        "Changes the working list in place, as the user's own playlist edits do: one undo step (Ctrl+Z), and the list keeps the stored list it came from, so the app still reminds the user to save the change there. Operations run in order, each on the result of the previous one (0-based indexes): add {songId, position?, title?, transpose?, capo?, instructions?}, remove {index}, move {from, to}, update {index, title?, transpose?, capo?, instructions?}; an empty title in update restores the song's own title. New items get the selected leader's settings for the song where not given. Nothing is selected or projected; when the song on display is updated, its new key, capo and section order show on the screens at once. A changed title, transposition or capo also becomes the selected leader's song setting, as far as the leader-profile setting allows (as with the user's own edits). Pass the revision from get_playlist: if the list changed meanwhile, nothing happens and you get the new revision.",
      inputSchema: object(
        {
          revision: { type: "string", description: "The revision from get_playlist." },
          operations: { type: "array", items: OPERATION_SCHEMA },
        },
        ["revision", "operations"]
      ),
      access: "write",
      confirmation: (args, host) => `Change the current playlist like this?\n\n${workingEdit(host, args).summary}`,
      run: async (args, host) => {
        const edit = workingEdit(host, args);
        await host.editPlaylist(edit.items, edit.sources);
        const view = workingPlaylistView(host);
        return view.source && !view.source.unchangedSinceLoaded
          ? {
              ...view,
              note: `The working list now differs from ${describeRef(view.source)} of ${view.source.leader}, which it was loaded from. Tell the user, or save it there with save_playlist if they want.`,
            }
          : view;
      },
    },
    {
      name: "load_playlist",
      title: "Load a playlist",
      description:
        "Loads a playlist into the working list, replacing it, as the Load button does: a leader's calendar day (date) or favorite (favorite), public leaders' lists included, or a playlist file the user picks in the app's file dialog (file: true). The user can undo it with Ctrl+Z in the playlist.",
      inputSchema: object({ ...STORED_REF_SCHEMA, file: { type: "boolean", description: "Let the user pick a playlist file." } }),
      access: "write",
      confirmation: (args, host) => {
        const warning = unsavedWarning(host, assertEditable(host));
        if (args.file === true) return warning ? `Open a playlist file and replace the current playlist?${warning}` : null;
        const { leader, ref, list } = stored(host, args, false, true);
        if (!list) return null;
        return `Load ${describeRef(ref)} of ${leader.name} (${list.items.length} songs) and replace the current playlist?${warning}`;
      },
      run: async (args, host) => {
        assertEditable(host);
        if (args.file === true) {
          const result = await host.loadPlaylistFile();
          if (result.status === "failed") throw new McpToolError(`The playlist file could not be loaded: ${result.error}`);
          if (result.status === "cancelled") return "The user cancelled the file dialog; the playlist did not change.";
          if (result.status === "pending") return "A file picker is open; the playlist is replaced when the user picks a file.";
          return workingPlaylistView(host);
        }
        const { leader, ref } = stored(host, args, false, true);
        if (!(await host.loadStoredPlaylist(leader.id, ref))) {
          throw new McpToolError(
            `${leader.name} has no ${describeRef(ref).replace(/^the /, "")}. list_leaders shows the stored dates and favorites.`
          );
        }
        return workingPlaylistView(host);
      },
    },
    {
      name: "save_playlist",
      title: "Save the working playlist",
      description:
        "Saves the working list, as the Save button does: into a calendar day (date) or a favorite (favorite) of one of the user's own leader profiles, after which the working list counts as loaded from there, or into a playlist file the user names in the app's file dialog (file: true). Like the app's own save, the items' titles, transpositions, capo and instructions also become the leader's song settings. An existing stored list is only replaced with overwrite=true.",
      inputSchema: object({
        ...STORED_REF_SCHEMA,
        leader: { type: "string", description: "Own leader profile. Default: the selected leader." },
        file: { type: "boolean", description: "Save into a file the user names." },
        overwrite: { type: "boolean" },
      }),
      access: "write",
      confirmation: (args, host) => {
        if (args.file === true) return null;
        const { leader, ref, list } = stored(host, args, true, true);
        if (list && args.overwrite !== true) storeResult("exists", leader, ref);
        const count = host.getPlaylist().items.length;
        return `Save the current playlist (${count} songs) as ${describeRef(ref)} of ${leader.name}${list ? `, replacing the stored list of ${list.items.length} songs` : ""}?`;
      },
      run: async (args, host) => {
        if (args.file === true) {
          const result = await host.savePlaylistFile();
          if (result.status === "failed") throw new McpToolError(`The playlist file could not be saved: ${result.error}`);
          return result.status === "cancelled" ? "The user cancelled the file dialog; nothing was saved." : "Saved.";
        }
        const { leader, ref, list } = stored(host, args, true, true);
        if (list && args.overwrite !== true) storeResult("exists", leader, ref);
        const result = host.saveWorkingPlaylist(leader.id, ref);
        if (result === "failed") throw new McpToolError("The playlist could not be saved.");
        storeResult(result, leader, ref);
        return { saved: `${leader.name}: ${describeRef(ref)}`, playlist: workingPlaylistView(host) };
      },
    },
    {
      name: "get_stored_playlist",
      title: "Read a stored playlist",
      description:
        "A playlist stored in a leader's profile: a calendar day (date) or a favorite (favorite); list_leaders shows which exist. edit_stored_playlist needs the 'revision'.",
      inputSchema: object(STORED_REF_SCHEMA),
      access: "read",
      run: (args, host) => {
        const { leader, ref, list } = stored(host, args, false);
        if (!list) throw new McpToolError(`${leader.name} has no such playlist. list_leaders shows the stored dates and favorites.`);
        return { leader: leader.name, ...ref, name: list.name, revision: playlistRevision(list.items), items: describeItems(host, list.items) };
      },
    },
    {
      name: "create_stored_playlist",
      title: "Store a new playlist",
      description:
        "Writes a playlist into a calendar day (date) or a favorite (favorite) of one of the user's own leader profiles, without touching the working list or the leader's song settings. Item titles are free text for this list only, so they can carry extra information such as the key. Items without title, transpose, capo or instructions get the leader's own settings for the song. An existing stored list is only replaced with overwrite=true.",
      inputSchema: object(
        {
          ...STORED_REF_SCHEMA,
          leader: { type: "string", description: "Own leader profile. Default: the selected leader." },
          items: { type: "array", items: PLAYLIST_ITEM_SCHEMA },
          overwrite: { type: "boolean" },
        },
        ["items"]
      ),
      access: "write",
      confirmation: (args, host) => {
        const { leader, ref, list } = stored(host, args, true);
        if (list && args.overwrite !== true) storeResult("exists", leader, ref);
        const items = storedItems(host, args, leader.id);
        const note = workingCopyNote(host, leader.id, ref);
        return `Store ${describeRef(ref)} for ${leader.name}${list ? ", replacing the stored list" : ""}?\n\n${listLines(items)}${note ? `\n\n${note}` : ""}`;
      },
      run: (args, host) => {
        const { leader, ref } = stored(host, args, true);
        const items = storedItems(host, args, leader.id);
        storeResult(host.storePlaylist(leader.id, ref, items, args.overwrite === true), leader, ref);
        const note = workingCopyNote(host, leader.id, ref);
        return {
          saved: `${leader.name}: ${describeRef(ref)}`,
          revision: playlistRevision(items),
          items: describeItems(host, items),
          ...(note ? { note } : {}),
        };
      },
    },
    {
      name: "edit_stored_playlist",
      title: "Change a stored playlist",
      description:
        "Changes a playlist stored in a calendar day (date) or a favorite (favorite) of one of the user's own leader profiles with the operations of edit_playlist, without touching the working list or the leader's song settings. Pass the revision from get_stored_playlist: if the list changed meanwhile, nothing happens.",
      inputSchema: object(
        {
          ...STORED_REF_SCHEMA,
          leader: { type: "string", description: "Own leader profile. Default: the selected leader." },
          revision: { type: "string", description: "The revision from get_stored_playlist." },
          operations: { type: "array", items: OPERATION_SCHEMA },
        },
        ["revision", "operations"]
      ),
      access: "write",
      confirmation: (args, host) => {
        const { leader, target, edit } = storedEdit(host, args);
        const note = workingCopyNote(host, leader.id, target);
        return `Change ${describeRef(target)} of ${leader.name} like this?\n\n${edit.summary}${note ? `\n\n${note}` : ""}`;
      },
      run: (args, host) => {
        const { leader, target, edit } = storedEdit(host, args);
        storeResult(host.storePlaylist(leader.id, target, edit.items, true), leader, target);
        const note = workingCopyNote(host, leader.id, target);
        return {
          saved: `${leader.name}: ${describeRef(target)}`,
          revision: playlistRevision(edit.items),
          items: describeItems(host, edit.items),
          ...(note ? { note } : {}),
        };
      },
    },
    {
      name: "get_network_status",
      title: "Network and sessions",
      description:
        "How other devices reach this app: the address tablets and phones open, the browser projection screen, the nearby session for the PraiseProjector apps, the connected devices and which of them may lead, and sessions of other devices found on the network. Use it to help set up or troubleshoot tablets.",
      inputSchema: NO_ARGS,
      access: "read",
      run: (_args, host) => host.getNetworkStatus(),
    },
    {
      name: "get_projection_state",
      title: "What is being projected",
      description: "The song loaded for projection, its sections (slides) with their text, and which section is on the projector now.",
      inputSchema: NO_ARGS,
      access: "read",
      run: (_args, host) => host.getProjection(),
    },
    {
      name: "open_view",
      title: "Open a dialog in the app",
      description:
        "Shows a part of the app to the user: the settings dialog (optionally on a page), sessions, database synchronization, the import wizard, the list of songs waiting for review (song-check), or the built-in tutorial. Changes nothing.",
      inputSchema: object(
        {
          target: { type: "string", enum: VIEW_TARGETS },
          page: { type: "string", enum: SETTINGS_PAGES, description: "Settings page, only for target=settings." },
        },
        ["target"]
      ),
      access: "read",
      run: (args, host) => {
        const target = text(args, "target") as McpViewTarget;
        if (!VIEW_TARGETS.includes(target)) throw new McpToolError(`'target' must be one of: ${VIEW_TARGETS.join(", ")}.`);
        if (!host.openView(target, text(args, "page", false) || undefined)) throw new McpToolError("This cannot be opened right now.");
        return "Opened.";
      },
    },
    {
      name: "get_ui_state",
      title: "What the user sees",
      description:
        "Where the user is in the app right now: which view (full operator view or the simple client view), which panel is in front, which dialogs are open, whether a song is being edited, the selected song. Call it before giving step-by-step directions, so they start from what is on the screen.",
      inputSchema: NO_ARGS,
      access: "read",
      run: (_args, host) => host.getUiState(),
    },
    {
      name: "show_in_app",
      title: "Point at something in the app",
      description:
        "Highlights a button or panel on the user's screen for a few seconds and brings its panel forward, so the user sees where it is. The target is a 'targets' id of a help topic (search_help, get_help_topic), e.g. 'full/profile-database'. Prefer this over describing positions in words.",
      inputSchema: object({ target: { type: "string", description: "A target id from a help topic." } }, ["target"]),
      access: "read",
      run: async (args, host) => {
        switch (await host.showInApp(text(args, "target"))) {
          case "shown":
            return "It is highlighted on the user's screen now.";
          case "other-view":
            throw new McpToolError(
              `This belongs to the other view; the user is in the ${host.getUiState().view} view. Tell the user how to switch (full view toolbar: 'Switch to mobile view'; client view: the home button), then try again.`
            );
          case "not-visible":
            throw new McpToolError(
              "The element is not on the screen right now (a dialog may cover it, or it needs a selected song). Check get_ui_state."
            );
          default:
            throw new McpToolError("Unknown target. Use a 'targets' id from search_help or get_help_topic.");
        }
      },
    },
    {
      name: "diagnose",
      title: "Check for common problems",
      description:
        "Looks for the usual reasons something does not work (not signed in, database never or long ago synchronized, empty database, no leader selected, web server off so tablets cannot join, no second screen for the projector, update pending) and says how to fix each. Call it when the user says something does not work or does not know where to start.",
      inputSchema: NO_ARGS,
      access: "read",
      run: async (_args, host) => {
        const findings = await diagnose(host);
        return findings.length ? findings : "No common problem found.";
      },
    },
    {
      name: "show_song",
      title: "Load a song for projection",
      description:
        "LIVE: selects a song as the operator would. A song of the current playlist is selected there; any other song is opened from the song list. No section is projected until select_section or section_command.",
      inputSchema: object({ songId: { type: "string" } }, ["songId"]),
      access: "control",
      run: async (args, host) => {
        const result = await host.showSong(text(args, "songId"));
        if (result === "not-found") throw new McpToolError("There is no song with this id.");
        return result === "playlist" ? "Selected in the playlist." : "Opened from the song list (it is not in the playlist).";
      },
    },
    {
      name: "select_section",
      title: "Project a section",
      description: "LIVE: projects the section with this index of the loaded song (indexes: get_projection_state). -1 clears the projector.",
      inputSchema: object({ index: { type: "integer", minimum: -1 } }, ["index"]),
      access: "control",
      run: async (args, host) => {
        const index = integer(args, "index", -1, -1, 100000);
        const count = (await host.getProjection()).sections.length;
        if (index >= count) throw new McpToolError(`The loaded song has ${count} sections (indexes 0…${count - 1}).`);
        if (!host.selectSection(index)) throw new McpToolError("The section could not be selected.");
        return index < 0 ? "Projector cleared." : `Section ${index} is projected.`;
      },
    },
    {
      name: "section_command",
      title: "Step the projection",
      description:
        "LIVE: the operator's section controls. next / previous move the selection, project-next projects the next section (or repeats), first / last jump, next-block / previous-block / block-start move by verse-chorus blocks, clear blanks the projector.",
      inputSchema: object({ command: { type: "string", enum: Object.keys(SECTION_COMMANDS) } }, ["command"]),
      access: "control",
      run: (args, host) => {
        const command = SECTION_COMMANDS[text(args, "command")];
        if (!command) throw new McpToolError(`'command' must be one of: ${Object.keys(SECTION_COMMANDS).join(", ")}.`);
        if (!host.sectionCommand(command))
          throw new McpToolError("Nothing to do: no song is loaded for projection, or the command does not apply now.");
        return "Done.";
      },
    },
  ];
}

export function createMcpResources(content: McpContent): McpResource[] {
  const guide = (language: HelpLanguage): McpResource => ({
    uri: `praiseprojector://guide/${language}`,
    name: `user-guide-${language}`,
    title: language === "hu" ? "PraiseProjector felhasználói útmutató (magyar)" : "PraiseProjector user guide (English)",
    description: "The application's built-in tutorial texts and button descriptions as one document.",
    mimeType: "text/markdown",
    read: () =>
      buildHelpTopics(content.help, language)
        .map((topic) => `## ${topic.title}\n(${topic.area}, id: ${topic.id})\n\n${topic.text}`)
        .join("\n\n"),
  });
  return [guide("en"), guide("hu")];
}
