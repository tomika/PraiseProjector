import type { AbcVisualParams, SynthOptions } from "abcjs";
import type { HeaderOptionDefaults } from "abc-gui";
import { readPersistedScoreDefaults } from "../common/score-settings";

/** The app sizes notation to its own layout, so neither users nor scores may rescale it. */
const FIXED_SCALE = 1;

/** Matches abc-gui's JSON/--- envelope, masking it to retain abcjs source offsets. */
export function parseAbcSource(value: string): { abc: string; options: Record<string, unknown>; bodyStart: number } {
  const normalized = value.replace(/\r(?=\n)/g, " ");
  const separator = /^[\t ]*---[\t ]*\r?$/m.exec(value);
  if (!separator || !/^\{\s*(?:["}]|$)/.test(value.slice(0, separator.index).trimStart())) {
    return { abc: normalized, options: {}, bodyStart: 0 };
  }
  const end = separator.index + separator[0].length;
  const bodyStart = value[end] === "\n" ? end + 1 : end;
  const abc = normalized.slice(0, end).replace(/[^\n]/g, " ") + normalized.slice(end);
  try {
    const options: unknown = JSON.parse(value.slice(0, separator.index));
    if (options && typeof options === "object" && !Array.isArray(options)) return { abc, options: options as Record<string, unknown>, bodyStart };
  } catch {
    // Like abc-gui, keep malformed drafts editable while ignoring their options.
  }
  return { abc, options: {}, bodyStart };
}

type Validator = (value: unknown) => boolean;
const number: Validator = (value) => typeof value === "number" && Number.isFinite(value);
const positive: Validator = (value) => number(value) && (value as number) > 0;
const nonnegative: Validator = (value) => number(value) && (value as number) >= 0;
const integer: Validator = (value) => number(value) && Number.isInteger(value);
const bool: Validator = (value) => typeof value === "boolean";
const string: Validator = (value) => typeof value === "string";
const midi: Validator = (value) => integer(value) && (value as number) >= 0 && (value as number) <= 127;
const integers: Validator = (value) => Array.isArray(value) && value.every((item) => integer(item) && item >= 0);

// Keep the data-only option surface in sync with abc-gui/src/parser/options.ts.
// Never forward arbitrary JSON as abcjs options (callbacks and sample URLs are host-owned).
const AUDIO: Record<string, Validator> = {
  swing: nonnegative,
  qpm: positive,
  defaultQpm: positive,
  program: midi,
  bassprog: midi,
  chordprog: midi,
  bassvol: midi,
  chordvol: midi,
  midiTranspose: integer,
  channel: (value) => integer(value) && (value as number) >= 0 && (value as number) <= 16,
  chordsOff: bool,
  drumOff: bool,
  voicesOff: (value) => bool(value) || integers(value),
  drum: string,
  gchord: string,
  drumBars: positive,
  drumIntro: nonnegative,
  fadeLength: nonnegative,
  soundFontVolumeMultiplier: nonnegative,
  pan: (value) => Array.isArray(value) && value.every((item) => number(item) && item >= -1 && item <= 1),
};
const VISUAL: Record<string, Validator> = {
  accentAbove: bool,
  ariaLabel: string,
  chordGrid: (value) => value === "noMusic" || value === "withMusic",
  expandToWidest: bool,
  foregroundColor: string,
  initialClef: bool,
  jazzchords: bool,
  germanAlphabet: bool,
  lineBreaks: integers,
  lineThickness: number,
  minPadding: nonnegative,
  oneSvgPerLine: bool,
  paddingbottom: nonnegative,
  paddingleft: nonnegative,
  paddingright: nonnegative,
  paddingtop: nonnegative,
  print: bool,
  scale: positive,
  staffwidth: positive,
  stafftopmargin: nonnegative,
  textboxpadding: nonnegative,
  visualTranspose: integer,
};

function pick(options: Record<string, unknown>, validators: Record<string, Validator>): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(validators)
      .filter(([key, validate]) => Object.prototype.hasOwnProperty.call(options, key) && validate(options[key]))
      .map(([key]) => [key, options[key]])
  );
}

export function abcSynthOptions(options: Record<string, unknown>): SynthOptions {
  return pick(options, AUDIO);
}

export function abcVisualOptions(options: Record<string, unknown>): AbcVisualParams {
  const result = pick(options, VISUAL);
  // `format.scale` is left out: abcjs lets it override the fixed `scale` option.
  const formatKeys =
    "titlefont gchordfont composerfont footerfont headerfont historyfont infofont measurefont partsfont repeatfont subtitlefont tempofont textfont voicefont tripletfont vocalfont wordsfont annotationfont partsbox freegchord fontboxpadding stretchlast tablabelfont tabnumberfont tabgracefont stafftopmargin".split(
      " "
    );
  if (options.format && typeof options.format === "object" && !Array.isArray(options.format)) {
    result.format = pick(
      options.format as Record<string, unknown>,
      Object.fromEntries(formatKeys.map((key) => [key, (value: unknown) => string(value) || number(value) || bool(value)]))
    );
  }
  if (options.wrap && typeof options.wrap === "object" && !Array.isArray(options.wrap)) {
    result.wrap = pick(
      options.wrap as Record<string, unknown>,
      Object.fromEntries(["preferredMeasuresPerLine", "minSpacing", "maxSpacing", "lastLineLimit", "minSpacingLimit"].map((key) => [key, positive]))
    );
  }
  return result;
}

/** Saved defaults are shared with the standalone client, which has no SettingsProvider. */
export function scoreOptionValues(tempo?: string): Record<string, unknown> {
  const values: Record<string, unknown> = { ...readPersistedScoreDefaults() };
  const bpm = Number(tempo);
  if (Number.isFinite(bpm) && bpm > 0) values.defaultQpm = bpm;
  return values;
}

export function abcHeaderDefaults(tempo: string, germanAlphabet: boolean, jazzchords: boolean): HeaderOptionDefaults {
  return {
    ...Object.fromEntries(Object.entries(scoreOptionValues(tempo)).map(([key, value]) => [key, { value }])),
    germanAlphabet: { value: germanAlphabet, editable: false },
    jazzchords: { value: jazzchords, editable: false },
    scale: { value: FIXED_SCALE, editable: false },
  };
}

/** abcjs directives that would override the fixed render options (`tune.formatting` beats them). */
const FIXED_DIRECTIVES = new Set(["scale"]);

/**
 * Blanks the arguments of fixed directives in all three abcjs forms: `%%name`, the
 * `I:name` field and the inline `[I:name]`. The prefix (and an inline field's `]`)
 * stays, so abcjs reads an empty directive: no length change keeps source offsets,
 * and no inserted whitespace breaks the beaming of the surrounding notes. The name
 * is matched like abcjs's directive token: a case-insensitive run of letters.
 */
export function maskFixedDirectives(abc: string): string {
  return abc.replace(/(^%%|^[ \t]*I:|\[I:)([ \t]*([A-Za-z]+)[^\]\n]*)/gm, (match, prefix: string, rest: string, name: string) =>
    FIXED_DIRECTIVES.has(name.toLowerCase()) ? prefix + " ".repeat(rest.length) : match
  );
}

export function resolveAbcOptions(source: string, tempo?: string) {
  const parsed = parseAbcSource(source);
  const defaults = scoreOptionValues(tempo);
  return {
    ...parsed,
    abc: maskFixedDirectives(parsed.abc),
    // Like abc-gui's fixed defaults, the scale also overrides a header written before it was fixed.
    visual: { ...abcVisualOptions(defaults), ...abcVisualOptions(parsed.options), scale: FIXED_SCALE },
    synth: { ...abcSynthOptions(defaults), ...abcSynthOptions(parsed.options) },
  };
}
