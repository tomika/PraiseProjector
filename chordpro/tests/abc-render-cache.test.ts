import assert from "node:assert/strict";
import test from "node:test";
import { ChordProAbc, ChordProDocument, getChordSystem } from "../chordpro_base";
import type { DisplayPlan } from "../render/display-plan";
import { DomSongRenderer, type AbcRenderPort, type DomSongRendererInput } from "../render/dom-song-renderer";
import type { SongLayoutResult } from "../layout/song-layout";
import { CHORDFORMAT_SUBSCRIPT } from "../render/chord-visual";

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
  const options: Parameters<AbcRenderPort["render"]>[2][] = [];
  const abcPort: AbcRenderPort = {
    isLoaded: () => true,
    load: () => Promise.resolve(),
    render: (_node, abc, params) => {
      rendered.push(abc);
      options.push(params);
      return { rendered: rendered.length } as unknown as TuneObject;
    },
  };
  Object.assign(renderer, {
    abcNodes: new Map(),
    abcPort,
    doc: { createElement: fakeNode },
    measurer: { styleRevision: 0, measureOwnedElement: () => ({ width: 30, height: 30 }) },
  });
  return { harness: renderer as unknown as AbcCacheHarness, rendered, options };
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

test("superscript changes invalidate the ABC cache and follow the same chord flag as the rest of the song", () => {
  const document = new ChordProDocument(getChordSystem("G"), SONG);
  const abc = document.lines[0] as ChordProAbc;
  const { harness, rendered, options } = abcCacheHarness();
  const layout = { width: 300 } as SongLayoutResult;
  const input = { system: { systemCode: "G" }, isDark: false, chordFormat: 0 } as unknown as DomSongRendererInput;
  harness.renderAbcBlocks(abcPlan(abc), layout, input);
  harness.renderAbcBlocks(abcPlan(abc), layout, { ...input, chordFormat: CHORDFORMAT_SUBSCRIPT });
  assert.equal(rendered.length, 2);
  assert.equal(options[0].jazzchords, false);
  assert.equal(options[1].jazzchords, true);
});
