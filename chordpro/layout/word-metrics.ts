import { segmentVisualUnits, type VisualUnit } from "./text-units";

export interface MeasuredWordUnit<Id> extends VisualUnit {
  readonly id: Id;
  readonly width: number;
}

export interface MeasuredWordChord<Id> {
  /** Stable display-chord identity supplied by the display plan. */
  readonly id: Id;
  /** Original UTF-16 anchor in the complete lyric line. */
  readonly anchor: number;
  /** Full occupied width, including the renderer's chord border. */
  readonly width: number;
}

export interface WordSourceChord<Id> {
  readonly id: Id;
  /** Original UTF-16 anchor; ownership never erases source identity. */
  readonly sourceOffset: number;
  /** UTF-16 anchor relative to this word's source start. */
  readonly anchorOffset: number;
  readonly width: number;
}

export interface WordSource<UnitId, ChordId> {
  readonly sourceStart: number;
  readonly sourceEnd: number;
  readonly trimmedSourceEnd: number;
  readonly units: readonly MeasuredWordUnit<UnitId>[];
  readonly chords: readonly WordSourceChord<ChordId>[];
  /** Cost of breaking BEFORE this word. The first word is unbreakable. */
  readonly breakCost: number;
}

export interface WordMetrics {
  /** Full lyric width, including trailing whitespace. */
  readonly width: number;
  /** Lyric width with trailing whitespace removed. */
  readonly trimmedWidth: number;
  readonly firstChordStart: number | null;
  readonly lastChordEnd: number | null;
}

export function isWhitespaceText(text: string) {
  return text.length > 0 && text.trim().length === 0;
}

function isUppercaseUnit(text: string) {
  const normalized = text.normalize("NFC");
  const upper = normalized.toUpperCase();
  const lower = normalized.toLowerCase();
  return upper !== lower && normalized === upper;
}

/**
 * Computes the cost of breaking before every word's first non-whitespace
 * visual unit. Keys and all comparisons are UTF-16 source offsets.
 */
export function computeBreakCosts(text: string): ReadonlyMap<number, number> {
  const result = new Map<number, number>();
  const units = segmentVisualUnits(text);
  let previousNonWhitespace: VisualUnit | null = null;
  let atWordStart = true;
  let foundWord = false;

  for (const unit of units) {
    if (isWhitespaceText(unit.text)) {
      if (previousNonWhitespace) atWordStart = true;
      continue;
    }
    if (atWordStart) {
      let cost = Number.POSITIVE_INFINITY;
      if (foundWord) {
        if (previousNonWhitespace && ".:;?!".includes(previousNonWhitespace.text)) cost = 0;
        else if (previousNonWhitespace?.text === ",") cost = 1;
        else if (isUppercaseUnit(unit.text)) cost = 5;
        else cost = 10;
      }
      result.set(unit.sourceStart, cost);
      foundWord = true;
      atWordStart = false;
    }
    previousNonWhitespace = unit;
  }
  return result;
}

function sourceWidthAt<UnitId, ChordId>(word: WordSource<UnitId, ChordId>, relativeSourceOffset: number) {
  const absolute = word.sourceStart + relativeSourceOffset;
  let width = 0;
  for (const unit of word.units) {
    if (unit.sourceEnd > absolute) break;
    width += unit.width;
  }
  return width;
}

/**
 * Builds structural words directly from the centralized visual-unit helper.
 * A word owns trailing whitespace; line-leading whitespace belongs to the first
 * following word. Chords retain their stable identity and original UTF-16
 * anchor even when an inter-word whitespace anchor transfers to the next word.
 */
export function buildWordSources<UnitId, ChordId>(
  text: string,
  measureUnit: (unit: VisualUnit) => { readonly id: UnitId; readonly width: number },
  chords: readonly MeasuredWordChord<ChordId>[],
  breakCosts: ReadonlyMap<number, number> = computeBreakCosts(text),
  visualUnits: readonly VisualUnit[] = segmentVisualUnits(text)
): WordSource<UnitId, ChordId>[] {
  const units: MeasuredWordUnit<UnitId>[] = visualUnits.map((unit) => ({ ...unit, ...measureUnit(unit) }));
  const starts: number[] = [];
  let sawNonWhitespace = false;
  let afterWhitespace = false;

  for (let index = 0; index < units.length; index += 1) {
    const whitespace = isWhitespaceText(units[index].text);
    if (whitespace) {
      if (sawNonWhitespace) afterWhitespace = true;
      continue;
    }
    if (!sawNonWhitespace) {
      starts.push(0);
      sawNonWhitespace = true;
    } else if (afterWhitespace) starts.push(index);
    afterWhitespace = false;
  }

  // Whitespace-only and genuinely empty lines both keep one structural word.
  // The latter is what gives chord-only and empty lyric lines a deterministic row.
  if (starts.length === 0) starts.push(0);

  const mutable = starts.map((start, index) => {
    const end = starts[index + 1] ?? units.length;
    const wordUnits = units.slice(start, end);
    const sourceStart = index === 0 ? 0 : (wordUnits[0]?.sourceStart ?? text.length);
    const sourceEnd = wordUnits[wordUnits.length - 1]?.sourceEnd ?? sourceStart;
    let trimmedUnitCount = wordUnits.length;
    while (trimmedUnitCount > 0 && isWhitespaceText(wordUnits[trimmedUnitCount - 1].text)) trimmedUnitCount -= 1;
    const trimmedSourceEnd = trimmedUnitCount > 0 ? wordUnits[trimmedUnitCount - 1].sourceEnd : sourceStart;
    const firstNonWhitespace = wordUnits.find((unit) => !isWhitespaceText(unit.text));
    return {
      sourceStart,
      sourceEnd,
      trimmedSourceEnd,
      units: wordUnits,
      chords: [] as WordSourceChord<ChordId>[],
      breakCost: index === 0 ? Number.POSITIVE_INFINITY : (breakCosts.get(firstNonWhitespace?.sourceStart ?? sourceStart) ?? 10),
    };
  });

  for (const chord of chords) {
    let wordIndex = mutable.length - 1;
    let anchorOffset: number;
    if (chord.anchor >= text.length) {
      anchorOffset = mutable[wordIndex].sourceEnd - mutable[wordIndex].sourceStart;
    } else {
      wordIndex = mutable.findIndex((word) => chord.anchor < word.sourceEnd);
      if (wordIndex < 0) wordIndex = mutable.length - 1;
      const word = mutable[wordIndex];
      const inTrailingWhitespace = wordIndex + 1 < mutable.length && chord.anchor >= word.trimmedSourceEnd && chord.anchor < word.sourceEnd;
      if (inTrailingWhitespace) {
        wordIndex += 1;
        anchorOffset = 0;
      } else anchorOffset = Math.max(0, Math.min(word.sourceEnd - word.sourceStart, chord.anchor - word.sourceStart));
    }
    mutable[wordIndex].chords.push({ id: chord.id, sourceOffset: chord.anchor, anchorOffset, width: chord.width });
  }

  return mutable;
}

/** Conservative word geometry used only by the breaker; it never invokes LP. */
export function computeWordMetrics<UnitId, ChordId>(word: WordSource<UnitId, ChordId>): WordMetrics {
  const width = word.units.reduce((total, unit) => total + unit.width, 0);
  const trimmedWidth = word.units.filter((unit) => unit.sourceEnd <= word.trimmedSourceEnd).reduce((total, unit) => total + unit.width, 0);
  let firstChordStart: number | null = null;
  let lastChordEnd: number | null = null;
  let chordFrontier = Number.NEGATIVE_INFINITY;

  for (const chord of word.chords) {
    const naturalAnchor = sourceWidthAt(word, chord.anchorOffset);
    const start = Math.max(naturalAnchor, chordFrontier);
    chordFrontier = start + chord.width;
    if (firstChordStart === null) firstChordStart = start;
    lastChordEnd = chordFrontier;
  }
  return { width, trimmedWidth, firstChordStart, lastChordEnd };
}
