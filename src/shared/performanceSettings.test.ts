import { test } from "node:test";
import assert from "node:assert/strict";
import {
  capRenderDimensions,
  normalizePerformanceFeatureMode,
  normalizePerformancePreferences,
  resolvePerformanceFeature,
  resolveProjectionRenderDimensions,
} from "./performanceSettings.ts";

test("feature modes override or defer to the automatic decision", () => {
  assert.equal(resolvePerformanceFeature("off", false), false);
  assert.equal(resolvePerformanceFeature("off", true), false);
  assert.equal(resolvePerformanceFeature("on", false), true);
  assert.equal(resolvePerformanceFeature("on", true), true);
  assert.equal(resolvePerformanceFeature("auto", false), true);
  assert.equal(resolvePerformanceFeature("auto", true), false);
});

test("invalid and legacy performance settings normalize safely", () => {
  assert.equal(normalizePerformanceFeatureMode("invalid"), "auto");
  assert.equal(normalizePerformancePreferences({ displayPlaylistUpdateInterval: -1 }).playlistProjectionCheckMode, "off");
  assert.equal(normalizePerformancePreferences({ displayPlaylistUpdateInterval: 100 }).playlistProjectionCheckMode, "auto");
});

test("performance projection mode caps the long edge without changing aspect ratio", () => {
  assert.deepEqual(capRenderDimensions(3840, 2160), { width: 1920, height: 1080 });
  assert.deepEqual(capRenderDimensions(1080, 1920), { width: 1080, height: 1920 });
  assert.deepEqual(resolveProjectionRenderDimensions("quality", true, 3840, 2160), { width: 3840, height: 2160 });
  assert.deepEqual(resolveProjectionRenderDimensions("auto", false, 3840, 2160), { width: 3840, height: 2160 });
  assert.deepEqual(resolveProjectionRenderDimensions("auto", true, 3840, 2160), { width: 1920, height: 1080 });
});
