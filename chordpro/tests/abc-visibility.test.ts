import assert from "node:assert/strict";
import test from "node:test";
import { ChordProDocument, getChordSystem } from "../chordpro_base";
import { defaultDisplayProperties, defaultStyles } from "../chordpro_styles";
import { CHORDFORMAT_NOABC } from "../render/chord-visual";
import { buildDisplayPlan, DisplayIdentityRegistry } from "../render/display-plan";

const SONG = "[G]Amazing [C]grace\n{start_of_abc: Intro}\nX:1\nK:G\nGABc|\n{end_of_abc}\n[D]How sweet the [G]sound";

function planKinds(chordFormat: number, readOnly: boolean) {
  const system = getChordSystem("G");
  const document = new ChordProDocument(system, SONG);
  const display = defaultDisplayProperties();
  const plan = buildDisplayPlan({
    document,
    identities: new DisplayIdentityRegistry(),
    system,
    display,
    directives: defaultStyles(display.lyricsFont),
    chordFormat,
    showTitle: false,
    showMeta: false,
    showTags: true,
    abbreviateTags: false,
    readOnly,
  });
  return plan.occurrences.map((occurrence) => occurrence.kind);
}

test("ABC blocks are part of the readonly plan by default", () => {
  assert.deepEqual(planKinds(0, true), ["lyrics", "abc", "lyrics"]);
});

test("CHORDFORMAT_NOABC drops ABC blocks from the readonly plan only", () => {
  assert.deepEqual(planKinds(CHORDFORMAT_NOABC, true), ["lyrics", "lyrics"]);
});

test("CHORDFORMAT_NOABC never hides ABC blocks while editing", () => {
  assert.deepEqual(planKinds(CHORDFORMAT_NOABC, false), ["lyrics", "abc", "lyrics"]);
});
