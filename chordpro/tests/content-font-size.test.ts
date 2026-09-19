import assert from "node:assert/strict";
import test from "node:test";
import { ChordProEditor } from "../chordpro_editor";
import { createDefaultChordProStylesSettings, type ChordProDisplayProperties, type ChordProStylesSettings } from "../chordpro_styles";
import { placeChordDiagrams } from "../render/dom-song-renderer";

function fontSizeHarness(styles: ChordProStylesSettings | null = null, dark = false) {
  const editor = Object.create(ChordProEditor.prototype) as ChordProEditor;
  Object.assign(editor, {
    contentFontSizePx: null,
    customStyles: styles,
    stylesBaseRootFontPx: 16,
    isDark: dark,
    styleRevision: 0,
  });
  const state = editor as unknown as { displayProps: ChordProDisplayProperties };
  return { editor, display: () => state.displayProps };
}

test("font-size trials scale both diagrams from the theme and restore their natural sizes", () => {
  const { editor, display } = fontSizeHarness();
  for (const [font, width, height] of [
    [28, 100, 120],
    [42, 150, 180],
    [21, 75, 90],
    [7, 25, 30],
  ] as const) {
    editor.setContentFontSize(font, false);
    assert.equal(editor.getContentFontSize(), font);
    assert.deepEqual(display().guitarChordSize, { width, height });
    assert.deepEqual(display().pianoChordSize, { width: height, height: width * 0.8 });
  }
  editor.setContentFontSize(null, false);
  assert.equal(editor.getContentFontSize(), 14);
  assert.deepEqual(display().guitarChordSize, { width: 50, height: 60 });
  assert.deepEqual(display().pianoChordSize, { width: 60, height: 40 });
});

test("custom diagram sizes scale with their theme font without mutating persisted styles", () => {
  const styles = createDefaultChordProStylesSettings();
  for (const theme of [styles.light, styles.dark]) {
    theme.display.lyricsFont = "20px Arial";
    theme.display.guitarChordSize = { width: 70, height: 84 };
    theme.display.pianoChordSize = { width: 90, height: 60 };
  }
  const original = structuredClone(styles);
  for (const dark of [false, true]) {
    const { editor, display } = fontSizeHarness(styles, dark);
    editor.setContentFontSize(30, false);
    assert.deepEqual(display().guitarChordSize, { width: 105, height: 126 });
    assert.deepEqual(display().pianoChordSize, { width: 135, height: 90 });
    editor.setContentFontSize(null, false);
    assert.deepEqual(display(), original[dark ? "dark" : "light"].display);
  }
  assert.deepEqual(styles, original);
});

test("diagram placement reserves extra rows and height during larger font trials", () => {
  const { editor, display } = fontSizeHarness();
  const layoutAt = (font: number) => {
    editor.setContentFontSize(font, false);
    return placeChordDiagrams(
      ["C", "G", "Am", "F"],
      { width: 220, height: 200 },
      display().guitarChordSize,
      0,
      { horizontalMargin: 5, verticalMargin: 5 },
      () => true
    );
  };
  const natural = layoutAt(14);
  const larger = layoutAt(28);
  assert.equal(new Set(natural.placements.map((entry) => entry.y)).size, 1);
  assert.equal(new Set(larger.placements.map((entry) => entry.y)).size, 2);
  assert.ok(larger.height > natural.height);
});
