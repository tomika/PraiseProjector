import { Song, songStoreCodec } from "./Song";
import { Playlist } from "./Playlist";
import { SongPreference } from "./SongPreference";
import { Leader } from "./Leader";
import { Leaders } from "./Leaders";
import { SongWords } from "./SongWords";
import { StringExtensions } from "./StringExtensions";
import { DamerauLevenshtein } from "./DamerauLevenshtein";
import { TypesenseClient } from "../common/typesense-client";
import { PlaylistEntry } from "./PlaylistEntry";
import { cloudApi } from "../common/cloudApi";
import { formatLocalDateLabel, parseScheduleDate } from "../common/date-only";
import { LeaderDBProfile, SongDBEntryWithData, SongFoundType } from "../common/pp-types";
import { leaderDBProfileCodec, leadersResponseCodec, uniType } from "../common/pp-codecs";
import { decode, parseAndDecode } from "../common/io-utils";
import * as t from "io-ts";
import { TinyEmitter } from "tiny-emitter";
import { databaseStorage, getStorageKey } from "./DatabaseStorage";

export interface DatabaseSettings {
  searchMethod?: "traditional" | "typesense";
  typesenseUrl: string;
  typesenseApiKey: string;
  searchMaxResults?: number;
  traditionalSearchCaseSensitive?: boolean;
  traditionalSearchWholeWords?: boolean;
  useTextSimilarities?: boolean;
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
}

export enum SongOrder {
  Alphabetical,
  MoreRecent,
  LessCostMatch,
}

interface IComparable<T> {
  compareTo(other: T): number;
}

export class FilterData {
  private normalized: string;
  private wholeWords: boolean;
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
      this._simplified = StringExtensions.simplify(this.normalized);
    }
    return this._simplified;
  }

  public get Words(): string[] {
    if (this._words === null) {
      this._words = this.Simplified.split(" ");
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
    this.useTextSimilarities = options?.useTextSimilarities ?? true;
    this.lastWordIsPrefix = options?.lastWordIsPrefix ?? false;
    this.normalized = StringExtensions.minimizeSpaces(expr.toLowerCase());
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
        const allowedMaxCost = this.useTextSimilarities && !this.wholeWords ? Math.max(word.length >= 3 ? 1.5 : 0.0, 0.9) : 0.0;
        const prefixMaxCost = this.useTextSimilarities ? (word.length <= 2 ? 0.9 : word.length === 3 ? 1.0 : word.length === 4 ? 1.2 : 1.5) : 0.0;

        if (allowPrefixBonus) {
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

        if (!m.empty) {
          const maxWordCost = allowPrefixBonus ? (this.useTextSimilarities ? prefixMaxCost : prefixCost) : allowedMaxCost;
          m.filterPositions(maxWordCost);
          filters.push(m);
        }
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
  public words: SongWords = new SongWords();
  private typesense: TypesenseClient | null = null;

  private songToTypesenseInfo(song: Song) {
    return { id: song.Id, version: song.version, text: song.Text };
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
    if (this.typesense)
      this.typesense.update([this.songToTypesenseInfo(song)]).catch((error) => {
        console.error("Database", "Failed to update Typesense index", error);
      });
    else this.words.add(song);
  }

  private removeSongFromSearchEngine(_song: Song) {
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

    Database.initPromise = (async () => {
      Database.currentUsername = username;
      Database.instance = new Database(username);

      // Try to migrate from localStorage first (one-time migration)
      await databaseStorage.migrateFromLocalStorage(username || undefined);

      // Load from IndexedDB
      await Database.instance.loadAsync();
      Database.isInitialized = true;

      console.info("Database", `Initialized for user: "${username || "(anonymous)"}"`);
      return Database.instance;
    })();

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
  public static async waitForReady(): Promise<Database> {
    // If a user switch is in progress, wait for it to finish first
    if (Database.switchPromise) {
      return Database.switchPromise;
    }
    if (Database.initPromise) {
      return Database.initPromise;
    }
    // If already initialized (e.g., after switchUser), return the instance
    if (Database.isInitialized && Database.instance) {
      return Database.instance;
    }
    // If not initialized yet, initialize with empty username
    return Database.initialize();
  }

  /**
   * Switch to a different user's database.
   * This saves the current database, clears the instance, and loads the new user's data.
   * Serialized: concurrent calls are queued so only one switch runs at a time,
   * preventing a partially-loaded (empty) instance from being saved over existing data.
   */
  public static async switchUser(username: string): Promise<Database> {
    // Serialize: wait for any in-flight switch to finish before starting a new one.
    // After the previous switch completes we re-check the early-return guard because
    // the previous switch may have already switched to the requested user.
    if (Database.switchPromise) {
      await Database.switchPromise;
    }

    const nextUsername = username || "";

    if (Database.isInitialized && Database.instance && Database.currentUsername === nextUsername) {
      return Database.instance;
    }

    // Wrap the actual work in a promise so subsequent callers can wait for it.
    Database.switchPromise = (async () => {
      // Save current user's data only if it has been modified since load.
      // This prevents writing an empty/unchanged guest instance over existing
      // storage when switching users on page reload.
      if (Database.instance) {
        if (Database.instance.savePromise) {
          // A fire-and-forget save is already in progress — wait for it
          await Database.instance.savePromise;
        }
        if (Database.instance.isDirty) {
          await Database.instance.forceSaveAsync();
        }
      }

      // Update current username
      Database.currentUsername = nextUsername;

      // Reset initPromise so waitForReady() returns the new instance
      Database.initPromise = null;
      Database.isInitialized = false;

      // Clear and recreate instance
      Database.instance = new Database(nextUsername);

      // Try to migrate from localStorage first (one-time migration)
      await databaseStorage.migrateFromLocalStorage(nextUsername || undefined);

      // Load from IndexedDB
      await Database.instance.loadAsync();

      // Mark as initialized after loading
      Database.isInitialized = true;

      console.info("Database", `Switched to user: "${username || "(anonymous)"}"`);

      // Emit global event so all components can refresh with new database
      if (typeof window !== "undefined") {
        window.dispatchEvent(new CustomEvent("pp-database-switched"));
      }

      // Emit db-updated event to notify components that the database has changed
      Database.instance.emitter.emit("db-updated");

      return Database.instance;
    })();

    try {
      return await Database.switchPromise;
    } finally {
      Database.switchPromise = null;
    }
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
        }
      );

      const dbState = await databaseStorage.load<unknown>(this.instanceUsername || undefined);

      if (dbState) {
        const validatedState = decode(loadCodec, dbState);
        this.applyDbState(validatedState);
      }
    } catch (error) {
      console.error("Database", "Failed to load data from IndexedDB", error);
    }
  }

  /**
   * Apply database state from parsed JSON
   */
  private applyDbState(dbState: {
    version?: number;
    songs?: unknown[];
    leaders?: unknown;
    songBackup?: Array<[string, { version: number; song: unknown }]>;
    profileBackup?: Array<[string, { version: number; leader: unknown }]>;
  }): void {
    if (dbState.songs) {
      const songMap = new Map<string, Song>();
      for (const item of dbState.songs) {
        const song = Song.fromJSON(item);
        songMap.set(song.Id, song);
      }
      this.songs = songMap;
      this.updateSearchEngine();
    }

    if (dbState.leaders) {
      this.leaders = Leaders.fromJSON(dbState.leaders);
    }

    // Load song backups
    const songBackupData = dbState.songBackup;
    if (songBackupData) {
      const backupMap = new Map<string, { version: number; song: Song }>();
      for (const [songId, entry] of songBackupData) {
        backupMap.set(songId, {
          version: entry.version,
          song: Song.fromJSON(entry.song),
        });
      }
      this.songBackup = backupMap;
    }

    // Load profile backups
    if (dbState.profileBackup) {
      const backupMap = new Map<string, { version: number; leader: Leader }>();
      for (const [leaderId, entry] of dbState.profileBackup) {
        backupMap.set(leaderId, {
          version: entry.version,
          leader: Leader.fromJSON(entry.leader),
        });
      }
      this.profileBackup = backupMap;
    }

    if (typeof dbState.version === "number") {
      this.version = dbState.version;
    }
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
    this.forceSaveAsync().catch((error) => {
      console.error("Database", "Failed to save data to IndexedDB", error);
      if (typeof window !== "undefined") window.dispatchEvent(new CustomEvent("pp-db-save-error"));
    });
  }

  /**
   * Async force save to IndexedDB storage
   */
  public async forceSaveAsync(): Promise<void> {
    // If a save is already in progress, wait for it and then save again
    if (this.savePromise) {
      await this.savePromise;
    }

    this.savePromise = (async () => {
      try {
        const dbState = {
          version: this.version,
          songs: Array.from(this.songs.values()),
          leaders: this.leaders,
          songBackup: Array.from(this.songBackup.entries()),
          profileBackup: Array.from(this.profileBackup.entries()),
        };

        if (Database.isDevValidationEnabled()) {
          parseAndDecode(Database.importExportCodec, JSON.stringify(dbState));
        }

        await databaseStorage.save(dbState, this.instanceUsername || undefined);
        this.isDirty = false;
        this.emitter.emit("db-updated");
      } catch (error) {
        console.error("Database", "Failed to save data to IndexedDB", error);
        if (typeof window !== "undefined") window.dispatchEvent(new CustomEvent("pp-db-save-error"));
        throw error;
      } finally {
        this.savePromise = null;
      }
    })();

    return this.savePromise;
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
    if (typeof targetSongOrGroupId === "string") {
      addedSong.GroupId = targetSongOrGroupId;
    } else {
      addedSong.GroupWith(targetSongOrGroupId);
    }
    this.forceSave();
  }

  public Ungroup(song: Song): void {
    song.GroupId = "";
    this.forceSave();
  }

  public addSong(song: Song): void {
    this.songs.set(song.Id, song);
    this.addSongToSearchEngine(song);
    this.save();
  }

  public removeSong(songId: string): void {
    const song = this.songs.get(songId);
    if (song) {
      this.songs.delete(songId);
      this.words.remove(song);
      this.removeSongFromSearchEngine(song);
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
        const u = updatedSong.ToUpdate();
        const b = backup.song.ToUpdate();
        if (u.songdata.text === b.songdata.text && u.songdata.system === b.songdata.system && (u.groupId ?? null) === (b.groupId ?? null)) {
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
    const dbState = {
      version: this.version,
      songs: Array.from(this.songs.values()),
      leaders: this.leaders,
    };
    return JSON.stringify(dbState);
  }

  /**
   * Restore database state from a backup string
   * Used to rollback if user cancels sync with pending conflicts
   */
  public restoreFromBackup(backupData: string): void {
    try {
      const dbState = decode(Database.importExportCodec, JSON.parse(backupData));

      // Clear current state
      this.songs.clear();
      this.leaders = new Leaders();
      this.words = new SongWords();
      this.songBackup.clear();
      this.profileBackup.clear();
      this.version = 0;

      this.applyDbState(dbState);

      this.isDirty = true;
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
    this.leaders = new Leaders();
    this.words = new SongWords();
    this.songBackup.clear();
    this.profileBackup.clear();
    this.version = 0;
    this.isDirty = true;
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

  private static escapeRegExp(s: string): string {
    return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  }

  private static matchesTextConstraints(
    song: Song,
    reason: FoundReason,
    queryWords: string[],
    caseSensitive: boolean,
    wholeWords: boolean,
    lastWordIsPrefix: boolean
  ): boolean {
    if (queryWords.length === 0) return true;
    if (!caseSensitive && !wholeWords) return true;

    let text = "";
    if (reason === FoundReason.Title) {
      text = song.Title;
    } else if (reason === FoundReason.Meta) {
      const parts: string[] = [];
      for (const [key, value] of song.MetaData.entries()) {
        parts.push(`${key}: ${value}`);
      }
      text = parts.join(" | ");
    } else {
      text = song.Lyrics;
    }

    const flags = caseSensitive ? "g" : "gi";
    for (let i = 0; i < queryWords.length; i++) {
      const escaped = Database.escapeRegExp(queryWords[i]!);
      const isLast = i === queryWords.length - 1;
      const usePrefix = isLast && lastWordIsPrefix;
      const pattern = wholeWords && !usePrefix ? `\\b${escaped}\\b` : wholeWords ? `\\b${escaped}` : escaped;
      if (!new RegExp(pattern, flags).test(text)) {
        return false;
      }
    }

    return true;
  }

  public typesenseEngineEnabled = false;

  public async filter(
    expr: string,
    leader: Leader | null = null,
    includeItemsWithChords = true,
    includeItemsWithoutChords = true,
    includeItemsWithNotes = true,
    order: SongOrder = SongOrder.Alphabetical,
    settings?: DatabaseSettings | null
  ): Promise<SongFoundList> {
    if (this.typesenseEngineEnabled && settings?.searchMethod === "typesense" && expr.trim()) {
      try {
        const result = await this.typesenseFilter(
          expr,
          leader,
          includeItemsWithChords,
          includeItemsWithoutChords,
          includeItemsWithNotes,
          order,
          settings
        );
        this.typesenseFallbackFired = false;
        return result;
      } catch {
        if (!this.typesenseFallbackFired) {
          this.typesenseFallbackFired = true;
          if (typeof window !== "undefined") window.dispatchEvent(new CustomEvent("pp-typesense-fallback"));
        }
        return this.traditionalFilter(expr, leader, includeItemsWithChords, includeItemsWithoutChords, includeItemsWithNotes, order, settings);
      }
    }
    return this.traditionalFilter(expr, leader, includeItemsWithChords, includeItemsWithoutChords, includeItemsWithNotes, order, settings);
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
    includeItemsWithNotes: boolean,
    order: SongOrder,
    settings: DatabaseSettings
  ): Promise<SongFoundList> {
    const res = new SongFoundList();
    const maxResults = settings.searchMaxResults ?? 0;
    const markedItemsOnly = includeItemsWithNotes && !includeItemsWithChords && !includeItemsWithoutChords;
    const leaderFilter = leader ? this.leaderFilters.get(leader) : undefined;

    this.ensureTypesenseInit(settings);

    const hits = await this.typesense!.search(expr, maxResults || undefined);

    for (const hit of hits) {
      const song = this.songs.get(hit.songId);
      if (!song) continue;

      if (!(markedItemsOnly ? !!song.Notes : includeItemsWithNotes || !song.Notes)) continue;
      if (!(song.TextOnly ? includeItemsWithoutChords : includeItemsWithChords)) continue;
      if (leaderFilter && leaderFilter.has(song)) continue;

      const reason = Database.TYPESENSE_TYPE_TO_REASON[hit.found.type] ?? FoundReason.Lyrics;
      res.addSong(song, reason, hit.found.cost, leader, hit.found.snippet);
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
    includeItemsWithNotes: boolean,
    order: SongOrder,
    settings?: DatabaseSettings | null
  ): SongFoundList {
    const res = new SongFoundList();
    const maxResults = settings?.searchMaxResults ?? 0; // 0 = unlimited
    {
      const markedItemsOnly = includeItemsWithNotes && !includeItemsWithChords && !includeItemsWithoutChords;
      const caseSensitive = settings?.traditionalSearchCaseSensitive ?? false;
      const wholeWords = settings?.traditionalSearchWholeWords ?? false;
      const useTextSimilarities = settings?.useTextSimilarities ?? true;
      const queryWords = StringExtensions.minimizeSpaces(expr)
        .split(" ")
        .filter((w) => w.length > 0);
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

        for (const song of this.songs.values()) {
          if (
            (markedItemsOnly ? !!song.Notes : includeItemsWithNotes || !song.Notes) &&
            (song.TextOnly ? includeItemsWithoutChords : includeItemsWithChords)
          ) {
            const [reason, cost] = this.filterMatch(song, filters, leader, settings);
            const costGate = cost < Math.max(1.5 * minCost, minCost + 2);
            const textConstraintsPassed = Database.matchesTextConstraints(song, reason, queryWords, caseSensitive, wholeWords, lastWordIsPrefix);
            if (reason !== FoundReason.None && costGate && textConstraintsPassed) {
              const snippet = Database.generateTraditionalSnippet(song, searchExpr, reason, lastWordIsPrefix);
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
        for (const song of this.songs.values()) {
          if (
            (markedItemsOnly ? !!song.Notes : includeItemsWithNotes || !song.Notes) &&
            (song.TextOnly ? includeItemsWithoutChords : includeItemsWithChords)
          ) {
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
      if (startPos > SongWords.MetaPosOffset) return [FoundReason.Meta, cost, undefined];
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

  /**
   * Generate a snippet for traditional search by finding the search expression
   * in the song text and wrapping matches in <mark> tags.
   * Supports both exact and fuzzy (Damerau-Levenshtein) word matches.
   * For Title matches, returns undefined (title is already visible).
   */
  private static generateTraditionalSnippet(song: Song, expr: string, reason: FoundReason, lastWordIsPrefix: boolean = false): string | undefined {
    if (reason === FoundReason.None) return undefined;

    // Pick the text to search based on the match reason
    let text: string;
    if (reason === FoundReason.Title) {
      text = song.Title;
    } else if (reason === FoundReason.Meta) {
      const parts: string[] = [];
      for (const [key, value] of song.MetaData.entries()) {
        parts.push(`${key}: ${value}`);
      }
      text = parts.join(" | ");
    } else {
      text = song.Lyrics;
    }

    if (!text) return undefined;

    const lowerText = text.toLowerCase();
    const unaccentedText = StringExtensions.toUnaccented(lowerText);
    const searchWords = expr
      .toLowerCase()
      .trim()
      .split(/\s+/)
      .filter((w) => w.length > 0);
    if (searchWords.length === 0) return undefined;

    // First try exact full-expression substring match (accented then unaccented)
    // When last word is a prefix, match the expression as a prefix in text
    const lowerExpr = searchWords.join(" ");
    const unaccentedExpr = StringExtensions.toUnaccented(lowerExpr);

    let exactIdx = -1;
    let matchLen = lowerExpr.length;
    if (lastWordIsPrefix) {
      // Find where the expression starts, then extend the last word to its word boundary
      exactIdx = lowerText.indexOf(lowerExpr);
      if (exactIdx < 0) exactIdx = unaccentedText.indexOf(unaccentedExpr);
      if (exactIdx >= 0) {
        // Extend match to end of the last word in text
        let end = exactIdx + lowerExpr.length;
        while (end < text.length && /[a-zA-Z0-9\u00C0-\u024F\u0400-\u04FF]/.test(text[end]!)) end++;
        matchLen = end - exactIdx;
      }
    } else {
      exactIdx = lowerText.indexOf(lowerExpr);
      if (exactIdx < 0) exactIdx = unaccentedText.indexOf(unaccentedExpr);
    }
    if (exactIdx >= 0) {
      const highlighted =
        Database.escapeHtml(text.substring(0, exactIdx)) +
        "<mark>" +
        Database.escapeHtml(text.substring(exactIdx, exactIdx + matchLen)) +
        "</mark>" +
        Database.escapeHtml(text.substring(exactIdx + matchLen));
      return reason === FoundReason.Title ? highlighted : Database.trimSnippet(highlighted);
    }

    // Find word boundaries in the original text (consistent with StringExtensions.simplify regex)
    const wordBoundaries: Array<{ start: number; end: number; lower: string; unaccented: string }> = [];
    const wordRegex = /[a-zA-Z0-9\u00C0-\u024F\u0400-\u04FF]+/g;
    let m: RegExpExecArray | null;
    while ((m = wordRegex.exec(text)) !== null) {
      const lower = m[0].toLowerCase();
      wordBoundaries.push({ start: m.index, end: m.index + m[0].length, lower, unaccented: StringExtensions.toUnaccented(lower) });
    }

    // For each search word, find the best fuzzy-matching word in the text
    // (using Damerau-Levenshtein, same threshold as the search engine)
    // Compare against both accented and unaccented forms
    // Last word (if prefix) uses startsWith matching instead of fuzzy distance
    const highlights: Array<[number, number]> = [];
    for (let i = 0; i < searchWords.length; i++) {
      const searchWord = searchWords[i]!;
      const isLast = i === searchWords.length - 1;
      const usePrefix = isLast && lastWordIsPrefix;
      let bestCost = Infinity;
      let bestBoundary: { start: number; end: number } | null = null;
      const maxCost = Math.max(searchWord.length >= 3 ? 1.5 : 0.0, 0.9);
      const unaccentedSearch = StringExtensions.toUnaccented(searchWord);

      for (const wb of wordBoundaries) {
        if (usePrefix) {
          // Prefix match: search word must be a prefix of the text word
          if (wb.lower.startsWith(searchWord) || wb.unaccented.startsWith(unaccentedSearch)) {
            bestCost = 0;
            bestBoundary = wb;
            break;
          }
          // Also allow fuzzy prefix: edit distance on the prefix portion
          if (wb.lower.length >= searchWord.length) {
            const prefix = wb.lower.substring(0, searchWord.length);
            const uPrefix = wb.unaccented.substring(0, unaccentedSearch.length);
            let cost = DamerauLevenshtein.accentedDamerauLevenshteinDistance(searchWord, prefix);
            const uCost = DamerauLevenshtein.accentedDamerauLevenshteinDistance(unaccentedSearch, uPrefix);
            if (uCost < cost) cost = uCost;
            if (cost < bestCost && cost <= maxCost) {
              bestCost = cost;
              bestBoundary = wb;
            }
          }
        } else {
          // Quick length check — skip words that are way too different in length
          if (Math.abs(wb.lower.length - searchWord.length) > 2 && Math.abs(wb.unaccented.length - unaccentedSearch.length) > 2) continue;

          // Try accented comparison first (lower cost for exact accent match)
          let cost = DamerauLevenshtein.accentedDamerauLevenshteinDistance(searchWord, wb.lower);
          // Also try fully unaccented comparison
          const uCost = DamerauLevenshtein.accentedDamerauLevenshteinDistance(unaccentedSearch, wb.unaccented);
          if (uCost < cost) cost = uCost;

          if (cost < bestCost && cost <= maxCost) {
            bestCost = cost;
            bestBoundary = wb;
            if (cost === 0) break; // Exact match, no need to look further
          }
        }
      }

      if (bestBoundary) {
        highlights.push([bestBoundary.start, bestBoundary.end]);
      }
    }

    if (highlights.length === 0) return undefined;

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

    return reason === FoundReason.Title ? result : Database.trimSnippet(result);
  }

  private static escapeHtml(s: string): string {
    return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  }

  public async updateFromServer(
    incrementalVersion?: number,
    fetchLeaders: boolean = true,
    conflictMode: "keep-local" | "overwrite" | "select" = "select"
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

    try {
      // Use version parameter for incremental updates - server returns only songs newer than version
      const serverSongs = await cloudApi.fetchSongs(version);
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

      // Leaders endpoint - conditionally fetch based on fetchLeaders flag
      if (fetchLeaders) {
        const serverProfiles = await cloudApi.fetchLeaders(version);
        const mergeResult = this.mergeProfilesWithConflicts(serverProfiles, conflictMode);
        result.leadersUpdated = mergeResult.updated;
        result.leaderConflicts = mergeResult.conflicts;
        if (result.leadersUpdated > 0) {
          console.info("Database", `Database updated from server: ${result.leadersUpdated} leaders`);
        }
        if (result.leaderConflicts.length > 0) {
          console.info("Database", `Leader conflicts detected: ${result.leaderConflicts.length}`);
        }
      } else {
        console.info("Database", "Leader fetching disabled for this sync");
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
          if (existingSong.Text !== serverSong.Text || existingSong.Title !== serverSong.Title) {
            if (conflictMode === "keep-local") {
              // Keep local version, skip server update
              continue;
            } else if (conflictMode === "overwrite") {
              // Take server version
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
  public schedule(leader: Leader, date: Date, playlist: Playlist): void {
    if (leader) {
      const playlistToStore = playlist.clone();
      playlistToStore.name = formatLocalDateLabel(date); // YYYY.MM.DD format
      leader.addPlaylist(date, playlistToStore, true, this);
      this.save();
    }
  }
}

export { Database };
