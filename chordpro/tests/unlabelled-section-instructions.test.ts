import assert from "node:assert/strict";
import test from "node:test";
import { Song } from "../../db-common/Song";
import { ChordProDocument, getChordSystem } from "../chordpro_base";

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

  assert.equal(document.getDefaultInstructions(), "verse");
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
