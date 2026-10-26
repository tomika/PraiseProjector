import assert from "node:assert/strict";
import test, { mock } from "node:test";
import { ChordProAbc, ChordProDocument, getChordSystem } from "../chordpro_base";
import { Instructions } from "../chordpro_instructions";
import { defaultDisplayProperties, defaultStyles } from "../chordpro_styles";
import { buildDisplayPlan, DisplayIdentityRegistry, type AbcDisplayMode, type DisplayInstructionsMode } from "../render/display-plan";

const SONG = `{start_of_abc: Intro}
X:1
K:G
"G"GABc|"D"d4|
{end_of_abc}
{start_of_verse: Verse}
[G]Amazing [C]grace
[D]How sweet the [G]sound
{end_of_verse}`;

// The real chord-grid extraction renders through abcjs into a DOM, which Node lacks;
// these tests cover the projection's choice, so stand in a fixed grid line.
const GRID = new ChordProDocument(getChordSystem("G"), "{start_of_grid: Intro}\nG D\n{end_of_grid}");
mock.method(ChordProAbc.prototype, "toGrid", () => GRID.lines[0].clone(true));

function plan(
  abcMode: AbcDisplayMode | undefined,
  options: { readOnly?: boolean; instructions?: string; instructionsMode?: DisplayInstructionsMode } = {}
) {
  const system = getChordSystem("G");
  const document = new ChordProDocument(system, SONG);
  const display = defaultDisplayProperties();
  let instructions: Instructions | null = null;
  if (options.instructions) {
    instructions = new Instructions();
    instructions.parse(options.instructions, document);
  }
  const result = buildDisplayPlan({
    document,
    identities: new DisplayIdentityRegistry(),
    system,
    display,
    directives: defaultStyles(display.lyricsFont),
    chordFormat: 0,
    showTitle: false,
    showMeta: false,
    showTags: true,
    abbreviateTags: false,
    readOnly: options.readOnly ?? true,
    instructionsMode: options.instructionsMode ?? (instructions ? "FIRST_LINE" : ""),
    instructions,
    abcMode,
  });
  return result.occurrences.map((occurrence) => (occurrence.kind === "grid" ? `grid:${occurrence.text}` : occurrence.kind));
}

const INSTRUCTED = { instructions: "Intro\nVerse\nIntro" };

test("document order: AUTO and NOTATION render the abcjs block", () => {
  assert.deepEqual(plan(undefined), ["abc", "lyrics", "lyrics"]);
  assert.deepEqual(plan("NOTATION"), ["abc", "lyrics", "lyrics"]);
});

test("document order: CHORDS reduces the block to its chord grid, HIDDEN drops it", () => {
  assert.deepEqual(plan("CHORDS"), ["grid:G D", "lyrics", "lyrics"]);
  assert.deepEqual(plan("HIDDEN"), ["lyrics", "lyrics"]);
});

test("instructed: AUTO keeps the legacy chord grid, CHORDS matches it", () => {
  const legacy = ["grid:G D", "lyrics", "lyrics", "grid:G D ..."];
  assert.deepEqual(plan(undefined, INSTRUCTED), legacy);
  assert.deepEqual(plan("CHORDS", INSTRUCTED), legacy);
});

test("instructed: NOTATION renders the block, a FIRST_LINE repeat becomes a label row", () => {
  assert.deepEqual(plan("NOTATION", INSTRUCTED), ["abc", "lyrics", "lyrics", "comment"]);
  assert.deepEqual(plan("NOTATION", { ...INSTRUCTED, instructionsMode: "FULL" }), ["abc", "lyrics", "lyrics", "abc"]);
});

test("instructed: HIDDEN drops an ABC-only section with every repeat", () => {
  assert.deepEqual(plan("HIDDEN", INSTRUCTED), ["lyrics", "lyrics"]);
  assert.deepEqual(plan("HIDDEN", { ...INSTRUCTED, instructionsMode: "FULL" }), ["lyrics", "lyrics"]);
});

test("editing ignores the ABC mode", () => {
  assert.deepEqual(plan("HIDDEN", { readOnly: false }), ["abc", "lyrics", "lyrics"]);
  assert.deepEqual(plan("CHORDS", { readOnly: false }), ["abc", "lyrics", "lyrics"]);
});
