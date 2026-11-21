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
import { HelpLanguage, HelpSources, buildHelpTopics, foldText, renderHelpMarkdown, searchHelp } from "./help";
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
  MCP_SONG_PREFERENCE_TYPES as PREFERENCE_TYPES,
  McpSongSection,
  McpSongVersion,
  McpStoredPlaylistRef,
  McpTool,
  McpToolError,
  McpViewTarget,
} from "./types";
import { invalidArgument, strictObject, validateArgument } from "./validation";

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
const MAX_PLAYLIST_INSERT_ITEMS = MAX_PLAYLIST_OPERATIONS;

const object = (properties: Record<string, unknown>, required: string[] = []) => ({
  type: "object",
  properties,
  required,
  additionalProperties: false,
});
const NO_ARGS = { type: "object", additionalProperties: false };
const STRING = { type: "string" };
const NUMBER = { type: "number" };
const NONEMPTY_STRING = { ...STRING, minLength: 1, pattern: "\\S" };
const NONNEGATIVE_INTEGER = { type: "integer", minimum: 0 };

const OFFSET_SCHEMA = { type: "integer", minimum: 0, description: "Results to skip: the nextOffset of the previous answer. Default 0." };

const LEADER_SCHEMA = { ...NONEMPTY_STRING, description: "Leader profile ID or name. Default: the selected leader." };
const PREFERENCE_FILTERS = [...PREFERENCE_TYPES, "not-ignored"] as const;
const PREFERENCE_FILTER_FIELDS = {
  leader: LEADER_SCHEMA,
  preference: {
    type: "string",
    enum: PREFERENCE_FILTERS,
    description: "Filter by this leader's song preference. 'not-ignored' includes preferred and neutral songs. Omit for all types.",
  },
  marked: { type: "boolean", description: "Filter by the song's note marker in the song tree." },
  changedLocally: { type: "boolean", description: "Filter by locally created or modified songs awaiting sync (star icon)." },
};
const PREFERENCE_LIST_LIMIT = 100;
const MAX_PREFERENCE_UPDATES = 50;
const PREFERENCE_LIST_FIELDS = {
  leader: LEADER_SCHEMA,
  type: { type: "string", enum: PREFERENCE_TYPES },
  offset: { ...OFFSET_SCHEMA, maximum: 1_000_000 },
  limit: { type: "integer", minimum: 1, maximum: PREFERENCE_LIST_LIMIT, default: 20 },
};
const PREFERENCE_SET_FIELDS = {
  leader: LEADER_SCHEMA,
  type: { type: "string", enum: PREFERENCE_TYPES, description: "'neutral' clears the preference type and keeps the song's other profile settings." },
  songIds: { type: "array", items: NONEMPTY_STRING, minItems: 1, maxItems: MAX_PREFERENCE_UPDATES, uniqueItems: true },
};
const LEADER_OUTPUT = object({ id: STRING, name: STRING, access: { type: "string", enum: ["own", "public"] } }, ["id", "name", "access"]);
const PREFERENCE_ITEM_OUTPUT = object(
  {
    songId: STRING,
    title: STRING,
    type: { type: "string", enum: PREFERENCE_TYPES },
    overrides: object({ title: STRING, transpose: NUMBER, capo: NUMBER, hasInstructions: { type: "boolean" } }, [
      "title",
      "transpose",
      "capo",
      "hasInstructions",
    ]),
  },
  ["songId", "title", "type", "overrides"]
);
const PREFERENCE_LIST_OUTPUT = object(
  {
    leader: LEADER_OUTPUT,
    total: NONNEGATIVE_INTEGER,
    offset: NONNEGATIVE_INTEGER,
    returned: NONNEGATIVE_INTEGER,
    nextOffset: { type: ["integer", "null"], minimum: 0 },
    items: { type: "array", items: PREFERENCE_ITEM_OUTPUT },
  },
  ["leader", "total", "offset", "returned", "nextOffset", "items"]
);
const PREFERENCE_SET_OUTPUT = object(
  {
    leader: LEADER_OUTPUT,
    type: { type: "string", enum: PREFERENCE_TYPES },
    changed: NONNEGATIVE_INTEGER,
    songIds: { type: "array", items: STRING },
  },
  ["leader", "type", "changed", "songIds"]
);

const ITEM_FIELD_SCHEMA = {
  title: {
    type: "string",
    description: "Title shown in the list (free text, for this list only). Default: the leader's title for the song, or its own.",
  },
  transpose: { type: "integer", minimum: -11, maximum: 11, description: "Semitones. Default: the leader's setting for the song, or 0." },
  capo: { type: "integer", minimum: -1, maximum: 11, description: "Recommended capo fret, -1 for none. Default: the leader's setting, or none." },
  instructions: {
    type: "string",
    description:
      "The song's performance order for this item, one line each: a section name from get_song 'sections', optionally 'Nx' to repeat it and '+N'/'-N' to transpose it on top of the item's transpose; other lines are notes for the musicians. Empty: the song's own order. Check a text with check_instructions. Default: the leader's stored instructions for the song.",
  },
};

/** What an assistant needs to know about instructions; shown with check_instructions. */
const INSTRUCTIONS_GUIDE =
  "Instructions give the performance order of a song for one playlist item and never change the song itself. One line per step: the name of a section of the song (get_song 'sections', e.g. 'Verse 1', 'Chorus'; matching ignores case), optionally followed by a repeat count ('2x') and a transposition ('+2', '-1') that adds to the item's own transposition, e.g. a last chorus a step higher. Any other line is a note shown to the musicians at that place (e.g. 'slowly', 'only piano'). Adjacent repeats of the same section are merged ('Chorus 2x'). Empty instructions mean the song's own order: its sections as written, with any repeat count or transposition in a section's tag ({start_of_chorus: Chorus 2x}) and with comment lines that name a section ({c: Chorus}) repeating it there; this is 'defaultInstructions' in get_song. A song should hold each section once: repeats belong to instructions (or comment lines), not to copied text. Instructions travel with the song to tablets and phones, which show the song in this order while their 'Instructions' toolbar button is on (off by default; in page mode a repeat shows only its first line). The projector follows instructions only while the 'projectInstructions' setting (preview panel button 'Project instructions') is on; otherwise it shows every section once in the order of the song text. The leader can keep instructions per song in the profile; a new playlist item takes them from there.";

const PLAYLIST_ITEM_SCHEMA = object(
  { songId: { ...NONEMPTY_STRING, description: "Song id from search_songs, find_songs, query_songs or a playlist." }, ...ITEM_FIELD_SCHEMA },
  ["songId"]
);

const INSERT_PLAYLIST_SCHEMA = object(
  {
    revision: { ...NONEMPTY_STRING, description: "The opaque revision string from get_playlist." },
    items: { type: "array", minItems: 1, maxItems: MAX_PLAYLIST_INSERT_ITEMS, items: PLAYLIST_ITEM_SCHEMA },
    position: { ...NONNEGATIVE_INTEGER, description: "Zero-based index through the current list length. Omit to append." },
  },
  ["revision", "items"]
);

const PLAYLIST_VIEW_ITEM_SCHEMA = object(
  {
    index: NONNEGATIVE_INTEGER,
    songId: STRING,
    title: STRING,
    transpose: NUMBER,
    capo: NUMBER,
    instructions: STRING,
    key: STRING,
  },
  ["index", "songId", "title", "transpose", "capo", "instructions", "key"]
);

const playlistSourceFields = { leaderId: STRING, leader: STRING, unchangedSinceLoaded: { type: "boolean" } };
const playlistSourceRequired = Object.keys(playlistSourceFields);
const INSERT_PLAYLIST_OUTPUT_SCHEMA = object(
  {
    items: { type: "array", items: PLAYLIST_VIEW_ITEM_SCHEMA },
    selectedIndex: { type: "integer", minimum: -1 },
    revision: NONEMPTY_STRING,
    source: {
      oneOf: [
        { type: "null" },
        object({ ...playlistSourceFields, date: STRING }, [...playlistSourceRequired, "date"]),
        object({ ...playlistSourceFields, favorite: STRING }, [...playlistSourceRequired, "favorite"]),
      ],
    },
    readOnly: { type: "boolean" },
    inserted: object({ position: NONNEGATIVE_INTEGER, count: { type: "integer", minimum: 1, maximum: MAX_PLAYLIST_INSERT_ITEMS } }, [
      "position",
      "count",
    ]),
    note: STRING,
  },
  ["items", "selectedIndex", "revision", "source", "readOnly", "inserted"]
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
    storeInProfile: {
      type: "boolean",
      description:
        "add, update (working list only): also store the item's instructions as the selected leader's instructions for the song, as the instructions editor's 'Store in leader profile' does, so later playlists get them too. Ctrl+Z in the playlist does not undo this profile change.",
    },
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

const infoOf = ({ id, title, language, kind, key, state }: McpSong): McpSongInfo => ({ id, title, language, kind, key, state });
const leaderInfo = ({ id, name, access }: McpLeader) => ({ id, name, access });
type McpAccount = ReturnType<McpHost["account"]>;
const sameAccount = (a: McpAccount, b: McpAccount): boolean => a.username === b.username && a.signedIn === b.signedIn && a.guest === b.guest;

/** A leader by id or (accent- and case-insensitive, possibly partial) name. */
export function resolveLeader(host: McpHost, reference: string, mode: "legacy" | "unique" = "legacy"): McpLeader {
  const leaders = host.listLeaders();
  if (!reference) {
    const selected = host.selectedLeader();
    const matching = selected ? leaders.filter((candidate) => candidate.id === selected.id) : [];
    const leader = matching.find((candidate) => candidate.access === "own") ?? matching[0];
    if (!leader) throw new McpToolError("No leader is selected in the app. Use list_leaders and pass a leader ID.", "NO_LEADER");
    return leader;
  }
  const wanted = foldText(reference);
  const ids = leaders.filter((leader) => leader.id === reference);
  const exact = ids.length ? ids : leaders.filter((leader) => foldText(leader.name) === wanted);
  const found = exact.length ? exact : leaders.filter((leader) => foldText(leader.name).includes(wanted));
  // The same person may exist as an own profile and as its public mirror.
  const byId = new Map<string, McpLeader>();
  for (const leader of found) {
    if (!byId.has(leader.id) || leader.access === "own") byId.set(leader.id, leader);
  }
  const unique = [...byId.values()];
  const own = mode === "legacy" ? unique.filter((leader) => leader.access === "own") : [];
  const candidates = own.length ? own : unique;
  if (candidates.length === 1) return candidates[0];
  if (!candidates.length) throw new McpToolError(`No leader matches '${reference}'. Use list_leaders to find its ID.`, "LEADER_NOT_FOUND");
  throw new McpToolError(
    `'${reference}' matches several leaders: ${candidates.map((leader) => `${leader.name} (${leader.id})`).join(", ")}. Use a leader ID.`,
    "LEADER_AMBIGUOUS",
    { candidates: candidates.map(leaderInfo) }
  );
}

function ownLeader(host: McpHost, reference: string, mode: "legacy" | "unique" = "legacy"): McpLeader {
  const leader = resolveLeader(host, reference, mode);
  if (leader.access !== "own") {
    throw new McpToolError(`${leader.name} is a public, read-only profile. Use one of the user's own leader profiles (list_leaders).`, "READ_ONLY");
  }
  return leader;
}

function leaderArgument(args: Args): string {
  return args.leader === undefined ? "" : validateArgument("leader", () => text(args, "leader"));
}

function enumArgument<T extends string>(args: Args, key: string, values: readonly T[]): T {
  const value = args[key];
  const match = values.find((entry) => entry === value);
  if (match === undefined) throw invalidArgument(`'${key}' must be one of: ${values.join(", ")}.`, key);
  return match;
}

function booleanFilter(args: Args, key: string): boolean | undefined {
  const value = args[key];
  if (value === undefined || typeof value === "boolean") return value;
  throw invalidArgument(`'${key}' must be true or false.`, key);
}

interface SongStateFilter {
  leaderId?: string;
  preference?: (typeof PREFERENCE_FILTERS)[number];
  marked?: boolean;
  changedLocally?: boolean;
}

function songStateFilter(host: McpHost, args: Args): SongStateFilter {
  const preference = args.preference === undefined ? undefined : enumArgument(args, "preference", PREFERENCE_FILTERS);
  return {
    leaderId: args.leader !== undefined || preference ? resolveLeader(host, leaderArgument(args), "unique").id : host.selectedLeader()?.id,
    preference,
    marked: booleanFilter(args, "marked"),
    changedLocally: booleanFilter(args, "changedLocally"),
  };
}

function songStateDecorator(host: McpHost, leaderId: string | undefined, songIds: readonly string[]) {
  const preferences = leaderId ? host.getSongPreferences(leaderId, songIds) : null;
  return <T extends McpSongInfo>(song: T): T =>
    leaderId && preferences ? { ...song, state: { ...song.state, preference: { leaderId, type: preferences[song.id]?.type ?? "neutral" } } } : song;
}

function matchesSongState({ state }: McpSongInfo, filter: SongStateFilter): boolean {
  if (filter.marked !== undefined && state.marked !== filter.marked) return false;
  if (filter.changedLocally !== undefined && state.changedLocally !== filter.changedLocally) return false;
  if (!filter.preference) return true;
  return filter.preference === "not-ignored" ? state.preference?.type !== "ignored" : state.preference?.type === filter.preference;
}

function withSongStates<T extends { song: McpSongInfo }>(host: McpHost, leaderId: string | undefined, rows: readonly T[]): T[] {
  const decorate = songStateDecorator(
    host,
    leaderId,
    rows.map(({ song }) => song.id)
  );
  return rows.map((row) => ({ ...row, song: decorate(row.song) }));
}

function matchingSongIds(host: McpHost, filter: SongStateFilter): string[] | undefined {
  if (filter.preference === undefined && filter.marked === undefined && filter.changedLocally === undefined) return undefined;
  const songs = host.listSongs();
  const decorate = songStateDecorator(
    host,
    filter.leaderId,
    songs.map(({ id }) => id)
  );
  const ids = songs.filter((song) => matchesSongState(decorate(song), filter)).map(({ id }) => id);
  return ids.length && ids.length === songs.length ? undefined : ids;
}

function listSongPreferences(rawArgs: Args, host: McpHost) {
  const args = strictObject(rawArgs, Object.keys(PREFERENCE_LIST_FIELDS));
  const leader = resolveLeader(host, leaderArgument(args), "unique");
  const type = args.type === undefined ? undefined : enumArgument(args, "type", PREFERENCE_TYPES);
  const offset = validateArgument("offset", () => integer(args, "offset", 0, 0, 1_000_000));
  const limit = validateArgument("limit", () => integer(args, "limit", 20, 1, PREFERENCE_LIST_LIMIT));
  const songs = host.listSongs().sort(byTitle);
  const preferences = host.getSongPreferences(
    leader.id,
    songs.map(({ id }) => id)
  );
  const rows = songs.flatMap(({ id, title }) => {
    const preference = preferences[id];
    if (!preference || (type && preference.type !== type)) return [];
    const { type: songType, ...overrides } = preference;
    return [{ songId: id, title, type: songType, overrides }];
  });
  const page = pageOf(rows, offset, limit);
  return { leader: leaderInfo(leader), ...page.paging, items: page.items };
}

function prepareSongPreference(rawArgs: Args, host: McpHost) {
  const args = strictObject(rawArgs, Object.keys(PREFERENCE_SET_FIELDS));
  const reference = leaderArgument(args);
  const type = enumArgument(args, "type", PREFERENCE_TYPES);
  const leader = ownLeader(host, reference, "unique");
  const database = host.databaseIdentity();
  const account = { ...host.account() };
  const contextChanged = () =>
    new McpToolError(
      "The song or leader context changed. Read list_leaders and list_song_preferences, then prepare the change again.",
      "CONTEXT_CHANGED"
    );
  if (!database) throw contextChanged();

  const values = args.songIds;
  if (!Array.isArray(values) || !values.length || values.length > MAX_PREFERENCE_UPDATES) {
    throw invalidArgument(`'songIds' must be an array of 1–${MAX_PREFERENCE_UPDATES} song IDs.`, "songIds");
  }
  const seen = new Set<string>();
  const songs = values.map((value, index) => {
    const id = validateArgument("songIds", () => text({ songId: value }, "songId"), index);
    if (seen.has(id)) throw invalidArgument(`Duplicate song ID '${id}'. Give each song once.`, "songIds", index);
    seen.add(id);
    const song = host.getSong(id);
    if (!song) throw new McpToolError(`Song '${id}' was not found. Search for it and use its ID.`, "SONG_NOT_FOUND", { songId: id, index });
    return { id, title: song.title };
  });
  const songIds = songs.map(({ id }) => id);
  const previous = host.getSongPreferences(leader.id, songIds);
  const previousType = (id: string) => previous[id]?.type ?? "neutral";
  const changed = songs.filter(({ id }) => previousType(id) !== type);
  const hu = host.language() === "hu";
  const label = hu ? { preferred: "Kedvelt", ignored: "Figyelmen kívül hagyott", neutral: "Semleges" }[type] : type;
  const heading = hu
    ? `Beállítod a következő dalok preferenciáját „${label}” értékre ${leader.name} profiljában?`
    : `Set these songs to ${label} in ${leader.name}'s profile?`;
  return {
    confirmation: changed.length ? `${heading}\n\n${changed.map(({ title }) => `• ${title}`).join("\n")}` : null,
    commit: async () => {
      if (host.databaseIdentity() !== database || !sameAccount(host.account(), account) || (!reference && host.selectedLeader()?.id !== leader.id)) {
        throw contextChanged();
      }
      const currentLeader = host.listLeaders().find((candidate) => candidate.id === leader.id && candidate.access === "own");
      if (!currentLeader || currentLeader.name !== leader.name || songs.some(({ id, title }) => host.getSong(id)?.title !== title)) {
        throw contextChanged();
      }
      const current = host.getSongPreferences(leader.id, songIds);
      if (songIds.some((id) => (current[id]?.type ?? "neutral") !== previousType(id))) throw contextChanged();
      await host.setSongPreferences(
        leader.id,
        changed.map(({ id }) => id),
        type
      );
      if (host.databaseIdentity() !== database || !sameAccount(host.account(), account)) throw contextChanged();
      const savedLeader = host.listLeaders().find((candidate) => candidate.id === leader.id && candidate.access === "own");
      const saved = host.getSongPreferences(leader.id, songIds);
      if (!savedLeader || songIds.some((id) => !host.getSong(id) || (saved[id]?.type ?? "neutral") !== type)) throw contextChanged();
      return { leader: leaderInfo(leader), type, changed: changed.length, songIds };
    },
  };
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
function withFields(item: McpPlaylistItem, fields: Args, defaultTitle: () => string, batchIndex?: number): McpPlaylistItem {
  const title = validateArgument("title", () => optionalString(fields, "title"), batchIndex);
  const instructions = validateArgument("instructions", () => optionalString(fields, "instructions"), batchIndex);
  return {
    songId: item.songId,
    title: title === undefined ? item.title : title.trim() || defaultTitle(),
    transpose: validateArgument("transpose", () => integer(fields, "transpose", item.transpose, -11, 11), batchIndex),
    capo: validateArgument("capo", () => integer(fields, "capo", item.capo, -1, 11), batchIndex),
    instructions: instructions ?? item.instructions,
  };
}

/** A new item as the user's own "add" makes it (the leader's settings), with the given fields applied. */
function newItem(host: McpHost, fields: Args, leaderId: string | null, label: string, batchIndex?: number): McpPlaylistItem {
  const songId = validateArgument("songId", () => text(fields, "songId"), batchIndex);
  const base = host.newPlaylistItem(leaderId, songId);
  if (!base) {
    const details = { songId, ...(batchIndex === undefined ? {} : { index: batchIndex }) };
    throw new McpToolError(`${label}: there is no song with id '${songId}'. Search again and use an actual song ID.`, "SONG_NOT_FOUND", details);
  }
  return withFields(base, fields, () => base.title, batchIndex);
}

function playlistItems(host: McpHost, value: unknown, leaderId: string | null): McpPlaylistItem[] {
  if (!Array.isArray(value)) throw new McpToolError("'items' must be a list of playlist items.");
  if (value.length > MAX_PLAYLIST_ITEMS) throw new McpToolError(`A playlist can have at most ${MAX_PLAYLIST_ITEMS} items.`);
  return value.map((raw, position) => newItem(host, raw && typeof raw === "object" ? (raw as Args) : {}, leaderId, `Item ${position + 1}`));
}

const sameItem = (a: McpPlaylistItem, b: McpPlaylistItem) =>
  a.songId === b.songId && a.title === b.title && a.transpose === b.transpose && a.capo === b.capo && a.instructions === b.instructions;

function itemDetails(item: McpPlaylistItem, language: HelpLanguage = "en"): string {
  const details = [
    item.transpose ? `${language === "hu" ? "transzponálás" : "transpose"} ${item.transpose > 0 ? "+" : ""}${item.transpose}` : "",
    item.capo >= 0 ? `${language === "hu" ? "kapodaszter" : "capo"} ${item.capo}` : "",
    item.instructions ? (language === "hu" ? "egyéni sorrend" : "own section order") : "",
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
  /** Indices (in `items`) whose instructions also go into the leader's profile. */
  storeInstructions: number[];
}

/**
 * Applies add / remove / move / update operations in order, each to the result of the
 * previous one. Throws (and changes nothing) when any operation is invalid.
 */
export function editPlaylistItems(
  host: McpHost,
  current: readonly McpPlaylistItem[],
  operations: unknown,
  leaderId: string | null,
  /** Name of the leader whose profile may keep instructions (storeInProfile); null: not offered here. */
  profileLeader: string | null = null,
  addArgument: "operations" | "items" = "operations"
): PlaylistEdit {
  if (!Array.isArray(operations) || !operations.length) throw new McpToolError("'operations' must be a non-empty list.");
  if (operations.length > MAX_PLAYLIST_OPERATIONS) throw new McpToolError(`At most ${MAX_PLAYLIST_OPERATIONS} operations at once.`);
  type Row = { item: McpPlaylistItem; source: number | null; added: boolean; moved: boolean; edited: boolean; store?: boolean };
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
    const store = op.storeInProfile === true;
    if (store && op.op !== "add" && op.op !== "update") throw new McpToolError(`${label}: 'storeInProfile' belongs to add and update.`);
    if (store && !profileLeader) {
      throw new McpToolError(
        `${label}: 'storeInProfile' works on the playlist loaded in the app with a selected leader only (the leader whose profile keeps the instructions).`
      );
    }
    switch (op.op) {
      case "add": {
        const item =
          addArgument === "items" ? newItem(host, op, leaderId, `Item at index ${position}`, position) : newItem(host, op, leaderId, label);
        rows.splice(at("position", rows.length, rows.length), 0, { item, source: null, added: true, moved: false, edited: false, store });
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
        if (store) row.store = true;
        break;
      }
      default:
        throw new McpToolError(`${label}: 'op' must be add, remove, move or update.`);
    }
  });
  if (rows.length > MAX_PLAYLIST_ITEMS) throw new McpToolError(`A playlist can have at most ${MAX_PLAYLIST_ITEMS} items.`);

  const lines = rows.map((row, index) => {
    const mark = row.added ? "+ " : row.edited ? "✎ " : row.moved ? "↕ " : "";
    const stored = row.store
      ? ` [instructions kept in ${profileLeader}'s profile: ${row.item.instructions.replace(/\s*\r?\n\s*/g, " / ") || "(none)"}]`
      : "";
    return `${index + 1}. ${mark}${row.item.title}${row.added || row.edited ? itemDetails(row.item) : ""}${stored}`;
  });
  if (removed.length) lines.push("", `Removed: ${removed.map((title) => `− ${title}`).join(", ")}`);
  if (rows.some((row) => row.store))
    lines.push("", `The instructions kept in ${profileLeader}'s profile stay there even if the playlist change is undone.`);
  return {
    items: rows.map((row) => row.item),
    sources: rows.map((row) => row.source),
    summary: lines.join("\n"),
    storeInstructions: rows.flatMap((row, index) => (row.store ? [index] : [])),
  };
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

function workingPlaylistView(host: McpHost, playlist = host.getPlaylist()) {
  return {
    items: describeItems(host, playlist.items),
    selectedIndex: playlist.selectedIndex,
    revision: playlistRevision(playlist.items),
    source: sourceOf(host, playlist),
    readOnly: playlist.readOnly,
  };
}

function workingEditView(host: McpHost, playlist = host.getPlaylist()) {
  const view = workingPlaylistView(host, playlist);
  return view.source && !view.source.unchangedSinceLoaded
    ? {
        ...view,
        note: `The working list now differs from ${describeRef(view.source)} of ${view.source.leader}, which it was loaded from. Tell the user, or save it there with save_playlist if they want.`,
      }
    : view;
}

function assertEditable(host: McpHost): McpPlaylistState {
  const playlist = host.getPlaylist();
  if (playlist.readOnly) {
    throw new McpToolError("The app is following another session, so its playlist cannot be changed. Choose an editable list.", "READ_ONLY");
  }
  return playlist;
}

const sameItems = (items: readonly McpPlaylistItem[], expected: readonly McpPlaylistItem[]) =>
  items.length === expected.length && items.every((item, index) => sameItem(item, expected[index]));

function assertRevision(items: readonly McpPlaylistItem[], revision: string, what: string, expectedItems?: readonly McpPlaylistItem[]): void {
  const now = playlistRevision(items);
  if (revision !== now || (expectedItems && !sameItems(items, expectedItems))) {
    throw new McpToolError(
      `${what} changed since you read it (its revision is now ${now}). Read ${what === "The playlist" ? "get_playlist" : "get_stored_playlist"} and reconcile the intended change with the current list before sending it again.`,
      "REVISION_CONFLICT",
      { currentRevision: now }
    );
  }
}

const playlistContextChanged = () =>
  new McpToolError(
    "The playlist context changed. Read get_playlist and check the intended list and leader before making a fresh request.",
    "CONTEXT_CHANGED"
  );

function preparePlaylistInsertion(args: Args, host: McpHost) {
  strictObject(args, Object.keys(INSERT_PLAYLIST_SCHEMA.properties));
  validateArgument("revision", () => text(args, "revision"));
  const revision = args.revision as string;
  if (!Array.isArray(args.items) || args.items.length < 1 || args.items.length > MAX_PLAYLIST_INSERT_ITEMS) {
    throw invalidArgument(`'items' must contain between 1 and ${MAX_PLAYLIST_INSERT_ITEMS} playlist items.`, "items");
  }
  const members = args.items.map((item, index) => strictObject(item, Object.keys(PLAYLIST_ITEM_SCHEMA.properties), "items", index));
  const current = assertEditable(host);
  const { editContext } = current;
  const database = host.databaseIdentity();
  if (!database || !editContext.panel) throw playlistContextChanged();

  assertRevision(current.items, revision, "The playlist");
  const position = validateArgument("position", () => integer(args, "position", current.items.length, 0, current.items.length));
  if (current.items.length + members.length > MAX_PLAYLIST_ITEMS) {
    throw invalidArgument(`The resulting playlist can have at most ${MAX_PLAYLIST_ITEMS} items. Remove rows or insert fewer songs.`, "items");
  }
  const operations = members.map((item, index) => ({ ...item, op: "add", position: args.position === undefined ? undefined : position + index }));
  const leaderId = host.selectedLeader()?.id ?? null;
  const before = current.items.map((item) => ({ ...item }));
  const edit = editPlaylistItems(host, before, operations, leaderId, null, "items");
  const inserted = { position, count: members.length };
  const additions = edit.items.slice(position, position + inserted.count);
  const language = host.language();
  const heading =
    language === "hu"
      ? `Beszúrja a következő ${inserted.count} dalt a megnyitott lejátszási lista ${position + 1}. helyétől kezdve?`
      : `Insert these ${inserted.count} songs into the working playlist starting at position ${position + 1}?`;
  const preview = additions.map((item, index) => `${position + index + 1}. ${item.title}${itemDetails(item, language)}`).join("\n");
  const account = { ...host.account() };

  const assertContext = (playlist: McpPlaylistState) => {
    const live = playlist.editContext;
    if (
      host.databaseIdentity() !== database ||
      !sameAccount(host.account(), account) ||
      live.leader !== editContext.leader ||
      (host.selectedLeader()?.id ?? null) !== leaderId ||
      live.panel !== editContext.panel ||
      live.playlistId !== editContext.playlistId ||
      live.origin !== editContext.origin
    ) {
      throw playlistContextChanged();
    }
  };

  return {
    confirmation: `${heading}\n\n${preview}`,
    commit: async () => {
      const live = assertEditable(host);
      assertContext(live);
      assertRevision(live.items, revision, "The playlist", before);
      for (const [index, item] of operations.entries()) {
        let resolved: McpPlaylistItem;
        try {
          resolved = newItem(host, item, leaderId, `Item at index ${index}`, index);
        } catch (error) {
          if (error instanceof McpToolError && error.code === "SONG_NOT_FOUND") throw playlistContextChanged();
          throw error;
        }
        if (!sameItem(resolved, additions[index])) throw playlistContextChanged();
      }

      try {
        await host.editPlaylist(
          edit.items.map((item) => ({ ...item })),
          edit.sources
        );
      } catch (error) {
        console.error("MCP", "Working playlist insertion did not settle", error);
        throw new McpToolError(
          "The app could not finish saving or publishing the playlist change. Read get_playlist before deciding whether to retry.",
          "SAVE_FAILED"
        );
      }
      const after = host.getPlaylist();
      assertContext(after);
      if (after.readOnly || !sameItems(after.items, edit.items)) throw playlistContextChanged();
      return { ...workingEditView(host, after), inserted };
    },
  };
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
  stateFilter?: SongStateFilter;
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
  const filter = options.stateFilter ?? { leaderId: host.selectedLeader()?.id };
  const decorate = songStateDecorator(
    host,
    filter.leaderId,
    songs.map((song) => song.id)
  );
  const matches: { song: McpSongInfo; lines: string[] }[] = [];
  let searched = 0;
  let timedOut = false;
  for (const songInfo of songs) {
    if (now() - started > REGEX_TIME_BUDGET_MS) {
      timedOut = true;
      break;
    }
    searched++;
    const info = decorate(songInfo);
    if (!matchesSongState(info, filter)) continue;
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
  const pending = host.getSyncPending();
  if (pending?.needsSync) {
    add(
      "hint",
      `Pending synchronization affects ${pending.songs} of your songs and ${pending.profiles} of your leader profiles.`,
      "Review the changes in the synchronization dialog (open_view target 'sync')."
    );
  }
  if (ui.songList?.hasHiddenFilter) {
    add(
      "hint",
      "The song library has active filters that may hide songs.",
      "Check the content and language filters (show_in_app target 'full/song-tree/song-content-filters') or the preference filter ('full/song-tree/song-preference')."
    );
  }

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

export const SONG_PROBLEMS = [
  "unrecognized-chords",
  "not-a-chord",
  "grid-text",
  "missing-key",
  "key-mismatch",
  "missing-title",
  "no-lyrics",
] as const;
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
  if (info.key && chords.length) {
    const estimate = host.songKeyEstimate(info.id);
    // Few chords leave the estimate open (G and D alone may be D): flag only a stated key whose tonic chord never occurs.
    if (estimate?.estimatedKey && estimate.agreesWithStatedKey === false && estimate.statedKeyTonicUsed === false)
      problems["key-mismatch"] = [`stated ${info.key}`, `chords: ${estimate.estimatedKey}`];
  }
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
  const filter = songStateFilter(host, args);
  const songs = host.listSongs().sort(byTitle);
  const decorate = songStateDecorator(
    host,
    filter.leaderId,
    songs.map((song) => song.id)
  );

  const matches: { song: McpSongInfo; matched?: string[] }[] = [];
  for (const candidate of songs) {
    const info = decorate(candidate);
    if (!matchesSongState(info, filter)) continue;
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
const MAX_KEY_SONGS = 100;

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
    return editPlaylistItems(host, current.items, args.operations, workingLeaderId(host), host.selectedLeader()?.name ?? null);
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
        "Overview for troubleshooting: version, UI language, signed-in account, selected leader, database and playlist sizes, local changes pending synchronization, and what this connection can do.",
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
          syncPending: host.getSyncPending(),
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
        "Settings with their current value, allowed values, and the location and label of the associated app control. Filter by page or search text; without a filter every setting is returned.",
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
        const patch = validateSettingsPatch(changes(args));
        const labels = new Map(describeSettings(null, strings(host)).map((item) => [item.key, `${item.pageLabel} → ${item.label}`]));
        const lines = Object.entries(patch).map(([key, value]) => `${labels.get(key) ?? key}: ${JSON.stringify(value)}`);
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
        "Find a known title or lyric fragment, tolerant of typos and ranked best first. The app's song-language setting applies, and the tool takes explicit preference and mark filters independently of the song-tree preference toggle. Use find_songs for lyric patterns and query_songs for metadata or preferences alone. Page with offset.",
      inputSchema: object(
        {
          query: { type: "string" },
          ...PREFERENCE_FILTER_FIELDS,
          limit: { type: "integer", minimum: 1, maximum: 100, description: "Default 20." },
          offset: OFFSET_SCHEMA,
        },
        ["query"]
      ),
      access: "read",
      run: async (args, host) => {
        const { offset, limit } = pagingArgs(args, 20, 100);
        const query = text(args, "query");
        const database = host.databaseIdentity();
        const filter = songStateFilter(host, args);
        const songIds = matchingSongIds(host, filter);
        const hits = songIds?.length === 0 ? [] : await host.searchSongs(query, filter.leaderId, songIds);
        if (host.databaseIdentity() !== database) {
          throw new McpToolError("The active song catalogue changed. Search for the songs again.", "CONTEXT_CHANGED");
        }
        const matches = withSongStates(host, filter.leaderId, hits).filter(({ song }) => matchesSongState(song, filter));
        const page = pageOf(matches, offset, limit);
        return { ...page.paging, songs: page.items };
      },
    },
    {
      name: "find_songs",
      title: "Find songs by pattern",
      description:
        "Search lyrics, titles or ChordPro lines by pattern. Use stems and synonyms with |, e.g. 'pászt|nyáj|juh' or 'shepherd|flock|sheep'. Matches ignore case and usually accents. Give explicit preference or mark filters to narrow the scan independently of the song tree. Results are in title order; page with offset.",
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
          ...PREFERENCE_FILTER_FIELDS,
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
          stateFilter: songStateFilter(host, args),
          ...pagingArgs(args, 30, 100),
        });
      },
    },
    {
      name: "query_songs",
      title: "Filter songs by metadata or state",
      description:
        "List songs by metadata (author, artist, composer, copyright, language, kind, key), leader preference, note marker, or local changes. Example: {preference:'preferred'} finds the selected leader's preferred songs; {changedLocally:true} finds songs awaiting sync. Filters combine and are independent of the song-tree toggles. Results are in title order; page with offset. Use get_upload_info for cloud upload facts.",
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
        ...PREFERENCE_FILTER_FIELDS,
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
        "Read a song by ID. Returns ChordPro, metadata, first lyric lines, stated and estimated keys, sections, default instructions, repeated sections, related versions, and cloud upload facts. 'state' reports note marks, local changes and the leader's preference. 'selectedLeaderItem' gives the selected leader's playlist defaults. Pass leader to also get that profile's defaults in 'leaderItem' and its preference in 'state'.",
      inputSchema: object({ songId: { type: "string" }, leader: LEADER_SCHEMA }, ["songId"]),
      access: "read",
      run: async (args, host) => {
        const song = requireSong(host, text(args, "songId"));
        const leaderId = workingLeaderId(host);
        const explicitLeaderId = args.leader === undefined ? undefined : resolveLeader(host, leaderArgument(args), "unique").id;
        const decorate = songStateDecorator(host, explicitLeaderId ?? leaderId ?? undefined, [song.id, ...song.related.map(({ id }) => id)]);
        const { version: _version, ...visible } = decorate(song);
        return {
          ...visible,
          related: song.related.map(decorate),
          metadata: songMetadata(song.text),
          firstLines: lyricsOf(song.text).slice(0, 2),
          ...host.songStructure(song.id),
          keyEstimate: host.songKeyEstimate(song.id),
          ...(leaderId ? { selectedLeaderItem: host.newPlaylistItem(leaderId, song.id) } : {}),
          ...(explicitLeaderId ? { leaderItem: host.newPlaylistItem(explicitLeaderId, song.id) } : {}),
          upload: describeUpload(song, await history(host, song)),
        };
      },
    },
    {
      name: "estimate_song_keys",
      title: "Estimate song keys from the chords",
      description:
        "The key of up to 100 songs estimated from their chords by the app's own key detector (the one behind the key the editor and song view show), independently of the key the song states in its {key} line. Each song gets 'estimatedKey' (null: no recognized chords), 'statedKey' (empty: none), 'agreesWithStatedKey' (same tonic and mode, any spelling), 'statedKeyTonicUsed' (the stated key's tonic chord occurs in the song; false together with a disagreement: the stated key is likely wrong), and 'sectionKeys' only when the key changes inside the song (a lift to a new key, a bridge in the relative minor, a section tag transposition such as {start_of_verse: V +2}): the written and sounding key of every run of chords. Key names follow the song's chord system (German/Hungarian: H, B). It is an estimate: a song that only uses a few chords can be read as its relative minor/major or as a neighbouring key; look at the chords before changing a stated key. get_song and validate_chordpro give the same 'keyEstimate' for one song or text; find_song_problems 'key-mismatch' lists the songs whose stated key is likely wrong.",
      inputSchema: object({ songIds: { type: "array", items: { type: "string" }, description: `Up to ${MAX_KEY_SONGS} song ids.` } }, ["songIds"]),
      access: "read",
      run: (args, host) => {
        const ids = args.songIds;
        if (!Array.isArray(ids) || !ids.length || !ids.every((id) => typeof id === "string"))
          throw new McpToolError("'songIds' must be a list of song ids.");
        if (ids.length > MAX_KEY_SONGS) throw new McpToolError(`At most ${MAX_KEY_SONGS} songs at once.`);
        const songIds = [...new Set(ids as string[])];
        const decorate = songStateDecorator(host, host.selectedLeader()?.id, songIds);
        return {
          songs: songIds.map((id) => {
            const song = decorate(requireSong(host, id));
            return { songId: song.id, title: song.title, state: song.state, ...host.songKeyEstimate(song.id) };
          }),
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
      name: "check_instructions",
      title: "Check playlist instructions",
      description: `Reads an instruction text against a song the way the app does, before you put it on a playlist item: which line plays which section (with repeat count, transposition and the resulting key), which lines are only notes, the text as the app would store it, and which sections are left out. Without instructions it shows the song's own order. ${INSTRUCTIONS_GUIDE}`,
      inputSchema: object(
        {
          songId: { type: "string" },
          instructions: { type: "string", description: "One step per line. Empty or left out: the song's own order." },
          transpose: { type: "integer", minimum: -11, maximum: 11, description: "The playlist item's own transposition, for the keys. Default 0." },
        },
        ["songId"]
      ),
      access: "read",
      run: (args, host) => {
        const song = requireSong(host, text(args, "songId"));
        const structure = host.songStructure(song.id);
        const given = typeof args.instructions === "string" ? args.instructions : "";
        const instructions = given.trim() ? given : (structure?.defaultInstructions ?? "");
        const analysis = host.analyzeInstructions(song.id, instructions);
        if (!structure || !analysis) throw new McpToolError(`There is no song with id '${song.id}'.`);
        const itemTranspose = integer(args, "transpose", 0, -11, 11);
        const keyOf = (transpose: number) => host.songKey(song.id, itemTranspose + transpose) || undefined;
        // Only given instructions get warnings: the song's own comment lines are meant as notes.
        // "Verse 3" falls back to the song's "Verse 1" when no "Verse 3" exists: say so.
        const warnings = given.trim()
          ? analysis.lines.flatMap((line) =>
              line.kind === "section" && !line.exact
                ? [`'${line.line.trim()}' is read as the section '${line.section}'.`]
                : line.kind === "note"
                  ? [
                      `'${line.line.trim()}' names no section of this song, so it is only a note for the musicians. Section names: ${structure.sections.map((s) => s.name).join(", ")}.`,
                    ]
                  : []
            )
          : [];
        const named = new Set(analysis.order.flatMap((step) => ("section" in step ? [foldText(step.section)] : [])));
        // A score named as a whole plays its parts, and a named part plays a part of its score.
        const used = (section: McpSongSection) =>
          named.has(foldText(section.name)) ||
          (!!section.partOf && named.has(foldText(section.partOf))) ||
          structure.sections.some((part) => part.partOf === section.name && named.has(foldText(part.name)));
        return {
          song: infoOf(song),
          instructions: given.trim() ? "as given" : "none given: the song's own order",
          order: analysis.order.map((step) =>
            "section" in step ? { ...step, ...(keyOf(step.transpose) ? { key: keyOf(step.transpose) } : {}) } : step
          ),
          normalized: analysis.normalized,
          ...(warnings.length ? { warnings } : {}),
          unusedSections: structure.sections.filter((section) => !used(section)).map((section) => section.name),
          projector: host.getSettings()?.projectInstructions
            ? "'projectInstructions' is on: the projector follows the instructions of the item (or the song's own order when it has none)."
            : "'projectInstructions' is off: the projector shows every section once in the order of the song text. Tablets and phones follow the instructions while their 'Instructions' button is on.",
        };
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
        "Reads a ChordPro text the way the app does: title, kind, number of sections and lyric lines, metadata, every chord with its class (see check_chords: recognized / chord-shaped / not-a-chord), 'keyEstimate' (the key estimated from the chords, see estimate_song_keys; useful for the {key} line of a new song), and 'repeatedSections': sections written out more than once, which should be written once and repeated with a comment line naming them ({c: Chorus}) or with playlist instructions. Use it on a text before import_song and fix what is not recognized.",
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
        "Scans the whole database for songs that need attention: chords the app does not recognize (so they are not transposed reliably), bracket texts that are not chords, words in grid sections (grids hold bare chords and separators only; the app would transpose letters of such words), songs with chords but no stated key, songs whose stated key disagrees with the key estimated from their chords and whose chords never include the stated key's tonic chord ('key-mismatch', see estimate_song_keys; check the chords before changing the key), songs without a title or without lyrics. Returns totals per problem and the affected songs in title order (page with offset). A large database may need more than one call to finish: the answer says so. The user fixes a song by opening it in the editor.",
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
        const result = findSongProblems(host, wanted.length ? wanted : SONG_PROBLEMS, pagingArgs(args, 40, 200), Date.now, problemCache);
        return { ...result, songs: withSongStates(host, host.selectedLeader()?.id, result.songs) };
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
      name: "list_song_preferences",
      title: "Read a leader's saved song preferences",
      description:
        "List the selected or named leader's preferred songs, ignored songs and active song overrides. For 'my favorite songs' use {type:'preferred'}. 'neutral' includes songs with saved performance overrides and no preference type. Use query_songs for all neutral songs or to combine preference with metadata filters. Use get_song with leader for full instructions.",
      inputSchema: object(PREFERENCE_LIST_FIELDS),
      outputSchema: PREFERENCE_LIST_OUTPUT,
      access: "read",
      run: listSongPreferences,
    },
    {
      name: "set_song_preference",
      title: "Set a song preference for one or more songs",
      description:
        "Set an own leader profile's preferred, ignored or neutral state for 1–50 songs in one call. Use actual song IDs and one type, for example {songIds:['s1','s2'],type:'preferred'}. Use neutral to clear the preference type. The leader's other performance defaults stay intact.",
      inputSchema: object(PREFERENCE_SET_FIELDS, ["songIds", "type"]),
      outputSchema: PREFERENCE_SET_OUTPUT,
      access: "write",
      serialize: () => "song-preferences",
      prepare: prepareSongPreference,
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
          songs: withSongStates(host, leader.id, page.items),
        };
      },
    },
    {
      name: "get_playlist",
      title: "Read the working playlist",
      description:
        "Reads the working playlist open in the app and shared with participants in the local session. 'source' identifies its stored origin and whether the content still matches. Use the revision for insert_playlist_items, edit_playlist or replace_playlist. Use get_stored_playlist to read a leader's calendar or favorite playlist.",
      inputSchema: NO_ARGS,
      access: "read",
      run: (_args, host) => workingPlaylistView(host),
    },
    {
      name: "insert_playlist_items",
      title: "Insert songs into the working playlist",
      description:
        'Inserts an ordered array of 1–50 song items into the working playlist open in the app, using the required revision from get_playlist and each songId from a song lookup. Omit position to append or use a zero-based index through the current length. For five songs at the start, call once with {"revision":"2-1d707a53","position":0,"items":[{"songId":"s1"},{"songId":"s2"},{"songId":"s3"},{"songId":"s4"},{"songId":"s5"}]}, using real IDs and the current revision. Duplicates are kept. Omitted item fields inherit selected-leader defaults. The insertion is one undo step (Ctrl+Z) and keeps the stored origin, selection and projection. Use edit_playlist for moves, removals or updates, and edit_stored_playlist for a stored list.',
      inputSchema: INSERT_PLAYLIST_SCHEMA,
      outputSchema: INSERT_PLAYLIST_OUTPUT_SCHEMA,
      access: "write",
      serialize: () => "working-playlist",
      prepare: preparePlaylistInsertion,
    },
    {
      name: "replace_playlist",
      title: "Replace the working playlist",
      description:
        "Replaces the entire working playlist with the supplied song items and clears its stored origin. Pass the revision when get_playlist has been read. Items without title, transpose, capo or instructions inherit the selected leader's defaults. The user can undo the replacement with Ctrl+Z. Use insert_playlist_items to add songs, edit_playlist to change rows, or create_stored_playlist to prepare a stored list.",
      inputSchema: object(
        {
          items: { type: "array", items: PLAYLIST_ITEM_SCHEMA },
          revision: { type: "string", description: "Optional: the revision from get_playlist; nothing happens if the list changed meanwhile." },
        },
        ["items"]
      ),
      access: "write",
      destructiveHint: true,
      serialize: () => "working-playlist",
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
        "Changes the working list in place, as the user's own playlist edits do: one undo step (Ctrl+Z), and the list keeps the stored list it came from, so the app still reminds the user to save the change there. Operations run in order, each on the result of the previous one (0-based indexes): add {songId, position?, title?, transpose?, capo?, instructions?, storeInProfile?}, remove {index}, move {from, to}, update {index, title?, transpose?, capo?, instructions?, storeInProfile?}; an empty title in update restores the song's own title. Check instructions with check_instructions first; storeInProfile also keeps them as the selected leader's instructions for the song. New items get the selected leader's settings for the song where not given. Nothing is selected or projected; when the song on display is updated, its new key, capo and section order show on the screens at once. A changed title, transposition or capo also becomes the selected leader's song setting together with the item's instructions, as far as the leader-profile setting allows (as with the playlist's own controls). Ctrl+Z restores the playlist, not the leader's profile. Pass the revision from get_playlist: if the list changed meanwhile, nothing happens and you get the new revision.",
      inputSchema: object(
        {
          revision: { type: "string", description: "The revision from get_playlist." },
          operations: { type: "array", items: OPERATION_SCHEMA },
        },
        ["revision", "operations"]
      ),
      access: "write",
      serialize: () => "working-playlist",
      confirmation: (args, host) => `Change the current playlist like this?\n\n${workingEdit(host, args).summary}`,
      run: async (args, host) => {
        const edit = workingEdit(host, args);
        await host.editPlaylist(edit.items, edit.sources, edit.storeInstructions);
        return workingEditView(host);
      },
    },
    {
      name: "load_playlist",
      title: "Load a playlist",
      description:
        "Loads a playlist into the working list, replacing it, as the Load button does: a leader's calendar day (date) or favorite (favorite), public leaders' lists included, or a playlist file the user picks in the app's file dialog (file: true). The user can undo it with Ctrl+Z in the playlist.",
      inputSchema: object({ ...STORED_REF_SCHEMA, file: { type: "boolean", description: "Let the user pick a playlist file." } }),
      access: "write",
      destructiveHint: true,
      serialize: (args) => (args.file === true ? undefined : "working-playlist"),
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
      description:
        "The song loaded for projection, its sections (slides) with their text, which section is on the projector now, the instructions of the item on display, and whether the projector follows them ('projectInstructions'; see check_instructions).",
      inputSchema: NO_ARGS,
      access: "read",
      run: (_args, host) => host.getProjection(),
    },
    {
      name: "open_view",
      title: "Open a dialog in the app",
      description:
        "Opens the requested dialog in the user's app: settings (optionally on a page), sessions, database synchronization, the import wizard, songs waiting for review (song-check), or the tutorial.",
      inputSchema: object(
        {
          target: { type: "string", enum: VIEW_TARGETS },
          page: { type: "string", enum: SETTINGS_PAGES, description: "Settings page, only for target=settings." },
        },
        ["target"]
      ),
      access: "read",
      readOnlyHint: false,
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
        "Read the current view, panel, open dialogs, selected song, and song library query, filters and sort order when the full-view library is available. Use this before giving screen-specific directions.",
      inputSchema: NO_ARGS,
      access: "read",
      run: (_args, host) => {
        const ui = host.getUiState();
        if (!ui.selectedSong) return ui;
        const decorate = songStateDecorator(host, host.selectedLeader()?.id, [ui.selectedSong.id]);
        return { ...ui, selectedSong: decorate(ui.selectedSong) };
      },
    },
    {
      name: "show_in_app",
      title: "Point at something in the app",
      description:
        "Highlights a button or panel on the user's screen for a few seconds and brings its panel forward, so the user sees where it is. The target is a 'targets' id of a help topic (search_help, get_help_topic), e.g. 'full/profile-database'. Prefer this over describing positions in words.",
      inputSchema: object({ target: { type: "string", description: "A target id from a help topic." } }, ["target"]),
      access: "read",
      readOnlyHint: false,
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
        "Check common installation problems, including local changes pending synchronization and library filters that can hide songs. Gives a suggested app action for each finding.",
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
    read: () => renderHelpMarkdown(buildHelpTopics(content.help, language)),
  });
  return [guide("en"), guide("hu")];
}
