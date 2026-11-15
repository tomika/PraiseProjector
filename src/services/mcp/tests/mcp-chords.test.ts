/** Chords, metadata and song problems: the app's real chord code behind the MCP tools. */
import assert from "node:assert/strict";
import { test } from "node:test";
import { chordStatus, gridChords, importerChord, importerConventions, knownChordTypes } from "../appChords";
import { chordsOf, gridLinesOf, songDirectives, songKeyDirective, songMetadata } from "../songMeta";
import { checkChords, findSongProblems, gridText, lyricsOf, querySongs, SONG_PROBLEMS, songChords } from "../tools";
import { fakeHost, fakeState, song } from "./fakeHost";

test("recognized, chord-shaped and not-a-chord are three different things, and depend on the chord system", () => {
  for (const chord of ["C", "F#m7", "Asus", "Em7", "E/G#", "Cdim", "Caug", "Cmaj7", "D7sus4", "Cadd9"]) {
    assert.equal(chordStatus(chord, "G"), "recognized", chord);
    assert.equal(chordStatus(chord, "S"), "recognized", chord);
  }
  // H exists only in the German/Hungarian system.
  for (const chord of ["Hm", "H7", "G/H"]) {
    assert.equal(chordStatus(chord, "G"), "recognized", chord);
    assert.equal(chordStatus(chord, "S"), "chord-shaped", chord);
  }
  // Stored and shown as written, but unknown to the app.
  for (const chord of ["fisz", "#Fm", "Esz", "N.C.", "C(add9)", "(D)"]) assert.equal(chordStatus(chord, "G"), "chord-shaped", chord);
  for (const chord of ["", "x2", "|"]) assert.equal(chordStatus(chord, "G"), "not-a-chord", JSON.stringify(chord));
});

test("the import wizard reads more spellings than the app, fewer chord types, and writes German notation", () => {
  // Source spellings the app itself does not recognize become recognized chords.
  for (const [written, result] of [
    ["fisz", "F#m"],
    ["#Fm", "F#m"],
    ["Fism", "F#m"],
    ["Esz", "Eb"],
    ["a", "Am"],
  ]) {
    assert.equal(importerChord(written, true, true), result, written);
    assert.equal(chordStatus(result, "G"), "recognized", result);
  }
  // A source in standard notation is converted: B → H, Bb → B.
  assert.equal(importerChord("B", false, false), "H");
  assert.equal(importerChord("Bb", false, false), "B");
  assert.equal(importerChord("B", true, false), "B");
  // Chords the app knows but the wizard's normalizer does not handle: they stay as written.
  for (const chord of ["Cdim", "Caug", "C°"]) {
    assert.equal(importerChord(chord, true, true), "", chord);
    assert.equal(chordStatus(chord, "G"), "recognized", chord);
  }
  assert.deepEqual(importerConventions(["H", "A"]), { sourceUsesH: 1, lowercaseIsMinor: 0 });
  assert.equal(importerConventions(["B", "A"]).sourceUsesH, -1);
  assert.equal(importerConventions(["a", "D"]).lowercaseIsMinor, 1);
});

test("chord types come with the suffixes that select them", () => {
  const types = knownChordTypes();
  assert.ok(types.length > 40);
  const suffixes = new Set(types.flatMap((type) => type.suffixes));
  for (const suffix of ["", "m", "7", "m7", "maj7", "sus4", "dim"]) assert.ok(suffixes.has(suffix), JSON.stringify(suffix));
  for (const type of types.slice(0, 20)) {
    for (const suffix of type.suffixes) assert.equal(chordStatus(`C${suffix}`, "G"), "recognized", `C${suffix}`);
  }
});

test("check_chords answers both questions for every chord", () => {
  const report = checkChords(fakeHost(fakeState()), ["fisz", "Cdim", "Hm", "x2"], "S");
  assert.equal(report.importer.sourceUsesH, true);
  const byChord = Object.fromEntries(report.chords.map((entry) => [entry.chord, entry]));
  assert.equal(byChord.fisz.status, "chord-shaped");
  assert.deepEqual(byChord.fisz.importer, { becomes: "F#", status: "recognized" });
  assert.equal(byChord.Cdim.status, "recognized");
  assert.match(String(byChord.Cdim.importer), /not handled/);
  assert.equal(byChord.Hm.status, "chord-shaped");
  assert.equal(byChord.x2.status, "not-a-chord");
  // Ambiguous B: follows the chord system unless the caller says how the source writes it.
  assert.equal(checkChords(fakeHost(fakeState()), ["B", "A"], "S").importer.sourceUsesH, false);
  assert.equal(checkChords(fakeHost(fakeState()), ["B", "A"], "S", { sourceUsesH: true }).importer.howDecided.sourceUsesH, "given");
});

test("metadata is read with its names, outside score blocks", () => {
  const text =
    "{t: Cím}\n{artist: Hillsong Worship}\n{artist: Pintér Béla}\n{key: Hm}\n{start_of_chorus: Refr.}\n[G]szöveg [x2]\n{end_of_chorus}\n{start_of_abc}\n{title: nem}\n[CEG]\n{end_of_abc}\n{key: D}";
  assert.deepEqual(songMetadata(text), { title: "Cím", artist: "Hillsong Worship; Pintér Béla", key: "Hm; D" });
  assert.equal(songKeyDirective(text), "Hm");
  assert.deepEqual(chordsOf(text), ["G", "x2"]);
  assert.equal(songDirectives("{comment: hello}\n{c: x}").length, 0);
});

test("grid blocks hold chords without brackets; they are neither lyrics nor bracketed chords", () => {
  const text = [
    "{title: Rács}",
    "{start_of_verse: 1}",
    "[G]Első [D]sor",
    "{end_of_verse}",
    "{start_of_grid: Intro}",
    "| G . D/F# | Em7 / C | x2",
    "Hm Fisz | Refr",
    "{end_of_grid}",
    "{sot}",
    "e|--3--|",
    "{eot}",
    "[C]Utolsó",
  ].join("\n");
  assert.deepEqual(lyricsOf(text), ["Első sor", "Utolsó"]);
  assert.deepEqual(chordsOf(text), ["G", "D", "C"]);
  assert.deepEqual(gridLinesOf(text), ["| G . D/F# | Em7 / C | x2", "Hm Fisz | Refr"]);

  // The app's own chord finder: separators, a lone slash and repeat marks are not reported.
  assert.deepEqual(gridChords("| G . D/F# | Em7 / C | x2", "G"), { chords: ["G", "D/F#", "Em7", "C"], other: [] });
  assert.deepEqual(gridChords("(Am) Cmaj7 - F G/H %", "G"), { chords: ["Am", "Cmaj7", "F", "G/H"], other: [] });
  // The finder also matches letters inside words ("Fis" in Fisz, "B", "dg", "e" in Bridge):
  // such words are not chords, the app would transpose them letter by letter.
  assert.deepEqual(gridChords("Hm Fisz | Refr", "G"), { chords: ["Hm"], other: ["Fisz", "Refr"] });
  assert.deepEqual(gridChords("Intro: G (2x) Bridge", "G"), { chords: ["G"], other: ["Intro", "Bridge"] });
  // H is not a note in the standard system.
  assert.deepEqual(gridChords("Hm G", "S"), { chords: ["G"], other: ["Hm"] });
  assert.deepEqual(gridChords("", "G"), { chords: [], other: [] });

  const host = fakeHost(fakeState());
  assert.deepEqual(songChords(host, text, "G"), ["G", "D", "C", "D/F#", "Em7", "Hm"]);
  assert.deepEqual(gridText(host, text, "G"), ["Fisz", "Refr"]);
});

test("songs with problems are found and counted", () => {
  const state = fakeState();
  state.songs = [
    song("ok", "Rendben", "{key: G}\n[G]Minden [D]jó", "G"),
    song("u", "Ismeretlen", "{key: A}\n[fisz]sor [N.C.]sor [A]", "A"),
    song("b", "Hibás", "[x2]sor []sor [D]"),
    song("t", "", "{key: C}\n[C]szöveg", "C"),
    song("e", "Üres", "{key: C}"),
    song("g", "Rácsos", "{key: G}\n[G]szöveg\n{start_of_grid}\n| G | D | Bridge | C |\n{end_of_grid}", "G"),
  ];
  const all = { offset: 0, limit: 10 };
  const report = findSongProblems(fakeHost(state), SONG_PROBLEMS, all);
  assert.equal(report.songsScanned, 6);
  assert.deepEqual(report.songsWithProblems, {
    "unrecognized-chords": 1,
    "not-a-chord": 1,
    "grid-text": 1,
    "missing-key": 1,
    "missing-title": 1,
    "no-lyrics": 1,
  });
  const byId = Object.fromEntries(report.songs.map((entry) => [entry.song.id, entry.problems]));
  assert.deepEqual(byId.u, { "unrecognized-chords": ["fisz", "N.C."] });
  assert.deepEqual(byId.b, { "not-a-chord": ["[x2]", "[]"], "missing-key": true });
  assert.deepEqual(byId.g, { "grid-text": ["Bridge"] });
  assert.deepEqual(Object.keys(byId).sort(), ["b", "e", "g", "t", "u"]);
  assert.deepEqual(report.mostUsedUnrecognizedChords, [
    { chord: "fisz", songs: 1 },
    { chord: "N.C.", songs: 1 },
  ]);
  assert.equal(findSongProblems(fakeHost(state), ["missing-key"], all).songs.length, 1);
  // Pages follow the title order and do not overlap.
  const first = findSongProblems(fakeHost(state), SONG_PROBLEMS, { offset: 0, limit: 2 });
  const second = findSongProblems(fakeHost(state), SONG_PROBLEMS, { offset: 2, limit: 10 });
  assert.equal(first.nextOffset, 2);
  assert.equal(second.nextOffset, null);
  assert.deepEqual(
    [...first.songs, ...second.songs].map((entry) => entry.song.id),
    report.songs.map((entry) => entry.song.id)
  );
});

test("a problem scan stopped by its time budget goes on where it stopped when called again", () => {
  const state = fakeState();
  const host = fakeHost(state);
  const cache = new Map();
  let clock = 0;
  const slow = () => (clock += 3000);
  const calls: ReturnType<typeof findSongProblems>[] = [];
  do calls.push(findSongProblems(host, SONG_PROBLEMS, { offset: 0, limit: 10 }, slow, cache));
  while (calls.at(-1)!.incomplete && calls.length < 10);
  assert.match(calls[0].incomplete ?? "", /time budget[\s\S]*goes on where it stopped/);
  assert.equal(calls[0].nextOffset, null);
  const last = calls.at(-1)!;
  assert.equal(last.incomplete, undefined);
  assert.equal(last.songsScanned, state.songs.length);
  assert.deepEqual(last, findSongProblems(host, SONG_PROBLEMS, { offset: 0, limit: 10 }));
  // A changed song is checked again.
  state.songs[0] = { ...state.songs[0], text: "[fisz]" };
  assert.ok(findSongProblems(host, SONG_PROBLEMS, { offset: 0, limit: 10 }, Date.now, cache).songs.some((entry) => entry.song.id === "s1"));
});

test("songs of two artists by their metadata, in title order and in pages", () => {
  const state = fakeState();
  const by = (id: string, title: string, artist: string) => song(id, title, `{title: ${title}}\n{artist: ${artist}}\n[G]szöveg`);
  state.songs = [
    by("h1", "Óceánok", "Hillsong United"),
    by("h2", "Régi Hillsong", "Hillsong Worship"),
    by("p1", "Homokba írva", "Pintér Béla"),
    by("x1", "Más", "Valaki Más"),
    song("n1", "Hillsong cím nélkül", "{artist: Hillsong}\n[G]szöveg"),
  ];
  const host = fakeHost(state);
  const found = querySongs(host, { meta: "hillsong|pinter bela" });
  assert.deepEqual(
    found.songs.map((entry) => entry.song.id),
    ["n1", "p1", "h1", "h2"]
  );
  assert.deepEqual(found.songs[2].matched, ["artist: Hillsong United"]);
  assert.equal(found.total, 4);
  assert.equal(found.nextOffset, null);

  const page = querySongs(host, { meta: "hillsong|pinter bela", limit: 3 });
  assert.deepEqual([page.returned, page.nextOffset], [3, 3]);
  assert.deepEqual(
    querySongs(host, { meta: "hillsong|pinter bela", limit: 3, offset: 3 }).songs.map((entry) => entry.song.id),
    ["h2"]
  );
  // A field narrows where to look.
  assert.equal(querySongs(host, { meta: "hillsong", field: "title" }).total, 2);
  assert.equal(querySongs(host, { hasKey: true }).total, 0);
  assert.throws(() => querySongs(host, { meta: "(a+)+" }), /freeze/);
  assert.throws(() => querySongs(host, { offset: -1 }), /offset/);
});
