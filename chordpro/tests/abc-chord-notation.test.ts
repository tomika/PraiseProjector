import assert from "node:assert/strict";
import { before, test } from "node:test";
import type { TuneObject } from "abcjs";
import { abcjs, loadAbcjs } from "../abcjs-lazy";
import { getChordSystem } from "../chordpro_base";
import { abcKeyName, createAbcChordNotation } from "../render/abc-chord-notation";
import { CHORDFORMAT_ROMAN, CHORDFORMAT_ROMAN_MAJOR, CHORDFORMAT_SIMPLIFIED, CHORDFORMAT_SUBSCRIPT } from "../render/chord-visual";

before(async () => {
  await loadAbcjs();
});

const english = getChordSystem("S");
const german = getChordSystem("G");

type Symbol = { name: string; position: string };

function chordSymbols(tune: TuneObject) {
  const symbols: Symbol[] = [];
  for (const line of tune.lines)
    for (const staff of line.staff ?? [])
      for (const voice of staff.voices ?? []) for (const item of voice) symbols.push(...((item as { chord?: Symbol[] }).chord ?? []));
  return symbols;
}

function notate(abc: string, chordFormat: number, system = english, fallbackKey?: string) {
  const [tune] = abcjs().parseOnly(abc);
  const original = chordSymbols(tune).map(({ name }) => name);
  const notation = createAbcChordNotation({ system, chordFormat, fallbackKey });
  notation.afterParsing(tune);
  const rendered = chordSymbols(tune).map(({ name }) => name);
  notation.restore();
  return { rendered, original, restored: chordSymbols(tune).map(({ name }) => name), scoreKey: notation.scoreKey };
}

const MINOR = 'X:1\nK:Am\n"Am"A "C"c "F"f "G"g|"E7"e "Dm7/F"f "^Fine"a "N.C."z|\n';

test("score chords follow both Roman modes, keep annotations and are restored for playback", () => {
  const scale = notate(MINOR, CHORDFORMAT_ROMAN);
  assert.deepEqual(scale.rendered, ["i", "III", "VI", "VII", "V7", "iv7∕VI", "Fine", "N.C."]);
  assert.equal(scale.scoreKey, "Am");
  assert.deepEqual(scale.restored, scale.original, "MIDI accompaniment reads the original chord names");

  const major = notate(MINOR, CHORDFORMAT_ROMAN_MAJOR);
  assert.deepEqual(major.rendered, ["i", "♭III", "♭VI", "♭VII", "V7", "iv7∕♭VI", "Fine", "N.C."]);
});

test("inline and line key changes renumber the following chords", () => {
  const { rendered, scoreKey } = notate('X:1\nK:C\n"C"c "G7"g [K:G] "G"g "D7"d|\n"C"c4|\nK:D dor\n"Dm"d "C"c|\n', CHORDFORMAT_ROMAN);
  assert.deepEqual(rendered, ["I", "V7", "I", "V7", "IV", "i", "VII"]);
  assert.equal(scoreKey, "C");
});

test("stacked chord symbols are formatted line by line", () => {
  assert.deepEqual(notate('X:1\nK:G\n"G;Em"G4|\n', CHORDFORMAT_ROMAN).rendered, ["I\nvi"]);
});

test("superscript and simplified chord formats match the ChordPro rows", () => {
  const superscript = notate('X:1\nK:C\n"G7"g "Cmaj7/E"e "F"f|\n', CHORDFORMAT_ROMAN | CHORDFORMAT_SUBSCRIPT).rendered;
  assert.deepEqual(superscript, ["V\x037\x03", "I\x03maj7\x03∕III", "IV"]);
  assert.deepEqual(notate('X:1\nK:C\n"G7"g "Cmaj7/E"e|\n', CHORDFORMAT_ROMAN | CHORDFORMAT_SIMPLIFIED).rendered, ["V", "I"]);
});

test("German/Hungarian songs read the international ABC names in their own system", () => {
  const { rendered, scoreKey } = notate('X:1\nK:Bb\n"Bb"B "F/A"A "Eb"e "Cm"c "B"B|\n', CHORDFORMAT_ROMAN, german);
  assert.deepEqual(rendered, ["I", "V∕VII", "IV", "ii", "♯I"]);
  assert.equal(scoreKey, "B");
  assert.equal(abcKeyName(german, { root: "B", acc: "", mode: "m" }), "Hm");
});

test("a score without a usable key numbers its chords from the song key", () => {
  assert.deepEqual(notate('X:1\n"Em"E "C"C|\n', CHORDFORMAT_ROMAN, english, "G").rendered, ["vi", "IV"]);
  const none = notate('X:1\nK:none\n"Em"E "C"C|\n', CHORDFORMAT_ROMAN, english, "G");
  assert.deepEqual(none.rendered, ["vi", "IV"]);
  assert.equal(none.scoreKey, undefined);
  assert.deepEqual(notate('X:1\n"Em"E "C/E"C|\n', CHORDFORMAT_ROMAN).rendered, ["Em", "C∕E"], "letter names without any key");
});
