import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { zipSync, strToU8 } from "fflate";
import abcjs from "abcjs";
import { convertMusicXml, convertMusicXmlData } from "../../musicxml/musicxml-import";
import { adaptAbc } from "../../musicxml/abc-adapter";

const fixture = readFileSync(resolve("chordpro/tests/fixtures/musicxml-lyrics.musicxml"), "utf8");
const note = "<note><pitch><step>C</step><octave>4</octave></pitch><duration>4</duration><type>quarter</type></note>";
const attributes =
  "<attributes><divisions>4</divisions><key><fifths>0</fifths></key><time><beats>4</beats><beat-type>4</beat-type></time></attributes>";
const score = (body = note) =>
  `<score-partwise><part-list><score-part id="P1"><part-name>Voice</part-name></score-part></part-list><part id="P1"><measure number="1">${attributes}${body}</measure></part></score-partwise>`;

test("MusicXML preserves systems, Hungarian lyric lanes, repeats, and voice durations", () => {
  const result = convertMusicXml(fixture, "Áldjad");
  assert.deepEqual(result.warnings, []);
  assert.match(result.abc, /T:Áldjad/);
  assert.doesNotMatch(result.abc, /\$|\[I:staff/gm);
});

test("the imported lyrics and independent voices retain their musical events", () => {
  const { abc, warnings } = convertMusicXml(fixture, "Áldjad");
  assert.deepEqual(warnings, []);
  assert.equal((abc.match(/^L:1\/8$/gm) || []).length, 1);
  assert.match(abc, /:\| %2\nw:/);
  assert.match(abc, /\n\[2 /);
  const [tune] = abcjs.parseOnly(abc);
  const systems = tune.lines.filter((l) => l.staff);
  assert.equal(systems.length, 2);
  assert.deepEqual(
    systems.map((l) => l.staff?.length),
    [2, 2]
  );
  const voices = new Map<string, number[]>();
  systems.forEach((l) =>
    l.staff?.forEach((s, si) =>
      s.voices?.forEach((v, vi) => {
        const key = `${si}:${vi}`,
          durations = voices.get(key) ?? [];
        v.forEach((e) => {
          if (e.el_type === "note") durations.push(e.duration);
        });
        voices.set(key, durations);
      })
    )
  );
  assert.deepEqual(voices.get("0:0"), [0.25, 0.25, 0.5, 0.5, 0.5]);
  assert.deepEqual(voices.get("1:0"), [0.0625, 0.0625, 0.0625, 0.0625, 0.25, 0.5, 0.5, 0.5]);
  assert.match(abc, /w: Ál- djad\|lelkem\|/);
  assert.match(abc, /w: Szent a\|név\|/);
});

test("MXL reads the manifest's selected score instead of another XML file", () => {
  const bytes = zipSync({
    "META-INF/container.xml": strToU8(
      '<container xmlns="urn:oasis:names:tc:opendocument:xmlns:container"><rootfiles><rootfile full-path="scores/actual.musicxml" media-type="application/vnd.recordare.musicxml+xml"/></rootfiles></container>'
    ),
    "unrelated.xml": strToU8("<bad/>"),
    "scores/actual.musicxml": strToU8(fixture),
  });
  assert.equal(convertMusicXmlData(bytes, "Áldjad.MXL").abc, convertMusicXml(fixture, "Áldjad").abc);
});

test("timewise and namespaced MusicXML convert like partwise scores", () => {
  const timewise = `<score-timewise><part-list><score-part id="P1"><part-name>Voice</part-name></score-part></part-list><measure number="1"><part id="P1">${attributes}${note}</part></measure></score-timewise>`;
  assert.equal(convertMusicXml(timewise).abc, convertMusicXml(score()).abc);
  const prefixed = score()
    .replace(/<(\/?)([a-z][\w-]*)/g, "<$1m:$2")
    .replace("<m:score-partwise>", '<m:score-partwise xmlns:m="http://www.musicxml.org/ns/musicxml">');
  assert.equal(convertMusicXml(prefixed).abc, convertMusicXml(score()).abc);
});

test("invalid XML, unrelated XML, out-of-range keys and bad MXL fail explicitly", () => {
  assert.throws(() => convertMusicXml("<score-partwise><part>"), /Invalid MusicXML/);
  assert.throws(() => convertMusicXml("<html/>"), /not a MusicXML/);
  assert.throws(() => convertMusicXml(score().replace("<fifths>0", "<fifths>8")), /seven sharps/);
  assert.throws(() => convertMusicXmlData(zipSync({ "score.xml": strToU8(score()) }), "a.mxl"), /container.xml/);
  assert.throws(() => convertMusicXml('<!DOCTYPE score-partwise [<!ENTITY x "y">]>' + score()), /entity declarations/);
});

test("repeat conversions do not leak state; unsupported pedal change does not lose the score", () => {
  const expected = convertMusicXml(score()).abc;
  const result = convertMusicXml(score('<direction><direction-type><pedal type="change"/></direction-type></direction>' + note));
  assert.ok(result.warnings.some((w) => w.includes("direction type change")));
  assert.equal(convertMusicXml(score()).abc, expected);
});

test("irregular rests retain total duration and quoted dollar signs stay text", () => {
  const xml = score(
    "<direction><direction-type><words>cost $5</words></direction-type></direction>" + note + "<forward><duration>20</duration></forward>"
  );
  const result = convertMusicXml(xml);
  assert.match(result.abc, /cost \$5/);
  assert.doesNotMatch(result.abc, /\bx5\b/);
  assert.ok(!result.warnings.some((w) => w.includes("Duration not representable")));
});

test("tempo after dynamics, stemless notes and pedals produce readable notation", () => {
  const raw = "X:1\nT:Test\nL:1/8\nK:C\nU:s=!stemless!\nV:1 clef=treble\nV:1\n!p![Q:1/4=80]sC2 !ped!D2 !ped-up! | %1";
  const warnings = new Set<string>();
  const abc = adaptAbc(raw, "Test", warnings);
  const [tune] = abcjs.parseOnly(abc);
  assert.deepEqual(tune.warnings ?? [], []);
  assert.match(abc, /\[Q:1\/4=80\]!p!C2/);
  assert.equal(warnings.size, 2);
});

test("gap rest adaptation preserves exact rational timing", () => {
  const warnings = new Set<string>();
  const abc = adaptAbc("X:1\nL:1/8\nK:C\nV:1 treble\nV:1\nx5 x37/6 | %1", "Test", warnings);
  assert.match(abc, /x4 x x6 \(3:2:1x\/4/);
  const [tune] = abcjs.parseOnly(abc);
  assert.deepEqual(tune.warnings ?? [], []);
  const notes = tune.lines
    .flatMap((l) => l.staff ?? [])
    .flatMap((s) => s.voices ?? [])
    .flat()
    .filter((n) => n.el_type === "note");
  const durations = notes.map((n) => (n.el_type === "note" ? n.duration : 0));
  // Last written 1/32 rest is scaled by a 3:2 tuplet to 1/48.
  assert.ok(Math.abs(durations.slice(0, -1).reduce((n, v) => n + v, 0) + (durations.at(-1)! * 2) / 3 - (5 + 37 / 6) / 8) < 1e-10);
});

test("very short source durations are not silently rounded", () => {
  const xml = score(note.replace("<duration>4</duration>", "<duration>1</duration>").replace("<type>quarter</type>", "<type>1024th</type>")).replace(
    "<divisions>4</divisions>",
    "<divisions>256</divisions>"
  );
  const { abc, warnings } = convertMusicXml(xml);
  assert.match(abc, /C\/128/);
  assert.ok(warnings.some((w) => w.includes("Duration not representable")));
});

test("UTF-16 MusicXML honors its BOM and declaration", () => {
  const xml = '<?xml version="1.0" encoding="UTF-16"?>' + score();
  const bytes = new Uint8Array(2 + xml.length * 2);
  bytes.set([255, 254]);
  for (let i = 0; i < xml.length; i++) {
    bytes[2 + i * 2] = xml.charCodeAt(i) & 255;
    bytes[3 + i * 2] = xml.charCodeAt(i) >> 8;
  }
  assert.equal(convertMusicXmlData(bytes, "Song.xml").abc, convertMusicXml(score(), "Song").abc);
});

test("named and numeric voice IDs remain distinct", () => {
  const namedNote = (id: string, step: string) =>
    note.replace("<step>C</step>", `<step>${step}</step>`).replace("<type>", `<voice>${id}</voice><type>`);
  const xml = score(
    namedNote("soprano", "C") +
      "<backup><duration>4</duration></backup>" +
      namedNote("1", "E") +
      "<backup><duration>4</duration></backup>" +
      namedNote("alto", "G")
  );
  const { abc } = convertMusicXml(xml);
  const voices = abcjs
    .parseOnly(abc)[0]
    .lines.flatMap((l) => l.staff ?? [])
    .flatMap((s) => s.voices ?? []);
  assert.equal(voices.length, 3);
  const pitches = voices
    .map((v) => v.flatMap((n) => (n.el_type === "note" ? (n.pitches?.map((p) => p.pitch) ?? []) : [])))
    .sort((a, b) => a[0] - b[0]);
  assert.deepEqual(pitches, [[0], [2], [4]]);
});

test("part-list IDs associate names and notes when XML part order differs", () => {
  const xml = `<score-partwise><part-list><score-part id="P1"><part-name>Soprano</part-name></score-part><score-part id="P2"><part-name>Bass</part-name></score-part></part-list><part id="P2"><measure number="1">${attributes}${note.replace("<step>C</step>", "<step>E</step>")}</measure></part><part id="P1"><measure number="1">${attributes}${note}</measure></part></score-partwise>`;
  const { abc } = convertMusicXml(xml);
  assert.match(abc, /V:1 treble nm="Soprano"/);
  assert.match(abc, /V:1\nC2/);
  assert.match(abc, /V:2\nE2/);
});

test("timewise parts absent from the part list are not silently discarded", () => {
  const xml = `<score-timewise><part-list><score-part id="P1"><part-name>Voice</part-name></score-part></part-list><measure number="1"><part id="P1">${attributes}${note}</part><part id="P2">${attributes}${note}</part></measure></score-timewise>`;
  assert.throws(() => convertMusicXml(xml), /part list/i);
});

test("UTF-16LE with an explicit declaration works without a BOM", () => {
  const xml = '<?xml version="1.0" encoding="UTF-16LE"?>' + score();
  const bytes = new Uint8Array(Buffer.from(xml, "utf16le"));
  assert.equal(convertMusicXmlData(bytes, "Song.xml").abc, convertMusicXml(score(), "Song").abc);
});

test("whitespace after dynamics does not make an inline tempo a note chord", () => {
  const abc = adaptAbc("X:1\nL:1/8\nK:C\nV:1 treble\nV:1\n!p! [Q:1/4=80] C2 | %1", "Test", new Set());
  assert.deepEqual(abcjs.parseOnly(abc)[0].warnings ?? [], []);
});

test("named lyric verse IDs retain every verse instead of merging them", () => {
  const xml = score(
    note.replace("</note>", '<lyric number="verse_a"><text>First</text></lyric><lyric number="verse_b"><text>Second</text></lyric></note>')
  );
  const { abc } = convertMusicXml(xml);
  assert.match(abc, /w: First\|/);
  assert.match(abc, /w: Second\|/);
});

test("an implicit default voice does not collide with a named voice", () => {
  const named = note.replace("<step>C</step>", "<step>E</step>").replace("<type>", "<voice>alto</voice><type>");
  const { abc } = convertMusicXml(score(note + "<backup><duration>4</duration></backup>" + named));
  const voices = abcjs
    .parseOnly(abc)[0]
    .lines.flatMap((l) => l.staff ?? [])
    .flatMap((s) => s.voices ?? []);
  assert.equal(voices.length, 2);
  assert.ok(voices.every((v) => v.filter((n) => n.el_type === "note").length === 1));
});

test("an authored title named Title is not mistaken for the fallback placeholder", () => {
  const xml = score().replace("<part-list>", "<work><work-title>Title</work-title></work><part-list>");
  assert.match(convertMusicXml(xml, "Filename").abc, /^T:Title$/m);
  assert.match(convertMusicXml(score(), "Filename").abc, /^T:Filename$/m);
});
