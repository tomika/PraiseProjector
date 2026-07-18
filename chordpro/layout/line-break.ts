import type { WordMetrics, WordSource } from "./word-metrics";

export interface WordFrontier {
  readonly lyric: number;
  readonly chord: number;
}

export interface MeasuredWord<UnitId, ChordId> {
  readonly source: WordSource<UnitId, ChordId>;
  readonly metrics: WordMetrics;
}

export interface RowSpan {
  readonly firstWord: number;
  readonly lastWord: number;
}

export interface LineBreakResult {
  readonly pending: boolean;
  readonly rows: readonly RowSpan[];
}

export function initialWordFrontier(): WordFrontier {
  return { lyric: 0, chord: Number.NEGATIVE_INFINITY };
}

/** Places a word against the two conservative lyric/chord frontiers. */
export function placeWord(frontier: WordFrontier, metrics: WordMetrics): { readonly start: number; readonly next: WordFrontier } {
  let start = frontier.lyric;
  if (metrics.firstChordStart !== null && frontier.chord !== Number.NEGATIVE_INFINITY)
    start = Math.max(start, frontier.chord - metrics.firstChordStart);
  start = Math.max(0, start);
  return {
    start,
    next: {
      lyric: start + metrics.width,
      chord: metrics.lastChordEnd === null ? frontier.chord : Math.max(frontier.chord, start + metrics.lastChordEnd),
    },
  };
}

/** Right edge excluding only the final word's trailing whitespace. */
export function occupiedFrontierRight(frontier: WordFrontier, lastWord: WordMetrics | null) {
  const lyric = lastWord ? frontier.lyric - (lastWord.width - lastWord.trimmedWidth) : frontier.lyric;
  return Math.max(lyric, frontier.chord === Number.NEGATIVE_INFINITY ? 0 : frontier.chord);
}

/**
 * Deterministic greedy breaker with a four-word legal-start lookback. The
 * whole-row LP is intentionally absent: callers run it once for each returned
 * final row, never while evaluating candidates.
 */
export function breakLine<UnitId, ChordId>(words: readonly MeasuredWord<UnitId, ChordId>[], measure: number): LineBreakResult {
  if (measure <= 0 || Number.isNaN(measure)) return { pending: true, rows: [] };
  if (words.length === 0) return { pending: false, rows: [{ firstWord: 0, lastWord: -1 }] };
  if (!Number.isFinite(measure)) return { pending: false, rows: [{ firstWord: 0, lastWord: words.length - 1 }] };

  const rows: RowSpan[] = [];
  let rowStart = 0;
  let frontier = initialWordFrontier();
  let index = 0;

  while (index < words.length) {
    const placed = placeWord(frontier, words[index].metrics);
    const right = occupiedFrontierRight(placed.next, words[index].metrics);
    if (index > rowStart && right > measure) {
      let best = index;
      let bestScore = Number.POSITIVE_INFINITY;
      const earliest = Math.max(rowStart + 1, index - 4);
      for (let candidate = index; candidate >= earliest; candidate -= 1) {
        const breakCost = words[candidate].source.breakCost;
        if (!Number.isFinite(breakCost)) continue;
        const score = breakCost * 2 + (index - candidate) * 3;
        // Candidates are visited closest-to-overflow first, so `<` preserves
        // the mandated closest break on ties.
        if (score < bestScore) {
          best = candidate;
          bestScore = score;
        }
      }
      rows.push({ firstWord: rowStart, lastWord: best - 1 });
      rowStart = best;
      frontier = initialWordFrontier();
      index = best;
      continue;
    }
    frontier = placed.next;
    index += 1;
  }

  rows.push({ firstWord: rowStart, lastWord: words.length - 1 });
  return { pending: false, rows };
}
