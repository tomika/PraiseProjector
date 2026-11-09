import assert from "node:assert/strict";
import test from "node:test";
import { DifferentialText, DiffTextPreProcessor } from "../../common/utils";
import { ChordProChord, ChordProDocument, createChordAnchorMatcher, getChordSystem } from "../chordpro_base";

/** Builds a compare-view document the way the editor does for `compareBase`. */
function differentialDocument(before: string, after: string, wordLevel = true) {
  const system = getChordSystem("G");
  const preprocessor = new DiffTextPreProcessor();
  const old = new ChordProDocument(system, before).generateDocument();
  const act = new ChordProDocument(system, after).generateDocument();
  const diff = DifferentialText.create(old, act, { preprocessor, wordLevel });
  const lines: DifferentialText[] = [];
  let line = new DifferentialText();
  diff.forEachChunk((chunk) => {
    let first = true;
    for (let text of chunk.text.split("\n")) {
      if (!first) {
        lines.push(line);
        line = new DifferentialText();
      }
      if (!text && first) text = String.fromCharCode(0x23ce);
      if (text) line.append(text, chunk.added);
      first = false;
    }
  });
  if (line.count) lines.push(line);
  return new ChordProDocument(system, lines);
}

const describe = (chord: ChordProChord) => ({
  text: chord.text,
  change: chord.moved ? "moved" : chord.added === true ? "added" : chord.added === false ? "removed" : "equal",
});

function chordsOf(before: string, after: string, wordLevel?: boolean) {
  const doc = differentialDocument(before, after, wordLevel);
  const line = doc.lines.find((l) => l.chords.length > 0);
  assert.ok(line, "expected a lyric line with chords");
  return line.chords;
}

for (const wordLevel of [true, false]) {
  const level = wordLevel ? "word-level" : "char-level";

  test(`${level}: inserting lyrics before chords does not mark later chords as moved`, () => {
    const chords = chordsOf(
      "bátran [F]folytasd a harcot gyerünk, csak [Gm]igy tová[C]bb!",
      "bátran [F]folytasd a harcot, gyerünk, csak [Gm]igy tová[C]bb!",
      wordLevel
    );
    assert.deepEqual(chords.map(describe), [
      { text: "F", change: "equal" },
      { text: "Gm", change: "equal" },
      { text: "C", change: "equal" },
    ]);
  });

  test(`${level}: deleting lyrics before chords does not mark later chords as moved`, () => {
    const chords = chordsOf("Nagyon [F]jól ismer engem, átveszi [B]minden terhem,", "Nagy [F]jól ismer, átveszi [B]minden terhem,", wordLevel);
    assert.deepEqual(chords.map(describe), [
      { text: "F", change: "equal" },
      { text: "B", change: "equal" },
    ]);
  });

  test(`${level}: a chord really moved after an earlier lyric edit is still reported as moved`, () => {
    const chords = chordsOf("abc [G]def ghi", "abcX def [G]ghi", wordLevel);
    assert.equal(chords.length, 1);
    assert.deepEqual(describe(chords[0]), { text: "G", change: "moved" });
    assert.equal(chords[0].prevPos, 4);
    assert.equal(chords[0].pos, 9);
  });
}

test("chord anchors survive accent changes inside the word", () => {
  const chords = chordsOf("Ő a [F]legjobb, mindig sz[Dm]ámíth[Gm]atok rá.[C]", "Ő a [F]legjobb, mindig sz[Dm]amith[Gm]atok ra.[C]");
  assert.deepEqual(
    chords.map(describe),
    ["F", "Dm", "Gm", "C"].map((text) => ({ text, change: "equal" }))
  );
});

test("removed and added chords are ordered by their rendered position", () => {
  // The removed D sits at old offset 6, the added E at new offset 2, but in the
  // rendered stream ("XXXXXX" removed, then "ab") D comes first.
  const chords = chordsOf("XXXXXX[D]ab", "ab[E]");
  assert.deepEqual(chords.map(describe), [
    { text: "D", change: "removed" },
    { text: "E", change: "added" },
  ]);
});

test("createChordAnchorMatcher maps offsets across insertions, deletions and replacements", () => {
  const insert = createChordAnchorMatcher("harcot gyerünk", "harcot, gyerünk");
  assert.equal(insert(7, 8), true, "after the insertion the offset shifts by its length");
  assert.equal(insert(7, 7), false);
  assert.equal(insert(6, 6), true, "either side of an insertion is the same place");
  assert.equal(insert(6, 7), true);

  const tailDeleted = createChordAnchorMatcher("abc def", "abc");
  assert.equal(tailDeleted(7, 3), true, "line end stays the line end");

  const replaced = createChordAnchorMatcher("abcd", "WXYZ");
  assert.equal(replaced(2, 2), true, "same relative offset inside replaced text");
  assert.equal(replaced(2, 3), false);

  const empty = createChordAnchorMatcher("", "");
  assert.equal(empty(0, 0), true, "chord-only lines");
});
