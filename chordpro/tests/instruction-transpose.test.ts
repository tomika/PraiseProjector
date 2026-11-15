import assert from "node:assert/strict";
import test from "node:test";
import { ChordProDocument, getChordSystem } from "../chordpro_base";
import { Instructions } from "../chordpro_instructions";
import { projectDisplaySequence } from "../render/display-plan";

const songText = `{title: Transpose test}
{start_of_verse: Verse}
[C]Line one [G]here
{end_of_verse}
{start_of_chorus: Chorus}
[F]Chorus [C]line
{end_of_chorus}`;

/** Chords of every projected section row, as "value: chords". */
function projectedChords(songTranspose: number, instructionText: string): string[] {
  const document = new ChordProDocument(getChordSystem("G"), songText);
  // The song's own transposition (playlist item / display) shifts the whole document,
  // as the editor and the client view do.
  if (songTranspose) document.transpose(songTranspose);
  const instructions = new Instructions();
  instructions.parse(instructionText, document);
  const sequence = projectDisplaySequence({ document, readOnly: true, instructionsMode: "FULL", instructions });
  return sequence.lines
    .filter((entry) => entry.role === "section" && entry.line.chords.length)
    .map((entry) => `${entry.item?.value}: ${entry.line.chords.map((chord) => chord.text).join(" ")}`);
}

test("an instruction's transposition adds to the song's transposition", () => {
  assert.deepEqual(projectedChords(0, "Verse\nChorus\nChorus +2"), ["Verse: C G", "Chorus: F C", "Chorus: G D"]);
  // Song +2 (C → D) and the last chorus another +1: three semitones there.
  assert.deepEqual(projectedChords(2, "Verse\nChorus\nChorus +1"), ["Verse: D A", "Chorus: G D", "Chorus: G# D#"]);
  assert.deepEqual(projectedChords(-1, "Chorus -2"), ["Chorus: D A"]);
});

test("a comment line naming a section repeats it in the song's own order", () => {
  const text = `{title: Recall}
{start_of_verse: Verse 1}
[C]First
{end_of_verse}
{start_of_chorus: Chorus}
[F]Refrain
{end_of_chorus}
{start_of_verse: Verse 2}
[G]Second
{end_of_verse}
{c: Chorus}
{c: Softly at the end}`;
  const document = new ChordProDocument(getChordSystem("G"), text);
  assert.equal(document.getDefaultInstructions(), "Verse 1\nChorus\nVerse 2\nChorus\nSoftly at the end");
  const sequence = projectDisplaySequence({ document, readOnly: true, instructionsMode: "FULL", instructions: null });
  assert.deepEqual(
    sequence.lines.filter((entry) => entry.role === "section" && entry.line.chords.length).map((entry) => entry.item?.value),
    ["Verse 1", "Chorus", "Verse 2", "Chorus"]
  );
});

test("a transposition written in the section tag is inherited by the instruction and adds up too", () => {
  const document = new ChordProDocument(getChordSystem("G"), songText.replace("{start_of_chorus: Chorus}", "{start_of_chorus: Chorus +1}"));
  document.transpose(2);
  const sequence = projectDisplaySequence({ document, readOnly: true, instructionsMode: "FULL", instructions: null });
  const chorus = sequence.lines.find((entry) => entry.line.chords.length && entry.line.chords[0].text !== "D");
  assert.deepEqual(
    chorus?.line.chords.map((chord) => chord.text),
    ["G#", "D#"]
  );
});
