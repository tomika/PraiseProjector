/**
 * Centralized visual-unit (grapheme cluster) segmentation for ChordPro lyric
 * text. Every unit carries UTF-16 source offsets (`sourceStart`/`sourceEnd`)
 * into the caller-supplied string. Measurement, wrapping, hit testing, and
 * editing must all segment text through this one helper so caret/selection
 * boundaries stay consistent everywhere; never reimplement segmentation
 * elsewhere and never use an array/code-point index as a source column.
 *
 * `Intl.Segmenter` (`granularity: "grapheme"`) is deliberately NOT used here.
 * It cannot be verified present on every runtime this project supports —
 * notably Android WebView on the project's minSdk 24 devices, whose system
 * WebView version is outside this project's control and is not guaranteed to
 * be auto-updated. A runtime-conditional segmenter would make caret/wrap
 * behavior diverge silently across hosts, which is worse than one
 * deterministic implementation everywhere. This fallback covers the
 * grapheme-cluster cases this codebase's fixtures actually exercise:
 * surrogate pairs, combining marks, ZWJ sequences, variation selectors,
 * emoji skin-tone modifiers, and regional-indicator (flag) pairs.
 */

export interface VisualUnit {
  readonly text: string;
  readonly sourceStart: number;
  readonly sourceEnd: number;
}

function isHighSurrogate(code: number) {
  return code >= 0xd800 && code <= 0xdbff;
}

function isLowSurrogate(code: number) {
  return code >= 0xdc00 && code <= 0xdfff;
}

const ZERO_WIDTH_JOINER = 0x200d;

function isVariationSelector(code: number) {
  return code >= 0xfe00 && code <= 0xfe0f;
}

/** Emoji skin-tone modifier (Fitzpatrick), U+1F3FB..U+1F3FF; always follows an emoji base. */
function isEmojiModifier(codePoint: number) {
  return codePoint >= 0x1f3fb && codePoint <= 0x1f3ff;
}

/** Regional indicator symbol, U+1F1E6..U+1F1FF; exactly two in a row form one flag. */
function isRegionalIndicator(codePoint: number) {
  return codePoint >= 0x1f1e6 && codePoint <= 0x1f1ff;
}

function isCombiningMark(code: number) {
  return (
    (code >= 0x0300 && code <= 0x036f) || // Combining Diacritical Marks
    (code >= 0x1ab0 && code <= 0x1aff) || // Combining Diacritical Marks Extended
    (code >= 0x1dc0 && code <= 0x1dff) || // Combining Diacritical Marks Supplement
    (code >= 0x20d0 && code <= 0x20ff) || // Combining Diacritical Marks for Symbols
    (code >= 0xfe20 && code <= 0xfe2f) // Combining Half Marks
  );
}

/** UTF-16 code-unit length of the codepoint starting at `index`: 2 for a valid surrogate pair, else 1. */
function codePointUnitLength(text: string, index: number): number {
  const code = text.charCodeAt(index);
  if (isHighSurrogate(code) && index + 1 < text.length && isLowSurrogate(text.charCodeAt(index + 1))) return 2;
  return 1;
}

/**
 * Segments `text` into visual (grapheme-cluster) units. Each unit's
 * `sourceStart`/`sourceEnd` are UTF-16 offsets into `text`, so
 * `text.slice(unit.sourceStart, unit.sourceEnd) === unit.text` always holds
 * and offsets compose directly with `ChordProChord.pos`-style UTF-16 anchors.
 */
export function segmentVisualUnits(text: string): VisualUnit[] {
  const units: VisualUnit[] = [];
  let index = 0;
  while (index < text.length) {
    const start = index;
    const firstCodePoint = text.codePointAt(index)!;
    index += codePointUnitLength(text, index);
    // Regional-indicator pairing: exactly two consecutive RIs form one flag;
    // a third RI starts the next unit (pairs greedily from the left).
    if (isRegionalIndicator(firstCodePoint) && index < text.length && isRegionalIndicator(text.codePointAt(index)!)) {
      index += codePointUnitLength(text, index);
    }
    for (;;) {
      if (index >= text.length) break;
      const code = text.charCodeAt(index);
      if (isCombiningMark(code) || isVariationSelector(code)) {
        index += 1;
        continue;
      }
      if (isEmojiModifier(text.codePointAt(index)!)) {
        index += 2; // skin-tone modifiers are always astral (one surrogate pair)
        continue;
      }
      if (code === ZERO_WIDTH_JOINER && index + 1 < text.length) {
        index += 1 + codePointUnitLength(text, index + 1);
        continue;
      }
      break;
    }
    units.push({ text: text.slice(start, index), sourceStart: start, sourceEnd: index });
  }
  return units;
}
