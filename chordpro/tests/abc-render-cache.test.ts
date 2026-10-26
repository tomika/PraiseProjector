import assert from "node:assert/strict";
import test from "node:test";
import { ChordProAbc, ChordProDocument, getChordSystem } from "../chordpro_base";
import type { DisplayPlan } from "../render/display-plan";
import { DomSongRenderer, type AbcRenderPort, type DomSongRendererInput } from "../render/dom-song-renderer";
import type { SongLayoutResult } from "../layout/song-layout";

type TuneObject = NonNullable<ReturnType<AbcRenderPort["render"]>>;

type AbcCacheHarness = {
  renderAbcBlocks(plan: DisplayPlan, layout: SongLayoutResult, input: DomSongRendererInput): boolean;
  getAbcVisualObject(abc: ChordProAbc): TuneObject | undefined;
};

const SONG = `{start_of_abc: Intro}\nX:1\nK:G\n"G"GABc|\n{end_of_abc}`;

function fakeNode() {
  return {
    className: "",
    dataset: {} as Record<string, string>,
    style: { width: "", removeProperty: () => "" },
    replaceChildren: () => undefined,
    remove: () => undefined,
    querySelector: () => null,
  };
}

/** The renderer's ABC cache only, without a DOM: abcjs is stood in by the port. */
function abcCacheHarness() {
  const renderer = Object.create(DomSongRenderer.prototype) as DomSongRenderer;
  const rendered: ChordProAbc[] = [];
  const abcPort: AbcRenderPort = {
    isLoaded: () => true,
    load: () => Promise.resolve(),
    render: (_node, abc) => {
      rendered.push(abc);
      return { rendered: rendered.length } as unknown as TuneObject;
    },
  };
  Object.assign(renderer, {
    abcNodes: new Map(),
    abcPort,
    doc: { createElement: fakeNode },
    measurer: { styleRevision: 0, measureOwnedElement: () => ({ width: 30, height: 30 }) },
  });
  return { harness: renderer as unknown as AbcCacheHarness, rendered };
}

function abcPlan(abc: ChordProAbc) {
  return {
    occurrences: [{ id: "abc-occurrence", kind: "abc", source: abc, text: abc.getAbc() }],
    display: { horizontalMargin: 0, lyricsLineHeight: 10 },
  } as unknown as DisplayPlan;
}

test("unchanged notation keeps its rendered tune while tracking the re-projected clone", () => {
  const document = new ChordProDocument(getChordSystem("G"), SONG);
  const origin = document.lines[0] as ChordProAbc;
  const firstClone = origin.clone(true);
  const secondClone = origin.clone(true);
  const { harness, rendered } = abcCacheHarness();
  const layout = { width: 300 } as SongLayoutResult;
  const input = { system: { systemCode: "G" }, isDark: false } as unknown as DomSongRendererInput;

  harness.renderAbcBlocks(abcPlan(firstClone), layout, input);
  const visual = harness.getAbcVisualObject(firstClone);
  assert.ok(visual);

  // e.g. a title-visibility toggle re-projects the instructed sequence.
  harness.renderAbcBlocks(abcPlan(secondClone), layout, input);
  assert.equal(rendered.length, 1, "the unchanged notation is not re-rendered");
  assert.equal(harness.getAbcVisualObject(secondClone), visual);
});
