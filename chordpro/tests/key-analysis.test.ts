import assert from "node:assert/strict";
import test from "node:test";
import { ChordProDocument, getChordSystem } from "../chordpro_base";
import { ChordProEditor } from "../chordpro_editor";
import { Instructions } from "../chordpro_instructions";
import { defaultDisplayProperties, defaultStyles } from "../chordpro_styles";
import { analyzeDocumentKeys } from "../key-analysis";
import { CHORDFORMAT_INKEY, CHORDFORMAT_ROMAN, CHORDFORMAT_ROMAN_MAJOR, type ChordVisualModel } from "../render/chord-visual";
import { buildDisplayPlan, DisplayIdentityRegistry } from "../render/display-plan";

const system = getChordSystem("S");
const verse = (label: string, chords: string) =>
  `{sov:${label}}\n${chords
    .split(" ")
    .map((c) => "[" + c + "]x")
    .join(" ")}\n{eov}`;

test("adjacent reprises retain distinct written keys and explicit playback shifts across a save", () => {
  const opening = verse("V", "C F G7 C");
  const doc = new ChordProDocument(system, [opening, verse("V", "D G A7 D"), verse("V -1", "E A B7 E"), opening].join("\n"));
  for (const song of [doc, new ChordProDocument(system, doc.generateDocument())]) {
    const result = analyzeDocumentKeys(song);
    assert.equal(result.key, "C");
    assert.deepEqual(
      result.sections.map((s) => [s.writtenKey, s.soundingKey, s.writtenRepeatShift]),
      [
        ["C", "C", undefined],
        ["D", "D", 2],
        ["E", "Eb", 4],
        ["C", "C", 0],
      ]
    );
    assert.equal(song.key, "");
  }
});

test("borrowed dominants, unlabelled chords, grids, author overrides and empty songs", () => {
  const infer = (text: string) => analyzeDocumentKeys(new ChordProDocument(system, text));
  assert.equal(infer("[C]a [D7]b [G7]c [C]d\n{soc}\nwords\n{eoc}").key, "C");
  assert.equal(infer("{start_of_grid}\n| Am Dm | E7 Am |\n{end_of_grid}").key, "Am");
  assert.equal(infer("words").key, null);
  assert.equal(infer("{key:F}\nwords").key, "F");
  assert.equal(infer("{key:C Major}\n[D]x [G]x [A7]x [D]x").key, "C");
  assert.equal(infer("{start_of_abc}\nX:1\nK:G\n[CEG]4|\n{end_of_abc}").key, null);
  const declared = infer("{key:Am}\n" + verse("V", "C F G C") + "\n" + verse("V", "D G A D"));
  assert.deepEqual(
    declared.sections.map((s) => s.writtenKey),
    ["Am", "Bm"]
  );
});

test("a leading comment stays inside its reprise after saving", () => {
  const text = verse("V", "C F G C") + "\n{sov:V}\n{c:Repeat softly}\n[D]x [G]x [A]x [D]x\n{eov}";
  const saved = new ChordProDocument(system, text).generateDocument();
  assert.match(saved, /\{end_of_verse\}\n\{start_of_verse:V\}\n\{comment:Repeat softly\}/);
  const reloaded = new ChordProDocument(system, saved);
  assert.equal(analyzeDocumentKeys(reloaded).writtenKeyByLine.get(reloaded.lines[1]), "D");
});

test("pitch parsing, key inference and transposition agree on Unicode accidentals and enharmonic notes", () => {
  for (const code of ["G", "S"] as const) {
    const alphabet = getChordSystem(code);
    const doc = new ChordProDocument(alphabet, verse("V", "G♭ C♭ D♭7 G♭"));
    assert.equal(analyzeDocumentKeys(doc).key, "Gb");
    const shifted = new ChordProDocument(alphabet, "[F♯/C♯]x");
    shifted.transpose(2);
    assert.equal(shifted.lines[0].chords[0].text, "G#/D#");
    assert.equal(alphabet.getKey("G♭ Major")?.name, "Gb");
    assert.equal(alphabet.getKey("F♯ minor")?.name, "F#m");
    assert.equal(alphabet.getKey("C XI"), undefined);
    assert.equal(alphabet.stringToNote("E#"), alphabet.stringToNote("F"));
  }
  const german = getChordSystem("G");
  assert.equal(german.stringToNote("A#"), german.stringToNote("B"));
  assert.equal(german.stringToNote("H"), system.stringToNote("B"));
});

function display(doc: ChordProDocument, instructionsText?: string, chordFormat = CHORDFORMAT_INKEY) {
  const style = defaultDisplayProperties();
  const instructions = new Instructions();
  if (instructionsText) instructions.parse(instructionsText, doc);
  return buildDisplayPlan({
    document: doc,
    identities: new DisplayIdentityRegistry(),
    system: doc.system,
    display: style,
    directives: defaultStyles(style.lyricsFont),
    chordFormat,
    showTitle: false,
    showMeta: true,
    showTags: true,
    abbreviateTags: false,
    readOnly: true,
    instructionsMode: instructionsText ? "FULL" : "",
    instructions,
    keyAnalysis: analyzeDocumentKeys(doc),
  });
}
const visualText = (visual: ChordVisualModel) => visual.tokens.map((t) => t.text).join("");

test("raw lyrics, grids and instructed projections spell in their local key, applying the playback shift once", () => {
  const doc = new ChordProDocument(
    system,
    [verse("V", "C F G7 C"), verse("R", "C#/G# F# G#7 C#"), "{start_of_grid:Grid +1}\nC F G7 C\n{end_of_grid}"].join("\n")
  );
  const raw = display(doc);
  assert.match(raw.meta.find((m) => m.name === "key")!.text, /C/);
  assert.equal(raw.key, "C");
  assert.equal(visualText(raw.occurrences[1].chords[0].visual), "D♭/A♭");
  const grid = raw.occurrences[2].gridRuns.find((r) => r.kind === "chord");
  assert.ok(grid?.kind === "chord");
  assert.equal(visualText(grid.visual), "D♭");
  const instructed = display(doc, "V +1");
  assert.equal(visualText(instructed.occurrences[0].chords[0].visual), "D♭");
  assert.equal(doc.key, "");
});

test("Roman notation distinguishes the song scale from parallel major, preserving chord quality and slash bass", () => {
  const doc = new ChordProDocument(system, "{key:Am}\n" + verse("V", "Am C F G G#dim7/B Bm7b5 E7#9 Dmin7/F xyz"));
  const chords = (format: number) => display(doc, undefined, format).occurrences[0].chords.map(({ visual }) => visualText(visual));
  assert.deepEqual(chords(CHORDFORMAT_ROMAN), ["i", "III", "VI", "VII", "♯vii°7/II", "iiø7", "V7♯9", "iv7/VI", "xyz"]);
  assert.deepEqual(chords(CHORDFORMAT_ROMAN_MAJOR), ["i", "♭III", "♭VI", "♭VII", "vii°7/II", "iiø7", "V7♯9", "iv7/♭VI", "xyz"]);
  doc.transpose(5);
  assert.deepEqual(chords(CHORDFORMAT_ROMAN_MAJOR), ["i", "♭III", "♭VI", "♭VII", "vii°7/II", "iiø7", "V7♯9", "iv7/♭VI", "xyz"]);
});

test("Roman notation numbers bracketed chords but keeps a chord label written as a word", () => {
  const doc = new ChordProDocument(system, "{key:Am}\n" + verse("V", "(Am) (E7) N.C. Coda Am(add9)"));
  const chords = display(doc, undefined, CHORDFORMAT_ROMAN).occurrences[0].chords.map(({ visual }) => visual);
  assert.deepEqual(chords.map(visualText), ["(i)", "(V7)", "N.C.", "Coda", "i(add9)"]);
  assert.equal(chords[2].unknown, false, "a known label keeps the normal chord colour");
});

test("Roman notation uses the local key in grids and instructed sections after a playback shift", () => {
  const doc = new ChordProDocument(system, "{key:Am}\n" + verse("V", "Am C F G") + "\n{start_of_grid:Grid +5}\nAm C F G\n{end_of_grid}");
  const raw = display(doc, undefined, CHORDFORMAT_ROMAN_MAJOR);
  assert.deepEqual(
    raw.occurrences.map(({ key }) => key),
    ["Am", "Dm"]
  );
  const grid = raw.occurrences[1].gridRuns.flatMap((run) => (run.kind === "chord" ? [visualText(run.visual)] : []));
  assert.deepEqual(grid, ["i", "♭III", "♭VI", "♭VII"]);
  const instructed = display(doc, "V +5", CHORDFORMAT_ROMAN);
  assert.equal(instructed.occurrences[0].key, "Dm");
  assert.deepEqual(
    instructed.occurrences[0].chords.map(({ visual }) => visualText(visual)),
    ["i", "III", "VI", "VII"]
  );
});

test("the visible Roman key follows chord rows in the scaled viewport and keeps the last key below them", () => {
  const doc = new ChordProDocument(system, verse("V", "Am C F G") + "\n{start_of_grid:Grid +5}\nAm C F G\n{end_of_grid}");
  const plan = display(doc, undefined, CHORDFORMAT_ROMAN_MAJOR);
  const editor = Object.assign(Object.create(ChordProEditor.prototype), {
    chordPro: doc,
    chordFormat: CHORDFORMAT_ROMAN_MAJOR,
    readOnly: true,
    system,
    domRenderer: {
      element: { getBoundingClientRect: () => ({ top: -80, height: 400 }) },
      getLayoutSnapshot: () => ({ height: 200 }),
      getGeometryIndex: () => ({ occurrences: plan.occurrences.map((occurrence, index) => ({ occurrence, bottom: (index + 1) * 100 })) }),
    },
  }) as ChordProEditor;

  assert.deepEqual(editor.getDisplayKey(), { name: "Am", inferred: true });
  assert.deepEqual(editor.getDisplayKey(20), { name: "Am", inferred: true });
  assert.deepEqual(editor.getDisplayKey(120), { name: "Dm", inferred: true });
  assert.deepEqual(editor.getDisplayKey(330), { name: "Dm", inferred: true });
});

test("the visible Roman key over a score is the score's own key, or the song key when it names none", () => {
  const doc = new ChordProDocument(system, "{key:C}\n[C]word");
  const occurrences = [
    { occurrence: { id: "named", kind: "abc", key: "C", chords: [], text: "K:Am" }, bottom: 100 },
    { occurrence: { id: "unnamed", kind: "abc", key: "C", chords: [], text: "K:none" }, bottom: 200 },
  ];
  const editor = Object.assign(Object.create(ChordProEditor.prototype), {
    chordPro: doc,
    chordFormat: CHORDFORMAT_ROMAN,
    readOnly: true,
    system,
    domRenderer: {
      element: { getBoundingClientRect: () => ({ top: 0, height: 200 }) },
      getLayoutSnapshot: () => ({ height: 200 }),
      getGeometryIndex: () => ({ occurrences }),
      getAbcScoreKey: (id: string) => (id === "named" ? "Am" : undefined),
    },
  }) as ChordProEditor;

  assert.deepEqual(editor.getDisplayKey(50), { name: "Am", inferred: false });
  assert.deepEqual(editor.getDisplayKey(150), { name: "C", inferred: false });
});

test("Roman notation respects chromatic spelling and German/Hungarian note names", () => {
  const doc = new ChordProDocument(getChordSystem("G"), "{key:C}\n" + verse("V", "Dm F# Gb B Hdim"));
  assert.deepEqual(
    display(doc, undefined, CHORDFORMAT_ROMAN).occurrences[0].chords.map(({ visual }) => visualText(visual)),
    ["ii", "♯IV", "♭V", "♭VII", "vii°"]
  );
});

test("the editor follows document replacements and transpose without writing the automatic key into the song", () => {
  for (const chordFormat of [CHORDFORMAT_INKEY, CHORDFORMAT_ROMAN, CHORDFORMAT_ROMAN_MAJOR]) {
    const doc = new ChordProDocument(system, verse("V", "C F G C"));
    const editor = Object.assign(Object.create(ChordProEditor.prototype), {
      chordPro: doc,
      system,
      chordFormat,
      readOnly: true,
      currentShift: 0,
      draw() {},
      saveState() {},
    }) as ChordProEditor;
    assert.equal(editor.getKey(), "C");
    editor.transpose(2, false);
    assert.equal(editor.getKey(), "D");
    assert.doesNotMatch(editor.chordProCode, /\{key:/);
    editor.externalUpdate("{key:F}\n[C]word");
    assert.equal(editor.getKey(), "F");
    editor.externalUpdate("words");
    assert.equal(editor.getKey(), undefined);
  }
});
