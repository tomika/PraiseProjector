import assert from "node:assert/strict";
import test from "node:test";
import { shouldSuppressTouchContextMenu } from "../chordpro_editor";

test("native contextmenu is suppressed before the touch long-press threshold", () => {
  assert.equal(shouldSuppressTouchContextMenu(1_649, 1_000, 0), true);
  assert.equal(shouldSuppressTouchContextMenu(1_650, 1_000, 0), false);
});

test("native contextmenu trailing a completed short tap is suppressed", () => {
  assert.equal(shouldSuppressTouchContextMenu(2_200, 0, 2_700), true);
  assert.equal(shouldSuppressTouchContextMenu(2_700, 0, 2_700), false);
});

test("desktop contextmenu is not suppressed without touch state", () => {
  assert.equal(shouldSuppressTouchContextMenu(5_000, 0, 0), false);
});
