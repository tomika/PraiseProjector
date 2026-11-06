import assert from "node:assert/strict";
import test from "node:test";
import { createDefaultScoreDefaults, normalizeScoreDefaults, readPersistedScoreDefaults } from "../../common/score-settings";
import { abcHeaderDefaults, maskFixedDirectives, parseAbcSource, resolveAbcOptions } from "../abc-options";
import { ChordProAbc, ChordProDocument, getChordSystem } from "../chordpro_base";
import { loadAbcjs } from "../abcjs-lazy";

function withStoredSettings(getItem: () => string | null, run: () => void) {
  const previous = Object.getOwnPropertyDescriptor(globalThis, "window");
  Object.defineProperty(globalThis, "window", { configurable: true, value: { localStorage: { getItem } } });
  try {
    run();
  } finally {
    if (previous) Object.defineProperty(globalThis, "window", previous);
    else Reflect.deleteProperty(globalThis, "window");
  }
}

function withSavedDefaults(defaults: object, run: () => void) {
  withStoredSettings(() => JSON.stringify({ scoreDefaults: defaults }), run);
}

function score(source: string, metadata = "", system: "G" | "S" = "G") {
  const doc = new ChordProDocument(getChordSystem(system), `${metadata}\n{start_of_abc: Intro}\n${source}\n{end_of_abc}`);
  return { doc, abc: doc.lines.find((line) => line instanceof ChordProAbc) as ChordProAbc };
}

test("old and partially saved settings receive independent defaults; invalid values and the retired scale are dropped", () => {
  assert.deepEqual(normalizeScoreDefaults(undefined), createDefaultScoreDefaults());
  assert.deepEqual(normalizeScoreDefaults({ bassvol: 0, program: 127, chordprog: 128, chordvol: -1, scale: 1.5, paddingtop: NaN }), {
    ...createDefaultScoreDefaults(),
    bassvol: 0,
    program: 127,
  });
  const first = createDefaultScoreDefaults();
  first.bassvol = 0;
  assert.equal(createDefaultScoreDefaults().bassvol, 64);
});

test("saved defaults are parsed once per settings text and follow every change", () => {
  let text: string | null = JSON.stringify({ scoreDefaults: { program: 24 } });
  withStoredSettings(
    () => text,
    () => {
      const first = readPersistedScoreDefaults();
      assert.equal(first.program, 24);
      assert.equal(readPersistedScoreDefaults(), first, "unchanged settings text reuses the parsed defaults");
      text = JSON.stringify({ scoreDefaults: { program: 40 } });
      assert.equal(readPersistedScoreDefaults().program, 40);
      for (text of ["{not json", "null", null]) assert.deepEqual(readPersistedScoreDefaults(), createDefaultScoreDefaults());
    }
  );
});

test("JSON headers are masked without shifting note offsets, including CRLF and malformed drafts", () => {
  for (const header of ['{ "swing": 65 }', '{\r\n "swing": 65,\r\n}']) {
    const value = `${header}\r\n---\r\nX:1\r\nK:C\r\nCDEF|`;
    const parsed = parseAbcSource(value);
    assert.equal(parsed.abc.length, value.length);
    assert.equal(parsed.abc.indexOf("CDEF"), value.indexOf("CDEF"));
    assert.equal(value.slice(parsed.bodyStart), "X:1\r\nK:C\r\nCDEF|");
    assert.equal(parsed.abc.includes("swing"), false);
  }
  assert.deepEqual(parseAbcSource('{"swing": 65}\n---\nK:C\nC').options, { swing: 65 });
  assert.deepEqual(parseAbcSource('{"swing":}\n---\nK:C\nC').options, {});
  assert.equal(parseAbcSource("{c}C\n---\nD").bodyStart, 0, "ordinary ABC grace notes are not JSON");
});

test("single-line and multiline headers survive ChordPro save/reload without becoming song metadata", () => {
  for (const header of ['{"program":24,"bassvol":0}', '{\n  "program": 24,\n  "bassvol": 0\n}']) {
    const source = `${header}\n---\nX:1\nK:G\n{c}GABc|`;
    const { doc, abc } = score(source);
    assert.equal(abc.getAbc(true, false), source);
    assert.equal(doc.getMeta('"program"'), "");
    const reloaded = new ChordProDocument(getChordSystem("G"), doc.generateDocument());
    const saved = reloaded.lines.find((line) => line instanceof ChordProAbc) as ChordProAbc;
    assert.equal(saved.getAbc(true, false), source);
  }
});

test("an ABC closing directive retains the existing optional label and soft-line-ending syntax", () => {
  const source = '{start_of_abc}\n{"program":24}\n---\nK:C\nCDEF|\n{end_of_abc: Intro}\u23ce\nFollowing lyrics';
  const doc = new ChordProDocument(getChordSystem("G"), source);
  assert.equal(doc.lines.length, 2);
  assert.ok(doc.lines[0] instanceof ChordProAbc);
  assert.equal((doc.lines[0] as ChordProAbc).getAbc(true, false), '{"program":24}\n---\nK:C\nCDEF|');
  assert.equal(doc.lines[1].lyrics, "Following lyrics");
});

test("song key fills a missing K: after the JSON header and ABC metadata using international notation", () => {
  for (const [songKey, abcKey] of [
    ["Hm", "Bm"],
    ["B", "Bb"],
    ["D II", "Ddor"],
    ["F#", "F#"],
  ]) {
    const header = '{"program":24}\n---\nX:1\nM:4/4\nL:1/8\n';
    const { abc } = score(header + "CDEF|", `{key: ${songKey}}`);
    assert.equal(abc.getAbc(true, false), `${header}K:${abcKey}\nCDEF|`);
    abc.updateMeta();
    assert.equal((abc.getAbc().match(/^K:/gm) ?? []).length, 1);
  }
  assert.match(score("X:1\nK:F\nFGA|", "{key: Hm}").abc.getAbc(), /\nK:F\n/);
  assert.equal(score("X:1\nCDEF|", "{key: B}", "S").doc.getAbcKey(), "B");
});

test("editor defaults use song tempo as a fallback and fix the app's chord naming, superscripts and scale", () => {
  withSavedDefaults({ program: 24, chordvol: 0, scale: 1.25 }, () => {
    const defaults = abcHeaderDefaults("96", true, false);
    assert.deepEqual(defaults.program, { value: 24 });
    assert.deepEqual(defaults.chordvol, { value: 0 });
    assert.deepEqual(defaults.defaultQpm, { value: 96 });
    assert.equal(defaults.qpm, undefined, "an authored Q: must retain priority over song tempo");
    assert.deepEqual(defaults.germanAlphabet, { value: true, editable: false });
    assert.deepEqual(defaults.jazzchords, { value: false, editable: false });
    assert.deepEqual(defaults.scale, { value: 1, editable: false }, "a scale saved by an earlier build is ignored");
    assert.equal(abcHeaderDefaults("", false, true).defaultQpm, undefined);
  });
});

test("document overrides win except for the fixed scale; invalid values, callbacks and sample URLs do not enter abcjs", () => {
  withSavedDefaults({ program: 24, bassvol: 70, scale: 1.25 }, () => {
    const options = resolveAbcOptions(
      JSON.stringify({
        program: 40,
        bassvol: 0,
        scale: 2,
        chordvol: 999,
        qpm: 120,
        swing: 66.67,
        soundFontUrl: "https://example.invalid/",
        clickListener: "ignored",
        format: { gchordfont: "Arial 12", scale: 3, unsupported: "ignored" },
      }) + "\n---\nX:1\nK:C\nCDEF|",
      "96"
    );
    assert.equal(options.synth.program, 40);
    assert.equal(options.synth.bassvol, 0);
    assert.equal(options.synth.chordvol, 48);
    assert.equal(options.synth.qpm, 120);
    assert.equal(options.synth.defaultQpm, 96);
    assert.equal(options.visual.scale, 1, "the app's layout owns the notation size");
    assert.deepEqual(options.visual.format, { gchordfont: "Arial 12" });
    assert.equal(options.synth.soundFontUrl, undefined);
    assert.equal(options.visual.clickListener, undefined);
  });
});

test("scale directives in the ABC text cannot bypass the fixed scale, in any form abcjs accepts", async () => {
  const abcjs = await loadAbcjs();
  const parsedScale = (abc: string) => abcjs.parseOnly(abc)[0].formatting.scale;
  const forms = [
    "X:1\n%%scale 2\nK:C\nCDEF|",
    "X:1\n%%SCALE 2\nK:C\nCDEF|",
    "X:1\n%% scale 2 % comment\nK:C\nCDEF|",
    "X:1\n%%scale2\nK:C\nCDEF|",
    "X:1\nK:C\n%%scale 2\nCDEF|",
    // abcjs 6.6 ignores a column-0 `I:scale` line but honours an indented one.
    "X:1\nK:C\n  I:scale 2\nCDEF|",
    "X:1\nK:C\nAB [I:scale 2]CDEF|",
  ];
  for (const form of forms) {
    for (const header of ["", '{"program":24}\n---\n']) {
      const source = header + form;
      assert.equal(parsedScale(source), 2, `abcjs itself honours ${JSON.stringify(form)}`);
      const { abc } = resolveAbcOptions(source);
      assert.equal(abc.length, source.length);
      assert.equal(abc.indexOf("CDEF|"), source.indexOf("CDEF|"));
      assert.equal(parsedScale(abc), undefined, `${JSON.stringify(form)} is neutralised`);
    }
  }
  assert.equal(maskFixedDirectives("I:scale 2\n"), "I:       \n", "the column-0 field is masked too, should abcjs start honouring it");
  const inline = "X:1\nK:C\nAB[I:scale 2]cd|";
  assert.equal(parsedScale(inline), 2, "abcjs itself honours the inline field");
  // Blanking only the arguments keeps the field, so no whitespace separates (unbeams) B and c.
  assert.equal(maskFixedDirectives(inline), "X:1\nK:C\nAB[I:       ]cd|");
  assert.equal(parsedScale(maskFixedDirectives(inline)), undefined);
  const unrelated = "X:1\n%%staffwidth 300\n%%scalefoo 2\n%%%scale 2\nI:linebreak $\nK:C\nCDEF|";
  assert.equal(maskFixedDirectives(unrelated), unrelated);
});

test("MIDI export applies header instrument and tempo while Q: overrides the song's fallback tempo", async () => {
  await loadAbcjs();
  const { abc } = score('{"program":24,"qpm":120}\n---\nX:1\nM:4/4\nK:C\nCDEF|', "{tempo: 96}");
  const midi = abc.generateMidi(true) as Uint8Array;
  assert.ok(midi?.length > 0);
  const bytes = Buffer.from(midi);
  assert.ok(bytes.includes(Buffer.from([0xc0, 24])), "nylon guitar program reaches the MIDI track");
  assert.ok(bytes.includes(Buffer.from([0xff, 0x51, 0x03, 0x07, 0xa1, 0x20])), "120 BPM tempo event");
  const authored = score("X:1\nM:4/4\nQ:1/4=120\nK:C\nCDEF|", "{tempo: 96}").abc.generateMidi(true) as Uint8Array;
  assert.ok(Buffer.from(authored).includes(Buffer.from([0xff, 0x51, 0x03, 0x07, 0xa1, 0x20])));
});

test("MIDI export inherits accompaniment mute unless the caller explicitly overrides it", async () => {
  await loadAbcjs();
  const { abc } = score('{"chordsOff":true}\n---\nX:1\nM:4/4\nK:C\n"C"CDEF|');
  assert.deepEqual(abc.generateMidi(), abc.generateMidi(true));
  assert.notDeepEqual(abc.generateMidi(), abc.generateMidi(false));
});
