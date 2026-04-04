import { Song } from "./Song";
import { MultiMap } from "./MultiMap";
import { StringExtensions } from "./StringExtensions";
import { DamerauLevenshtein } from "./DamerauLevenshtein";

export interface SongPos {
  song: Song;
  pos: number;
  cost: number;
}

class MatchResult {
  positions: SongPos[];
  readonly minCost: number;
  readonly version: number;

  constructor(p: SongPos[], v: number) {
    this.positions = p;
    this.version = v;
    this.minCost = p.reduce((min, pos) => Math.min(min, pos.cost), Infinity);
  }
}

export class SongWords {
  private posMap = new MultiMap<string, SongPos>();
  private prefixMap = new MultiMap<string, string>();
  private trigramMap = new MultiMap<string, string>();
  private _version = 0;

  private static normalizeToken(token: string): string {
    return token.normalize("NFC").trim().toLowerCase();
  }

  public get version(): number {
    return this._version;
  }

  public static readonly TitlePosOffset = 100000;
  public static readonly MetaPosOffset = 1000000;

  private static uniqueTrigrams(word: string): string[] {
    const token = word.trim().toLowerCase();
    if (!token) return [];

    const wrapped = `^${token}$`;
    if (wrapped.length < 3) return [wrapped];

    const set = new Set<string>();
    for (let i = 0; i <= wrapped.length - 3; i++) {
      set.add(wrapped.substring(i, i + 3));
    }
    return Array.from(set);
  }

  private indexWord(word: string) {
    const token = SongWords.normalizeToken(word);
    if (!token) return;

    // Index the accented form
    const prefixLen = Math.min(3, token.length);
    this.prefixMap.add(token.substring(0, prefixLen), token);
    for (const tri of SongWords.uniqueTrigrams(token)) {
      this.trigramMap.add(tri, token);
    }

    // Also index the unaccented form so unaccented queries find accented words
    const unaccented = StringExtensions.toUnaccented(token);
    if (unaccented !== token) {
      const uPrefixLen = Math.min(3, unaccented.length);
      this.prefixMap.add(unaccented.substring(0, uPrefixLen), token);
      for (const tri of SongWords.uniqueTrigrams(unaccented)) {
        this.trigramMap.add(tri, token);
      }
    }
  }

  private unindexWord(word: string) {
    const token = SongWords.normalizeToken(word);
    if (!token) return;

    const prefixLen = Math.min(3, token.length);
    this.prefixMap.removeValue(token.substring(0, prefixLen), (w) => w === token);
    for (const tri of SongWords.uniqueTrigrams(token)) {
      this.trigramMap.removeValue(tri, (w) => w === token);
    }

    const unaccented = StringExtensions.toUnaccented(token);
    if (unaccented !== token) {
      const uPrefixLen = Math.min(3, unaccented.length);
      this.prefixMap.removeValue(unaccented.substring(0, uPrefixLen), (w) => w === token);
      for (const tri of SongWords.uniqueTrigrams(unaccented)) {
        this.trigramMap.removeValue(tri, (w) => w === token);
      }
    }
  }

  private addWordPosition(word: string, song: Song, pos: number, cost: number = 0) {
    const token = SongWords.normalizeToken(word);
    if (!token) return;

    const wasNew = !this.posMap.has(token);
    this.posMap.add(token, { song, pos, cost });
    if (wasNew) this.indexWord(token);
  }

  public add(song: Song) {
    let pos = 0;
    for (const word of StringExtensions.getWords(song.Title)) {
      this.addWordPosition(word, song, pos++);
    }

    pos = SongWords.TitlePosOffset;
    for (const word of song.Words) {
      this.addWordPosition(word, song, pos++);
    }

    pos = SongWords.MetaPosOffset;
    for (const metaValue of song.MetaData.values()) {
      for (const word of StringExtensions.getWords(metaValue)) {
        this.addWordPosition(word, song, pos++);
      }
    }

    this._version++;
  }

  public remove(song: Song) {
    const allWords = new Set<string>(StringExtensions.getWords(song.Title));
    song.Words.forEach((w) => allWords.add(w));
    for (const metaValue of song.MetaData.values()) {
      StringExtensions.getWords(metaValue).forEach((w) => allWords.add(w));
    }

    for (const word of allWords) {
      const token = SongWords.normalizeToken(word);
      this.posMap.removeValue(token, (p) => p.song === song);
      if (!this.posMap.has(token)) {
        this.unindexWord(token);
      }
    }
    this._version++;
  }

  public rebuild(songs: Iterable<Song>) {
    this.posMap.clear();
    this.prefixMap.clear();
    this.trigramMap.clear();
    for (const song of songs) {
      this.add(song);
    }
  }

  private matches(costCalculator: (word: string) => number, candidates?: ReadonlySet<string>): SongPos[] {
    const results: SongPos[] = [];
    const wordEntries = candidates
      ? Array.from(candidates)
          .map((word) => [word, this.posMap.get(word)] as const)
          .filter((entry): entry is readonly [string, Set<SongPos>] => !!entry[1])
      : Array.from(this.posMap.entries());

    for (const [word, positions] of wordEntries) {
      const cost = costCalculator(word);
      if (!isNaN(cost) && isFinite(cost)) {
        for (const pos of positions) {
          results.push({ ...pos, cost: pos.cost + cost });
        }
      }
    }
    return results;
  }

  private candidateWordsFor(word: string, nullCostPrefix: boolean): Set<string> {
    const token = SongWords.normalizeToken(word);
    if (!token) return new Set();

    const candidates = new Set<string>();
    const unaccented = StringExtensions.toUnaccented(token);

    // Exact lookup (accented and unaccented)
    if (this.posMap.has(token)) candidates.add(token);
    if (unaccented !== token && this.posMap.has(unaccented)) candidates.add(unaccented);

    // Prefix lookup for both accented and unaccented forms
    const prefixLen = Math.min(3, token.length);
    const uPrefixLen = Math.min(3, unaccented.length);
    for (const w of this.prefixMap.getValues(token.substring(0, prefixLen))) candidates.add(w);
    if (unaccented !== token) {
      for (const w of this.prefixMap.getValues(unaccented.substring(0, uPrefixLen))) candidates.add(w);
    }

    // Trigram overlap for both accented and unaccented forms
    const overlap = new Map<string, number>();
    for (const tri of SongWords.uniqueTrigrams(token)) {
      for (const w of this.trigramMap.getValues(tri)) overlap.set(w, (overlap.get(w) ?? 0) + 1);
    }
    if (unaccented !== token) {
      for (const tri of SongWords.uniqueTrigrams(unaccented)) {
        for (const w of this.trigramMap.getValues(tri)) overlap.set(w, (overlap.get(w) ?? 0) + 1);
      }
    }

    const minOverlap = token.length <= 4 ? 1 : 2;
    for (const [w, count] of overlap.entries()) {
      if (count >= minOverlap) candidates.add(w);
    }

    // Prefix-starts-with for last-word-in-query completion
    if (nullCostPrefix) {
      if (token.length >= 2) {
        const pfx = token.substring(0, Math.min(3, token.length));
        const uPfx = unaccented.substring(0, Math.min(3, unaccented.length));
        for (const w of this.prefixMap.getValues(pfx)) {
          if (w.startsWith(token) || StringExtensions.toUnaccented(w).startsWith(unaccented)) candidates.add(w);
        }
        if (uPfx !== pfx) {
          for (const w of this.prefixMap.getValues(uPfx)) {
            if (w.startsWith(token) || StringExtensions.toUnaccented(w).startsWith(unaccented)) candidates.add(w);
          }
        }
      } else {
        // For very short prefix (1 char), scan all prefix keys that start with token
        // to find words like "el", "ezt" when typing "e"
        for (const w of this.posMap.keys()) {
          if (w.startsWith(token) || StringExtensions.toUnaccented(w).startsWith(unaccented)) candidates.add(w);
        }
      }
    }

    return candidates;
  }

  private recentWordMatches = new Map<string, MatchResult>();
  private recentWordUsage: string[] = [];
  private static readonly maxRecentListCount = 15;

  private getMatches(word: string, nullCostPrefix: boolean, maxCost: number = Number.POSITIVE_INFINITY): MatchResult {
    let rv: MatchResult | undefined;
    const originalWord = word;

    for (let i = 0; i < (nullCostPrefix ? 2 : 1); i++) {
      const maxKey = Number.isFinite(maxCost) ? maxCost.toFixed(3) : "inf";
      const searchWord = i === 0 ? `${originalWord}|${maxKey}` : `${originalWord}\u0001|${maxKey}`;
      let mv = this.recentWordMatches.get(searchWord);

      if (mv) {
        if (mv.version !== this.version) {
          this.recentWordMatches.delete(searchWord);
          mv = undefined;
        }
        const usageIndex = this.recentWordUsage.indexOf(searchWord);
        if (usageIndex > -1) {
          this.recentWordUsage.splice(usageIndex, 1);
        }
      }

      if (!mv) {
        const candidates = this.candidateWordsFor(word, i > 0);
        const positions = this.matches(
          (w) => {
            return DamerauLevenshtein.calcDifferenceTo(word, w, i > 0, maxCost);
          },
          candidates.size > 0 ? candidates : undefined
        );
        mv = new MatchResult(positions, this.version);
        this.recentWordMatches.set(searchWord, mv);
      }

      if (rv && rv.minCost <= mv.minCost) break;

      this.recentWordUsage.push(searchWord);
      while (this.recentWordUsage.length > SongWords.maxRecentListCount) {
        const wordToRemove = this.recentWordUsage.shift();
        if (wordToRemove) {
          this.recentWordMatches.delete(wordToRemove);
        }
      }
      rv = mv;
    }

    return rv!;
  }

  public aiMatches(word: string, nullCostPrefix: boolean, maxCost: number = Number.POSITIVE_INFINITY): SongPos[] {
    return this.getMatches(word, nullCostPrefix, maxCost).positions;
  }

  public getWordCost(word: string, nullCostPrefix: boolean, maxCost: number = Number.POSITIVE_INFINITY): number {
    return this.getMatches(word, nullCostPrefix, maxCost).minCost;
  }

  public simpleMatches(word: string, ignoreCase: boolean = false): SongPos[] {
    return this.matches((w) => {
      const comparison = ignoreCase ? w.toLowerCase() === word.toLowerCase() : w === word;
      return comparison ? 0 : NaN;
    });
  }

  /**
   * Find all positions where a word starts with the given prefix.
   * Returns positions with the given cost. Bypasses candidate/cache logic.
   */
  public prefixMatches(prefix: string, cost: number): SongPos[] {
    const lowerPrefix = SongWords.normalizeToken(prefix);
    const unaccentedPrefix = StringExtensions.toUnaccented(lowerPrefix);
    return this.matches((w) => {
      const normalizedWord = SongWords.normalizeToken(w);
      if (normalizedWord.startsWith(lowerPrefix)) return cost;
      if (StringExtensions.toUnaccented(normalizedWord).startsWith(unaccentedPrefix)) return cost;
      return NaN;
    });
  }

  /**
   * Find all positions where a word can match the given prefix with bounded edit distance.
   * Only the beginning of each candidate word is compared, so non-prefix fuzzy matches are excluded.
   */
  public fuzzyPrefixMatches(prefix: string, maxCost: number): SongPos[] {
    const token = SongWords.normalizeToken(prefix);
    if (!token) return [];

    const unaccentedToken = StringExtensions.toUnaccented(token);
    return this.matches((w) => {
      const normalizedWord = SongWords.normalizeToken(w);
      if (!normalizedWord) return NaN;

      const candidatePrefix = normalizedWord.substring(0, Math.min(token.length, normalizedWord.length));
      const unaccentedWord = StringExtensions.toUnaccented(normalizedWord);
      const unaccentedCandidatePrefix = unaccentedWord.substring(0, Math.min(unaccentedToken.length, unaccentedWord.length));

      const accentedCost = DamerauLevenshtein.accentedDamerauLevenshteinDistanceBounded(token, candidatePrefix, maxCost);
      const unaccentedCost = DamerauLevenshtein.accentedDamerauLevenshteinDistanceBounded(unaccentedToken, unaccentedCandidatePrefix, maxCost);
      const cost = Math.min(accentedCost, unaccentedCost);

      return isFinite(cost) && cost <= maxCost ? cost : NaN;
    });
  }
}
