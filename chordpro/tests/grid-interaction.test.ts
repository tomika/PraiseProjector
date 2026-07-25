import assert from "node:assert/strict";
import test from "node:test";
import { ChordProDocument, getChordSystem } from "../chordpro_base";
import { defaultDisplayProperties, defaultStyles } from "../chordpro_styles";
import { layoutSong } from "../layout/song-layout";
import { buildDisplayPlan, DisplayIdentityRegistry } from "../render/display-plan";
import { buildGeometryIndex, computeSelectionSpans, hitTestGridChord, resolveCaretGeometry, resolveLineCaretHit } from "../render/dom-interaction";
import type { TextMeasurer } from "../render/text-measurer";

const measurer: TextMeasurer = {
  styleRevision: 0,
  measure: (requests) =>
    requests.map((request) => ({
      id: request.id,
      size: { width: request.text.length * 10, height: 10 },
    })),
};

function gridFixture(text = "D F G Am") {
  const system = getChordSystem("G");
  const document = new ChordProDocument(system, `{start_of_grid: Intro}\n${text}\n{end_of_grid}`);
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
    tagWidths: new Map(plan.occurrences.map((occurrence) => [occurrence.id, 30])),
    overlayRevMoveCost: 1,
    overlayFwdMoveCost: 1,
  });
  return { document, plan, layout, geometry: buildGeometryIndex(plan, layout) };
}

test("grid display runs retain every source space between chords", () => {
  const { plan } = gridFixture();
  const grid = plan.occurrences[0];

  assert.equal(grid.kind, "grid");
  assert.equal(grid.gridRuns.map((run) => run.text).join(""), "D F G Am");
  assert.deepEqual(
    grid.gridRuns.filter((run) => run.kind === "text").map((run) => run.text),
    [" ", " ", " "]
  );
});

test("grid layout exposes chord hit boxes and editable caret stops", () => {
  const { document, geometry, plan } = gridFixture();
  const occurrence = geometry.occurrences[0];
  const row = occurrence.rows?.[0];

  assert.ok(row);
  assert.equal(geometry.gridChords.length, 4);

  const firstChord = geometry.gridChords[0];
  const chordHit = hitTestGridChord(geometry, {
    x: firstChord.left + firstChord.width / 2,
    y: firstChord.top + firstChord.height / 2,
  });
  assert.equal(chordHit?.text, "D");
  assert.equal(chordHit?.line, document.lines[0]);

  const caretHit = resolveLineCaretHit(geometry, {
    x: row.left + row.caretStops[2].pos,
    y: row.lyricsTop + row.lyricsHeight / 2,
  });
  assert.equal(caretHit?.occurrence.occurrence.kind, "grid");
  assert.equal(caretHit?.column, row.caretStops[2].sourceOffset);

  const caret = resolveCaretGeometry(geometry, document.lines[0], 3);
  assert.ok(caret);
  assert.equal(caret.rowId, row.id);

  const selection = computeSelectionSpans(plan.occurrences, {
    startLine: document.lines[0],
    startColumn: 1,
    endLine: document.lines[0],
    endColumn: 4,
  });
  assert.deepEqual(selection.get(plan.occurrences[0].id), { start: 1, end: 4 });
});
