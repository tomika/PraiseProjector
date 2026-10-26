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
 * exactly the chord-derived substring it represents (prefix, a note letter,
 * a modifier run, a suffix, or the whole unknown-chord text) with only the
 * existing flat/sharp glyph substitution applied — arbitrary or
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
import { VersionedMap } from "../../common/utils";
import { ChordProChordBase, ChordSystem } from "../chordpro_base";

export const CHORDFORMAT_LCMOLL = 1;
export const CHORDFORMAT_NOMMOL = 3;
export const CHORDFORMAT_SUBSCRIPT = 4;
export const CHORDFORMAT_BB = 8;
export const CHORDFORMAT_SIMPLIFIED = 16;
export const CHORDFORMAT_NOSECTIONDUP = 32;
export const CHORDFORMAT_NOCHORDS = 64;
export const CHORDFORMAT_INKEY = 128;

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
  readonly bassNote: string;
  readonly suffix: string;
  readonly minor: boolean;
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
  /** The active song key (`ChordDrawer.getKey()`), consulted only when CHORDFORMAT_INKEY is set. */
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

function formatModifierText(text: string, readOnly: boolean, chordFormat: number): { text: string; subscript: boolean } {
  const subscript = readOnly && (chordFormat & CHORDFORMAT_SUBSCRIPT) === CHORDFORMAT_SUBSCRIPT;
  const substituted = subscript
    ? text.replace(/[#b]/g, (r) => (r === "#" ? UnicodeSymbol.sharp : UnicodeSymbol.flat))
    : text.replace(/b/g, UnicodeSymbol.flat);
  return { text: substituted, subscript };
}

function resolveInKeyBaseNote(options: BuildChordVisualModelOptions, baseNote: string): string {
  const { system, chordFormat, readOnly, actualKey, chordsInKey } = options;
  if (!readOnly || (chordFormat & CHORDFORMAT_INKEY) !== CHORDFORMAT_INKEY || !actualKey) return baseNote;
  const key = system.getKey(actualKey);
  if (!key) return baseNote;
  if (!chordsInKey) return key.noteName(baseNote);
  let resolved = chordsInKey.get(key.name, baseNote);
  if (!resolved) chordsInKey.set(key.name, baseNote, (resolved = key.noteName(baseNote)));
  return resolved;
}

/**
 * Builds the safe token model for one chord. Behavior mirrors
 * `ChordDrawer.drawChordText` exactly (see module doc); this function never
 * touches a canvas/DOM and never builds a markup string.
 */
export function buildChordVisualModel(options: BuildChordVisualModelOptions): ChordVisualModel {
  const { chord, chordDetails, system, chordFormat, readOnly } = options;

  if (!chordDetails) {
    const text = typeof chord === "string" ? chord : chord.text;
    return {
      unknown: true,
      tokens: [{ role: "unknown-text", text, subscript: false, gapBefore: 0 }],
      underline: false,
    };
  }

  const tokens: ChordVisualToken[] = [];

  if (chordDetails.prefix) tokens.push({ role: "prefix", text: chordDetails.prefix, subscript: false, gapBefore: 0 });

  const baseNote = resolveInKeyBaseNote(options, chordDetails.baseNote);
  let note = formatNote(system, readOnly, chordFormat, baseNote, chordDetails.minor);
  tokens.push({ role: "base-note", text: note.substring(0, 1), subscript: false, gapBefore: 0 });

  let modifierText = note.substring(1);
  if (readOnly && chordDetails.minor && (chordFormat & CHORDFORMAT_NOMMOL) === CHORDFORMAT_NOMMOL) modifierText += chordDetails.modifier.substring(1);
  else modifierText += chordDetails.modifier;

  if (modifierText) {
    const formatted = formatModifierText(modifierText, readOnly, chordFormat);
    tokens.push({ role: "modifier", text: formatted.text, subscript: formatted.subscript, gapBefore: 1 });
  }

  if (!readOnly || (chordFormat & CHORDFORMAT_SIMPLIFIED) === 0) {
    if (chordDetails.bassNote) {
      tokens.push({ role: "bass-separator", text: "/", subscript: false, gapBefore: 0 });
      note = formatNote(system, readOnly, chordFormat, chordDetails.bassNote, false);
      tokens.push({ role: "bass-note", text: note.substring(0, 1), subscript: false, gapBefore: 0 });
      const bassModifier = formatModifierText(note.substring(1), readOnly, chordFormat);
      tokens.push({ role: "bass-modifier", text: bassModifier.text, subscript: bassModifier.subscript, gapBefore: 0 });
    }
  }

  if (chordDetails.suffix) tokens.push({ role: "suffix", text: chordDetails.suffix, subscript: false, gapBefore: 0 });

  return { unknown: false, tokens, underline: !!options.actual };
}
