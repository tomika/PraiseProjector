import assert from "node:assert/strict";
import { test } from "node:test";
import { createOrientationResizeTracker, nextOrientation, shouldUsePagingLayoutForOrientation } from "../viewLayout";

test("soft keyboard shrinking a portrait tablet keeps the paging layout", () => {
  const orientation = nextOrientation("portrait", 800, 800, 650, true);
  assert.equal(orientation, "portrait");
  assert.equal(shouldUsePagingLayoutForOrientation(800, orientation), true);
});

test("closing the soft keyboard keeps the orientation", () => {
  assert.equal(nextOrientation("portrait", 800, 800, 1100, true), "portrait");
});

test("a rotation while editing still switches orientation", () => {
  assert.equal(nextOrientation("portrait", 800, 1100, 450, true), "landscape");
});

test("a height-only resize without text entry focus re-evaluates orientation", () => {
  assert.equal(nextOrientation("portrait", 800, 800, 650, false), "landscape");
});

test("deferred updaters still see the width before their own resize", () => {
  const track = createOrientationResizeTracker(800);
  // A rotation followed by a second resize before React runs either updater.
  const rotate = track(1100, 450, true);
  const settle = track(1100, 800, true);
  assert.equal(settle(rotate("portrait")), "landscape");
});
