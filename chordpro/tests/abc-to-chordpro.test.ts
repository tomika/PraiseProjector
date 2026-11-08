import assert from "node:assert/strict";
import { before, test } from "node:test";
import { loadAbcjs } from "../abcjs-lazy";
import { ChordProAbc, ChordProDocument, getChordSystem } from "../chordpro_base";
import { Instructions } from "../chordpro_instructions";
import { ChordProEditor } from "../chordpro_editor";
import { defaultDisplayProperties, defaultStyles } from "../chordpro_styles";
import { CHORDFORMAT_NOCHORDS } from "../render/chord-visual";
import { buildDisplayPlan, DisplayIdentityRegistry, projectDisplaySequence, type AbcDisplayMode } from "../render/display-plan";
import type { DomSongRendererInput } from "../render/dom-song-renderer";

before(async () => {
  await loadAbcjs();
});

// User-supplied score: the two stanzas span BOTH music lines. Their final
// syllables also differ (én / lán-gol, and Rád / nem szól).
const VERSES = `X:1
M:4/4
L:1/8
K:Am
P:Vsz
"Am"z2 E2 "F"DC-CC- | "C"C4 "G/B"z4 | "Am"z CCC "F"G/E3/ E/D3/ | "C"(E4 "G/B"D4) |
w: 1.~Úgy sze-ret--ném, _ Hogy job-ban sze-res-se-lek én! _
w: 2.~Nincs re-mé--nyem, _ Te-rem-tő szik-rád ha nem lán-gol.
"Am"z2 E2 "F"DC-CC- | "C"C4 "G/B"z4 | "Am"z CCC "F"GE/E/-ED | "C"(E4 "G/B"D4) ||
w: Úgy vá-gyom _ rá, _ Hogy job-ban vá-gya-koz--zam Rád! _
w: Nem ver szí--vem, _ Győ-zel-mi é-ne-ked _ ha nem szól.
P:Bridge
"F"z A, CA,/C/-C3 C/A,/ | "Am"CDEC z4 |
w: Úgy szom-ja-zom, _ szí-vem hogy szom-jaz-zon,`;

function score(source = VERSES, system: "G" | "S" = "G", label = "Score") {
  const document = new ChordProDocument(getChordSystem(system), `{key:Am}\n{start_of_abc: ${label}}\n${source}\n{end_of_abc}`);
  return { document, abc: document.lines.find((line) => line instanceof ChordProAbc) as ChordProAbc };
}

function displayPlan(document: ChordProDocument, mode: AbcDisplayMode, text?: string, identities = new DisplayIdentityRegistry(), chordFormat = 0) {
  const instructions = text == null ? null : new Instructions();
  instructions?.parse(text!, document);
  const display = defaultDisplayProperties();
  return buildDisplayPlan({
    document,
    identities,
    system: document.system,
    display,
    directives: defaultStyles(display.lyricsFont),
    chordFormat,
    showTitle: false,
    showMeta: false,
    showTags: true,
    abbreviateTags: false,
    readOnly: true,
    instructionsMode: instructions ? "FULL" : "",
    instructions,
    abcMode: mode,
  });
}

test("a shared melody produces complete consecutive stanzas, with the common bridge once", () => {
  const { document, abc } = score();
  const before = document.generateDocument();
  const rows = abc.toChordPro();
  assert.deepEqual(
    rows.map((line) => line.getTagInfo().tag),
    ["Vsz 1", "Vsz 1", "Vsz 2", "Vsz 2", "Bridge"]
  );
  assert.deepEqual(
    rows.map((line) => line.lyrics),
    [
      "Úgy szeretném, Hogy jobban szeresselek én!",
      "Úgy vágyom rá, Hogy jobban vágyakozzam Rád!",
      "Nincs reményem, Teremtő szikrád ha nem lángol.",
      "Nem ver szívem, Győzelmi éneked ha nem szól.",
      "Úgy szomjazom, szívem hogy szomjazzon,",
    ]
  );
  assert.ok(rows.every((line) => !line.isGrid));
  assert.equal(document.generateDocument(), before);
});

test("short first lyrics cannot absorb the second stanza's remaining syllables", () => {
  const { abc } = score("X:1\nK:C\nCDEF|\nw: One two\nw: Red green blue white\nGABc|\nw: Three four\nw: Black pink gold grey");
  assert.deepEqual(
    abc.toChordPro().map((line) => line.lyrics),
    ["One two", "Three four", "Red green blue white", "Black pink gold grey"]
  );
});

test("inline ABC part fields expose both lyric sections to instructions", () => {
  const { document, abc } = score('X:1\nK:C\n[P:Verse]"C"CDEF|[P:Bridge]"G"GABc|\nw: Sing this part now Share these words too');
  assert.deepEqual(
    abc.toChordPro().map((line) => line.getTagInfo().tag),
    ["Verse", "Bridge"]
  );
  assert.deepEqual(
    displayPlan(document, "NOTATION", "Bridge\nVerse").occurrences.map((line) => line.text),
    ["Share these words too", "Sing this part now"]
  );
});

test("a word split across music lines is rejoined with its chord anchors", () => {
  const { abc } = score('X:1\nK:C\n"C"CD|\nw: won-der-\n"G"EF|\nw: ful song');
  const rows = abc.toChordPro();
  assert.equal(rows.length, 1);
  assert.equal(rows[0].text, "[C]wonder[G]ful song");
});

test("inline parts, two lyric lanes and word continuations survive a CRLF options envelope", () => {
  const source =
    '{"program":24}\n---\nX:1\nK:C\n[P:Verse]"C"CD|\nw: 1.~won-der-\nw: 2.~sha-dow\n"G"EF|\nw: ful song\nw: walks on\n[P:Bridge]GABc|\nw: Common bridge lives here';
  const { abc } = score(source.replace(/\n/g, "\r\n"));
  const rows = abc.toChordPro();
  assert.deepEqual(
    rows.map((line) => line.getTagInfo().tag),
    ["Verse 1", "Verse 2", "Verse 2", "Bridge"]
  );
  assert.deepEqual(
    rows.map((line) => line.lyrics),
    ["wonderful song", "shadow", "walks on", "Common bridge lives here"]
  );
  assert.equal(rows[0].text, "[C]wonder[G]ful song");
});

test("Hungarian spelling and UTF-16 chord positions also survive a word continued on the next staff", () => {
  const { abc } = score('X:1\nK:C\n"C"C|\nw: ÖSZ-\n"G"D|\nw: SZEFORR');
  const row = abc.toChordPro()[0];
  assert.equal(row.lyrics, "ÖSSZEFORR");
  assert.equal(row.chords[1].pos, 2);
  assert.equal(row.text, "[C]ÖS[G]SZEFORR");
});

test("authored verse numbers and tunebook titles remain independently addressable", () => {
  const { abc } = score(
    "X:1\nT:First\nK:C\nCDEF|\nw: 3.~One two three four\nw: 4.~Red green blue white\n\nX:2\nT:Second\nK:C\nGABc|\nw: Common words go here"
  );
  assert.deepEqual(
    abc.toChordPro().map((line) => line.getTagInfo().tag),
    ["First 3", "First 4", "Second"]
  );
  assert.deepEqual(
    abc.toChordPro().map((line) => line.lyrics),
    ["One two three four", "Red green blue white", "Common words go here"]
  );
});

test("rests and melismas retain chords; B/H conversion applies to roots and slash basses", () => {
  const source = 'X:1\nL:1/4\nK:C\n"B"z "G/B"C "Bb"D "B/Bb"E |\nw: Sing _ now';
  assert.equal(score(source, "G").abc.toChordPro()[0].text, "[H][G/H]Sing[B] [H/B]now");
  assert.equal(score(source, "S").abc.toChordPro()[0].text, "[B][G/B]Sing[B♭] [B/B♭]now");
});

test("instrumental parts inside a vocal score use the song's chord alphabet too", () => {
  const { abc } = score('X:1\nK:C\nP:Intro\n|:"B"C2 "G/B"D2 "Bb"E2 "B/Bb"F2:|\nP:Verse\n"C"CDEF|\nw: Sing this song now');
  const rows = abc.toChordPro();
  assert.equal(rows[0].lyrics, "|: H G/H B H/B :|");
  assert.ok(rows[0].isGrid);
  assert.equal(rows[0].chords.length, 0);
});

test("an unchorded instrumental intro in a vocal score remains an addressable grid", () => {
  const { abc, document } = score("X:1\nK:C\nP:Intro\nCDEF|\nP:Verse\nGABc|\nw: Sing this song now");
  assert.deepEqual(
    abc.toChordPro().map((line) => line.getTagInfo().tag),
    ["Intro", "Verse"]
  );
  assert.ok(abc.toChordPro()[0].isGrid);
  assert.equal(displayPlan(document, "NOTATION", "Intro").occurrences.length, 1);
});

test("a two-staff instrumental intro is one grid row of chord symbols, without pedal annotations", () => {
  const { abc } = score(
    'X:1\nM:4/4\nL:1/8\n%%score {1|2}\nV:1 clef=treble\nV:2 clef=bass\nK:E\nP:Intro\n[V:1] "C#m"z2 D6 | "E""^rit."z2 F2 D4 :|\n[V:2] "_Ped."C,E,-E,6 | "_Ped."E,G,/B,/-B,6 :|\nP:Verse\n[V:1] "E"EEEEE |\nw: Lá-tom az é-lő'
  );
  const rows = abc.toChordPro();
  assert.deepEqual(
    rows.map((line) => [line.getTagInfo().tag, line.lyrics]),
    [
      ["Intro", "C♯m E :|"],
      ["Verse", "Látom az élő"],
    ]
  );
  assert.ok(rows[0].isGrid);
});

test("an instrumental intro takes its chords from whichever voice of the staff carries them", () => {
  const { abc } = score('X:1\n%%score (1 2)\nK:C\nP:Intro\n[V:1] c4 d4 |\n[V:2] "C"C,4 "G"G,,4 :|\nP:Verse\n[V:1] "C"CDEF |\nw: Sing this song now');
  const rows = abc.toChordPro();
  assert.deepEqual(
    rows.map((line) => [line.getTagInfo().tag, line.lyrics]),
    [
      ["Intro", "C G :|"],
      ["Verse", "Sing this song now"],
    ]
  );
});

test("the same progression written on both piano staves is one grid row; different ones stay separate", () => {
  const intro = (bass: string) =>
    score(`X:1\n%%score {1|2}\nK:C\nP:Intro\n[V:1] "C"c4 "G"d4 |\n[V:2] ${bass} |\nP:Verse\n[V:1] "C"CDEF |\nw: Sing this song now`).abc.toChordPro();
  assert.deepEqual(
    intro('"C"C,4 "G"G,,4')
      .filter((line) => line.isGrid)
      .map((line) => line.lyrics),
    ["C G"]
  );
  assert.deepEqual(
    intro('"Am"A,,4 "F"F,,4')
      .filter((line) => line.isGrid)
      .map((line) => line.lyrics),
    ["C G", "Am F"]
  );
  // A row that renders the same chords (bar lines are not shown) is not repeated.
  assert.deepEqual(
    intro('C,4 "C"C,4 | "G"G,,4')
      .filter((line) => line.isGrid)
      .map((line) => line.lyrics),
    ["C G"]
  );
});

test("Hungarian long digraphs are abbreviated except at compound boundaries and before -szor", () => {
  const { abc } = score(
    "X:1\nK:C\nCDEF GABc|cBAG FEDC|CDEF GABc|\nw: Ösz-sze visz-sza asz-szony köny-nyű egy-gyé dísz-szel dísz-szemle jegy-gyű-rű húsz-szor rossz-szal"
  );
  assert.equal(abc.toChordPro()[0].lyrics, "Össze vissza asszony könnyű eggyé dísszel díszszemle jegygyűrű húszszor rosszal");
});

test("trailing punctuation does not hide an assimilated suffix", () => {
  const { abc } = score("X:1\nK:C\nCDEF GA|\nw: nagy-gyá! dísz-szel, jegy-gyel.");
  assert.equal(abc.toChordPro()[0].lyrics, "naggyá! dísszel, jeggyel.");
});

test("dropping an already abbreviated digraph keeps the next syllable's chord on its first letter", () => {
  const { abc } = score('X:1\nK:C\n"C"C "G"D|\nw: rossz-szal');
  assert.equal(abc.toChordPro()[0].text, "[C]ros[G]szal");
});

test("instrumental scores keep the legacy grid, repeats and alternate endings", () => {
  const { abc } = score('X:1\nK:C\n|:"C"CDEF|[1 "G"GABc:|[2 "F"F4|]');
  const lines = abc.toChordPro();
  assert.equal(lines.length, 1);
  assert.ok(lines[0].isGrid);
  assert.equal(lines[0].lyrics, "|: C 1( G ) :| 2( F )");
  assert.equal(lines[0].lyrics, abc.toGrid(true).lyrics);
});

test("the options envelope survives conversion and source edits invalidate the cache", () => {
  const { document, abc } = score('{"program":24}\n---\nX:1\nK:C\n"C"CDEF|\nw: Sing this song now');
  const original = document.generateDocument();
  const expanded = document.expandAbc();
  assert.equal(expanded.lines[0].lyrics, "Sing this song now");
  assert.equal(document.expandAbc(), expanded);
  assert.equal(document.generateDocument(), original);
  abc.push("GABc|");
  abc.push("w: This is brand new");
  assert.notEqual(document.expandAbc(), expanded);
  assert.equal(document.expandAbc().lines[1].lyrics, "This is brand new");
});

test("normal notation stays intact; explicit zoom conversion exposes lyrics with stable identities", () => {
  const { document } = score();
  const original = document.generateDocument();
  assert.deepEqual(
    displayPlan(document, "NOTATION").occurrences.map((line) => line.kind),
    ["abc"]
  );
  const identities = new DisplayIdentityRegistry();
  const first = displayPlan(document, "CHORDS", undefined, identities);
  const second = displayPlan(document, "CHORDS", undefined, identities);
  assert.equal(first.occurrences.length, 5);
  assert.ok(first.occurrences.every((line) => line.kind === "lyrics"));
  assert.deepEqual(
    second.occurrences.map((line) => line.id),
    first.occurrences.map((line) => line.id)
  );
  assert.deepEqual(
    second.occurrences.flatMap((line) => line.chords.map((chord) => chord.id)),
    first.occurrences.flatMap((line) => line.chords.map((chord) => chord.id))
  );
  const hiddenChords = displayPlan(document, "CHORDS", undefined, identities, CHORDFORMAT_NOCHORDS);
  assert.equal(hiddenChords.occurrences.length, 5);
  assert.ok(hiddenChords.occurrences.every((line) => !line.chords.length));
  assert.equal(document.generateDocument(), original);
});

test("instructions automatically convert only when addressing separate inner parts", () => {
  const { document } = score();
  assert.deepEqual(
    displayPlan(document, "NOTATION", "Score").occurrences.map((line) => line.kind),
    ["abc"]
  );
  const plan = displayPlan(document, "NOTATION", "Vsz 2\nBridge\nVsz 1 +2");
  assert.deepEqual(
    plan.occurrences.map((line) => line.text),
    [
      "Nincs reményem, Teremtő szikrád ha nem lángol.",
      "Nem ver szívem, Győzelmi éneked ha nem szól.",
      "Úgy szomjazom, szívem hogy szomjazzon,",
      "Úgy szeretném, Hogy jobban szeresselek én!",
      "Úgy vágyom rá, Hogy jobban vágyakozzam Rád!",
    ]
  );
  assert.equal(plan.occurrences[0].chords[0].source.text, "Am");
  assert.equal(plan.occurrences[3].chords[0].source.text, "Hm");
  assert.equal(displayPlan(document, "HIDDEN", "Vsz 2\nBridge\nVsz 2").occurrences.length, 0);
  assert.equal(displayPlan(document, "CHORDS", "Score").occurrences.length, 5);
});

test("a single named inner part selected in the instruction editor is also playable", () => {
  const { document } = score('X:1\nK:C\nP:Chorus\n"C"CDEF|\nw: A sin-gle part');
  assert.deepEqual(
    displayPlan(document, "NOTATION", "Chorus").occurrences.map((line) => line.text),
    ["A single part"]
  );
});

test("existing sections and parts from different scores cannot accidentally share an instruction", () => {
  const first = "X:1\nK:C\nP:Verse\nCDEF|\nw: First score goes here";
  const second = "X:1\nK:C\nP:Verse\nGABc|\nw: Other score goes here";
  const document = new ChordProDocument(
    getChordSystem("S"),
    `{start_of_verse: Verse}\nExisting verse\n{end_of_verse}\n{start_of_abc: A}\n${first}\n{end_of_abc}\n{start_of_abc: B}\n${second}\n{end_of_abc}`
  );
  assert.deepEqual(document.expandAbc().getSections(), ["Verse", "A / Verse", "B / Verse"]);
  assert.deepEqual(
    displayPlan(document, "NOTATION", "Verse").occurrences.map((line) => line.text),
    ["Existing verse"]
  );
  assert.deepEqual(
    displayPlan(document, "NOTATION", "B / Verse").occurrences.map((line) => line.text),
    ["Other score goes here"]
  );
});

test("a prefixed score part cannot collide with an already-authored prefixed section", () => {
  const document = new ChordProDocument(
    getChordSystem("S"),
    "{start_of_verse: Verse}\nExisting verse\n{end_of_verse}\n{start_of_verse: A / Verse}\nExisting prefixed verse\n{end_of_verse}\n{start_of_abc: A}\nX:1\nK:C\nP:Verse\nCDEF|\nw: Score words go here\n{end_of_abc}"
  );
  const names = document
    .expandAbc()
    .getSections()
    .map((name) => name.toLocaleLowerCase());
  assert.equal(new Set(names).size, names.length);
  assert.deepEqual(
    displayPlan(document, "NOTATION", "A / Verse").occurrences.map((line) => line.text),
    ["Existing prefixed verse"]
  );
});

test("an inner part named after its score does not hide the aggregate parent alias", () => {
  const { document } = score("X:1\nK:C\nP:Score\nCDEF|\nw: First score lyrics here\nP:Bridge\nGABc|\nw: Common bridge lyrics here");
  assert.deepEqual(document.expandAbc().getSections(), ["Score / Score", "Bridge"]);
  assert.deepEqual(
    displayPlan(document, "NOTATION", "Score").occurrences.map((line) => line.kind),
    ["abc"]
  );
  assert.deepEqual(
    displayPlan(document, "NOTATION", "Score / Score").occurrences.map((line) => line.text),
    ["First score lyrics here"]
  );
  assert.equal(displayPlan(document, "CHORDS", "Score").occurrences.length, 2);
});

test("score names differing only in case still get distinct selectable part names", () => {
  const source = "X:1\nK:C\nP:Verse\nCDEF|\nw: Score words go here";
  const document = new ChordProDocument(
    getChordSystem("S"),
    `{start_of_abc: A}\n${source}\n{end_of_abc}\n{start_of_abc: a}\n${source}\n{end_of_abc}`
  );
  const names = document
    .expandAbc()
    .getSections()
    .map((name) => name.toLocaleLowerCase());
  assert.equal(new Set(names).size, names.length);
});

test("expanding a score preserves the original ordinary lines, marks and hit targets", () => {
  const document = new ChordProDocument(
    getChordSystem("S"),
    `{start_of_verse: Other}\n[C]Keep this line\n{end_of_verse}\n{start_of_abc: Score}\n${VERSES}\n{end_of_abc}`
  );
  const ordinary = document.lines[0];
  ordinary.marked = 1;
  ordinary.chords[0].marked = 1;
  const first = displayPlan(document, "CHORDS").occurrences[0];
  assert.equal(first.origin, ordinary);
  assert.equal(first.source, ordinary);
  assert.equal(first.source.marked, 1);
  assert.equal(first.chords[0].source, ordinary.chords[0]);
  first.chords[0].source.marked = 0;
  assert.equal(ordinary.chords[0].marked, 0);
  assert.equal(displayPlan(document, "CHORDS").occurrences[0].source.marked, 1);
});

test("a chord on an accompaniment voice is preserved rather than silently discarded", () => {
  const { abc } = score('X:1\n%%score (one two)\nK:C\nV:one\nCDEF|\nw: Sing this song now\nV:two\n"G"GABc|');
  const rows = abc.toChordPro();
  assert.ok(rows[0] instanceof ChordProAbc);
});

test("an accompaniment chord on another staff retains notation instead of moving after the sung line", () => {
  const { abc, document } = score('X:1\n%%score (one) (two)\nK:C\nV:one\nCDEF|\nw: Sing this song now\nV:two\n"G"GABc|');
  const original = document.generateDocument();
  assert.ok(abc.toChordPro()[0] instanceof ChordProAbc);
  assert.equal(document.expandAbc(), document);
  assert.deepEqual(
    displayPlan(document, "CHORDS").occurrences.map((line) => line.kind),
    ["abc"]
  );
  assert.equal(document.generateDocument(), original);
});

test("an unchorded accompaniment staff still allows the vocal staff's lyrics and chords to convert", () => {
  const { abc } = score('X:1\n%%score (one) (two)\nK:C\nV:one\n"C"CDEF|\nw: Sing this song now\nV:two\nGABc|');
  const rows = abc.toChordPro();
  assert.equal(rows.length, 1);
  assert.ok(!(rows[0] instanceof ChordProAbc));
  assert.equal(rows[0].lyrics, "Sing this song now");
  assert.equal(rows[0].chords[0].chord, "C");
  assert.equal(rows[0].chords[0].pos, 0);
});

test("annotations on an accompaniment staff are not chords and do not block the vocal conversion", () => {
  const { abc } = score('X:1\n%%score (one) (two)\nK:C\nV:one\n"C""^mf"CDEF|\nw: Sing this song now\nV:two\n"_Ped."GABc|');
  const rows = abc.toChordPro();
  assert.equal(rows.length, 1);
  assert.ok(!(rows[0] instanceof ChordProAbc));
  assert.equal(rows[0].text, "[C]Sing this song now");
});

test("legacy instrumental section aliases still resolve to their parent", () => {
  const { document } = score('X:1\nK:C\n"C"CDEF|', "S", "Intro");
  const instructions = new Instructions();
  instructions.parse("Intro 2", document);
  assert.equal(instructions.items[0].info?.instructionName(), "Intro");
});

test("unlabelled instrumental ABC stays selectable after expansion", () => {
  const document = new ChordProDocument(getChordSystem("S"), '{start_of_abc}\nX:1\nK:C\n"C"CDEF|\n{end_of_abc}');
  assert.equal(document.expandAbc().getDefaultInstructions(), "abc");
  const instructions = new Instructions();
  instructions.parse("abc", document.expandAbc());
  assert.equal(instructions.items[0].multiplier, 1);
  assert.equal(displayPlan(document, "CHORDS", "abc").occurrences[0].text, "C");
});

test("selective expansion reuses identities while unrelated scores remain notation", () => {
  const document = new ChordProDocument(
    getChordSystem("S"),
    `{start_of_abc: A}\n${VERSES}\n{end_of_abc}\n{start_of_abc: B}\nX:1\nK:C\n"C"CDEF|\n{end_of_abc}`
  );
  const instructions = new Instructions();
  instructions.parse("Vsz 2\nB", document);
  const sequence = () => projectDisplaySequence({ document, readOnly: true, instructionsMode: "FULL", instructions, abcMode: "NOTATION" });
  const first = sequence();
  const second = sequence();
  assert.equal(second.document, first.document);
  assert.deepEqual(
    second.lines.map((row) => row.line instanceof ChordProAbc),
    [false, false, true]
  );
  assert.equal(second.lines[2].origin, document.lines[1]);
});

test("ambiguous simultaneous vocal voices retain their complete original notation", () => {
  const { document, abc } = score("X:1\n%%score (one two)\nK:C\nV:one\nCDEF|\nw: First voice sings here\nV:two\nGABc|\nw: Other voice sings here");
  const original = document.generateDocument();
  assert.ok(abc.toChordPro()[0] instanceof ChordProAbc);
  assert.equal(document.expandAbc(), document);
  assert.deepEqual(
    displayPlan(document, "CHORDS").occurrences.map((line) => line.kind),
    ["abc"]
  );
  assert.equal(document.generateDocument(), original);
});

test("editing ignores conversion and inner-part instructions", () => {
  const { document } = score();
  const sequence = projectDisplaySequence({ document, readOnly: false, instructionsMode: "FULL", abcMode: "CHORDS" });
  assert.equal(sequence.document, undefined);
  assert.equal(sequence.lines[0].line, document.lines[0]);
});

test("the instruction editor source and preview share the expanded selectable parts", () => {
  const { document } = score();
  type Harness = {
    createInstructionsRendererInput(pane: "source" | "preview", instructions: Instructions | null, revision: number): DomSongRendererInput;
    applyInstructions(text: string, draw: boolean): void;
    getInstructions(mode: "DEFAULT" | "SETTING"): string;
  };
  const editor = Object.assign(Object.create(ChordProEditor.prototype), {
    chordPro: document,
    instructionEditorActive: true,
    system: document.system,
    displayProps: defaultDisplayProperties(),
    documentRevision: 0,
    displayRevision: 0,
  }) as Harness;
  assert.equal(editor.getInstructions("DEFAULT"), "Vsz 1\nVsz 2\nBridge");
  const input = editor.createInstructionsRendererInput("source", null, 0);
  assert.equal(input.document.lines.length, 5);
  const item = Instructions.createSectionItem(input.document, "Vsz 2");
  assert.equal(item.multiplier, 1);
  editor.applyInstructions("Vsz 2\nBridge", false);
  assert.ok(
    editor.createInstructionsRendererInput("source", null, 0).displayRevision > input.displayRevision,
    "instruction changes must invalidate the committed DOM even when drawing is deferred and the mode is unchanged"
  );
  assert.equal(editor.getInstructions("SETTING"), "Vsz 2\nBridge");
  const instructions = new Instructions([item]);
  const preview = editor.createInstructionsRendererInput("preview", instructions, 1);
  assert.equal(preview.sequence?.lines.length, 2);
  assert.ok(preview.sequence?.lines.every((line) => line.line.lyrics.startsWith("Nincs") || line.line.lyrics.startsWith("Nem")));
  editor.applyInstructions("Score", false);
  assert.equal(editor.getInstructions("SETTING"), "", "a legacy aggregate default becomes the expanded defaults");
  editor.applyInstructions("Score 2x +2", false);
  assert.equal(editor.getInstructions("SETTING"), "Vsz 1 +2\nVsz 2 +2\nBridge +2\nVsz 1 +2\nVsz 2 +2\nBridge +2");
  const beforeReset = editor.createInstructionsRendererInput("source", null, 0).displayRevision;
  editor.applyInstructions("", false);
  assert.ok(editor.createInstructionsRendererInput("source", null, 0).displayRevision > beforeReset, "reset must also invalidate the DOM");
});

test("expanding legacy score instructions preserves sequence, transpose, comments and ordinary sections", () => {
  const { document } = score();
  const original = document.generateDocument();
  const instructions = new Instructions();
  instructions.parse("Speak here\nScore 2x +2\nOther comment", document);
  const before = projectDisplaySequence({ document, readOnly: true, instructionsMode: "FULL", instructions, abcMode: "CHORDS" });
  instructions.expandAbcSections(document);
  const after = projectDisplaySequence({ document, readOnly: true, instructionsMode: "FULL", instructions, abcMode: "CHORDS" });
  const originalLines = before.lines.map((row) => row.line.text);
  const scoreLines = originalLines.slice(1, -1);
  // The aggregate displays its repeat as a multiplier on the single score.
  // Editable parts express that same performance as two consecutive sequences.
  assert.deepEqual(
    after.lines.map((row) => row.line.text),
    [originalLines[0], ...scoreLines, ...scoreLines, originalLines.at(-1)]
  );
  assert.equal(instructions.items.length, 8);
  assert.equal(document.generateDocument(), original);

  const unsupported = score("X:1\n%%score (one two)\nK:C\nV:one\nCDEF|\nw: First voice sings here\nV:two\nGABc|\nw: Other voice sings here").document;
  instructions.parse("Score 2x", unsupported);
  instructions.expandAbcSections(unsupported);
  assert.equal(instructions.format(), "Score 2x");

  instructions.parse("Score 1000000x", document);
  instructions.expandAbcSections(document);
  assert.equal(instructions.format(), "Score 1000000x", "large imported repeats stay bounded without losing the repeat count");
});
