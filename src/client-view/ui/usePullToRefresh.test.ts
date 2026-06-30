/**
 * Unit tests for the pure pull-to-refresh helpers ({@link pullOffset},
 * {@link pullProgress}, {@link levelForHoldTime}). No test framework is
 * configured, so these run on Node's built-in runner with native TypeScript
 * type-stripping (zero new deps):
 *
 *   cd public
 *   node --experimental-strip-types --test src/client-view/ui/usePullToRefresh.test.ts
 *
 * The file is also type-checked + linted by the normal gate (it lives under
 * src/client-view, which tsc and eslint already cover).
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { levelForHoldTime, pullOffset, pullProgress, LEVEL_HOLD_MS as H } from "./usePullToRefresh.ts";

test("levelForHoldTime: not armed (heldMs < 0) is level 0", () => {
  assert.equal(levelForHoldTime(-1, 3), 0);
  assert.equal(levelForHoldTime(-1000, 3), 0);
});

test("levelForHoldTime: escalates by time held, one level per hold window", () => {
  assert.equal(levelForHoldTime(0, 3), 1, "armed → level 1 immediately");
  assert.equal(levelForHoldTime(H - 1, 3), 1);
  assert.equal(levelForHoldTime(H, 3), 2);
  assert.equal(levelForHoldTime(2 * H, 3), 3);
  assert.equal(levelForHoldTime(10 * H, 3), 3, "saturates at the top level");
});

test("levelForHoldTime: caps at maxLevel (Rest reload-only allows level 1 at most)", () => {
  assert.equal(levelForHoldTime(0, 1), 1);
  assert.equal(levelForHoldTime(5 * H, 1), 1, "holding longer still only reaches level 1");
});

test("levelForHoldTime: maxLevel 0 disables the gesture", () => {
  assert.equal(levelForHoldTime(0, 0), 0);
  assert.equal(levelForHoldTime(10 * H, 0), 0);
});

test("pullOffset: 1:1 up to the arm distance, then hard-clamps (no rubber-band)", () => {
  assert.equal(pullOffset(-10, 100), 0, "never negative");
  assert.equal(pullOffset(0, 100), 0);
  assert.equal(pullOffset(50, 100), 50, "tracks the finger 1:1");
  assert.equal(pullOffset(100, 100), 100);
  assert.equal(pullOffset(200, 100), 100, "clamped at the arm distance, no overshoot");
});

test("pullProgress: arc fills 0..1 across the arm distance, then saturates", () => {
  assert.equal(pullProgress(-10, 100), 0, "never negative");
  assert.equal(pullProgress(0, 100), 0);
  assert.equal(pullProgress(50, 100), 0.5);
  assert.equal(pullProgress(100, 100), 1);
  assert.equal(pullProgress(200, 100), 1, "saturates past the arm distance");
});
