import assert from "node:assert/strict";
import test from "node:test";
import { ChordProEditor } from "../chordpro_editor";
import type { ChordProLine } from "../chordpro_base";
import { highlightDecorationKey, nonHighlightDecorationKey, type DomSongRendererInput } from "../render/dom-song-renderer";

type HighlightState = {
  readOnly: boolean;
  disposed: boolean;
  drawingSuppressed: boolean;
  sectionRepeatCounts: Array<{ section: number; from: number; to: number; multiplier: number }>;
  highlighted: {
    from: number;
    to: number;
    section?: number;
    repeatIndex?: number;
    repeatTotal?: number;
    repeatNonce?: number;
  } | null;
  requestHighlightScroll: () => void;
  reconcileRenderBackend: (category: string) => void;
};

function highlightEditorHarness() {
  const editor = Object.create(ChordProEditor.prototype) as ChordProEditor;
  let reconciles = 0;
  const state = editor as unknown as HighlightState;
  Object.assign(state, {
    readOnly: true,
    disposed: false,
    drawingSuppressed: false,
    sectionRepeatCounts: [{ section: 3, from: 10, to: 20, multiplier: 3 }],
    highlighted: null,
    requestHighlightScroll: () => undefined,
    reconcileRenderBackend: () => {
      reconciles += 1;
    },
  });
  return { editor, state, reconciles: () => reconciles };
}

test("an explicit zero repeat nonce keeps duplicate passive highlights idempotent", () => {
  const { editor, state } = highlightEditorHarness();

  editor.highlight(10, 20, 3, 0, false);
  editor.highlight(10, 20, 3, 0, false);

  assert.equal(state.highlighted?.repeatIndex, 1);
  assert.equal(state.highlighted?.repeatNonce, 0);
});

test("an omitted repeat nonce retains the intentional advance-repeat semantics", () => {
  const { editor, state } = highlightEditorHarness();

  editor.highlight(10, 20, 3, undefined, false);
  editor.highlight(10, 20, 3, undefined, false);

  assert.equal(state.highlighted?.repeatIndex, 2);
});

test("highlight rendering respects drawing suppression and disposal", () => {
  const { editor, state, reconciles } = highlightEditorHarness();

  state.drawingSuppressed = true;
  editor.highlight(10, 20, 3, 0);
  assert.equal(reconciles(), 0);

  state.drawingSuppressed = false;
  editor.highlight(11, 20, 3, 0);
  assert.equal(reconciles(), 1);

  state.disposed = true;
  editor.highlight(12, 20, 3, 0);
  assert.equal(reconciles(), 1);
});

test("highlight and non-highlight decoration keys are independent", () => {
  const line = {} as ChordProLine;
  const base = {
    document: { lines: [line] },
    highlight: { from: 10, to: 20, section: 3, repeatIndex: 1, repeatTotal: 3 },
    highlightOpacity: 0.5,
    isDark: false,
    editing: null,
  } as unknown as DomSongRendererInput;
  const dark = { ...base, isDark: true };
  const caret = {
    ...base,
    editing: {
      caret: { line, column: 2 },
      selection: null,
      chordText: null,
      tagText: null,
      drag: null,
    },
  };

  assert.equal(highlightDecorationKey(dark), highlightDecorationKey(base));
  assert.equal(highlightDecorationKey(caret), highlightDecorationKey(base));
  assert.notEqual(nonHighlightDecorationKey(dark), nonHighlightDecorationKey(base));
  assert.notEqual(nonHighlightDecorationKey(caret), nonHighlightDecorationKey(base));
});
