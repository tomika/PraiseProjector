/**
 * Roman chord notation inside rendered ABC scores.
 *
 * abcjs formats chord symbols itself (German note names and jazz superscripts
 * only). This module does not patch abcjs: it uses the documented
 * `afterParsing` render option to replace the chord names of the parsed tune
 * before engraving. abcjs then measures and spaces the text it actually draws,
 * and every element keeps the character offsets of the real source, which the
 * notation highlight resolves against. `restore()` puts the original names
 * back once the tune is engraved, because MIDI playback reads the chord
 * symbols of the same tune object for its accompaniment.
 *
 * With the optional `wrap` score option, abcjs chooses the line breaks from
 * measure widths taken before `afterParsing`, so only those use the original
 * chord widths; the spacing within each line uses the drawn text.
 *
 * Chord text comes from `buildChordVisualModel`, the formatter of the ChordPro
 * rows, so a score and the lyrics around it show the same numerals.
 */
import type { KeySignature, TuneObject } from "abcjs";
import { abcChordNameToSystem, type ChordSystem } from "../chordpro_base";
import { buildChordVisualModel, CHORDFORMAT_ROMAN_MASK, CHORDFORMAT_SIMPLIFIED, type ChordVisualModel } from "./chord-visual";

/** abcjs's SVG writer draws the text after this marker as a jazz-style superscript, and the text after a second marker smaller. */
const ABCJS_SUPERSCRIPT_MARKER = "\x03";
/** abcjs keeps an ASCII slash bass only when it starts with a letter A–G, so a Roman bass needs another slash. */
const DIVISION_SLASH = "∕";

const ABC_MODE_SUFFIX: Record<string, string> = {
  "": "",
  m: "m",
  Dor: " dorian",
  Phr: " phrygian",
  Lyd: " lydian",
  Mix: " mixolydian",
  Loc: " locrian",
};

type AbcChordSymbol = { name: string; position?: string; rel_position?: unknown };
type AbcKey = Pick<KeySignature, "root" | "acc" | "mode">;

export function usesRomanAbcChords(chordFormat: number, readOnly: boolean) {
  return readOnly && (chordFormat & CHORDFORMAT_ROMAN_MASK) !== 0;
}

/** The key name in `system`'s spelling, or undefined for `K:none`, highland pipes and unsupported keys. */
export function abcKeyName(system: ChordSystem, key: AbcKey | undefined): string | undefined {
  if (!key || !/^[A-G]$/.test(key.root)) return undefined;
  const suffix = ABC_MODE_SUFFIX[key.mode];
  if (suffix === undefined) return undefined;
  return system.getKey(abcChordNameToSystem(system, key.root + key.acc) + suffix)?.name;
}

/** Serializes the token model for abcjs: the modifier becomes a superscript exactly when the ChordPro rows draw it so. */
export function abcChordText(model: ChordVisualModel): string {
  if (model.unknown) return model.tokens.map((token) => token.text).join("");
  let head = "";
  let modifier = "";
  let tail = "";
  let superscript = false;
  for (const token of model.tokens) {
    if (token.role === "modifier") {
      modifier += token.text;
      superscript ||= token.subscript;
    } else if (token.role === "prefix" || token.role === "base-note") head += token.text;
    else tail += token.role === "bass-separator" ? DIVISION_SLASH : token.text;
  }
  return superscript ? [head, modifier, tail].join(ABCJS_SUPERSCRIPT_MARKER) : head + modifier + tail;
}

export interface AbcChordNotationOptions {
  readonly system: ChordSystem;
  readonly chordFormat: number;
  /** The key of the surrounding song rows, used where the score names no key. */
  readonly fallbackKey?: string;
}

export interface AbcChordNotation {
  /** The `afterParsing` render option. abcjs calls it again after a re-parse for line wrapping. */
  readonly afterParsing: (tune: TuneObject) => TuneObject;
  /** Puts the original chord names back into every tune changed so far. */
  restore(): void;
  /** The first key the last processed tune names, in the system's spelling. */
  readonly scoreKey: string | undefined;
}

export function createAbcChordNotation(options: AbcChordNotationOptions): AbcChordNotation {
  const { system, chordFormat, fallbackKey } = options;
  const simplify = (chordFormat & CHORDFORMAT_SIMPLIFIED) !== 0;
  const replaced: { symbol: AbcChordSymbol; name: string }[] = [];
  let scoreKey: string | undefined;

  const format = (name: string, key: string | undefined) =>
    name
      .split("\n")
      .map((line) => {
        const chord = abcChordNameToSystem(system, line);
        return abcChordText(
          buildChordVisualModel({
            chord,
            chordDetails: system.getChordDetails(chord, simplify),
            system,
            chordFormat,
            readOnly: true,
            actualKey: key,
          })
        );
      })
      .join("\n");

  const afterParsing = (tune: TuneObject) => {
    scoreKey = undefined;
    for (const line of tune.lines) {
      for (const staff of line.staff ?? []) {
        const lineKey = abcKeyName(system, staff.key);
        scoreKey ??= lineKey;
        for (const voice of staff.voices ?? []) {
          // A line starts in the key in force there; inline [K:] fields change it for the rest of the voice.
          let key = lineKey ?? fallbackKey;
          for (const item of voice) {
            if (item.el_type === "key") {
              const inlineKey = abcKeyName(system, item);
              scoreKey ??= inlineKey;
              key = inlineKey ?? fallbackKey;
              continue;
            }
            if (item.el_type !== "note") continue;
            for (const symbol of (item as { chord?: AbcChordSymbol[] }).chord ?? []) {
              // Positioned strings ("^text", "@x,y text") are annotations, not chord symbols.
              if (symbol.position !== "default" || symbol.rel_position || typeof symbol.name !== "string") continue;
              const text = format(symbol.name, key);
              if (text === symbol.name) continue;
              replaced.push({ symbol, name: symbol.name });
              symbol.name = text;
            }
          }
        }
      }
    }
    return tune;
  };

  return {
    afterParsing,
    restore() {
      // Newest first, so a symbol changed twice ends on its original name.
      for (const { symbol, name } of replaced.splice(0).reverse()) symbol.name = name;
    },
    get scoreKey() {
      return scoreKey;
    },
  };
}
