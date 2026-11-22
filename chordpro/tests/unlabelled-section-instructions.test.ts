import assert from "node:assert/strict";
import test from "node:test";
import { Song } from "../../db-common/Song";
import { ChordProDocument, getChordSystem } from "../chordpro_base";
import { Instructions } from "../chordpro_instructions";
import { insertTransitionInstruction } from "../transition-instruction";

const songText = `{title:Jézus véred megtisztít}
{start_of_verse}
[A]Jézus véred [E/G]megtisz[F#m/E]tít.
Véred [D]ad új élet[Esus]et!       [E]
Véred te[D]sz ma szabadd[Esus E]á!
Értem fo[A]lyt e [C#m]drága [F#m/E]vér!
Így a [D]lel[Dm]kem,
Fehér mint a [A]hó [E/G#](mint a [F#m/E]hó).
Úr [Hm]Jézu[Hm/A]s, Te [D/E]megölt [E7]Bárá[A]ny!
{end_of_verse}`;

test("unlabelled standard section produces a default instruction", () => {
  const document = new ChordProDocument(getChordSystem("G"), songText);

  assert.equal(Instructions.defaultsFor(document), "verse");
});

test("unlabelled standard section remains projectable through instructed sections", () => {
  const song = new Song(songText, "G");

  assert.equal(song.Sections.length, 1);
  assert.equal(song.Sections[0].tag, "Verse");
  const instructed = song.InstructedSections("");
  assert.equal(instructed.length, 1);
  assert.equal(instructed[0].tag, "Verse");
  assert.match(instructed[0].text, /Jézus véred megtisztít/);
});

test("a transition annotation alone leaves an unsectioned song projectable", () => {
  const song = new Song("[D]Plain song", "S");
  const instructions = insertTransitionInstruction("", {
    from: "before",
    to: "after",
    placement: "next",
    sourceKey: "C",
    targetKey: "D",
    chords: ["C", "A7", "D"],
    style: "cadential",
    rating: 5,
  });
  assert.ok(song.Sections.length);
  assert.deepEqual(song.ProjectionSections(`\n${instructions}\n`), song.Sections);
});

test("getSections retains authored modifiers and the legacy unlabelled grid name", () => {
  const document = new ChordProDocument(
    getChordSystem("G"),
    `{start_of_verse: Verse 3x #2}\nLine\n{end_of_verse}\n{start_of_grid}\nD F G\n{end_of_grid}`
  );

  assert.deepEqual(document.getSections(), ["Verse 3x #2", "grid"]);
});
