import assert from "node:assert/strict";
import { test } from "node:test";
import { abcKeyToSongKey, abcToChordProSong, looksLikeAbc, mapOutsideAbcBlocks } from "../abc-import";
import { ChordProAbc, ChordProDocument, getChordSystem } from "../chordpro_base";
import { Mode } from "../note_system";

const HYMN = `X:1
T:Áldjad, lelkem
T:103. zsoltár
C:Ismeretlen
M:3/4
L:1/4
Q:1/4=96
K:Bb
"Bb"B2 c|d3|
w: Ál-djad lel-kem`;

test("header metadata moves into the song; K:, M: and L: stay in the score", () => {
  assert.equal(
    abcToChordProSong(HYMN, "G"),
    [
      "{title: Áldjad, lelkem}",
      "{subtitle: 103. zsoltár}",
      "{composer: Ismeretlen}",
      "{key: B}",
      "{time: 3/4}",
      "{tempo: 96}",
      "{start_of_abc}",
      "X:1",
      "M:3/4",
      "L:1/4",
      "K:Bb",
      '"Bb"B2 c|d3|',
      "w: Ál-djad lel-kem",
      "{end_of_abc}",
    ].join("\n")
  );
});

test("the imported song reads back with its metadata and a single score", () => {
  const document = new ChordProDocument(getChordSystem("G"), abcToChordProSong(HYMN, "G"));
  assert.equal(document.getMeta("title"), "Áldjad, lelkem");
  assert.equal(document.getMeta("tempo"), "96");
  const scores = document.lines.filter((line) => line instanceof ChordProAbc) as ChordProAbc[];
  assert.equal(scores.length, 1);
  assert.equal(scores[0].getAbc().match(/^K:/gm)?.length, 1, "the song key must not add a second K:");
});

test("only the starting key, meter and tempo become metadata; later changes stay in the score", () => {
  const song = abcToChordProSong("X:1\nT:Changes\nM:4/4\nQ:1/4=80\nK:G\nGABc|\nK:D\nM:3/4\nQ:1/4=120\ndef|", "S");
  assert.match(song, /\{key: G\}\n\{time: 4\/4\}\n\{tempo: 80\}/);
  assert.match(song, /K:G\nGABc\|\nK:D\nM:3\/4\nQ:1\/4=120\ndef\|/);
  assert.doesNotMatch(song, /Q:1\/4=80/, "an exact quarter-note tempo is carried by {tempo} alone");
});

test("tempos {tempo} cannot reproduce exactly keep their Q: field", () => {
  const dotted = abcToChordProSong("X:1\nM:6/8\nQ:3/8=60\nK:C\nCDE FGA|", "S");
  assert.match(dotted, /\{tempo: 90\}/, "60 dotted quarters are 90 quarter notes a minute");
  assert.match(dotted, /^Q:3\/8=60$/m);
  const labelled = abcToChordProSong('X:1\nQ:"Allegro" 1/4=132\nK:C\nCDEF|', "S");
  assert.match(labelled, /\{tempo: 132\}/);
  assert.match(labelled, /^Q:"Allegro" 1\/4=132$/m);
});

test("ABC keys become song keys in the song's chord alphabet, modes included", () => {
  assert.equal(abcKeyToSongKey("Bb", "G"), "B");
  assert.equal(abcKeyToSongKey("B", "G"), "H");
  assert.equal(abcKeyToSongKey("Bb", "S"), getChordSystem("S").getKey("Bb")!.name);
  assert.equal(abcKeyToSongKey("C clef=bass", "S"), "C");
  assert.equal(abcKeyToSongKey("G treble", "S"), "G");
  for (const [abc, signature, mode] of [
    ["F#m", 3, Mode.aeolian],
    ["Gmin", -2, Mode.aeolian],
    ["Ador", 1, Mode.dorian],
    ["D Mixolydian", 1, Mode.mixolydian],
    ["E phr", 0, Mode.phrygian],
  ] as const) {
    const key = getChordSystem("G").getKey(abcKeyToSongKey(abc, "G"));
    assert.equal(key?.signature, signature, abc);
    assert.equal(key?.scaleType, mode, abc);
  }
  assert.equal(abcKeyToSongKey("none", "G"), "");
  assert.equal(abcKeyToSongKey("Hp", "G"), "");
});

test("accent mnemonics, \\u escapes, entities and continuations read as plain text", () => {
  const song = abcToChordProSong("X:1\nT:Gy\\Hozelem\n+:\\u00e9s \\'Ed\\'en\nC:J\\'anos &amp; P&#233;ter\nK:C\nC|", "S");
  assert.match(song, /\{title: Győzelem és Édén\}/);
  assert.match(song, /\{composer: János & Péter\}/);
  assert.doesNotMatch(song, /^[T+C]:/m);
});

test("a tunebook keeps its tune titles in the score and takes the song's metadata from the first tune", () => {
  const song = abcToChordProSong("X:1\nT:First\nK:G\nGABc|\n\nX:2\nT:Second\nK:D\ndefg|", "S");
  assert.match(song, /^\{title: First\}$/m);
  assert.match(song, /^\{key: G\}$/m);
  assert.match(song, /^T:First$/m);
  assert.match(song, /^T:Second$/m);
  assert.match(song, /defg\|\n\{end_of_abc\}$/);
});

test("ABC is recognized only as plain notation, never in ChordPro or ordinary lyrics", () => {
  assert.ok(looksLikeAbc(HYMN));
  assert.ok(looksLikeAbc("T:No reference\nM:4/4\nK:C\nCDEF|"));
  assert.ok(looksLikeAbc("X:1\nK:C\n{g}A2 B2|"), "grace notes are not ChordPro directives");
  assert.ok(!looksLikeAbc(`{title: Song}\n{start_of_abc}\n${HYMN}\n{end_of_abc}`));
  assert.ok(!looksLikeAbc("Amazing grace, how sweet the sound\nK: is not a key here"));
});

test("chord handling skips ABC blocks, including an unterminated one", () => {
  const upper = (text: string) => text.replace(/\[([^\]]+)\]/g, (_, chord: string) => `[${chord.toUpperCase()}]`);
  const text = "[g]Hello\n{start_of_abc: Intro}\nX:1\nK:C\n[ceg]|[P:a]\n{end_of_abc}\n[d]World";
  assert.equal(mapOutsideAbcBlocks(text, upper), "[G]Hello\n{start_of_abc: Intro}\nX:1\nK:C\n[ceg]|[P:a]\n{end_of_abc}\n[D]World");
  assert.equal(mapOutsideAbcBlocks("[a]x\n{start_of_abc}\n[ceg]", upper), "[A]x\n{start_of_abc}\n[ceg]");
});
