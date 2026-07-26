import assert from "node:assert/strict";
import test from "node:test";
import { ChordProDocument, getChordSystem } from "../chordpro_base";
import { collectChordDiagramLabels } from "../render/diagram-chords";
import { CHORDFORMAT_SIMPLIFIED } from "../render/chord-visual";

test("simplified chord diagrams use only the chords visible in the song", () => {
  const system = getChordSystem("G");
  const document = new ChordProDocument(system, "[Cmaj7]One [C/E]two [Cm7/G]three [C]four");

  assert.deepEqual(collectChordDiagramLabels(document, system, CHORDFORMAT_SIMPLIFIED, true), ["C", "Cm"]);
});

test("editable chord diagrams retain authored extensions and slash bass notes", () => {
  const system = getChordSystem("G");
  const document = new ChordProDocument(system, "[Cmaj7]One [C/E]two");

  assert.deepEqual(collectChordDiagramLabels(document, system, CHORDFORMAT_SIMPLIFIED, false), ["Cmaj7", "C/E"]);
});
