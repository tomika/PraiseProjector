import assert from "node:assert/strict";
import { test } from "node:test";
import { ChordProEditor as FullViewEditor } from "../ChordProEditor";
import { ChordProEditor as CoreEditor } from "../../../../chordpro/chordpro_editor";
import type { chordProAPI } from "../../../../chordpro/chordProApi";
import type { Display } from "../../../../common/pp-types";

test("full-view highlights retain ABC page ranges across the bound editor API", () => {
  const core = Object.assign(Object.create(CoreEditor.prototype), {
    readOnly: true,
    drawingSuppressed: true,
    highlighted: null,
    requestHighlightScroll: () => undefined,
  }) as CoreEditor;
  // The bound API has positional instruction/nonce/draw arguments before ABC.
  const bound = { highlight: (...args: Parameters<ReturnType<typeof chordProAPI.bind>["highlight"]>) => core.highlight(...args) };
  const fullView = Object.assign(Object.create(FullViewEditor.prototype), {
    wysiwygLoaded: true,
    wysiwygInitialized: true,
    getBoundChordProAPI: () => bound,
  }) as FullViewEditor;
  const state = core as unknown as { highlighted: { section?: number; abcRange?: Display["abcRange"] } | null };

  fullView.highlightSectionInEditor(50, 51, { source: 50, from: 0, to: 2 });
  assert.equal(state.highlighted?.section, undefined);
  assert.deepEqual(state.highlighted?.abcRange, { source: 50, from: 0, to: 2 });
  fullView.highlightSectionInEditor(50, 51, { source: 50, from: 2, to: 4 });
  assert.deepEqual(state.highlighted?.abcRange, { source: 50, from: 2, to: 4 });
  fullView.highlightSectionInEditor(60, 61);
  assert.equal(state.highlighted?.abcRange, undefined);
  fullView.highlightSectionInEditor(0, 0);
  assert.equal(state.highlighted?.abcRange, undefined);
});
