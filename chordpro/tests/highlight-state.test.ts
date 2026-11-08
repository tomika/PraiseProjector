import assert from "node:assert/strict";
import test from "node:test";
import { ChordProEditor } from "../chordpro_editor";
import type { ChordProLine } from "../chordpro_base";
import { highlightDecorationKey, nonHighlightDecorationKey, LayoutSnapshotCoordinator, type DomSongRendererInput } from "../render/dom-song-renderer";

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

test("deferred highlights keep draw=false with omitted section and nonce arguments", () => {
  const { editor, reconciles } = highlightEditorHarness();
  editor.highlight(10, 11, undefined, 0, false, { source: 10, from: 0, to: 1 });
  editor.highlight(11, 12, 3, undefined, false);
  editor.highlight(12, 13, undefined, false);
  editor.highlight(13, 14, false);
  assert.equal(reconciles(), 0);
  editor.highlight(14, 15);
  editor.highlight(15, 16, 3);
  editor.highlight(16, 17, true);
  assert.equal(reconciles(), 3, "all legacy shorthand calls still draw by default");
});

test("a deferred highlight follows only after its first layout and the host's fit frame", async (context) => {
  const frames: FrameRequestCallback[] = [];
  const originalRaf = Object.getOwnPropertyDescriptor(globalThis, "requestAnimationFrame");
  Object.defineProperty(globalThis, "requestAnimationFrame", {
    configurable: true,
    value: (callback: FrameRequestCallback) => frames.push(callback),
  });
  context.after(() => {
    if (originalRaf) Object.defineProperty(globalThis, "requestAnimationFrame", originalRaf);
    else Reflect.deleteProperty(globalThis, "requestAnimationFrame");
  });
  const { editor, state } = highlightEditorHarness();
  Reflect.deleteProperty(editor, "requestHighlightScroll");
  Reflect.deleteProperty(editor, "reconcileRenderBackend");
  let follows = 0;
  let hostScale = 1;
  let followedScale = 0;
  const runtime = editor as unknown as {
    domRenderer: unknown;
    createDomRendererInput: () => object;
    syncPrimarySurfaceVisibility: () => void;
    scrollHighlightedIntoView: () => void;
    reconcileRenderBackend: () => void;
  };
  runtime.scrollHighlightedIntoView = () => {
    follows++;
    followedScale = hostScale;
  };
  state.drawingSuppressed = true;
  editor.highlight(10, 11, undefined, 0, false, { source: 10, from: 3, to: 4 });
  assert.equal(follows, 0, "the suppressed document has no usable geometry yet");

  const snapshots = new LayoutSnapshotCoordinator();
  runtime.domRenderer = {
    update: () => snapshots.markPending(),
    whenLayoutSettled: () => snapshots.whenSettled(),
    getLayoutSnapshot: () => snapshots.getSnapshot(),
  };
  runtime.createDomRendererInput = () => ({});
  runtime.syncPrimarySurfaceVisibility = () => undefined;
  state.drawingSuppressed = false;
  runtime.reconcileRenderBackend();
  runtime.reconcileRenderBackend();
  assert.equal(frames.length, 0);
  snapshots.commit(400, 1200, true);
  await Promise.resolve();
  assert.equal(frames.length, 1, "repeated paints coalesce into one follow");
  assert.equal(follows, 0);
  hostScale = 1.25;
  frames.shift()!(0);
  assert.equal(follows, 1);
  assert.equal(followedScale, 1.25);

  editor.highlight(10, 11, undefined, 0, true, { source: 10, from: 4, to: 5 });
  snapshots.commit(400, 1300, true);
  await Promise.resolve();
  assert.equal(frames.length, 1);
  snapshots.markPending();
  frames.shift()!(1);
  await Promise.resolve();
  assert.equal(frames.length, 0, "an invalidated layout waits for settlement instead of polling frames");
  assert.equal(follows, 1);
  snapshots.commit(400, 1400, false);
  await Promise.resolve();
  assert.equal(frames.length, 0, "unsettled commits cannot create a frame loop");
  snapshots.commit(400, 1500, true);
  await Promise.resolve();
  assert.equal(frames.length, 1);
  frames.shift()!(2);
  assert.equal(follows, 2, "the latest settled layout is followed once");
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
