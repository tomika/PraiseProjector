import assert from "node:assert/strict";
import test from "node:test";
import { ChordProAbc, ChordProDocument, getChordSystem } from "../chordpro_base";
import type { DisplayPlan } from "../render/display-plan";
import { DomSongRenderer, type AbcPlaybackAnchor, type AbcRenderPort, type DomSongRendererInput } from "../render/dom-song-renderer";
import type { SongLayoutResult } from "../layout/song-layout";
import { CHORDFORMAT_SUBSCRIPT } from "../render/chord-visual";

type TuneObject = NonNullable<ReturnType<AbcRenderPort["render"]>>;

type AbcCacheHarness = {
  renderAbcBlocks(plan: DisplayPlan, layout: SongLayoutResult, input: DomSongRendererInput): boolean;
  getAbcVisualObject(abc: ChordProAbc): TuneObject | undefined;
  getAbcPlaybackAnchor(abc: ChordProAbc): AbcPlaybackAnchor | undefined;
  getAbcVisualObjectForAnchor(anchor: AbcPlaybackAnchor): TuneObject | undefined;
};

const SONG = `{start_of_abc: Intro}\nX:1\nK:G\n"G"GABc|\n{end_of_abc}`;

function fakeNode(svg?: SVGSVGElement) {
  return {
    className: "",
    dataset: {} as Record<string, string>,
    style: { width: "", removeProperty: () => "" },
    replaceChildren: () => undefined,
    remove: () => undefined,
    querySelector: () => svg ?? null,
    querySelectorAll: () => (svg ? [svg] : []),
  };
}

/** The renderer's ABC cache only, without a DOM: abcjs is stood in by the port. */
function abcCacheHarness(svg?: SVGSVGElement) {
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
    doc: { createElement: () => fakeNode(svg) },
    measurer: {
      styleRevision: 0,
      measureOwnedElement: (node: HTMLElement, prepare?: () => void) => {
        prepare?.();
        return { width: Number.parseFloat(node.style.width) || 30, height: 30 };
      },
    },
  });
  return { harness: renderer as unknown as AbcCacheHarness, rendered, options };
}

function abcPlan(abc: ChordProAbc | null, id = "abc-occurrence", origin: ChordProAbc | null = null) {
  return {
    occurrences: abc ? [{ id, kind: "abc", source: abc, origin, text: abc.getAbc() }] : [],
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

/** An abcjs SVG without a viewBox attribute, as each browser reports it. */
function headerOverflowSvg(browser: "chrome" | "firefox") {
  const attributes = new Map([
    ["width", "600"],
    ["height", "200"],
  ]);
  const svg = {
    getAttribute: (name: string) => attributes.get(name) ?? null,
    setAttribute: (name: string, value: string) => attributes.set(name, value),
    getBBox: () => ({ x: -25, width: 650 }),
    viewBox: { baseVal: browser === "chrome" ? { x: 0, y: 0, width: 0, height: 0 } : null },
  } as unknown as SVGSVGElement;
  return { svg, attributes };
}

test("a missing viewBox reported as null (Firefox) still widens the SVG for overlong headers", () => {
  const { svg, attributes } = headerOverflowSvg("firefox");
  const { harness } = abcCacheHarness(svg);
  const document = new ChordProDocument(getChordSystem("G"), SONG);
  const input = { system: { systemCode: "G" }, chordFormat: 0 } as unknown as DomSongRendererInput;

  harness.renderAbcBlocks(abcPlan(document.lines[0] as ChordProAbc), { width: 20 } as SongLayoutResult, input);
  assert.equal(attributes.get("viewBox"), "-25 0 650 200");
  assert.equal(attributes.get("width"), "650");
});

test("ABC-only headers use the actual score width, retain overlong text and cache the visible playback tune", () => {
  const { svg, attributes } = headerOverflowSvg("chrome");
  const { harness, rendered, options } = abcCacheHarness(svg);
  const document = new ChordProDocument(getChordSystem("G"), SONG);
  const abc = document.lines[0] as ChordProAbc;
  const layout = { width: 20 } as SongLayoutResult;
  const input = { system: { systemCode: "G" }, chordFormat: 0 } as unknown as DomSongRendererInput;

  harness.renderAbcBlocks(abcPlan(abc), layout, input);
  assert.equal(options.length, 2);
  assert.equal(options[1].staffwidth, 600, "headers align to the staff's actual width, independent of the host viewport");
  assert.equal(attributes.get("viewBox"), "-25 0 650 200");
  assert.equal(attributes.get("width"), "650");
  assert.deepEqual(harness.getAbcVisualObject(abc), { rendered: 2 }, "MIDI playback must use the second, visible render");
  harness.renderAbcBlocks(abcPlan(abc), layout, input);
  assert.equal(rendered.length, 2, "the fitted score is cached without repeated expansion or rendering");
});

test("a playback anchor finds its score again after the zoom view showed it as lyrics", () => {
  const document = new ChordProDocument(getChordSystem("G"), SONG);
  const origin = document.lines[0] as ChordProAbc;
  const { harness, rendered } = abcCacheHarness();
  const layout = { width: 300 } as SongLayoutResult;
  const input = { system: { systemCode: "G" }, isDark: false, chordFormat: 0 } as unknown as DomSongRendererInput;

  const clicked = origin.clone(true);
  harness.renderAbcBlocks(abcPlan(clicked, "e1:l0|repeat:0", origin), layout, input);
  const anchor = harness.getAbcPlaybackAnchor(clicked);
  assert.deepEqual(anchor, { occurrenceId: "e1:l0|repeat:0", origin });
  assert.equal(harness.getAbcVisualObjectForAnchor(anchor!), harness.getAbcVisualObject(clicked));

  // Expanded to lyrics: the notation is gone, and with it every rendered tune.
  harness.renderAbcBlocks(abcPlan(null), layout, input);
  assert.equal(harness.getAbcVisualObjectForAnchor(anchor!), undefined);

  // Back to notation in a new identity epoch: a fresh rendering of the same score.
  harness.renderAbcBlocks(abcPlan(origin.clone(true), "e3:l0|repeat:0", origin), layout, input);
  assert.equal(rendered.length, 2);
  assert.deepEqual(harness.getAbcVisualObjectForAnchor(anchor!), { rendered: 2 });
});
