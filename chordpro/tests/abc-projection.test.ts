import assert from "node:assert/strict";
import { before, test } from "node:test";
import { loadAbcjs } from "../abcjs-lazy";
import { Song } from "../../db-common/Song";
import { ChordProAbc, ChordProDocument, ChordProLine, getChordSystem } from "../chordpro_base";
import { SectionGenerator, type DisplaySettings } from "../../src/utils/SectionGenerator";
import { buildSectionRepeatCounts } from "../../src/components/preview/sectionControlCommands";
import { projectDisplaySequence, isHighlightedOccurrence, type DisplayOccurrence } from "../render/display-plan";
import { DomSongRenderer } from "../render/dom-song-renderer";
import type { SongGeometryIndex } from "../render/dom-interaction";
import { ChordProEditor } from "../chordpro_editor";
import { compareDisplays, getEmptyDisplay } from "../../common/pp-utils";
import { displayCodec } from "../../common/pp-codecs";
import { findSectionByLine, getSectionRepeatNonce } from "../../src/components/preview/sectionSelection";

before(async () => {
  await loadAbcjs();
});

const SCORE = `{start_of_abc: Score}
X:1
K:C
P:Verse
"C"CDEF|
w: One two three four
w: Five six seven eight
"G"GABc|
w: Here is our song
w: Sing it again now
{end_of_abc}`;

const SETTINGS: DisplaySettings = {
  fontFamily: "Arial",
  fontSize: 20,
  bold: false,
  italic: false,
  underline: false,
  alignment: "left",
  renderRectWidth: 1000,
  renderRectHeight: 20,
  contentBasedSections: false,
  checkSectionsProjectable: false,
  allowFontSizeReduction: false,
  displayFaultThreshold: 0,
  nonSplittingWords: [],
};

/** Deterministic one-row page, using the production paginator with a font port. */
function generator() {
  return Object.assign(Object.create(SectionGenerator.prototype), {
    measurer: {
      measureText: (text: string) => ({ width: 100, height: text.trim().split(/\r?\n/).length * 20 }),
      measureTextConstrained: (text: string) => ({ width: 100, height: text.trim().split(/\r?\n/).length * 20, linesFilled: 1 }),
    },
    splitter: { modifyString: (text: string) => text },
  }) as SectionGenerator;
}

test("ABC lyric pages keep original source coordinates and distinct canonical row ranges on the wire", () => {
  const song = new Song(`{title:Test}\n${SCORE}\n{sov:Ordinary}\nAfter the score\n{eov}`, "S");
  const original = song.Text;
  const pages = generator().updateSectionList(song, SETTINGS);
  assert.deepEqual(
    pages.map((page) => page.text.trim()),
    ["One two three four", "Here is our song", "Five six seven eight", "Sing it again now", "After the score"]
  );
  const source = original.split("\n").indexOf("{end_of_abc}");
  assert.deepEqual(
    pages.slice(0, 4).map((page) => [page.from, page.to]),
    Array.from({ length: 4 }, () => [source, source + 1])
  );
  assert.deepEqual(
    pages.slice(0, 4).map((page) => page.abcRange),
    Array.from({ length: 4 }, (_, from) => ({ source, from, to: from + 1 }))
  );
  assert.equal(pages[4].abcRange, undefined);
  assert.equal(song.Text, original);
  assert.deepEqual(
    song.Sections.map((s) => s.text.trim()),
    ["After the score"],
    "search/storage lyrics remain authored data"
  );
  const first = { ...getEmptyDisplay(), song: original, from: source, to: source + 1, abcRange: pages[0].abcRange };
  const next = { ...first, abcRange: pages[1].abcRange };
  assert.ok(displayCodec.is(JSON.parse(JSON.stringify(next))));
  assert.equal(compareDisplays(first, next), false, "long-poll observes a page change inside one score");
  assert.equal(compareDisplays(next, { ...next, abcRange: undefined }), false, "leaving the score clears its row range");
});

test("default instruction indices agree in notation and expanded views, including sections after the score", () => {
  const song = new Song(`${SCORE}\n{soc:Chorus}\nNormal chorus\n{eoc}`, "S");
  const doc = new ChordProDocument(getChordSystem("S"), song.Text);
  const pages = generator().updateSectionList(song, SETTINGS, true);
  assert.deepEqual(
    pages.map((page) => page.instructedIndex),
    [0, 0, 0, 0, 1]
  );
  for (const abcMode of ["NOTATION", "CHORDS"] as const) {
    const sequence = projectDisplaySequence({ document: doc, readOnly: true, instructionsMode: "FULL", abcMode });
    assert.equal(sequence.lines.at(-1)?.instructionIndex, 1);
    const highlight = { from: pages[2].from, to: pages[2].to, section: 0, abcRange: pages[2].abcRange };
    const lit = sequence.lines.filter(({ line }) => isHighlightedOccurrence({ source: line } as DisplayOccurrence, highlight, sequence.groups));
    assert.equal(lit.length, 1);
    if (abcMode === "CHORDS") assert.equal(lit[0].line.lyrics, "Five six seven eight");
    else assert.ok(lit[0].line instanceof ChordProAbc);
  }
});

test("split verse repeats retain page order and cannot join pages sharing the same ABC parent", () => {
  const song = new Song(SCORE, "S");
  const pages = generator().updateSectionList(song, SETTINGS, true, "Verse 1 2x");
  assert.deepEqual(
    pages.map((page) => page.abcRange?.from),
    [0, 1, 0, 1]
  );
  assert.equal(buildSectionRepeatCounts(pages), undefined);
  const joined = generator().updateSectionList(song, { ...SETTINGS, renderRectHeight: 1000 }, true, "Verse 1 2x");
  assert.equal(joined.length, 1);
  assert.deepEqual(buildSectionRepeatCounts(joined)?.[0].abcRange, { source: song.Text.split("\n").indexOf("{end_of_abc}"), from: 0, to: 2 });
});

test("whole-score repeats retain verse order instead of multiplying each verse in place", () => {
  const pages = generator().updateSectionList(new Song(SCORE, "S"), SETTINGS, true, "Score 2x");
  assert.deepEqual(
    pages.map((page) => page.abcRange?.from),
    [0, 1, 2, 3, 0, 1, 2, 3]
  );
});

test("ordinary verses keep the same boundaries with or without an ABC block elsewhere in the song", () => {
  const ordinary = `{sov:Ordinary}
First line
{c: Sing softly}

[C]
Second line
{eov}
{sov:Ordinary}
Another occurrence
{eov}`;
  for (const instructions of [undefined, "", "Ordinary"]) {
    const plain = new Song(ordinary, "S");
    const mixed = new Song(`${ordinary}\n${SCORE}`, "S");
    const expected = plain.ProjectionSections(instructions);
    const actual = mixed.ProjectionSections(instructions).filter((section) => !section.abcRange);
    assert.deepEqual(
      actual.map(({ text, from, to, type, tag }) => ({ text, from, to, type, tag })),
      expected.map(({ text, from, to, type, tag }) => ({ text, from, to, type, tag })),
      `comments, blank and chord-only rows do not split a verse (${String(instructions)})`
    );
  }
});

test("expanded score repeats retain their occurrence identity through pagination", () => {
  for (const renderRectHeight of [20, 1000]) {
    const pages = generator().updateSectionList(new Song(SCORE, "S"), { ...SETTINGS, renderRectHeight }, true, "Score 3x");
    const perRepeat = pages.length / 3;
    assert.equal(Number.isInteger(perRepeat), true);
    for (let repeat = 0; repeat < 3; ++repeat) {
      for (const page of pages.slice(repeat * perRepeat, (repeat + 1) * perRepeat)) {
        assert.deepEqual(page.projectionRepeat, { index: repeat, total: 3 });
        assert.equal(page.instructedMultiplier, 1, "expanded repeats must not be repeated again by the controls");
      }
    }
  }
});

test("expanded repeat selections publish distinct displays and remote hits stay in the current pass", () => {
  const pages = generator().updateSectionList(new Song(SCORE, "S"), SETTINGS, true, "Score 3x");
  const displays = [0, 4, 8].map((index) => {
    const page = pages[index];
    return {
      ...getEmptyDisplay(),
      from: page.from,
      to: page.to,
      section: page.instructedIndex,
      abcRange: page.abcRange,
      sectionRepeatNonce: getSectionRepeatNonce(page, 99),
    };
  });
  assert.deepEqual(
    displays.map((display) => display.sectionRepeatNonce),
    [0, 1, 2]
  );
  assert.equal(compareDisplays(displays[0], displays[1]), false);
  assert.equal(compareDisplays(displays[1], displays[2]), false);
  assert.equal(buildSectionRepeatCounts(pages), undefined, "the explicit page sequence must not gain another repeat loop");
  for (const selected of [5, 9]) {
    const passStart = selected - 1;
    for (let offset = 0; offset < 4; ++offset) {
      const hit = pages[offset];
      assert.equal(findSectionByLine(pages, selected, hit.from, hit.instructedIndex, hit.abcRange), passStart + offset);
    }
  }
  assert.equal(findSectionByLine(pages, -1, pages[0].from, 0, pages[0].abcRange), 0, "no prior selection starts at the first pass");
  assert.equal(getSectionRepeatNonce(pages[4], 99, { bumpRepeatNonce: true }), 1, "a pass identity survives incidental repaints");
  assert.equal(getSectionRepeatNonce({}, 2, { bumpRepeatNonce: true }), 3, "joined-repeat behavior stays intact");
  assert.equal(getSectionRepeatNonce({}, 2, { preserveRepeatNonce: true }), 2);
});

test("a paginated inner ABC verse carries its own repeat pass, independently of a whole-score repeat", () => {
  const pages = generator().updateSectionList(new Song(SCORE, "S"), SETTINGS, true, "Verse 1 3x");
  assert.deepEqual(
    pages.map((page) => getSectionRepeatNonce(page, 0)),
    [0, 0, 1, 1, 2, 2]
  );
  assert.equal(findSectionByLine(pages, 3, pages[0].from, 0, pages[0].abcRange), 2);
  const ordinary = generator().updateSectionList(new Song("{sov:Verse}\nFirst line\nSecond line\n{eov}", "S"), SETTINGS, true, "Verse 3x");
  assert.deepEqual(
    ordinary.map((page) => getSectionRepeatNonce(page, 0)),
    [0, 0, 1, 1, 2, 2],
    "ordinary paginated repeats use the same identities"
  );
});

test("a tag hit cannot mix ABC blocks, ordinary lyrics or different instruction occurrences", () => {
  const doc = new ChordProDocument(getChordSystem("S"), `${SCORE}\n${SCORE}`);
  const [firstAbc, secondAbc] = doc.lines as ChordProAbc[];
  const row = (source?: ChordProAbc, abcRow?: number, section?: number) => {
    const line = new ChordProLine(doc);
    line.styles.set("start_of_verse", "Same displayed tag");
    line.abcSource = source;
    line.abcRow = abcRow;
    line.instructedSectionIndex = section;
    line.sourceLineNumber = source?.sourceLineNumber ?? 99;
    line.setLyrics(`Row ${abcRow ?? "ordinary"}`);
    return line;
  };
  const lines = [row(firstAbc, 0, 0), row(firstAbc, 1, 0), row(secondAbc, 0, 0), row(secondAbc, 1, 0), row(), row(firstAbc, 0, 1)];
  for (const [clicked, expectedFrom, expectedTo] of [
    [0, 0, 2],
    [2, 0, 2],
    [5, 0, 1],
  ]) {
    const hits: Parameters<NonNullable<ChordProEditor["onLyricsHit"]>>[0][] = [];
    const selected = lines[clicked];
    const editor = Object.assign(Object.create(ChordProEditor.prototype, { displayedLines: { value: lines } }), {
      readOnly: true,
      lastMouseDown: { x: 0, y: 0 },
      normalizeMousePos: () => ({ x: 0, y: 0 }),
      checkChordBoxTouch: () => false,
      HitTestLine: () => selected,
      isTagColumnHit: () => true,
      onLyricsHit: (hit: (typeof hits)[number]) => hits.push(hit),
    }) as ChordProEditor;
    editor.onMouseUp({ preventDefault: () => undefined } as MouseEvent);
    assert.deepEqual(hits[0].abcRange, { source: selected.abcSource!.sourceLineNumber, from: expectedFrom, to: expectedTo });
    assert.equal(hits[0].from, selected.abcSource!.sourceLineNumber);
    assert.equal(hits[0].to, selected.abcSource!.sourceLineNumber + 1);
  }
});

test("instrumental and unsupported scores do not leak ABC source text into the lyric projector", () => {
  const instrumental = SCORE.replace(/^w:.*\n/gm, "");
  assert.deepEqual(generator().updateSectionList(new Song(instrumental, "S"), SETTINGS), []);
  const unsupported = SCORE.replace('"C"CDEF|', '"C"CDEF| ???');
  assert.deepEqual(generator().updateSectionList(new Song(unsupported, "S"), SETTINGS), []);
});

test("notation follow resolves the selected verse's music spans to the visible staff, independently of host scale", () => {
  const doc = new ChordProDocument(getChordSystem("S"), SCORE);
  const abc = doc.lines[0] as ChordProAbc;
  const source = abc.sourceLineNumber;
  const rows = abc.toChordPro();
  const selectables = rows.slice(0, 2).flatMap((row, index) =>
    (row.abcMusicRanges ?? []).map((span) => ({
      absEl: { abcelem: { el_type: "note", startChar: span.start, endChar: span.end } },
      staffPos: { top: index * 300 + 30, height: 90 },
    }))
  );
  const geometry = { occurrences: [{ occurrence: { source: abc }, top: 100, bottom: 1000 }] } as unknown as SongGeometryIndex;
  const renderer = Object.assign(Object.create(DomSongRenderer.prototype), {
    abcNodes: new Map([["score", { source: abc, visual: { getSelectableArray: () => selectables } }]]),
    geometry,
  }) as DomSongRenderer;
  assert.deepEqual(renderer.getAbcHighlightRange(abc, { source, from: 1, to: 2 }), { top: 320, bottom: 380 });
  assert.deepEqual(renderer.getAbcHighlightRange(abc, { source, from: 3, to: 4 }), { top: 320, bottom: 380 }, "verse two follows the shared melody");
  assert.equal(renderer.getAbcHighlightRange(abc, { source: 99, from: 1, to: 2 }), null);

  const scrollTarget = { scrollTop: 0, clientHeight: 200, scrollHeight: 2000, getBoundingClientRect: () => ({ top: 10 }) };
  let targetTop = -1;
  const editor = Object.assign(Object.create(ChordProEditor.prototype, { displayedLines: { value: [abc] } }), {
    highlighted: { from: source, to: source + 1, abcRange: { source, from: 1, to: 2 } },
    lastHighlightScrollSectionToken: "section:score",
    parent_div: {},
    domRenderer: renderer,
    highlightScrollSurface: () => ({ rect: { top: 10 }, logicalToDisplay: 2 }),
    findScrollableAncestor: () => scrollTarget,
    animateScrollTo: (_target: unknown, top: number) => {
      targetTop = top;
    },
  }) as unknown as { scrollHighlightedIntoView(): void };
  editor.scrollHighlightedIntoView();
  assert.equal(targetTop, 560, "the same-score safety follow uses the selected staff, scaled into viewport pixels");
});
