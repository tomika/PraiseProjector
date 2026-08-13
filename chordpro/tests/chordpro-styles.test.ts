import assert from "node:assert/strict";
import test from "node:test";
import { createDefaultChordProStylesSettings, normalizeChordProStyles } from "../chordpro_styles";

test("normalizeChordProStyles fills missing nested values without changing valid legacy values", () => {
  const normalized = normalizeChordProStyles({
    light: {
      display: { lyricsFont: "18px Arial", lyricsLineHeight: 27 },
      directives: { title: { font: "bold 40px Arial" } },
    },
  });

  assert.equal(normalized.light.display.lyricsFont, "18px Arial");
  assert.equal(normalized.light.display.lyricsLineHeight, 27);
  assert.equal(normalized.light.display.chordLineHeight, 16);
  assert.equal(normalized.light.directives.title.font, "bold 40px Arial");
  assert.equal(normalized.light.directives.title.align, "center");
  assert.equal(normalized.dark.display.backgroundColor, "black");
});

test("normalizeChordProStyles repairs invalid known values and preserves unknown extensions", () => {
  const normalized = normalizeChordProStyles({
    futureRoot: "kept",
    light: {
      futureTheme: true,
      display: {
        lyricsLineHeight: "invalid",
        futureDisplay: 42,
        guitarChordSize: { width: 77, height: null, futureSize: "kept" },
      },
      directives: {
        title: { height: Number.NaN, futureDirective: "kept" },
        custom_directive: { font: "13px Arial", custom: true },
      },
    },
  }) as unknown as Record<string, unknown>;

  assert.equal(normalized.futureRoot, "kept");
  const light = normalized.light as Record<string, unknown>;
  assert.equal(light.futureTheme, true);
  const display = light.display as Record<string, unknown>;
  assert.equal(display.lyricsLineHeight, 16);
  assert.equal(display.futureDisplay, 42);
  assert.deepEqual(display.guitarChordSize, { width: 77, height: 60, futureSize: "kept" });
  const directives = light.directives as Record<string, Record<string, unknown>>;
  assert.equal(directives.title.height, 38);
  assert.equal(directives.title.futureDirective, "kept");
  assert.deepEqual(directives.custom_directive, { font: "13px Arial", custom: true });
});

test("normalizeChordProStyles is idempotent", () => {
  const partial = { light: { display: { lyricsFont: "19px Georgia" } } };
  const once = normalizeChordProStyles(partial);
  const twice = normalizeChordProStyles(once);
  assert.deepEqual(twice, once);
});

test("normalization keeps the established persisted shape", () => {
  const defaults = createDefaultChordProStylesSettings();
  const normalized = normalizeChordProStyles(defaults);
  assert.deepEqual(Object.keys(normalized).sort(), ["dark", "light"]);
  assert.deepEqual(normalized, defaults);
});
