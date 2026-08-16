import assert from "node:assert/strict";
import test from "node:test";
import type { SongLayoutResult } from "../layout/song-layout";
import { buildGeometryIndex } from "../render/dom-interaction";
import type { DisplayPlan } from "../render/display-plan";

function geometryWithTagLayout(tagLaneWidth: number, tagGap: number) {
  const source = {
    tag: null,
    style: { align: "left", indent: 0 },
    chords: [],
  };
  const plan = {
    showTags: true,
    display: {
      horizontalMargin: 10,
      verticalMargin: 0,
      lyricsLineHeight: 20,
      chordLineHeight: 20,
      chordBorder: 0,
    },
  } as unknown as DisplayPlan;
  const layout = {
    width: 200,
    height: 20,
    bodyWidth: 100,
    tagLaneWidth,
    tagGap,
    meta: [],
    occurrences: [
      {
        id: "line-1",
        source,
        height: 20,
        contentWidth: 100,
        tagWidth: 0,
        tagSeparation: 0,
        rows: [],
      },
    ],
  } as unknown as SongLayoutResult;
  return buildGeometryIndex(plan, layout);
}

test("highlight starts with lyrics when tag display is enabled but the song has no visible tags", () => {
  const geometry = geometryWithTagLayout(0, 0);

  // horizontal margin (10) minus highlight padding (4)
  assert.equal(geometry.highlightLeft, 6);
});

test("highlight retains the real tag lane and gap when visible tags reserve them", () => {
  const geometry = geometryWithTagLayout(15, 40);

  // horizontal margin (10) + tag lane (15) + tag gap (40) - padding (4)
  assert.equal(geometry.highlightLeft, 61);
});
