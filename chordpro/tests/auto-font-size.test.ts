import assert from "node:assert/strict";
import test from "node:test";
import { findLargestFittingFontSize, findLargestLargerFittingFontSize, scaleFitWidthMetric } from "../layout/auto-font-size";

test("scaleFitWidthMetric returns the visual FIT_WIDTH value", () => {
  assert.equal(scaleFitWidthMetric(20, 1000, 500), 40);
  assert.equal(scaleFitWidthMetric(300, 1000, 500), 600);
});

test("findLargestFittingFontSize returns the largest fitting integer", async () => {
  const visited: number[] = [];
  const result = await findLargestFittingFontSize({
    min: 10,
    max: 64,
    fits: async (size) => {
      visited.push(size);
      return size <= 37;
    },
  });

  assert.equal(result, 37);
  assert.ok(visited.length <= 6);
});

test("findLargestFittingFontSize returns the minimum when every size overflows", async () => {
  const result = await findLargestFittingFontSize({ min: 12, max: 24, fits: async () => false });
  assert.equal(result, 12);
});

test("findLargestFittingFontSize stops a stale search", async () => {
  let cancelled = false;
  const result = await findLargestFittingFontSize({
    min: 10,
    max: 20,
    fits: async () => {
      cancelled = true;
      return true;
    },
    isCancelled: () => cancelled,
  });
  assert.equal(result, null);
});

test("findLargestLargerFittingFontSize never shrinks when the next size overflows", async () => {
  const visited: number[] = [];
  const result = await findLargestLargerFittingFontSize({
    base: 20,
    max: 64,
    fits: async (size) => {
      visited.push(size);
      return false;
    },
  });

  assert.equal(result, null);
  assert.deepEqual(visited, [21]);
});

test("findLargestLargerFittingFontSize returns the largest fitting size above the base", async () => {
  const result = await findLargestLargerFittingFontSize({
    base: 20,
    max: 64,
    fits: async (size) => size <= 37,
  });

  assert.equal(result, 37);
});
