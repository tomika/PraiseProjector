import assert from "node:assert/strict";
import test from "node:test";
import { placeChordDiagrams } from "../render/dom-song-renderer";

const chords = ["A", "D", "F#m", "E", "C#m", "Hm"];
const guitar = { width: 64, height: 76 };
const margins = { horizontalMargin: 5, verticalMargin: 5 };
const canRender = () => true;
const fitScale = (size: { width: number; height: number }, pane: { width: number; height: number }) =>
  Math.min(pane.width / size.width, pane.height / size.height);

test("portrait page widens the diagram strip to avoid an unnecessary second row", () => {
  const song = { width: 340.9, height: 445 };
  const pane = { width: 432, height: 613 };
  const layout = placeChordDiagrams(chords, song, guitar, pane.width / pane.height, margins, canRender);
  const wrapped = placeChordDiagrams(chords, song, guitar, 0, margins, canRender);

  assert.equal(new Set(layout.placements.map(({ y }) => y)).size, 1);
  assert.ok(layout.placements.every(({ y }) => y >= song.height));
  assert.ok(layout.width > song.width);
  assert.equal(new Set(wrapped.placements.map(({ y }) => y)).size, 2);
  assert.ok(fitScale(layout, pane) > fitScale(wrapped, pane));
});

test("a pane wider than the lyrics can still fit a bottom strip better than a side column", () => {
  const song = { width: 340, height: 490 };
  const ratio = 432 / 613;
  assert.ok(ratio > song.width / song.height);
  const layout = placeChordDiagrams(chords, song, guitar, ratio, margins, canRender);

  assert.ok(layout.placements.every(({ y }) => y >= song.height));
  assert.equal(new Set(layout.placements.map(({ y }) => y)).size, 1);
});

test("landscape page uses the free space beside a tall song", () => {
  const song = { width: 340, height: 445 };
  const layout = placeChordDiagrams(chords, song, guitar, 16 / 9, margins, canRender);

  assert.ok(layout.placements.every(({ x }) => x >= song.width + margins.horizontalMargin));
  assert.equal(layout.height, song.height);
  assert.deepEqual(
    layout.placements.map(({ chord }) => chord),
    chords
  );
});

test("width-fit keeps exact-fitting diagrams on one row and wraps the next", () => {
  const song = { width: 200, height: 445 }; // Three 64px diagrams plus two 4px gaps.
  for (const ratio of [0, -1]) {
    const layout = placeChordDiagrams(chords, song, guitar, ratio, margins, canRender);
    assert.equal(layout.width, song.width);
    assert.equal(layout.placements[0].x, 0);
    assert.equal(layout.placements[2].y, layout.placements[0].y);
    assert.equal(layout.placements[3].x, 0);
    assert.ok(layout.placements[3].y > layout.placements[2].y);
  }
});

test("unrenderable and duplicate labels reserve no space", () => {
  const song = { width: 340, height: 445 };
  const expected = placeChordDiagrams(chords, song, guitar, 0.7, margins, canRender);
  const actual = placeChordDiagrams(["unknown", ...chords, "A", "Hm"], song, guitar, 0.7, margins, (chord) => chord !== "unknown");
  assert.deepEqual(actual, expected);
  for (const ratio of [0, 0.7, 2]) {
    assert.deepEqual(
      placeChordDiagrams(chords, song, guitar, ratio, margins, () => false),
      { ...song, placements: [] }
    );
    assert.deepEqual(placeChordDiagrams([], song, guitar, ratio, margins, canRender), { ...song, placements: [] });
  }
});

test("every diagram stays inside the reported bounds without overlapping the song or other diagrams", () => {
  for (const song of [
    { width: 20, height: 10 },
    { width: 340.9, height: 445 },
    { width: 900, height: 180 },
  ]) {
    for (const size of [guitar, { width: 150, height: 50 }]) {
      for (const ratio of [0, 0.4, 0.7, 1, 16 / 9, 3]) {
        for (const count of [1, 6, 17]) {
          const labels = Array.from({ length: count }, (_, index) => `chord-${index}`);
          const layout = placeChordDiagrams(labels, song, size, ratio, margins, canRender);
          assert.deepEqual(
            layout.placements.map(({ chord }) => chord),
            labels
          );
          for (const [index, entry] of layout.placements.entries()) {
            assert.ok(entry.x >= 0 && entry.y >= 0);
            assert.ok(entry.x + size.width <= layout.width + 1e-9);
            assert.ok(entry.y + size.height <= layout.height + 1e-9);
            assert.ok(entry.x >= song.width || entry.y >= song.height);
            for (const other of layout.placements.slice(index + 1)) {
              assert.ok(
                entry.x + size.width <= other.x ||
                  other.x + size.width <= entry.x ||
                  entry.y + size.height <= other.y ||
                  other.y + size.height <= entry.y
              );
            }
          }
          if (ratio > 0) {
            const wrapped = placeChordDiagrams(labels, song, size, 0, margins, canRender);
            const pane = { width: ratio, height: 1 };
            assert.ok(fitScale(layout, pane) >= fitScale(wrapped, pane));
          }
        }
      }
    }
  }
});
