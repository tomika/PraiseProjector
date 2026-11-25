/** The shared channel through which the tutorial host and the MCP spotlight open detail surfaces. */
import assert from "node:assert/strict";
import { test } from "node:test";
import { openTutorialDetailSurface, registerTutorialDetailSurfaceOpener } from "../tutorialDetailSurfaces";

test("a detail surface opens through the opener of its own view and returns its cleanup", () => {
  const calls: string[] = [];
  const unregisterFull = registerTutorialDetailSurfaceOpener("full", (surface) => {
    calls.push(`full:${surface}`);
    return () => calls.push("full:closed");
  });
  try {
    assert.equal(openTutorialDetailSurface("client", "sessions"), undefined);
    const cleanup = openTutorialDetailSurface("full", "sessions");
    assert.equal(typeof cleanup, "function");
    cleanup?.();
    assert.deepEqual(calls, ["full:sessions", "full:closed"]);
  } finally {
    unregisterFull();
  }
  assert.equal(openTutorialDetailSurface("full", "sessions"), undefined);
});

test("withdrawing a replaced opener keeps the newer registration", () => {
  const unregisterOld = registerTutorialDetailSurfaceOpener("client", () => () => undefined);
  let opened = 0;
  const unregisterNew = registerTutorialDetailSurfaceOpener("client", () => {
    opened += 1;
  });
  try {
    // A view instance mounted later can register before the earlier one's effect cleanup runs.
    unregisterOld();
    openTutorialDetailSurface("client", "sessions");
    assert.equal(opened, 1);
  } finally {
    unregisterNew();
  }
});
