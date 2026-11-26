/**
 * Safe, render-neutral chord visual model.
 *
 * Extracted from `ChordDrawer.drawChordText` (public/chordpro/chord_drawer.ts)
 * and the now-retired instructions-pane HTML renderer, which independently
 * reimplemented the same prefix/base-note/modifier/bass/
 * suffix composition and `LCMOLL`/`NOMMOL`/`BB`/`SIMPLIFIED`/`INKEY` flag
 * behavior — one via canvas draw calls, the other via HTML string
 * concatenation. This module is the ONE place that behavior is decided.
 *
 * Output is plain token data: an ordered array of `{ role, text, subscript,
 * gapBefore }` tokens, never HTML or markup strings. A token's `text` is
 * the formatted chord part it represents (prefix, a note or scale degree,
 * a modifier run, a suffix, or the whole unknown-chord text). Arbitrary or
 * malicious-looking chord text (e.g. containing `<`, `>`, `&`) passes through
 * unchanged as token text. Consumers must render tokens with
 * `document.createTextNode`/`textContent`, never `innerHTML` — this module
 * has no DOM types and does not render anything itself.
 *
 * `gapBefore` (0 or 1 px) reproduces the existing canvas layout exactly: the
 * base chord's modifier run is drawn 1px after the base note; every other
 * token abuts the previous one.
 */
import { UnicodeSymbol } from "../../common/symbols";
import { romanLower, romanUpper, VersionedMap } from "../../common/utils";
import { ChordProChordBase, ChordSystem } from "../chordpro_base";
import type { Key } from "../note_system";

export const CHORDFORMAT_LCMOLL = 1;
export const CHORDFORMAT_NOMMOL = 3;
export const CHORDFORMAT_SUBSCRIPT = 4;
export const CHORDFORMAT_BB = 8;
export const CHORDFORMAT_SIMPLIFIED = 16;
export const CHORDFORMAT_NOSECTIONDUP = 32;
export const CHORDFORMAT_NOCHORDS = 64;
export const CHORDFORMAT_INKEY = 128;
export const CHORDFORMAT_ROMAN = 256;
export const CHORDFORMAT_ROMAN_MAJOR = 512;
export const CHORDFORMAT_ROMAN_MASK = CHORDFORMAT_ROMAN | CHORDFORMAT_ROMAN_MAJOR;

export type ChordVisualTokenRole = "prefix" | "base-note" | "modifier" | "bass-separator" | "bass-note" | "bass-modifier" | "suffix" | "unknown-text";

export interface ChordVisualToken {
  readonly role: ChordVisualTokenRole;
  /** Plain text, already flat/sharp-substituted where applicable. Never HTML. */
  readonly text: string;
  /** Whether this token should be drawn in the subscript font/offset (CHORDFORMAT_SUBSCRIPT). */
  readonly subscript: boolean;
  /** Pixel gap to insert before this token, on top of the previous token's own width (0 or 1). */
  readonly gapBefore: number;
}

export interface ChordVisualModel {
  /** True when the chord text could not be parsed/identified; `tokens` is then a single unknown-text token. */
  readonly unknown: boolean;
  readonly tokens: readonly ChordVisualToken[];
  /** Whether to draw the "actual chord" underline marker beneath the full token run. */
  readonly underline: boolean;
}

/** The subset of `ChordSystem.getChordDetails`'s return shape this module needs. */
export interface ChordVisualDetails {
  readonly prefix: string;
  readonly baseNote: string;
  readonly modifier: string;
  readonly normalized: string;
  readonly bassNote: string;
  readonly suffix: string;
  readonly minor: boolean;
  readonly hasMinorThird: boolean;
}

export interface BuildChordVisualModelOptions {
  /** Only consulted for its `.text`/string value when `chordDetails` is null (unknown chord). */
  readonly chord: string | ChordProChordBase;
  /**
   * Pre-resolved via the caller's own `getChordDetails(chord)` (which owns the
   * `simplify` default). Passing it in, rather than re-deriving it here, keeps
   * that one small defaulting rule in its single existing home.
   */
  readonly chordDetails: ChordVisualDetails | null;
  readonly system: ChordSystem;
  readonly chordFormat: number;
  readonly readOnly: boolean;
  /** Whether to request the "actual chord" underline marker. */
  readonly actual?: boolean;
  /** The active key for key-aware note spelling and Roman numerals. */
  readonly actualKey?: string;
  /** Optional cache for INKEY note-name resolution, keyed the same way as `ChordDrawer.chordsInKey`. */
  readonly chordsInKey?: VersionedMap<string, string, string>;
}

function formatNote(system: ChordSystem, readOnly: boolean, chordFormat: number, note: string, moll: boolean): string {
  if (readOnly && (chordFormat & CHORDFORMAT_BB) !== 0) {
    const n = system.stringToNote(note);
    if (n === 1) note = "Bb";
    else if (n === 2) note = "B";
  }
  return !readOnly || !moll || (chordFormat & CHORDFORMAT_LCMOLL) === 0 ? ChordProChordBase.formatSingleNote(note) : note.toLowerCase();
}

function formatModifierText(text: string, readOnly: boolean, chordFormat: number, roman = false): { text: string; subscript: boolean } {
  const subscript = readOnly && (chordFormat & CHORDFORMAT_SUBSCRIPT) === CHORDFORMAT_SUBSCRIPT;
  const substituted =
    subscript || roman
      ? text.replace(/[#b]/g, (r) => (r === "#" ? UnicodeSymbol.sharp : UnicodeSymbol.flat))
      : text.replace(/b/g, UnicodeSymbol.flat);
  return { text: substituted, subscript };
}

function resolveInKeyNote(options: BuildChordVisualModelOptions, baseNote: string): string {
  const { system, chordFormat, readOnly, actualKey, chordsInKey } = options;
  if (!readOnly || (chordFormat & CHORDFORMAT_INKEY) !== CHORDFORMAT_INKEY || !actualKey) return baseNote;
  const key = system.getKey(actualKey);
  if (!key) return baseNote;
  if (!chordsInKey) return key.noteName(baseNote);
  let resolved = chordsInKey.get(key.name, baseNote);
  if (!resolved) chordsInKey.set(key.name, baseNote, (resolved = key.noteName(baseNote)));
  return resolved;
}

const majorIntervals = [0, 2, 4, 5, 7, 9, 11];
const pitchClass = (pitch: number) => ((pitch % 12) + 12) % 12;

function formatRomanDegree(key: Key, note: string, minor: boolean, majorReference: boolean): string {
  const { system } = key;
  const pitch = system.stringToNote(note);
  const tonic = system.stringToNote(key.baseNote);
  if (pitch === null || tonic === null) return note;

  const interval = pitchClass(pitch - tonic);
  const scaleIntervals = Array.from(key.notes(), (degree) => pitchClass(system.stringToNote(degree)! - tonic));
  const reference = majorReference ? majorIntervals : scaleIntervals;
  let degree = reference.indexOf(interval);
  // Keep the degree of a note in the song's scale when comparing it to the major scale.
  if (degree < 0) degree = scaleIntervals.indexOf(interval);
  if (degree < 0) {
    // For other chromatic notes, distinguish spellings such as F♯ (♯IV) and G♭ (♭V).
    // In the German/Hungarian system, both H and B use the seventh letter position.
    const letters = system.systemCode === "G" ? "CDEFGAH" : "CDEFGAB";
    const letterIndex = (name: string) => letters.indexOf(system.systemCode === "G" && name[0] === "B" ? "H" : name[0]);
    degree = (letterIndex(note) - letterIndex(key.baseNote) + 7) % 7;
  }
  const accidental = pitchClass(interval - reference[degree] + 6) - 6;
  const sign = accidental < 0 ? UnicodeSymbol.flat : UnicodeSymbol.sharp;
  return sign.repeat(Math.abs(accidental)) + (minor ? romanLower : romanUpper)[degree + 1];
}

function romanModifier(details: ChordVisualDetails, simplified: boolean): string {
  if (details.normalized === "dim") return "°";
  if (details.normalized === "o") return simplified ? "°" : "°7";
  if (details.normalized === "ø") return simplified ? "°" : "ø7";
  return details.hasMinorThird ? details.modifier.replace(/^(?:min|m(?!aj)|-)/, "") : details.modifier;
}

/**
 * Builds the safe token model for one chord. Behavior mirrors
 * `ChordDrawer.drawChordText` exactly (see module doc); this function never
 * touches a canvas/DOM and never builds a markup string.
 */
export function buildChordVisualModel(options: BuildChordVisualModelOptions): ChordVisualModel {
  const { chord, chordDetails, system, chordFormat, readOnly } = options;
  const roman = readOnly && (chordFormat & CHORDFORMAT_ROMAN_MASK) !== 0;

  if (!chordDetails) {
    const text = typeof chord === "string" ? chord : chord.text;
    return {
      unknown: true,
      tokens: [{ role: "unknown-text", text, subscript: false, gapBefore: 0 }],
      underline: false,
    };
  }
  // A note letter inside a word (N.C., Coda) is a recognized chord label, but
  // not a degree to number: keep its text as written. A bracketed extension
  // such as (add9) is still part of the chord.
  if (roman && (/\p{L}/u.test(chordDetails.prefix) || /^\p{L}/u.test(chordDetails.suffix))) {
    const text = typeof chord === "string" ? chord : chord.text;
    return { unknown: false, tokens: [{ role: "unknown-text", text, subscript: false, gapBefore: 0 }], underline: !!options.actual };
  }

  const tokens: ChordVisualToken[] = [];

  if (chordDetails.prefix) tokens.push({ role: "prefix", text: chordDetails.prefix, subscript: false, gapBefore: 0 });

  const romanKey = roman && options.actualKey ? system.getKey(options.actualKey) : undefined;
  const majorReference = (chordFormat & CHORDFORMAT_ROMAN_MAJOR) !== 0;
  const simplified = readOnly && (chordFormat & CHORDFORMAT_SIMPLIFIED) !== 0;
  let modifierText: string;
  if (romanKey) {
    const text = formatRomanDegree(romanKey, chordDetails.baseNote, chordDetails.hasMinorThird, majorReference);
    tokens.push({ role: "base-note", text, subscript: false, gapBefore: 0 });
    modifierText = romanModifier(chordDetails, simplified);
  } else {
    const baseNote = resolveInKeyNote(options, chordDetails.baseNote);
    const note = formatNote(system, readOnly, chordFormat, baseNote, chordDetails.minor);
    tokens.push({ role: "base-note", text: note.substring(0, 1), subscript: false, gapBefore: 0 });
    const omitMinor = readOnly && chordDetails.minor && (chordFormat & CHORDFORMAT_NOMMOL) === CHORDFORMAT_NOMMOL;
    modifierText = note.substring(1) + (omitMinor ? chordDetails.modifier.substring(1) : chordDetails.modifier);
  }

  if (modifierText) {
    const formatted = formatModifierText(modifierText, readOnly, chordFormat, roman);
    tokens.push({ role: "modifier", text: formatted.text, subscript: formatted.subscript, gapBefore: 1 });
  }

  if (!simplified && chordDetails.bassNote) {
    tokens.push({ role: "bass-separator", text: "/", subscript: false, gapBefore: 0 });
    if (romanKey) {
      const text = formatRomanDegree(romanKey, chordDetails.bassNote, false, majorReference);
      tokens.push({ role: "bass-note", text, subscript: false, gapBefore: 0 });
    } else {
      const note = formatNote(system, readOnly, chordFormat, resolveInKeyNote(options, chordDetails.bassNote), false);
      tokens.push({ role: "bass-note", text: note.substring(0, 1), subscript: false, gapBefore: 0 });
      const bassModifier = formatModifierText(note.substring(1), readOnly, chordFormat, roman);
      tokens.push({ role: "bass-modifier", text: bassModifier.text, subscript: bassModifier.subscript, gapBefore: 0 });
    }
  }

  if (chordDetails.suffix) tokens.push({ role: "suffix", text: chordDetails.suffix, subscript: false, gapBefore: 0 });

  return { unknown: false, tokens, underline: !!options.actual };
}
