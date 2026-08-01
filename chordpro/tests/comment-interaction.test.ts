import assert from "node:assert/strict";
import test from "node:test";
import { ChordProDocument, getChordSystem } from "../chordpro_base";
import { defaultDisplayProperties, defaultStyles } from "../chordpro_styles";
import { layoutSong } from "../layout/song-layout";
import { buildDisplayPlan, DisplayIdentityRegistry } from "../render/display-plan";
import { buildGeometryIndex, computeSelectionSpans, resolveCaretGeometry, resolveLineCaretHit } from "../render/dom-interaction";
import type { TextMeasurer } from "../render/text-measurer";

const measurer: TextMeasurer = {
  styleRevision: 0,
  measure: (requests) =>
    requests.map((request) => ({
      id: request.id,
      size: { width: request.text.length * 10, height: 10 },
    })),
};

function commentFixture(text = "Editable comment") {
  const system = getChordSystem("G");
  const document = new ChordProDocument(system, `{comment_italic:${text}}`);
  const display = defaultDisplayProperties();
  const plan = buildDisplayPlan({
    document,
    identities: new DisplayIdentityRegistry(),
    system,
    display,
    directives: defaultStyles(display.lyricsFont),
    chordFormat: 0,
    showTitle: false,
    showMeta: false,
    showTags: true,
    abbreviateTags: false,
    readOnly: false,
  });
  const layout = layoutSong(plan, measurer, {
    tagWidths: new Map(),
    overlayRevMoveCost: 1,
    overlayFwdMoveCost: 1,
  });
  return { document, plan, layout, geometry: buildGeometryIndex(plan, layout) };
}

test("comment layout exposes editable caret stops and selection spans", () => {
  const { document, plan, geometry } = commentFixture();
  const occurrence = geometry.occurrences[0];
  const row = occurrence.rows?.[0];

  assert.ok(row);
  assert.equal(occurrence.occurrence.kind, "comment");
  assert.equal(row.caretStops.length, "Editable comment".length + 1);

  const caretHit = resolveLineCaretHit(geometry, {
    x: row.left + row.caretStops[5].pos,
    y: row.lyricsTop + row.lyricsHeight / 2,
  });
  assert.equal(caretHit?.column, 5);

  const caret = resolveCaretGeometry(geometry, document.lines[0], 5);
  assert.equal(caret?.rowId, row.id);

  const selection = computeSelectionSpans(plan.occurrences, {
    startLine: document.lines[0],
    startColumn: 2,
    endLine: document.lines[0],
    endColumn: 7,
  });
  assert.deepEqual(selection.get(plan.occurrences[0].id), { start: 2, end: 7 });
});

test("splitting an editable comment keeps both halves as comments", () => {
  const { document } = commentFixture("Split me");
  const suffix = document.lines[0].splitAt(5);

  assert.ok(suffix);
  assert.equal(document.lines[0].lyrics, "Split");
  assert.equal(suffix.lyrics, " me");
  assert.equal(document.lines[0].getCommentType(), "italic");
  assert.equal(suffix.getCommentType(), "italic");
});
