import assert from "node:assert/strict";
import test from "node:test";
import { ChordProDocument, getChordSystem } from "../chordpro_base";
import { Instructions } from "../chordpro_instructions";
import { defaultDisplayProperties, defaultStyles } from "../chordpro_styles";
import { commentChipInset, layoutSong } from "../layout/song-layout";
import {
  buildDisplayPlan,
  DisplayIdentityRegistry,
  projectDisplaySequence,
  type CommentDisplayMode,
  type DisplayInstructionsMode,
} from "../render/display-plan";
import { buildGeometryIndex, hitTestTag, resolveLineCaretHit } from "../render/dom-interaction";
import type { TextMeasurer } from "../render/text-measurer";

const measurer: TextMeasurer = {
  styleRevision: 0,
  measure: (requests) => requests.map((request) => ({ id: request.id, size: { width: request.text.length * 10, height: 10 } })),
};

const SONG = `{title: References}
{start_of_verse: Verse 1}
[C]First line
[G]and more
{end_of_verse}
{start_of_chorus: Chorus}
[F]Refrain [C]here
[G]and again
{end_of_chorus}
{c: Chorus 2x}
{start_of_verse: Verse 2}
{c: Chorus}
[G]Second
{end_of_verse}
{c: Chorus softly}
{c: Chorus +2}
{c: Slowly at the end}`;

type PlanOptions = {
  text?: string;
  readOnly?: boolean;
  comments?: CommentDisplayMode;
  abbreviateTags?: boolean;
  instructionsMode?: DisplayInstructionsMode;
  instructions?: string;
};

function plan(options: PlanOptions = {}) {
  const system = getChordSystem("G");
  const document = new ChordProDocument(system, options.text ?? SONG);
  const display = defaultDisplayProperties();
  let instructions: Instructions | null = null;
  if (options.instructions != null) {
    instructions = new Instructions();
    instructions.parse(options.instructions, document);
  }
  const readOnly = options.readOnly ?? true;
  const instructionsMode = options.instructionsMode ?? "";
  const sequence = projectDisplaySequence({ document, readOnly, instructionsMode, instructions, commentDisplay: options.comments ?? "PREVIEW" });
  return buildDisplayPlan({
    document,
    identities: new DisplayIdentityRegistry(),
    system,
    display,
    directives: defaultStyles(display.lyricsFont),
    chordFormat: 0,
    showTitle: false,
    showMeta: false,
    showTags: true,
    abbreviateTags: options.abbreviateTags ?? false,
    readOnly,
    instructionsMode,
    instructions,
    sequence,
  });
}

/** Every row as "kind[tag]: text"; a reference label is marked with "*". */
function rows(result: ReturnType<typeof plan>) {
  return result.occurrences.map((occurrence) => {
    const tag = occurrence.tag?.visible ? `[${occurrence.tag.text}${occurrence.tag.reference ? "*" : ""}]` : "";
    return `${occurrence.kind}${tag}: ${occurrence.text}`;
  });
}

test("a readonly comment naming a section previews its first line under a reference label", () => {
  assert.deepEqual(rows(plan()), [
    "lyrics[Verse 1]: First line",
    "lyrics: and more",
    "lyrics[Chorus]: Refrain here",
    "lyrics: and again",
    "lyrics[Chorus 2x*]: Refrain here ...",
    // Inside another section a reference is never an instruction.
    "comment[Verse 2]: Chorus",
    "lyrics: Second",
    // Read as the default instructions read it; the label keeps its own words.
    "lyrics[Chorus softly*]: Refrain here ...",
    // The transpose is in the previewed chords, not in the label.
    "lyrics[Chorus*]: Refrain here ...",
    "comment: Slowly at the end",
  ]);
  const chords = plan().occurrences.map((occurrence) => occurrence.chords.map((chord) => chord.source.text).join(" "));
  assert.equal(chords[4], "F C");
  assert.equal(chords[8], "G D");
});

test("the preview selects and highlights as the referenced section's first line", () => {
  const preview = plan().occurrences[4];
  assert.equal(preview.role, "ellipsis");
  assert.equal(preview.source.sourceLineNumber, plan().occurrences[2].source.sourceLineNumber);
});

test("the host decides how comments show without instructions; editing shows them as authored", () => {
  assert.equal(plan({ comments: "SHOW" }).occurrences[4].kind, "comment");
  assert.equal(plan({ readOnly: false }).occurrences[4].kind, "comment");
  assert.deepEqual(rows(plan({ comments: "HIDE" })), [
    "lyrics[Verse 1]: First line",
    "lyrics: and more",
    "lyrics[Chorus]: Refrain here",
    "lyrics: and again",
    "lyrics[Verse 2]: Second",
  ]);
});

test("a reference inside another section is no default instruction, and editing marks it", () => {
  const document = new ChordProDocument(getChordSystem("G"), SONG);
  assert.equal(Instructions.defaultsFor(document), "Verse 1\nChorus\nChorus 2x\nVerse 2\nChorus softly\nChorus +2\nSlowly at the end");
  const marked = (readOnly: boolean) =>
    plan({ readOnly })
      .occurrences.filter((occurrence) => occurrence.misplacedReference)
      .map((occurrence) => `${occurrence.sourceLineIndex}: ${occurrence.text}`);
  assert.deepEqual(marked(false), ["5: Chorus"]);
  assert.deepEqual(marked(true), []);
});

test("inside a section no comment is an instruction; only a plain reference is marked", () => {
  const text = `{start_of_chorus: Chorus}
[F]Refrain
{end_of_chorus}
{start_of_verse: Verse 1}
{c: Chorus softly}
[C]First
{c: Chorus}
{end_of_verse}`;
  assert.equal(Instructions.defaultsFor(new ChordProDocument(getChordSystem("G"), text)), "Chorus\nVerse 1");
  const marked = plan({ text, readOnly: false })
    .occurrences.filter((occurrence) => occurrence.misplacedReference)
    .map((occurrence) => occurrence.text);
  assert.deepEqual(marked, ["Chorus"]);
});

test("a reference to an unlabelled section is labelled with the comment", () => {
  const text = `{c: Chorus}
{start_of_chorus}
[F]Refrain here
{end_of_chorus}`;
  assert.deepEqual(rows(plan({ text })), ["lyrics[Chorus*]: Refrain here ...", "lyrics: Refrain here"]);
});

test("the instructions mode alone decides an instructed display", () => {
  const instructed = plan({ instructionsMode: "FIRST_LINE", instructions: "Verse 1\nChorus\nVerse 2\nChorus\nSlowly at the end" });
  assert.deepEqual(rows(instructed).slice(4), ["lyrics[Verse 2]: Second", "lyrics[Chorus]: Refrain here ...", "comment: Slowly at the end"]);
});

test("a reference label is abbreviated like the section labels", () => {
  assert.equal(plan({ abbreviateTags: true }).occurrences[4].tag?.text, "C 2x");
});

test("section label spacing shifts lyrics and their hit targets only when the tag lane is visible", () => {
  const result = plan();
  const options = {
    tagWidths: new Map(result.occurrences.filter((occurrence) => occurrence.tag?.visible).map((occurrence) => [occurrence.id, 50])),
    overlayRevMoveCost: 1,
    overlayFwdMoveCost: 1,
  };
  const noGap = { ...result, display: { ...result.display, tagLyricsGap: 0 } };
  const withGap = { ...result, display: { ...result.display, tagLyricsGap: 24 } };
  const compact = layoutSong(noGap, measurer, options);
  const spaced = layoutSong(withGap, measurer, options);
  assert.equal(compact.tagGap, 0);
  assert.equal(spaced.tagGap, 24);
  assert.equal(spaced.width - compact.width, 24);

  const geometry = buildGeometryIndex(withGap, spaced);
  const first = geometry.occurrences[0];
  assert.ok(first.tag && first.rows?.length);
  assert.equal(first.rows[0].left - (first.tag.left + first.tag.width), 24);

  for (const tagLyricsGap of [0, 2]) {
    const displayPlan = { ...result, display: { ...result.display, tagLyricsGap } };
    const geometry = buildGeometryIndex(displayPlan, layoutSong(displayPlan, measurer, options));
    const first = geometry.occurrences[0];
    assert.ok(first.tag && first.rows?.length);
    const point = { x: first.rows[0].left, y: first.tag.top + 1 };
    assert.ok(hitTestTag(geometry, { ...point, x: point.x - 0.5 }));
    assert.equal(hitTestTag(geometry, point), null);
    assert.equal(resolveLineCaretHit(geometry, point)?.column, 0);
    assert.equal(geometry.highlightLeft, geometry.tagBoundary);
  }

  assert.equal(layoutSong({ ...withGap, showTags: false }, measurer, options).tagGap, 0);
  assert.equal(layoutSong(plan({ text: "[C]No section label" }), measurer, options).tagGap, 0);
});

test("a reference label's chip counts in the tag lane; a comment chip hugs its text and is centred", () => {
  const result = plan();
  const display = result.display;
  const inset = commentChipInset(display);
  const layout = layoutSong(result, measurer, {
    tagWidths: new Map(result.occurrences.filter((occurrence) => occurrence.tag?.visible).map((occurrence) => [occurrence.id, 50])),
    overlayRevMoveCost: 1,
    overlayFwdMoveCost: 1,
  });
  assert.equal(layout.occurrences[4].tagWidth, 50 + 2 * inset);
  assert.equal(layout.tagLaneWidth, 50 + 2 * inset);
  assert.equal(layout.occurrences[2].tagWidth, 50);

  const comment = layout.occurrences[9];
  assert.equal(comment.blockTextInset, inset);
  assert.equal(comment.blockTextTop, display.chordLineHeight / 4);
  assert.equal(comment.blockWidth, "Slowly at the end".length * 10 + 2 * inset);
  assert.equal(comment.blockCaretStops?.[0].pos, inset);

  const geometry = buildGeometryIndex(result, layout);
  const commentRow = geometry.occurrences[9].rows?.[0];
  assert.ok(commentRow);
  assert.equal(commentRow.lyricsTop - commentRow.top, display.chordLineHeight / 4);
});
