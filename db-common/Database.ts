import { cloneJson } from "./cloneJson";
import { Song, songStoreCodec } from "./Song";
import { Playlist } from "./Playlist";
import { SongPreference } from "./SongPreference";
import { Leader } from "./Leader";
import { Leaders } from "./Leaders";
import { SongWords } from "./SongWords";
import { StringExtensions } from "./StringExtensions";
import { TypesenseClient } from "../common/typesense-client";
import { PlaylistEntry } from "./PlaylistEntry";
import { cloudApi } from "../common/cloudApi";
import { formatLocalDateLabel, parseScheduleDate } from "../common/date-only";
import { favoriteLabel, hasFavoriteLabel, isFavoriteScheduleDate } from "../common/favorite-playlists";
import { LeaderDBProfile, SongDBEntryWithData, SongFoundType } from "../common/pp-types";
import { leaderDBProfileCodec, leadersResponseCodec, uniType } from "../common/pp-codecs";
import { decode, parseAndDecode } from "../common/io-utils";
import * as t from "io-ts";
import { TinyEmitter } from "tiny-emitter";
import { databaseStorage, getStorageKey } from "./DatabaseStorage";
import { matchesSongLanguage } from "../common/song-language";
import { validateDatabaseState } from "./validateDatabaseState";

export interface DatabaseSettings {
  searchMethod?: "traditional" | "typesense";
  typesenseUrl: string;
  typesenseApiKey: string;
  searchMaxResults?: number;
  traditionalSearchCaseSensitive?: boolean;
  traditionalSearchWholeWords?: boolean;
  useTextSimilarities?: boolean;
  songLanguageFilter?: readonly string[] | null;
}
// --- MinHash hash coefficients (deterministic LCG-generated) ---
const MINHASH_NUM_HASHES = 64;
const MINHASH_SHINGLE_SIZE = 3;
const MINHASH_COEFFS = (() => {
  const a: number[] = [];
  const b: number[] = [];
  let seed = 1234567;
  const next = () => {
    seed = (Math.imul(seed, 1103515245) + 12345) >>> 0;
    return seed;
  };
  for (let i = 0; i < MINHASH_NUM_HASHES; i++) {
    a.push((next() % 2147483646) + 1);
    b.push(next() % 2147483647);
  }
  return { a, b };
})();

function baseHash(str: string): number {
  let h = 0;
  for (let i = 0; i < str.length; i++) {
    h = (Math.imul(31, h) + str.charCodeAt(i)) | 0;
  }
  return h >>> 0;
}

function computeSignature(text: string): number[] {
  const simplified = StringExtensions.simplify(text);
  const sig = new Array<number>(MINHASH_NUM_HASHES).fill(0xffffffff);
  const len = simplified.length;

  for (let i = 0; i <= len - MINHASH_SHINGLE_SIZE; i++) {
    const h = baseHash(simplified.substring(i, i + MINHASH_SHINGLE_SIZE));
    for (let j = 0; j < MINHASH_NUM_HASHES; j++) {
      const mh = (Math.imul(MINHASH_COEFFS.a[j], h) + MINHASH_COEFFS.b[j]) >>> 0;
      if (mh < sig[j]) sig[j] = mh;
    }
  }
  return sig;
}

function compareSignatures(sig1: number[], sig2: number[]): number {
  let match = 0;
  for (let i = 0; i < MINHASH_NUM_HASHES; i++) {
    if (sig1[i] === sig2[i]) match++;
  }
  return match / MINHASH_NUM_HASHES;
}

const databaseSongBackupMapEntryCodec = t.tuple([
  t.string,
  t.type({
    version: t.number,
    song: songStoreCodec,
  }),
]);

const databaseProfileBackupMapEntryCodec = t.tuple([
  t.string,
  t.type({
    version: t.number,
    leader: leaderDBProfileCodec,
  }),
]);

export enum FoundReason {
  None,
  Title,
  Header,
  Lyrics,
  Words,
  Meta,
}

export function FormatFoundReason(reason: FoundReason): SongFoundType {
  switch (reason) {
    case FoundReason.Title:
      return "TITLE";
    case FoundReason.Header:
      return "HEAD";
    case FoundReason.Lyrics:
      return "LYRICS";
    case FoundReason.Words:
      return "WORDS";
    case FoundReason.Meta:
      return "META";
    default:
      return "NONE";
  }
}

export function ParseFoundReason(value: SongFoundType): FoundReason {
  switch (value) {
    case "TITLE":
      return FoundReason.Title;
    case "HEAD":
      return FoundReason.Header;
    case "LYRICS":
      return FoundReason.Lyrics;
    case "WORDS":
      return FoundReason.Words;
    case "META":
      return FoundReason.Meta;
    default:
      return FoundReason.None;
  }
}

export class SongFound implements IComparable<SongFound> {
  public readonly song: Song;
  public readonly preference: SongPreference;
  public readonly reason: FoundReason;
  public readonly cost: number;
  public readonly snippet?: string; // HTML with <mark> tags showing matched text

  constructor(s: Song, p: SongPreference | null, r: FoundReason, c: number, snippet?: string) {
    this.song = s;
    this.reason = r;
    this.cost = c;
    this.snippet = snippet;
    this.preference = p ?? new SongPreference(s.Id);
  }

  compareTo(o: SongFound): number {
    const i = this.reason - o.reason;
    if (i !== 0) return i;
    if (this.cost === o.cost) return this.song.Title.localeCompare(o.song.Title);
    return this.cost < o.cost ? -1 : 1;
  }
}

export class SongFoundList extends Array<SongFound> {
  private set = new Set<Song>();

  contains(song: Song): boolean {
    return this.set.has(song);
  }

  addSong(song: Song, reason: FoundReason, cost: number, leader: Leader | null, snippet?: string) {
    this.set.add(song);
    this.push(new SongFound(song, leader?.getPreference(song.Id) ?? null, reason, cost, snippet));
  }

  /**
   * Shallow copy of the list (SongFound entries are immutable and shared).
   * Used by the filter cache so callers can never mutate a cached instance's
   * array container (splice/sort) and corrupt subsequent cache hits.
   */
  clone(): SongFoundList {
    const copy = new SongFoundList();
    for (const item of this) {
      copy.push(item);
      copy.set.add(item.song);
    }
    return copy;
  }
}

export enum SongOrder {
  Alphabetical,
  MoreRecent,
  LessCostMatch,
}

type SongIdFilter = readonly string[] | ReadonlySet<string>;

interface IComparable<T> {
  compareTo(other: T): number;
}

export class FilterData {
  private normalized: string;
  private wholeWords: boolean;
  private caseSensitive: boolean;
  private useTextSimilarities: boolean;
  private lastWordIsPrefix: boolean;
  private _simplified: string | null = null;
  private _words: string[] | null = null;
  private matches: WordMatch[] | null = null;
  private songWordsVersion = 0;

  public get Normalized(): string {
    return this.normalized;
  }

  public get Simplified(): string {
    if (this._simplified === null) {
      this._simplified = StringExtensions.simplify(this.normalized, this.caseSensitive);
    }
    return this._simplified;
  }

  public get Words(): string[] {
    if (this._words === null) {
      this._words = this.Simplified.split(" ").filter(Boolean);
    }
    return this._words;
  }

  constructor(
    expr: string,
    options?: {
      caseSensitive?: boolean;
      wholeWords?: boolean;
      useTextSimilarities?: boolean;
      lastWordIsPrefix?: boolean;
    }
  ) {
    this.wholeWords = options?.wholeWords ?? false;
    this.caseSensitive = options?.caseSensitive ?? false;
    this.useTextSimilarities = options?.useTextSimilarities ?? true;
    this.lastWordIsPrefix = options?.lastWordIsPrefix ?? false;
    this.normalized = StringExtensions.minimizeSpaces(this.caseSensitive ? expr : expr.toLowerCase());
  }

  matchesTo(songWords: SongWords): ReadonlyArray<WordMatch> {
    if (this.matches === null || this.songWordsVersion !== songWords.version) {
      const filters: WordMatch[] = [];
      let i = 0;
      const words = this.Words;
      const l = words.length;

      while (i < l) {
        const word = words[i++]!;
        const m = new WordMatch(word);

        const allowPrefixBonus = i === l && !this.wholeWords && this.lastWordIsPrefix;
        const prefixCost = this.useTextSimilarities ? 0.01 : 0.0;
        const allowedMaxCost = this.useTextSimilarities ? Math.max(word.length >= 3 ? 1.5 : 0.0, 0.9) : 0.0;
        const prefixMaxCost = this.useTextSimilarities ? (word.length <= 2 ? 0.9 : word.length === 3 ? 1.0 : word.length === 4 ? 1.2 : 1.5) : 0.0;

        if (this.caseSensitive) {
          for (const sp of songWords.caseSensitiveMatches(word, allowPrefixBonus, allowPrefixBonus ? prefixMaxCost : allowedMaxCost)) {
            m.add(sp.song, sp.pos, sp.cost);
          }
        } else if (allowPrefixBonus) {
          // For the actively typed last token, enforce prefix semantics.
          // With text similarities enabled, allow fuzzy matching against word prefixes only.
          // This keeps incremental typing monotonic while still tolerating small typos/accents.
          const prefixResults = this.useTextSimilarities
            ? songWords.fuzzyPrefixMatches(word, prefixMaxCost)
            : songWords.prefixMatches(word, prefixCost);
          for (const sp of prefixResults) {
            m.add(sp.song, sp.pos, sp.cost);
          }
        } else {
          const aiResults = songWords.aiMatches(m.word, false, allowedMaxCost);
          for (const sp of aiResults) {
            m.add(sp.song, sp.pos, sp.cost);
          }
        }

        const maxWordCost = allowPrefixBonus ? (this.useTextSimilarities ? prefixMaxCost : prefixCost) : allowedMaxCost;
        m.filterPositions(maxWordCost);
        // Keep an empty term: every query word must match, including unknown words.
        filters.push(m);
      }
      this.songWordsVersion = songWords.version;
      this.matches = filters;
    }
    return this.matches;
  }
}

class WordMatch {
  word: string;
  private positions: Map<string, Map<number, number>>;

  constructor(s: string) {
    this.word = s;
    this.positions = new Map<string, Map<number, number>>();
  }

  add(song: Song, pos: number, cost: number) {
    let d = this.positions.get(song.Id);
    if (!d) {
      d = new Map<number, number>();
      this.positions.set(song.Id, d);
    }
    d.set(pos, cost);
  }

  getSongPositions(songId: string): Map<number, number> | undefined {
    return this.positions.get(songId);
  }

  get empty(): boolean {
    return this.positions.size === 0;
  }

  filterPositions(maxCost: number) {
    const ps = new Map<string, Map<number, number>>();
    for (const [songId, posMap] of this.positions.entries()) {
      const filtered = new Map<number, number>();
      for (const [pos, cost] of posMap.entries()) {
        if (cost <= maxCost) {
          filtered.set(pos, cost);
        }
      }
      if (filtered.size > 0) {
        ps.set(songId, filtered);
      }
    }
    this.positions = ps;
  }
}

/** Text regions a snippet can be taken from; each one owns a distinct word-position range. */
type SnippetRegion = "lyrics" | "title" | "meta";

/** A save of an account whose database never loaded (it was reported as unreadable). */
export class DatabaseNotOpenError extends Error {
  constructor(username: string) {
    super(`The database of "${username}" is not open; it could not be loaded`);
    this.name = "DatabaseNotOpenError";
  }
}

/** A queued account switch whose requester no longer wants it (see Database.switchUser). */
export class DatabaseSwitchSupersededError extends Error {
  constructor(username: string) {
    super(`The switch to the database of "${username}" was superseded`);
    this.name = "DatabaseSwitchSupersededError";
  }
}

class Database {
  public static readonly importExportCodec = uniType(
    {
      version: t.number,
      songs: t.array(songStoreCodec),
      leaders: leadersResponseCodec,
    },
    {
      songBackup: t.array(databaseSongBackupMapEntryCodec),
      profileBackup: t.array(databaseProfileBackupMapEntryCodec),
      publicLeaders: leadersResponseCodec,
      retainedSongs: t.array(t.unknown),
    }
  );

  private static isDevValidationEnabled(): boolean {
    const env = (import.meta as ImportMeta & { env?: { DEV?: boolean } }).env;
    return !!env?.DEV;
  }

  private static instance: Database;
  private static currentUsername: string = "";
  private static initPromise: Promise<Database> | null = null;
  private static isInitialized: boolean = false;
  private static switchPromise: Promise<Database> | null = null;
  public emitter = new TinyEmitter();
  private songs: Map<string, Song> = new Map();
  public leaders: Leaders = new Leaders();
  /** Read-only mirror of other leaders' profiles fetched from GET /leaders.
   *  Kept separate from `leaders` so they never enter sync upload / conflict
   *  resolution; refreshed wholesale by updatePublicLeaders(). */
  private publicLeaders: Leaders = new Leaders();
  /** Public-profile refreshes can overlap (for example a background sync and the
   *  load dialog's manual refresh). An older response cannot overwrite a newer
   *  applied one; ordinary background callers share an already-running request. */
  private publicLeaderRefreshPromise: Promise<boolean> | null = null;
  private publicLeaderRefreshSequence = 0;
  private publicLeaderAppliedSequence = 0;
  public words: SongWords = new SongWords();
  private typesense: TypesenseClient | null = null;

  // --- Filter result cache (LRU) ---------------------------------------------
  // Song filtering (fuzzy Damerau-Levenshtein over every song/word) is the most
  // CPU-intensive read in the app and is re-run on every keystroke, filter-flag
  // toggle, and `db-updated` event — often with a query that was already
  // evaluated moments ago (e.g. backspacing, or the same list re-requested by a
  // sibling panel). We memoize the SongFoundList keyed by all inputs that affect
  // the result. The whole cache is invalidated on any data mutation (see
  // invalidateFilterCache callers), so a hit is always as correct as a recompute.
  private static readonly FILTER_CACHE_MAX = 32;
  private static readonly FILTER_CACHE_MAX_IDS = 500; // don't build huge keys for large songId sets
  private filterCache = new Map<string, SongFoundList>();
  // Bumped on every invalidation so an in-flight async (typesense) filter can
  // detect that data changed under it and decline to cache a now-stale result.
  private filterCacheEpoch = 0;

  /** Drop all memoized filter results. Called from every mutation entry point. */
  public invalidateFilterCache(): void {
    this.filterCacheEpoch++;
    if (this.filterCache.size) this.filterCache.clear();
  }

  private songToTypesenseInfo(song: Song) {
    return { id: song.Id, version: song.version, text: song.Text, language: song.Language };
  }

  public verifySearchEngine(settings: DatabaseSettings | null) {
    const typesenseEnabled = settings?.searchMethod === "typesense";
    if (typesenseEnabled && !this.typesense) {
      this.ensureTypesenseInit(settings);
      this.updateSearchEngine();
    } else if (!typesenseEnabled && this.typesense) {
      this.typesense = null;
      this.updateSearchEngine();
    }
  }

  private updateSearchEngine(newSongs?: Song[]) {
    this.invalidateFilterCache();
    if (this.typesense) {
      const songs = newSongs ?? this.getSongs();
      this.typesense.update(songs.map((s) => this.songToTypesenseInfo(s))).catch((error) => {
        console.error("Database", "Failed to rebuild Typesense index", error);
      });
    } else if (newSongs) {
      for (const song of newSongs) {
        this.words.add(song);
      }
    } else this.words.rebuild(this.getSongs());
  }

  private addSongToSearchEngine(song: Song) {
    this.invalidateFilterCache();
    if (this.typesense)
      this.typesense.update([this.songToTypesenseInfo(song)]).catch((error) => {
        console.error("Database", "Failed to update Typesense index", error);
      });
    else this.words.add(song);
  }

  private removeSongFromSearchEngine(_song: Song) {
    this.invalidateFilterCache();
    // Typesense non-existing results are filtered at search time
    this.words.remove(_song);
  }
  private leaderFilters: Map<Leader, Set<Song>> = new Map();
  // Backup of original songs before user modification (version !== current when edited)
  private songBackup: Map<string, { version: number; song: Song }> = new Map();
  // Backup of original leader profiles before user modification
  private profileBackup: Map<string, { version: number; leader: Leader }> = new Map();
  public version = 0;
  public autoSave = true;
  private savePromise: Promise<void> | null = null;
  // Tracks whether in-memory data has been modified since last load/save.
  // Used by switchUser to avoid writing an empty/unchanged instance over existing storage.
  private isDirty = false;
  private persistenceReady = false;
  // Replaced by an account switch (drained before that). A later save, from work
  // still holding the old instance (a network refresh, a sync merge), goes to
  // its own account against its own baseline, as in earlier versions; only
  // while that account is open again in a newer instance is it dropped.
  private retired = false;
  // Its account was replaced by an import; the page reloads to open the import.
  private supersededByImport = false;
  // Stored song entries shadowed by a later entry with the same id: never live,
  // but stored again on every save so no stored song is lost.
  private retainedSongs: unknown[] = [];
  // Distinguishes an instance that never loaded (holds nothing of the user's)
  // from one whose reload failed (keeps its earlier data and unsaved edits).
  private loadedOnce = false;
  private mutationSequence = 0;

  // Per-instance username: captures the username this instance belongs to,
  // so saves always target the correct storage key even if the static
  // currentUsername has been changed by a concurrent switchUser call.
  private readonly instanceUsername: string;

  private get storageKey(): string {
    return getStorageKey(this.instanceUsername);
  }

  private constructor(username: string = "") {
    this.instanceUsername = username;
  }

  /**
   * Initialize the database asynchronously.
   * This should be called once at app startup.
   */
  public static async initialize(username: string = ""): Promise<Database> {
    if (Database.initPromise) {
      return Database.initPromise;
    }
    // Never load a second instance beside a queued or completed switch: go
    // through the switch queue instead (it returns the current instance when
    // that account is already active).
    if (Database.switchPromise || (Database.isInitialized && Database.instance)) {
      return Database.switchUser(username);
    }

    Database.initPromise = (async () => {
      Database.currentUsername = username;
      Database.instance = new Database(username);

      // Load from IndexedDB
      await Database.instance.loadAsync();
      Database.isInitialized = true;
      Database.lastInitFailure = null;

      console.info("Database", `Initialized for user: "${username || "(anonymous)"}"`);
      return Database.instance;
    })().catch((error) => {
      Database.initPromise = null;
      Database.isInitialized = false;
      Database.lastInitFailure = username;
      throw error;
    });

    return Database.initPromise;
  }

  /**
   * Get the database instance.
   * IMPORTANT: Call initialize() first at app startup.
   * This returns the current instance synchronously.
   */
  public static getInstance(): Database {
    if (!Database.instance) {
      // Create empty instance - caller should have called initialize() first
      console.warn("Database", "getInstance called before initialize - returning empty database");
      Database.instance = new Database(Database.currentUsername);
    }
    return Database.instance;
  }

  /**
   * Check if database is initialized
   */
  public static isReady(): boolean {
    return Database.isInitialized;
  }

  /**
   * Wait for database to be ready
   */
  // The account whose initialization failed: waitForReady does not reload it
  // for every consumer (each would repeat the failing load); a switch retries.
  private static lastInitFailure: string | null = null;

  public static async waitForReady(): Promise<Database> {
    // If a user switch is in progress, wait for it to finish first. A failed or
    // superseded switch leaves the current account active and valid.
    if (Database.switchPromise) {
      try {
        return await Database.switchPromise;
      } catch {
        if (Database.isInitialized && Database.instance) return Database.instance;
      }
    }
    if (Database.initPromise) {
      return Database.initPromise;
    }
    // If already initialized (e.g., after switchUser), return the instance
    if (Database.isInitialized && Database.instance) {
      return Database.instance;
    }
    if (Database.lastInitFailure === Database.currentUsername && Database.instance) return Database.instance;
    // If not initialized yet, initialize with empty username
    return Database.initialize();
  }

  /**
   * Switch to a different user's database.
   * This saves the current database, clears the instance, and loads the new user's data.
   * Serialized: concurrent calls are queued so only one switch runs at a time,
   * preventing a partially-loaded (empty) instance from being saved over existing data.
   *
   * `isCurrent` is checked in the queue right before the switch starts and
   * right before the loaded account is published: once it returns false (e.g.
   * the sign-in that asked for this account was superseded), the switch is
   * abandoned with DatabaseSwitchSupersededError and the current account stays.
   */
  public static async switchUser(username: string, options: { isCurrent?: () => boolean } = {}): Promise<Database> {
    const nextUsername = username || "";
    const checkCurrent = () => {
      if (options.isCurrent && !options.isCurrent()) throw new DatabaseSwitchSupersededError(nextUsername);
    };
    // Attach to the queue before yielding; multiple waiting callers must not
    // start switches concurrently when the previous operation finishes.
    const task = (Database.switchPromise ?? Promise.resolve())
      .catch(() => {})
      .then(async () => {
        // A failed initialization (e.g. an unreadable guest database) must not
        // also block switching to another account.
        if (Database.initPromise) await Database.initPromise.catch(() => {});
        if (Database.isInitialized && Database.instance && Database.currentUsername === nextUsername) return Database.instance;
        checkCurrent();

        const previous = Database.instance;
        const drainPrevious = async () => {
          if (!previous) return;
          if (!previous.persistenceReady) {
            await previous.savePromise?.catch(() => {});
            // After a failed reload the earlier data and unsaved edits are still
            // in memory but cannot be saved: refuse to switch rather than drop them.
            if (previous.loadedOnce && previous.isDirty) {
              throw new Error("Unsaved changes cannot be stored after a failed reload; switch refused");
            }
            // It never loaded: it holds nothing of the user's, so its failing
            // saves must not block the switch.
            return;
          }
          while (previous.savePromise || previous.isDirty) {
            if (previous.savePromise) await previous.savePromise;
            else await previous.forceSaveAsync();
          }
        };
        await drainPrevious();

        // Publish the new account only after every entity loads successfully.
        // A failed load leaves the previous account and its in-memory edits intact.
        const next = new Database(nextUsername);
        try {
          await next.loadAsync();
          // Edits may arrive while the next account is loading. Drain those too
          // before releasing the previous instance from the application.
          await drainPrevious();
          // Nothing is awaited between this check and the publication below.
          checkCurrent();
        } catch (error) {
          next.persistenceReady = false;
          databaseStorage.release(nextUsername, next);
          throw error;
        }
        // The previous instance keeps its own write baseline (see `retired`).
        if (previous) previous.retired = true;
        Database.lastInitFailure = null;
        Database.instance = next;
        Database.currentUsername = nextUsername;
        Database.initPromise = null;
        Database.isInitialized = true;
        if (typeof window !== "undefined") window.dispatchEvent(new CustomEvent("pp-database-switched"));
        next.emitter.emit("db-updated");
        return next;
      });
    Database.switchPromise = task;
    try {
      return await task;
    } finally {
      if (Database.switchPromise === task) Database.switchPromise = null;
    }
  }

  /**
   * After an import replaced these accounts in storage: the open instance of
   * one of them stops saving (its state must not go over the import; the page
   * reloads to open it) instead of failing every save until then.
   */
  public static supersedeByImport(usernames: string[]): void {
    const current = Database.instance;
    if (current && usernames.map((name) => name || "").includes(current.instanceUsername)) current.supersededByImport = true;
  }

  /**
   * Get the current username
   */
  public static getCurrentUsername(): string {
    return Database.currentUsername;
  }

  /**
   * Async load from IndexedDB storage
   */
  private async loadAsync(): Promise<void> {
    try {
      console.debug("Database", `Loading from storage key: ${this.storageKey}`);

      const loadCodec = uniType(
        {
          version: t.number,
          songs: t.array(t.unknown),
          leaders: t.array(t.unknown),
        },
        {
          songBackup: t.array(t.tuple([t.string, t.type({ version: t.number, song: t.unknown })])),
          profileBackup: t.array(t.tuple([t.string, t.type({ version: t.number, leader: t.unknown })])),
          publicLeaders: t.array(t.unknown),
          retainedSongs: t.array(t.unknown),
        }
      );

      const dbState = await databaseStorage.load<unknown>(this.instanceUsername || undefined, this);

      if (dbState) {
        const validatedState = decode(loadCodec, dbState);
        this.applyDbState(validatedState);
      } else {
        this.applyDbState({ songs: [], leaders: [] });
      }
      this.persistenceReady = true;
      this.loadedOnce = true;
      this.isDirty = false;
    } catch (error) {
      this.persistenceReady = false;
      databaseStorage.release(this.instanceUsername, this);
      console.error("Database", "Failed to load data from IndexedDB", error);
      // Callers (e.g. the auth context at startup) may continue with another
      // account's database; the user must learn that this one was not opened.
      if (typeof window !== "undefined") {
        window.dispatchEvent(new CustomEvent("pp-db-load-error", { detail: { username: this.instanceUsername } }));
      }
      throw error;
    }
  }

  /**
   * Apply database state from parsed JSON
   */
  private applyDbState(dbState: {
    version?: number;
    songs?: unknown[];
    leaders?: unknown;
    publicLeaders?: unknown;
    songBackup?: Array<[string, { version: number; song: unknown }]>;
    profileBackup?: Array<[string, { version: number; leader: unknown }]>;
    retainedSongs?: unknown[];
  }): void {
    // Decode everything before replacing any live state. A malformed profile
    // or backup cannot leave an existing instance half reloaded. Duplicates are
    // resolved as in every earlier version (the last song wins, profiles are
    // kept), but nothing is dropped: a shadowed song is retained and stored
    // again, and Leader retains undated or shadowed playlists and preferences.
    // Duplicate sync backups (server originals) are resolved last-wins.
    let duplicates = 0;
    const songs = new Map<string, Song>();
    const songIndex = new Map<string, number>();
    const retainedSongs: unknown[] = cloneJson(dbState.retainedSongs ?? []);
    (dbState.songs ?? []).forEach((item, index) => {
      const song = Song.fromJSON(item);
      const shadowed = songIndex.get(song.Id);
      if (shadowed !== undefined) {
        duplicates++;
        retainedSongs.push(cloneJson(dbState.songs![shadowed]));
      }
      songIndex.set(song.Id, index);
      songs.set(song.Id, song);
    });
    const loadLeader = (input: unknown): Leader => Leader.fromJSON(input);
    const loadLeaders = (input: unknown): Leaders => {
      const leaders = Leaders.fromJSON(input);
      duplicates += leaders.items.length - new Set(leaders.items.map((leader) => leader.id)).size;
      return leaders;
    };
    const leaders = loadLeaders(dbState.leaders ?? []);
    const publicLeaders = loadLeaders(dbState.publicLeaders ?? []);
    const songBackup = new Map<string, { version: number; song: Song }>();
    for (const [songId, entry] of dbState.songBackup ?? []) {
      if (songBackup.has(songId)) duplicates++;
      songBackup.set(songId, { version: entry.version, song: Song.fromJSON(entry.song) });
    }
    const profileBackup = new Map<string, { version: number; leader: Leader }>();
    for (const [leaderId, entry] of dbState.profileBackup ?? []) {
      if (profileBackup.has(leaderId)) duplicates++;
      profileBackup.set(leaderId, { version: entry.version, leader: loadLeader(entry.leader) });
    }
    if (duplicates) console.warn("Database", `${duplicates} duplicate stored songs, profiles or backups were resolved on load`);
    this.songs = songs;
    this.retainedSongs = retainedSongs;
    this.leaders = leaders;
    this.publicLeaders = publicLeaders;
    this.songBackup = songBackup;
    this.profileBackup = profileBackup;
    this.version = dbState.version ?? 0;
    this.updateSearchEngine();
  }

  /**
   * @deprecated Use loadAsync instead. Kept for compatibility during migration.
   */
  private load(): void {
    // Synchronous load is no longer supported - use loadAsync()
    console.warn("Database", "Synchronous load() called - this is deprecated. Use loadAsync() instead.");
  }

  public save(): void {
    this.isDirty = true;
    this.mutationSequence++;
    if (!this.autoSave) return;
    this.forceSave();
  }

  /**
   * Force save to storage (fire-and-forget async save)
   * For synchronous code that needs to trigger a save.
   */
  public forceSave(): void {
    this.isDirty = true;
    // Use fire-and-forget pattern for backwards compatibility
    // forceSaveAsync reports the failure to the user itself.
    this.forceSaveAsync().catch((error) => console.error("Database", "Failed to save data to IndexedDB", error));
  }

  /**
   * Async force save to IndexedDB storage
   */
  public async forceSaveAsync(): Promise<void> {
    this.isDirty = true;
    const sequence = ++this.mutationSequence;
    // Keep the entire chain, including queued writes, visible to switchUser.
    // A failed write remains dirty and may be retried by a later explicit save.
    const task = (this.savePromise ?? Promise.resolve())
      .catch(() => {})
      .then(async () => {
        if (
          this.supersededByImport ||
          (this.retired && Database.instance !== this && Database.instance?.instanceUsername === this.instanceUsername)
        ) {
          // Its account holds an import, or is open in a newer instance: this
          // instance's state must not go over either.
          console.warn("Database", `Ignoring a late save of the replaced database of "${this.instanceUsername}"`);
          return;
        }
        try {
          if (!this.persistenceReady) {
            if (!this.loadedOnce) throw new DatabaseNotOpenError(this.instanceUsername);
            throw new Error("Cannot save a database whose reload failed");
          }
          const dbState = this.persistentState();
          if (Database.isDevValidationEnabled()) {
            parseAndDecode(Database.importExportCodec, JSON.stringify(dbState));
          }
          await databaseStorage.save(dbState, this.instanceUsername || undefined, this);
          if (sequence === this.mutationSequence) this.isDirty = false;
          this.emitter.emit("db-updated");
        } catch (error) {
          console.error("Database", "Failed to save data to IndexedDB", error);
          if (typeof window !== "undefined") {
            // An account that never opened was reported as such on load (an
            // export is impossible then); every other failure is a save error.
            window.dispatchEvent(
              error instanceof DatabaseNotOpenError
                ? new CustomEvent("pp-db-load-error", { detail: { username: this.instanceUsername } })
                : new CustomEvent("pp-db-save-error")
            );
          }
          throw error;
        }
      });
    this.savePromise = task;
    try {
      await task;
    } finally {
      if (this.savePromise === task) this.savePromise = null;
    }
  }

  private static readonly SONG_SIMILARITY_THRESHOLD = 0.6;

  // Get or compute section MinHash signatures for a song (cached on Song._sectionSignatures)
  private getSectionSignatures(song: Song): number[][] {
    if (!song._sectionSignatures) {
      const sections = song.Sections;
      if (sections.length > 0) {
        song._sectionSignatures = sections.map((section) => computeSignature(section.text));
      } else if (song.Simplified.length > 0) {
        // No parsed sections — treat whole simplified text as one section
        song._sectionSignatures = [computeSignature(song.Simplified)];
      } else {
        song._sectionSignatures = [];
      }
    }
    return song._sectionSignatures;
  }

  // Compare two songs using section-level best-match pairing.
  // For each section in the smaller song, find the best-matching section in the larger song.
  // The score is the average of these best matches — order-independent and handles different section counts.
  public compareSongs(songA: Song, songB: Song): number {
    const sigsA = this.getSectionSignatures(songA);
    const sigsB = this.getSectionSignatures(songB);

    if (sigsA.length === 0 || sigsB.length === 0) return 0;

    // Use the song with fewer sections as the "query" side
    const [querySigs, targetSigs] = sigsA.length <= sigsB.length ? [sigsA, sigsB] : [sigsB, sigsA];

    let totalScore = 0;
    for (const qSig of querySigs) {
      let bestMatch = 0;
      for (const tSig of targetSigs) {
        const sim = compareSignatures(qSig, tSig);
        if (sim > bestMatch) bestMatch = sim;
      }
      totalScore += bestMatch;
    }

    return totalScore / querySigs.length;
  }

  public MakeGroup(addedSong: Song, targetSongOrGroupId: Song | string): void {
    const previousGroupId = addedSong.GroupId;
    let targetGroupId: string;

    if (typeof targetSongOrGroupId === "string") {
      targetGroupId = targetSongOrGroupId;
      if (!targetGroupId || targetGroupId === previousGroupId) return;

      addedSong.GroupId = targetGroupId;
      addedSong.version = 0;
    } else {
      if (addedSong.Id === targetSongOrGroupId.Id) return;

      targetGroupId = targetSongOrGroupId.GroupId;
      if (targetGroupId) {
        if (targetGroupId === previousGroupId) return;
        addedSong.GroupId = targetGroupId;
        addedSong.version = 0;
      } else {
        targetGroupId = addedSong.GroupWith(targetSongOrGroupId);
      }
    }

    if (previousGroupId && previousGroupId !== targetGroupId) {
      this.normalizeGroupAfterMemberRemoval(previousGroupId);
    }
    this.forceSave();
  }

  public Ungroup(song: Song): void {
    // The editor keeps a clone of the selected song. Always mutate the
    // canonical database instance; changing only the clone would be lost as
    // soon as the song tree rebuilds from the database.
    const storedSong = this.songs.get(song.Id) ?? song;
    const previousGroupId = storedSong.GroupId;
    if (!previousGroupId) return;

    storedSong.GroupId = "";
    storedSong.version = 0;
    if (storedSong !== song) {
      song.GroupId = "";
      song.version = 0;
    }
    this.normalizeGroupAfterMemberRemoval(previousGroupId);
    this.forceSave();
  }

  private normalizeGroupAfterMemberRemoval(groupId: string): void {
    const remainingSongs = Array.from(this.songs.values()).filter((song) => song.GroupId === groupId);
    if (remainingSongs.length === 1) {
      remainingSongs[0]!.GroupId = "";
      remainingSongs[0]!.version = 0;
      return;
    }

    if (remainingSongs.length < 2 || remainingSongs.some((song) => song.Id === groupId)) return;

    // The anchor itself left the group. Keep the remaining multi-song group
    // intact and promote its first member to be the new named anchor.
    const replacementGroupId = remainingSongs[0]!.Id;
    for (const remainingSong of remainingSongs) {
      remainingSong.GroupId = replacementGroupId;
      remainingSong.version = 0;
    }
  }

  public addSong(song: Song): void {
    this.songs.set(song.Id, song);
    this.addSongToSearchEngine(song);
    this.save();
  }

  public removeSong(songId: string): void {
    const song = this.songs.get(songId);
    if (song) {
      const previousGroupId = song.GroupId;
      this.songs.delete(songId);
      this.words.remove(song);
      this.removeSongFromSearchEngine(song);
      if (previousGroupId) this.normalizeGroupAfterMemberRemoval(previousGroupId);
      this.save();
    }
  }

  public updateSong(updatedSong: Song): void {
    const existing = this.songs.get(updatedSong.Id);
    if (!existing) {
      this.addSong(updatedSong);
      return;
    }

    // Create backup before modifying song (only if it's being marked as updated for the first time)
    if (existing.version !== 0 && updatedSong.version === 0 && !this.songBackup.has(updatedSong.Id)) {
      this.songBackup.set(updatedSong.Id, {
        version: existing.version,
        song: existing.clone(),
      });
      console.debug("Database", `Created song backup for ${updatedSong.Id}`);
    }

    // If the song has been reverted to match the original backup content, restore the
    // server version number and discard the backup so it is no longer treated as modified.
    if (updatedSong.version === 0) {
      const backup = this.songBackup.get(updatedSong.Id);
      if (backup) {
        if (updatedSong.hasSameContent(backup.song)) {
          updatedSong.version = backup.version;
          this.songBackup.delete(updatedSong.Id);
          console.debug("Database", `Song ${updatedSong.Id} reverted to original — restored version ${backup.version}`);
        }
      }
    }

    this.songs.set(updatedSong.Id, updatedSong);
    this.removeSongFromSearchEngine(existing);
    this.addSongToSearchEngine(updatedSong);
    this.save();
  }

  public setSong(song: Song): void {
    // A confirmed server version becomes the baseline for future local edits.
    // Keeping an older backup here would allow a later revert to undo the sync.
    if (song.version > 0) this.clearSongBackup(song.Id);
    this.songs.set(song.Id, song);
    this.addSongToSearchEngine(song);
    this.save();
  }

  public getSong(songId: string): Song | undefined {
    return this.songs.get(songId);
  }

  public getUpdatedSongs(version: number = Number.MAX_VALUE): Song[] {
    const result: Song[] = [];
    for (const song of this.songs.values()) {
      if (song.version === 0 || song.version > version) {
        result.push(song);
      }
    }
    return result;
  }

  public getUpdatedLeaders(version: number = Number.MAX_VALUE): Leader[] {
    const result: Leader[] = [];
    for (const leader of this.leaders.items) {
      if (leader.version === 0 || leader.version > version) {
        result.push(leader);
      }
    }
    return result;
  }

  /** Number of locally-modified songs that have not yet been synced to the cloud (version === 0). */
  public countUpdatedSongs(): number {
    let count = 0;
    for (const song of this.songs.values()) {
      if (song.version === 0) count++;
    }
    return count;
  }

  /** Number of locally-modified leader profiles that have not yet been synced to the cloud (version === 0). */
  public countUpdatedProfiles(): number {
    let count = 0;
    for (const leader of this.leaders.items) {
      if (leader.version === 0) count++;
    }
    return count;
  }

  /**
   * Get backup version of a song
   */
  public getBackupSong(songId: string): { version: number; song: Song } | undefined {
    return this.songBackup.get(songId);
  }

  /**
   * Check if a song has a backup
   */
  public hasBackup(songId: string): boolean {
    return this.songBackup.has(songId);
  }

  /**
   * Get list of updated songs that have backups for user to decide action
   */
  public getUpdatedSongsWithBackups(): Array<{ song: Song; backup: { version: number; song: Song } }> {
    const result: Array<{ song: Song; backup: { version: number; song: Song } }> = [];
    for (const [songId, backup] of this.songBackup.entries()) {
      const song = this.songs.get(songId);
      if (song && song.version === 0) {
        result.push({ song, backup });
      }
    }
    return result;
  }

  /**
   * Revert song to its backup version
   */
  public revertSongFromBackup(songId: string): boolean {
    const backup = this.songBackup.get(songId);
    if (!backup) {
      console.warn("Database", `No backup found for song ${songId}`);
      return false;
    }

    const restoredSong = backup.song.clone();
    restoredSong.version = backup.version;
    this.updateSong(restoredSong);
    this.clearSongBackup(songId);
    console.debug("Database", `Reverted song ${songId} to backup version`);
    return true;
  }

  /**
   * Clear backup for a song
   */
  public clearSongBackup(songId: string): void {
    if (this.songBackup.delete(songId)) {
      console.debug("Database", `Cleared song backup for ${songId}`);
    }
  }

  /**
   * Clear all song backups
   */
  public clearAllSongBackups(): void {
    this.songBackup.clear();
    console.debug("Database", "Cleared all song backups");
  }

  // ── Profile backup methods ─────────────────────────────────────────

  /**
   * Get backup version of a leader profile
   */
  public getBackupLeader(leaderId: string): { version: number; leader: Leader } | undefined {
    return this.profileBackup.get(leaderId);
  }

  /**
   * Check if a leader profile has a backup
   */
  public hasProfileBackup(leaderId: string): boolean {
    return this.profileBackup.has(leaderId);
  }

  /**
   * Get list of updated leaders that have backups for user to decide action
   */
  public getUpdatedLeadersWithBackups(): Array<{ leader: Leader; backup: { version: number; leader: Leader } }> {
    const result: Array<{ leader: Leader; backup: { version: number; leader: Leader } }> = [];
    for (const [leaderId, backup] of this.profileBackup.entries()) {
      const leader = this.leaders.find(leaderId);
      if (leader && leader.version === 0) {
        result.push({ leader, backup });
      }
    }
    return result;
  }

  /**
   * Revert leader profile to its backup version
   */
  public revertLeaderFromBackup(leaderId: string): boolean {
    const backup = this.profileBackup.get(leaderId);
    if (!backup) {
      console.warn("Database", `No backup found for leader ${leaderId}`);
      return false;
    }

    const restoredLeader = backup.leader.clone();
    restoredLeader.version = backup.version;
    this.updateLeader(restoredLeader);
    this.clearProfileBackup(leaderId);
    console.debug("Database", `Reverted leader ${leaderId} to backup version`);
    return true;
  }

  /**
   * Clear backup for a leader profile
   */
  public clearProfileBackup(leaderId: string): void {
    if (this.profileBackup.delete(leaderId)) {
      console.debug("Database", `Cleared profile backup for ${leaderId}`);
    }
  }

  /**
   * Clear all profile backups
   */
  public clearAllProfileBackups(): void {
    this.profileBackup.clear();
    console.debug("Database", "Cleared all profile backups");
  }

  /**
   * Clear all backups (songs and profiles)
   */
  public clearAllBackups(): void {
    this.songBackup.clear();
    this.profileBackup.clear();
    console.debug("Database", "Cleared all backups");
  }

  /**
   * Ensure a profile backup exists for the given leader before any in-place modifications.
   * Called internally by Leader.updatePreference() and Leader.addPlaylist().
   * Idempotent: does nothing if a backup already exists or the leader has version=0.
   */
  public ensureProfileBackup(leaderId: string): void {
    if (this.profileBackup.has(leaderId)) return;
    const leader = this.leaders.find(leaderId);
    if (!leader || leader.version === 0) return;
    this.profileBackup.set(leaderId, {
      version: leader.version,
      leader: leader.clone(),
    });
    console.debug("Database", `Created profile backup for ${leaderId}`);
  }

  public findSimilarSongs(song: Song, sameGroupAlso: boolean): Song[] {
    const results: { song: Song; score: number }[] = [];

    for (const s of this.songs.values()) {
      if (s === song) continue;
      if (!sameGroupAlso && song.GroupId && s.GroupId === song.GroupId) continue;

      const score = this.compareSongs(song, s);
      if (score >= Database.SONG_SIMILARITY_THRESHOLD) {
        results.push({ song: s, score });
      }
    }

    // Sort by score descending — most similar first
    results.sort((a, b) => b.score - a.score);
    return results.map((r) => r.song);
  }

  public updateLeader(leader: Leader): void {
    const existing = this.leaders.find(leader.id);
    if (existing) {
      // A replacement (e.g. the server's newer profile from a sync) knows
      // nothing of the entries retained only locally; they must survive it.
      if (existing !== leader) leader.retainFrom(existing);
      // Create profile backup before modifying (only if being marked as updated for the first time)
      if (existing.version !== 0 && leader.version === 0 && !this.profileBackup.has(leader.id)) {
        this.profileBackup.set(leader.id, {
          version: existing.version,
          leader: existing.clone(),
        });
        console.debug("Database", `Created profile backup for ${leader.id}`);
      }

      // If the leader profile has been reverted to match the original backup content, restore
      // the server version number and discard the backup so it is no longer treated as modified.
      if (leader.version === 0) {
        const backup = this.profileBackup.get(leader.id);
        if (backup && leader.equals(backup.leader)) {
          leader.version = backup.version;
          this.profileBackup.delete(leader.id);
          console.debug("Database", `Leader ${leader.id} reverted to original — restored version ${backup.version}`);
        }
      }

      this.leaders.remove(existing);
    }
    this.leaders.add(leader);
    this.save();
  }

  public needsSync(updateableLeaders?: Set<string>): boolean {
    if (this.getUpdatedSongs().length > 0) return true;

    if (updateableLeaders) {
      for (const leader of this.getUpdatedLeaders()) {
        if (updateableLeaders.has(leader.id)) return true;
      }
    } else {
      if (this.getUpdatedLeaders().length > 0) return true;
    }

    return false;
  }

  public reload(): void {
    // Fire-and-forget async reload
    this.reloadAsync().catch((error) => {
      console.error("Database", "Failed to reload database", error);
    });
  }

  public async reloadAsync(): Promise<void> {
    await this.loadAsync();
  }

  /**
   * Serialize the current database state for backup purposes
   * Used before sync to allow rollback if user cancels with pending conflicts
   */
  public serializeForBackup(): string {
    // Everything restoreFromBackup replaces: a rollback must not drop the
    // public profile mirror, the original-version backups or retained entries.
    return JSON.stringify(this.persistentState());
  }

  /** Everything stored for this account. Profiles are stored with their
   * retained entries (Leader.toStorageJSON), which the sync format omits. */
  private persistentState() {
    const profiles = (leaders: Leaders) => leaders.items.map((leader) => leader.toStorageJSON());
    return {
      version: this.version,
      songs: Array.from(this.songs.values()),
      leaders: profiles(this.leaders),
      publicLeaders: profiles(this.publicLeaders),
      songBackup: Array.from(this.songBackup.entries()),
      profileBackup: Array.from(this.profileBackup.entries(), ([leaderId, entry]) => [
        leaderId,
        { version: entry.version, leader: entry.leader.toStorageJSON() },
      ]),
      ...(this.retainedSongs.length ? { retainedSongs: cloneJson(this.retainedSongs) } : {}),
    };
  }

  /** Export the actual working state, including edits a failed save could not
   * persist. Never export an empty placeholder after a failed initial load. */
  public exportForBackup(): string {
    if (!this.loadedOnce) throw new Error("Cannot export a database that has never loaded successfully");
    const json = this.serializeForBackup();
    validateDatabaseState(json);
    return json;
  }

  /**
   * Restore database state from a backup string
   * Used to rollback if user cancels sync with pending conflicts
   */
  public restoreFromBackup(backupData: string): void {
    try {
      const dbState = decode(Database.importExportCodec, JSON.parse(backupData));

      this.applyDbState(dbState);

      this.isDirty = true;
      this.mutationSequence++;
      this.invalidateFilterCache();
      console.info("Database", `Restored from backup with version ${this.version}`);
    } catch (error) {
      console.error("Database", "Failed to restore from backup", error);
      throw error;
    }
  }

  /**
   * Clear all data from the database (matching C# Database.Clear)
   */
  public clear(): void {
    this.songs.clear();
    this.retainedSongs = [];
    this.leaders = new Leaders();
    this.words = new SongWords();
    this.songBackup.clear();
    this.profileBackup.clear();
    this.version = 0;
    this.isDirty = true;
    this.mutationSequence++;
    this.invalidateFilterCache();
  }

  public addLeader(leader: Leader): void {
    this.leaders.add(leader);
    this.save();
  }

  public getSongById(id: string): Song | undefined {
    return this.songs.get(id);
  }

  public getSongs(): Song[] {
    return Array.from(this.songs.values());
  }

  public getLeaders(): Leader[] {
    return this.leaders.items;
  }

  public typesenseEngineEnabled = false;

  /**
   * Filter songs by query, memoizing the result. See the filterCache field for
   * rationale. On a hit a defensive clone is returned so callers can never
   * corrupt a cached instance. A result is only stored if the cache was not
   * invalidated while an async (typesense) filter was in flight (epoch guard),
   * so a cached entry is always as fresh as a recompute.
   */
  public async filter(
    expr: string,
    leader: Leader | null = null,
    includeItemsWithChords = true,
    includeItemsWithoutChords = true,
    includeScoreOnlyItems = true,
    includeItemsWithNotes = true,
    order: SongOrder = SongOrder.Alphabetical,
    settings?: DatabaseSettings | null,
    songIds?: SongIdFilter | null
  ): Promise<SongFoundList> {
    const cacheKey = this.filterCacheKey(
      expr,
      leader,
      includeItemsWithChords,
      includeItemsWithoutChords,
      includeScoreOnlyItems,
      includeItemsWithNotes,
      order,
      settings,
      songIds
    );

    if (cacheKey !== null) {
      const cached = this.filterCache.get(cacheKey);
      if (cached) {
        // LRU touch: re-insert to mark as most-recently used.
        this.filterCache.delete(cacheKey);
        this.filterCache.set(cacheKey, cached);
        return cached.clone();
      }
    }

    const epochBefore = this.filterCacheEpoch;
    const result = await this.runFilter(
      expr,
      leader,
      includeItemsWithChords,
      includeItemsWithoutChords,
      includeScoreOnlyItems,
      includeItemsWithNotes,
      order,
      settings,
      songIds
    );

    // Only cache if no mutation invalidated the cache during an async filter.
    if (cacheKey !== null && this.filterCacheEpoch === epochBefore) {
      this.filterCache.set(cacheKey, result.clone());
      while (this.filterCache.size > Database.FILTER_CACHE_MAX) {
        const oldest = this.filterCache.keys().next().value;
        if (oldest === undefined) break;
        this.filterCache.delete(oldest);
      }
    }

    return result;
  }

  /** Build a cache key from every input that affects filter output, or null to
   *  bypass caching (e.g. an unusually large explicit songId set). */
  private filterCacheKey(
    expr: string,
    leader: Leader | null,
    includeItemsWithChords: boolean,
    includeItemsWithoutChords: boolean,
    includeScoreOnlyItems: boolean,
    includeItemsWithNotes: boolean,
    order: SongOrder,
    settings?: DatabaseSettings | null,
    songIds?: SongIdFilter | null
  ): string | null {
    let idsSig = "*";
    const idSet = Database.toSongIdSet(songIds);
    if (idSet) {
      if (idSet.size > Database.FILTER_CACHE_MAX_IDS) return null;
      idsSig = Array.from(idSet).sort().join(",");
    }

    const settingsSig = settings
      ? [
          settings.searchMethod ?? "traditional",
          settings.searchMaxResults ?? 0,
          settings.traditionalSearchCaseSensitive ? 1 : 0,
          settings.traditionalSearchWholeWords ? 1 : 0,
          settings.useTextSimilarities === false ? 0 : 1,
          settings.typesenseUrl ?? "",
          settings.typesenseApiKey ?? "",
          JSON.stringify(settings.songLanguageFilter ?? null),
        ].join("")
      : "-";

    return [
      expr,
      leader?.id ?? "",
      includeItemsWithChords ? 1 : 0,
      includeItemsWithoutChords ? 1 : 0,
      includeScoreOnlyItems ? 1 : 0,
      includeItemsWithNotes ? 1 : 0,
      order,
      this.typesenseEngineEnabled ? 1 : 0,
      settingsSig,
      idsSig,
    ].join("");
  }

  private async runFilter(
    expr: string,
    leader: Leader | null,
    includeItemsWithChords: boolean,
    includeItemsWithoutChords: boolean,
    includeScoreOnlyItems: boolean,
    includeItemsWithNotes: boolean,
    order: SongOrder,
    settings?: DatabaseSettings | null,
    songIds?: SongIdFilter | null
  ): Promise<SongFoundList> {
    if (this.typesenseEngineEnabled && settings?.searchMethod === "typesense" && expr.trim()) {
      try {
        const result = await this.typesenseFilter(
          expr,
          leader,
          includeItemsWithChords,
          includeItemsWithoutChords,
          includeScoreOnlyItems,
          includeItemsWithNotes,
          order,
          settings,
          songIds
        );
        this.typesenseFallbackFired = false;
        return result;
      } catch {
        if (!this.typesenseFallbackFired) {
          this.typesenseFallbackFired = true;
          if (typeof window !== "undefined") window.dispatchEvent(new CustomEvent("pp-typesense-fallback"));
        }
        return this.traditionalFilter(
          expr,
          leader,
          includeItemsWithChords,
          includeItemsWithoutChords,
          includeScoreOnlyItems,
          includeItemsWithNotes,
          order,
          settings,
          songIds
        );
      }
    }
    return this.traditionalFilter(
      expr,
      leader,
      includeItemsWithChords,
      includeItemsWithoutChords,
      includeScoreOnlyItems,
      includeItemsWithNotes,
      order,
      settings,
      songIds
    );
  }

  private typesenseInitHash = "";
  private typesenseFallbackFired = false;

  private ensureTypesenseInit(settings: DatabaseSettings) {
    const hash = `${settings.typesenseUrl}|${settings.typesenseApiKey}`;
    if (hash === this.typesenseInitHash) return;
    this.typesenseInitHash = hash;
    try {
      const url = new URL(settings.typesenseUrl);
      this.typesense = new TypesenseClient(
        url.hostname,
        parseInt(url.port) || (url.protocol === "https:" ? 443 : 8108),
        url.protocol.replace(":", ""),
        settings.typesenseApiKey
      );
    } catch {
      this.typesense = null;
    }
  }

  /** Song-tree type filters. Each song has exactly one SongContentKind, so the
   *  "with chords" and "score only" toggles never overlap: a score-only song is
   *  not shown by the chord toggle, and a chord/mixed song not by the score one.
   *  With every content toggle off, the "marked" toggle alone lists the marked
   *  songs of any content kind. */
  private static matchesSongTypeFilter(song: Song, withChords: boolean, textOnly: boolean, scoreOnly: boolean, withNotes: boolean): boolean {
    if (!withChords && !textOnly && !scoreOnly) return withNotes && !!song.Notes;
    if (song.Notes && !withNotes) return false;
    switch (song.ContentKind) {
      case "text":
        return textOnly;
      case "score":
        return scoreOnly;
      default:
        return withChords;
    }
  }

  private static readonly TYPESENSE_TYPE_TO_REASON: Record<string, FoundReason> = {
    TITLE: FoundReason.Title,
    HEAD: FoundReason.Header,
    LYRICS: FoundReason.Lyrics,
    META: FoundReason.Meta,
  };

  private async typesenseFilter(
    expr: string,
    leader: Leader | null,
    includeItemsWithChords: boolean,
    includeItemsWithoutChords: boolean,
    includeScoreOnlyItems: boolean,
    includeItemsWithNotes: boolean,
    order: SongOrder,
    settings: DatabaseSettings,
    songIds?: SongIdFilter | null
  ): Promise<SongFoundList> {
    const res = new SongFoundList();
    const bestBySongId = new Map<string, SongFound>();
    const maxResults = settings.searchMaxResults ?? 0;
    const leaderFilter = leader ? this.leaderFilters.get(leader) : undefined;
    const allowedSongIds = Database.toSongIdSet(songIds);
    if (settings.songLanguageFilter?.length === 0) return res;

    this.ensureTypesenseInit(settings);

    const hits = await this.typesense!.search(
      expr,
      maxResults || undefined,
      allowedSongIds ? [...allowedSongIds] : undefined,
      settings.songLanguageFilter ?? undefined
    );

    for (const hit of hits) {
      if (allowedSongIds && !allowedSongIds.has(hit.songId)) continue;
      const song = this.songs.get(hit.songId);
      if (!song) continue;
      if (!matchesSongLanguage(song.Language, settings.songLanguageFilter ?? null)) continue;

      if (!Database.matchesSongTypeFilter(song, includeItemsWithChords, includeItemsWithoutChords, includeScoreOnlyItems, includeItemsWithNotes))
        continue;
      if (leaderFilter && leaderFilter.has(song)) continue;

      const reason = Database.TYPESENSE_TYPE_TO_REASON[hit.found.type] ?? FoundReason.Lyrics;
      const candidate = new SongFound(song, leader?.getPreference(song.Id) ?? null, reason, hit.found.cost, hit.found.snippet);
      const existing = bestBySongId.get(song.Id);
      if (
        !existing ||
        candidate.reason < existing.reason ||
        (candidate.reason === existing.reason && candidate.cost < existing.cost) ||
        (candidate.reason === existing.reason && candidate.cost === existing.cost && !!candidate.snippet && !existing.snippet)
      ) {
        bestBySongId.set(song.Id, candidate);
      }
    }

    for (const songFound of bestBySongId.values()) {
      res.addSong(songFound.song, songFound.reason, songFound.cost, leader, songFound.snippet);
    }

    // Sorting
    switch (order) {
      case SongOrder.MoreRecent:
        res.sort((f1, f2) => {
          const i = f1.reason - f2.reason;
          if (i !== 0) return i;
          if (f1.song.version !== 0 && f2.song.version !== 0) {
            const d = f2.song.version - f1.song.version;
            if (d !== 0) return d;
          } else if (f1.song.version !== 0) return 1;
          else if (f2.song.version !== 0) return -1;
          return f1.song.Title.localeCompare(f2.song.Title);
        });
        break;
      case SongOrder.Alphabetical:
        res.sort((f1, f2) => {
          const i = f1.reason - f2.reason;
          if (i !== 0) return i;
          return f1.song.Title.localeCompare(f2.song.Title);
        });
        break;
      case SongOrder.LessCostMatch:
      default:
        res.sort((f1, f2) => f1.compareTo(f2));
        break;
    }

    if (maxResults > 0 && res.length > maxResults) {
      res.splice(maxResults);
    }

    return res;
  }

  private traditionalFilter(
    expr: string,
    leader: Leader | null,
    includeItemsWithChords: boolean,
    includeItemsWithoutChords: boolean,
    includeScoreOnlyItems: boolean,
    includeItemsWithNotes: boolean,
    order: SongOrder,
    settings?: DatabaseSettings | null,
    songIds?: SongIdFilter | null
  ): SongFoundList {
    const res = new SongFoundList();
    const maxResults = settings?.searchMaxResults ?? 0; // 0 = unlimited
    const allowedSongIds = Database.toSongIdSet(songIds);
    const candidates = allowedSongIds
      ? Array.from(allowedSongIds, (songId) => this.songs.get(songId)).filter((song): song is Song => !!song)
      : this.songs.values();
    {
      const caseSensitive = settings?.traditionalSearchCaseSensitive ?? false;
      const wholeWords = settings?.traditionalSearchWholeWords ?? false;
      const useTextSimilarities = settings?.useTextSimilarities ?? true;
      const lastWordIsPrefix = expr.length > 0 && !expr.endsWith(" ");

      if (expr.trim()) {
        const searchExpr = expr.trim();

        const filterData = new FilterData(searchExpr, {
          caseSensitive,
          wholeWords,
          useTextSimilarities,
          lastWordIsPrefix,
        });
        let minCost = Infinity;
        const filters = filterData.matchesTo(this.words);

        for (const song of candidates) {
          if (!matchesSongLanguage(song.Language, settings?.songLanguageFilter ?? null)) continue;
          if (Database.matchesSongTypeFilter(song, includeItemsWithChords, includeItemsWithoutChords, includeScoreOnlyItems, includeItemsWithNotes)) {
            const [reason, cost] = this.filterMatch(song, filters, leader, settings);
            const costGate = cost < Math.max(1.5 * minCost, minCost + 2);
            if (reason !== FoundReason.None && costGate) {
              const snippet = Database.generateTraditionalSnippet(song, reason, filters);
              res.addSong(song, reason, cost, leader, snippet);
              minCost = cost;
            }
          }
        }
        const finalMinCost = Math.max(1.5 * minCost, minCost + 2);
        for (let i = res.length - 1; i >= 0; i--) {
          const item = res[i];
          if (item && item.cost >= finalMinCost) {
            res.splice(i, 1);
          }
        }
      } else {
        for (const song of candidates) {
          if (!matchesSongLanguage(song.Language, settings?.songLanguageFilter ?? null)) continue;
          if (Database.matchesSongTypeFilter(song, includeItemsWithChords, includeItemsWithoutChords, includeScoreOnlyItems, includeItemsWithNotes)) {
            res.addSong(song, FoundReason.None, 0, leader);
          }
        }
      }
    }
    // Sorting
    switch (order) {
      case SongOrder.MoreRecent:
        res.sort((f1, f2) => {
          const i = f1.reason - f2.reason;
          if (i !== 0) return i;
          if (f1.song.version !== 0 && f2.song.version !== 0) {
            const d = f2.song.version - f1.song.version;
            if (d !== 0) return d;
          } else if (f1.song.version !== 0) return 1;
          else if (f2.song.version !== 0) return -1;
          return f1.song.Title.localeCompare(f2.song.Title);
        });
        break;
      case SongOrder.Alphabetical:
        res.sort((f1, f2) => {
          const i = f1.reason - f2.reason;
          if (i !== 0) return i;
          return f1.song.Title.localeCompare(f2.song.Title);
        });
        break;
      case SongOrder.LessCostMatch:
      default:
        res.sort((f1, f2) => f1.compareTo(f2));
        break;
    }

    if (maxResults > 0 && res.length > maxResults) {
      res.splice(maxResults);
    }

    return res;
  }

  private static toSongIdSet(songIds?: SongIdFilter | null): ReadonlySet<string> | null {
    if (!songIds) return null;
    if (typeof (songIds as ReadonlySet<string>).has === "function") {
      const set = songIds as ReadonlySet<string>;
      return set.size ? set : null;
    }
    const filtered = (songIds as readonly string[]).filter((id: string) => !!id);
    return filtered.length ? new Set(filtered) : null;
  }

  /**
   * Trim a highlighted snippet to ~60 chars around the <mark> tags.
   * Same logic as the server's processHit() in pp-typesense.ts.
   */
  private static trimSnippet(html: string): string {
    const firstMark = html.indexOf("<mark>");
    const lastMarkEnd = html.lastIndexOf("</mark>");
    if (firstMark < 0 || lastMarkEnd < 0) return html;

    // Find newline boundaries
    const prevNL = html.lastIndexOf("\n", firstMark);
    const nextNL = html.indexOf("\n", lastMarkEnd);

    let start = Math.max(0, firstMark - 25);
    let end = Math.min(html.length, lastMarkEnd + 7 + 32); // 7 = "</mark>".length

    // Clip at newline boundaries if they're closer
    if (prevNL >= 0 && prevNL > start) start = prevNL + 1;
    if (nextNL >= 0 && nextNL < end) end = nextNL;

    let snippet = html.substring(start, end).trim();

    // Add ellipsis if trimmed
    if (start > 0) snippet = "…" + snippet;
    if (end < html.length) snippet = snippet + "…";

    return snippet;
  }

  private filterMatch(
    song: Song,
    filters: ReadonlyArray<WordMatch>,
    leader: Leader | null,
    _settings?: DatabaseSettings | null
  ): [FoundReason, number, string | undefined] {
    let cost = Infinity;
    const leaderFilter = leader ? this.leaderFilters.get(leader) : undefined;
    if (leaderFilter && leaderFilter.has(song)) {
      return [FoundReason.None, cost, undefined];
    }

    // If query terms produced no word matches, this song cannot match.
    // Without this guard, the fallback cost aggregation below treats
    // an empty filter set as zero-cost and incorrectly matches everything.
    if (filters.length === 0) {
      return [FoundReason.None, Infinity, undefined];
    }

    let minCost = Infinity;
    let startPos = -1;

    const fm = filters.length > 0 ? filters[0]!.getSongPositions(song.Id) : null;
    if (fm) {
      for (const [pos, initialCost] of fm.entries()) {
        let currentPos = pos;
        let currentCost = initialCost;
        let possible = true;

        for (let i = 1; i < filters.length; i++) {
          const m = filters[i]!;
          const ps = m.getSongPositions(song.Id);
          const nextCost = ps?.get(currentPos + 1);
          if (nextCost === undefined) {
            possible = false;
            break;
          }
          currentCost += nextCost;
          currentPos++;
        }

        if (possible && currentCost < minCost) {
          minCost = currentCost;
          startPos = pos;
        }
      }
    }

    if (minCost < Infinity) {
      cost = minCost;
      if (startPos < SongWords.TitlePosOffset) return [FoundReason.Title, cost, undefined];
      if (startPos >= SongWords.MetaPosOffset) return [FoundReason.Meta, cost, undefined];
      return [startPos < SongWords.TitlePosOffset + song.HeaderWordCount ? FoundReason.Header : FoundReason.Lyrics, cost, undefined];
    }

    cost = 0;
    for (const m of filters) {
      const sp = m.getSongPositions(song.Id);
      if (!sp) return [FoundReason.None, Infinity, undefined];

      const minWordCost = Array.from(sp.values()).reduce((min, c) => Math.min(min, c), Infinity);
      if (minWordCost === Infinity) return [FoundReason.None, Infinity, undefined];
      cost += minWordCost;
    }

    return cost < Infinity ? [FoundReason.Words, cost, undefined] : [FoundReason.None, Infinity, undefined];
  }

  /** Collect one region's text together with the word positions the index assigned to it. */
  private static snippetRegion(song: Song, region: SnippetRegion): { text: string; boundaries: Map<number, [number, number]> } {
    let text = "";
    const boundaries = new Map<number, [number, number]>();
    const append = (value: string, offset: number) => {
      const start = text.length;
      const normalized = value.normalize("NFC");
      let pos = offset;
      for (const match of normalized.matchAll(/[a-zA-Z0-9À-ɏЀ-ӿ]+/g)) {
        boundaries.set(pos++, [start + match.index, start + match.index + match[0].length]);
      }
      text += normalized;
      return pos;
    };
    if (region === "title") {
      append(song.Title, 0);
    } else if (region === "lyrics") {
      append(song.Lyrics, SongWords.TitlePosOffset);
    } else {
      let offset = SongWords.MetaPosOffset;
      for (const [key, value] of song.MetaData) {
        if (text) text += " | ";
        text += key + ": ";
        offset = append(value, offset);
      }
    }
    return { text, boundaries };
  }

  /** Highlight only positions accepted by the search, including all toggle constraints. */
  private static generateTraditionalSnippet(song: Song, reason: FoundReason, filters: ReadonlyArray<WordMatch>): string | undefined {
    if (reason === FoundReason.None) return undefined;

    // The reason names where the match was reported, not where every query word lives, and a
    // FoundReason.Words match is scattered by definition. Try the reason's own region first and
    // fall back to the others, so an accepted song is never rendered without a highlight.
    const regions: SnippetRegion[] =
      reason === FoundReason.Title
        ? ["title", "lyrics", "meta"]
        : reason === FoundReason.Meta
          ? ["meta", "lyrics", "title"]
          : ["lyrics", "title", "meta"];
    // A scattered match has no home region, so there the widest coverage wins instead of the first hit.
    const stopAtFirstHit = reason !== FoundReason.Words;

    let best: { region: SnippetRegion; text: string; highlights: Array<[number, number]>; cost: number } | undefined;
    for (const region of regions) {
      const { text, boundaries } = Database.snippetRegion(song, region);
      if (!text) continue;

      const highlights: Array<[number, number]> = [];
      let cost = 0;
      for (const filter of filters) {
        let bestCost = Infinity;
        let bestBoundary: [number, number] | undefined;
        for (const [pos, posCost] of filter.getSongPositions(song.Id) ?? []) {
          const boundary = boundaries.get(pos);
          if (boundary && posCost < bestCost) {
            bestCost = posCost;
            bestBoundary = boundary;
          }
        }
        if (bestBoundary) {
          highlights.push([...bestBoundary]);
          cost += bestCost;
        }
      }

      if (highlights.length === 0) continue;
      if (!best || highlights.length > best.highlights.length || (highlights.length === best.highlights.length && cost < best.cost)) {
        best = { region, text, highlights, cost };
      }
      if (stopAtFirstHit || best.highlights.length === filters.length) break;
    }

    if (!best) return undefined;
    const { text, highlights } = best;

    // Sort by position and merge overlapping ranges
    highlights.sort((a, b) => a[0] - b[0]);
    const merged: Array<[number, number]> = [highlights[0]!];
    for (let i = 1; i < highlights.length; i++) {
      const prev = merged[merged.length - 1]!;
      const curr = highlights[i]!;
      if (curr[0] <= prev[1]) {
        prev[1] = Math.max(prev[1], curr[1]);
      } else {
        merged.push(curr);
      }
    }

    // Build highlighted string
    let result = "";
    let pos = 0;
    for (const [start, end] of merged) {
      result += Database.escapeHtml(text.substring(pos, start));
      result += "<mark>" + Database.escapeHtml(text.substring(start, end)) + "</mark>";
      pos = end;
    }
    result += Database.escapeHtml(text.substring(pos));

    return best.region === "title" ? result : Database.trimSnippet(result);
  }

  private static escapeHtml(s: string): string {
    return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  }

  /**
   * Pull songs (and optionally leader profiles) from the server and merge them.
   *
   * When an `options.signal` is supplied the operation is cancellable: all
   * fetching happens first and the merge/save only starts once the signal is
   * known to be un-aborted, so a cancelled call applies nothing at all rather
   * than leaving a half-merged database behind.
   */
  public async updateFromServer(
    incrementalVersion?: number,
    fetchLeaders: boolean = true,
    conflictMode: "keep-local" | "overwrite" | "select" = "select",
    options?: { signal?: AbortSignal }
  ): Promise<{
    songsUpdated: number;
    leadersUpdated: number;
    songConflicts: Array<{ serverSong: Song; localSong: Song }>;
    leaderConflicts: Array<{ serverLeader: Leader; localLeader: Leader }>;
  }> {
    const result = {
      songsUpdated: 0,
      leadersUpdated: 0,
      songConflicts: [] as Array<{ serverSong: Song; localSong: Song }>,
      leaderConflicts: [] as Array<{ serverLeader: Leader; localLeader: Leader }>,
    };
    const version = incrementalVersion ?? this.version;

    const signal = options?.signal;

    try {
      // Fetch everything first. Use version parameter for incremental updates -
      // server returns only songs newer than version.
      const serverSongs = await cloudApi.fetchSongs(version, { signal });
      const serverProfiles = fetchLeaders ? await cloudApi.fetchLeaders(version, { signal }) : null;
      if (!fetchLeaders) {
        console.info("Database", "Leader fetching disabled for this sync");
      }

      // Last cancellation point: nothing has been merged yet, so aborting here
      // leaves the database exactly as it was. Everything below runs
      // synchronously through to forceSave().
      signal?.throwIfAborted();

      const mergeResult = this.mergeSongsWithConflicts(serverSongs, conflictMode);
      result.songsUpdated = mergeResult.updated;
      result.songConflicts = mergeResult.conflicts;
      if (result.songsUpdated > 0) {
        console.info("Database", `Database updated from server: ${result.songsUpdated} songs`);
        this.updateSearchEngine(this.getSongs().filter((s) => s.version > version));
      }
      if (result.songConflicts.length > 0) {
        console.info("Database", `Song conflicts detected: ${result.songConflicts.length}`);
      }

      if (serverProfiles) {
        const profileMergeResult = this.mergeProfilesWithConflicts(serverProfiles, conflictMode);
        result.leadersUpdated = profileMergeResult.updated;
        result.leaderConflicts = profileMergeResult.conflicts;
        if (result.leadersUpdated > 0) {
          console.info("Database", `Database updated from server: ${result.leadersUpdated} leaders`);
        }
        if (result.leaderConflicts.length > 0) {
          console.info("Database", `Leader conflicts detected: ${result.leaderConflicts.length}`);
        }
      }

      // Always save and emit event if any updates occurred
      if (result.songsUpdated > 0 || result.leadersUpdated > 0) {
        this.forceSave();
      }
    } catch (error) {
      console.error("Database", "Failed to fetch songs from server", error);
      throw error;
    }

    return result;
  }

  /**
   * Merge songs from server with conflict detection for version=0 local songs
   * (matching C# DBSyncForm conflict handling)
   * @param conflictMode - "keep-local": skip conflicts, "overwrite": take server version, "select": return conflicts for user selection
   */
  private mergeSongsWithConflicts(
    serverSongs: SongDBEntryWithData[],
    conflictMode: "keep-local" | "overwrite" | "select" = "select"
  ): {
    updated: number;
    conflicts: Array<{ serverSong: Song; localSong: Song }>;
  } {
    let count = 0;
    const conflicts: Array<{ serverSong: Song; localSong: Song }> = [];

    for (const serverSongData of serverSongs) {
      const existingSong = this.songs.get(serverSongData.songId);
      const serverSong = Song.fromServer(serverSongData);

      if (existingSong) {
        // Check for conflict: local song has version=0 (modified locally but not synced)
        if (existingSong.version === 0) {
          // If texts are different, it's a conflict
          if (!existingSong.hasSameContent(serverSong)) {
            if (conflictMode === "keep-local") {
              // Keep local version, skip server update
              continue;
            } else if (conflictMode === "overwrite") {
              // Take server version
              this.clearSongBackup(serverSongData.songId);
              this.songs.set(serverSongData.songId, serverSong);
              count++;
              continue;
            } else {
              // "select" mode - let user resolve
              conflicts.push({ serverSong, localSong: existingSong });
              continue;
            }
          }
          // Same content - just update version
        }

        // Normal update: server version is newer
        if (existingSong.version < serverSongData.version || existingSong.version === 0) {
          this.clearSongBackup(serverSongData.songId);
          this.songs.set(serverSongData.songId, serverSong);
          count++;
        }
      } else {
        // New song from server
        this.songs.set(serverSongData.songId, serverSong);
        count++;
      }
    }

    return { updated: count, conflicts };
  }

  /**
   * Merge leader profiles from server with conflict detection
   * @param conflictMode - "keep-local": skip conflicts, "overwrite": take server version, "select": return conflicts for user selection
   */
  private mergeProfilesWithConflicts(
    serverProfiles: LeaderDBProfile[],
    conflictMode: "keep-local" | "overwrite" | "select" = "select"
  ): {
    updated: number;
    conflicts: Array<{ serverLeader: Leader; localLeader: Leader }>;
  } {
    let count = 0;
    const conflicts: Array<{ serverLeader: Leader; localLeader: Leader }> = [];

    for (const serverProfile of serverProfiles) {
      const existingLeader = this.leaders.find(serverProfile.leaderId);
      const serverVersion = serverProfile.version;

      if (existingLeader) {
        // Check for conflict: local leader has version=0
        if (existingLeader.version === 0 && serverVersion > 0) {
          // Check if they're actually different
          const serverLeader = this.createLeaderFromProfile(serverProfile);
          serverLeader.version = serverVersion;
          if (!existingLeader.equals(serverLeader)) {
            if (conflictMode === "keep-local") {
              // Keep local version, skip server update
              continue;
            } else if (conflictMode === "overwrite") {
              // Take server version
              this.updateLeaderFromProfile(existingLeader, serverProfile);
              existingLeader.version = serverVersion;
              count++;
              continue;
            } else {
              // "select" mode - let user resolve
              conflicts.push({ serverLeader, localLeader: existingLeader });
              continue;
            }
          }
        }

        // Normal update: server version is newer
        if (existingLeader.version < serverVersion || existingLeader.version === 0) {
          this.updateLeaderFromProfile(existingLeader, serverProfile);
          existingLeader.version = serverVersion;
          count++;
        }
      } else {
        // Add new leader
        const newLeader = this.createLeaderFromProfile(serverProfile);
        newLeader.version = serverVersion;
        this.leaders.add(newLeader);
        count++;
      }
    }

    return { updated: count, conflicts };
  }

  public createLeaderFromProfile(profile: LeaderDBProfile): Leader {
    const leader = new Leader(profile.leaderId, profile.leaderName);

    // Add preferences
    for (const prefEntry of profile.preferences) {
      leader.updatePreference(
        prefEntry.songId,
        {
          title: prefEntry.title,
          transpose: prefEntry.transpose ?? 0,
          capo: prefEntry.capo ?? -1,
          type: prefEntry.type ?? "",
          instructions: prefEntry.instructions,
        },
        this
      );
    }

    // Add playlists as scheduled playlists
    for (const playlist of profile.playlists) {
      const entries: PlaylistEntry[] = [];
      for (const song of playlist.songs) {
        const entry = new PlaylistEntry(song.songId);
        entry.title = song.title;
        entry.transpose = song.transpose || 0;
        entry.capo = song.capo == null || song.capo < 0 ? -1 : song.capo;
        entry.instructions = song.instructions || "";
        entries.push(entry);
      }
      const pl = new Playlist(playlist.label, entries, playlist.label);
      if (playlist.scheduled) {
        const scheduledDate = typeof playlist.scheduled === "string" ? parseScheduleDate(playlist.scheduled) : playlist.scheduled;
        if (scheduledDate) {
          leader.addPlaylist(scheduledDate, pl, false, this);
        }
      }
    }

    return leader;
  }

  private updateLeaderFromProfile(leader: Leader, profile: LeaderDBProfile): void {
    // Clear existing preferences by recreating them
    const newPreferences = new Map<string, SongPreference>();

    // Add new preferences
    for (const prefEntry of profile.preferences) {
      const pref = leader.updatePreference(
        prefEntry.songId,
        {
          title: prefEntry.title,
          transpose: prefEntry.transpose ?? 0,
          capo: prefEntry.capo ?? -1,
          type: prefEntry.type ?? "",
          instructions: prefEntry.instructions,
        },
        this
      );
      newPreferences.set(prefEntry.songId, pref);
    }

    // Update the leader's preferences map
    (leader as unknown as { preferences: Map<string, SongPreference> }).preferences = newPreferences;

    // Clear existing schedule
    (leader as unknown as { schedule: Map<Date, Playlist> }).schedule.clear();

    // Add new playlists
    for (const playlist of profile.playlists) {
      const entries: PlaylistEntry[] = [];
      for (const song of playlist.songs) {
        const entry = new PlaylistEntry(song.songId);
        entry.title = song.title;
        entry.transpose = song.transpose || 0;
        entry.capo = song.capo == null || song.capo < 0 ? -1 : song.capo;
        entry.instructions = song.instructions || "";
        entries.push(entry);
      }
      const pl = new Playlist(playlist.label, entries, playlist.label);
      if (playlist.scheduled) {
        const scheduledDate = typeof playlist.scheduled === "string" ? parseScheduleDate(playlist.scheduled) : playlist.scheduled;
        if (scheduledDate) {
          leader.addPlaylist(scheduledDate, pl, false, this);
        }
      }
    }
  }

  // Leader management methods (matching C# Database class)
  public getAllLeaders(): Leader[] {
    return this.leaders.items;
  }

  public getLeaderById(leaderId: string): Leader | undefined {
    return this.leaders.find(leaderId);
  }

  /** Other leaders' read-only profiles (from GET /leaders). Leaders that have
   *  since become own/synced are filtered out at read time. */
  public getPublicLeaders(): Leader[] {
    const ownIds = new Set(this.leaders.items.map((l) => l.id));
    return this.publicLeaders.items.filter((l) => !ownIds.has(l.id));
  }

  /** Refresh the public-leader mirror from GET /leaders (full fetch, works for
   *  guests too). Own leaders are excluded; failure is non-fatal (offline).
   *  Every actual request bypasses HTTP caches. `supersede` only controls
   *  coalescing: explicit user actions start a newer request instead of sharing
   *  an already-running background refresh. */
  public updatePublicLeaders(options?: { supersede?: boolean; signal?: AbortSignal }): Promise<boolean> {
    // A caller-owned signal must never be shared: aborting that caller would
    // otherwise also cancel unrelated background refreshes awaiting the same
    // promise. Superseding calls detach any older shared request so subsequent
    // background work cannot join a response that is no longer authoritative.
    const shareable = options?.signal === undefined;
    if (shareable && !options?.supersede && this.publicLeaderRefreshPromise) return this.publicLeaderRefreshPromise;
    if (options?.supersede) this.publicLeaderRefreshPromise = null;

    const sequence = ++this.publicLeaderRefreshSequence;
    const refreshPromise = (async () => {
      try {
        const profiles = await cloudApi.fetchLeaders(0, { signal: options?.signal, fresh: true });
        // Never let an older response overwrite a newer one that already applied.
        // A merely started request is not enough to suppress this result: it may
        // still time out or be aborted by its caller.
        if (sequence < this.publicLeaderAppliedSequence) return true;
        this.publicLeaderAppliedSequence = sequence;

        const ownIds = new Set(this.leaders.items.map((l) => l.id));
        const next = new Leaders();
        next.items = profiles.filter((p) => !ownIds.has(p.leaderId)).map((p) => Leader.fromJSON(p));
        this.publicLeaders = next;
        this.forceSave();
        return true;
      } catch (error) {
        console.warn("Database", "Failed to refresh public leader lists", error);
        return false;
      }
    })();

    if (shareable) {
      this.publicLeaderRefreshPromise = refreshPromise;
      void refreshPromise.finally(() => {
        if (this.publicLeaderRefreshPromise === refreshPromise) this.publicLeaderRefreshPromise = null;
      });
    }
    return refreshPromise;
  }

  public getLeaderByName(leaderName: string): Leader | undefined {
    return this.leaders.findByName(leaderName);
  }

  public removeLeader(leaderId: string): void {
    const leader = this.leaders.find(leaderId);
    if (leader) {
      this.leaders.remove(leader);
      this.save();
    }
  }

  public createLeadersClone(): Leaders {
    return this.leaders.clone();
  }

  // Schedule a playlist for a leader on a specific date - matching C# Database.Schedule
  /**
   * Stores a playlist for a leader. A dated playlist is named after its date
   * (YYYY.MM.DD). A favorite (see common/favorite-playlists) gets the label of
   * `favoriteName` when given; otherwise it keeps the name it already has.
   */
  public schedule(leader: Leader, date: Date, playlist: Playlist, favoriteName?: string): void {
    if (leader) {
      const playlistToStore = playlist.clone();
      if (isFavoriteScheduleDate(date)) {
        const existingName = leader.getPlaylist(date)?.name;
        playlistToStore.name =
          favoriteName !== undefined
            ? favoriteLabel(favoriteName)
            : existingName || (hasFavoriteLabel(playlist.name) ? playlist.name : formatLocalDateLabel(date));
      } else {
        playlistToStore.name = formatLocalDateLabel(date); // YYYY.MM.DD format
      }
      leader.addPlaylist(date, playlistToStore, true, this);
      this.save();
    }
  }

  /** Renames a favorite playlist; its date and songs stay the same. */
  public renameFavorite(leader: Leader, date: Date, favoriteName: string): boolean {
    const existing = leader.getPlaylist(date);
    if (!existing || !isFavoriteScheduleDate(date)) return false;
    const renamed = existing.clone();
    renamed.name = favoriteLabel(favoriteName);
    leader.addPlaylist(date, renamed, false, this);
    this.save();
    return true;
  }

  /** Deletes the playlist stored for this exact date. */
  public removeScheduledPlaylist(leader: Leader, date: Date): boolean {
    if (!leader.removePlaylist(date, this)) return false;
    this.save();
    return true;
  }
}

export { Database };
