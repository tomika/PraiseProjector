import assert from "node:assert/strict";
import { beforeEach, test } from "node:test";
import { Database, SongOrder } from "../Database";
import { Song } from "../Song";

const db = Database.getInstance();
db.autoSave = false;
beforeEach(() => db.clear());

const abc = ["{start_of_abc}", "X:1", "K:G", "|: GABc [CEG] [K:D] {g}d2 :|", "w: la la la", "{end_of_abc}"];

function kind(...lines: string[]) {
  return new Song(lines.join("\n")).ContentKind;
}

test("lyrics without chords or notation are text-only", () => {
  assert.equal(kind("{title: Text}", "{artist: Someone}", "Plain lyrics", "Second line"), "text");
});

test("chords make a song music", () => {
  assert.equal(kind("{title: Chords}", "[G]Plain [D]lyrics"), "music");
});

test("an ABC block with nothing but metadata, directives and comments is a score", () => {
  assert.equal(kind("{title: Score}", "{key: G}", "# notes: check", "{c: twice}", "{start_of_verse}", ...abc, "{end_of_verse}"), "score");
  // Bracket tags in a directive are chords (as before) but still not content.
  assert.equal(kind("{title: Score}", "{c: Intro [G] [D]}", ...abc), "score");
});

test("labelled, multiple and unterminated ABC blocks are still score-only", () => {
  assert.equal(kind("{title: Score}", "{start_of_abc: Melody}", "X:1", "K:C", "CDEF|", "{end_of_abc}", ...abc), "score");
  assert.equal(kind("{title: Score}", "{start_of_abc}", "X:1", "K:C", "CDEF|"), "score");
});

test("ABC content is never read as ChordPro: envelopes, grace notes and bracket chords", () => {
  assert.equal(kind("{title: Score}", "{start_of_abc}", '{"staffwidth": 500}', "---", "X:1", "K:C", "{g}C [CEG]|", "{end_of_abc}"), "score");
});

test("ABC notation with lyrics or other content lines is music, even without chords", () => {
  assert.equal(kind("{title: Mixed}", ...abc, "Plain lyrics"), "music");
  assert.equal(kind("{title: Mixed}", "Plain lyrics", ...abc), "music");
});

test("songs without ABC keep the bracket-anywhere chord rule", () => {
  assert.equal(kind("{title: Song}", "{c: Intro [G] [D]}", "Plain lyrics"), "music");
  assert.equal(kind("{title: Song [live]}", "Plain lyrics"), "music");
  // Pre-existing limitation: bare grid chords are not bracket tags.
  assert.equal(kind("{title: Song}", "{start_of_grid}", "| G . . . | D . . . |", "{end_of_grid}", "Plain lyrics"), "text");
});

test("classification does not depend on the previously parsed song", () => {
  assert.equal(kind("{title: Late chord}", "Long plain lyrics line before the chord [G]here"), "music");
  assert.equal(kind("[G]Early"), "music");
  assert.equal(kind("{title: Score}", "{start_of_abc}", "X:1", "K:C", "[CEG]|", "{end_of_abc}"), "score");
  assert.equal(kind("[G]Early"), "music");
});

test("editing reclassifies the song", () => {
  const song = new Song(["{title: Score}", ...abc].join("\n"));
  assert.equal(song.ContentKind, "score");
  song.updateChordProText([song.Text, "Added lyrics"].join("\n"));
  assert.equal(song.ContentKind, "music");
});

test("chord, text-only and score-only filters partition the songs", async () => {
  const text = new Song("{title: Text}\nPlain lyrics");
  const music = new Song("{title: Music}\n[G]Plain lyrics");
  const mixed = new Song(["{title: Mixed}", ...abc, "Plain lyrics"].join("\n"));
  const score = new Song(["{title: Score}", ...abc].join("\n"));
  for (const song of [text, music, mixed, score]) db.addSong(song);

  const titles = async (withChords: boolean, textOnly: boolean, scoreOnly: boolean) =>
    Array.from(await db.filter("", null, withChords, textOnly, scoreOnly, true, SongOrder.Alphabetical), (found) => found.song.Title);

  assert.deepEqual(await titles(true, false, false), ["Mixed", "Music"]);
  assert.deepEqual(await titles(false, true, false), ["Text"]);
  assert.deepEqual(await titles(false, false, true), ["Score"]);
  assert.deepEqual(await titles(true, true, true), ["Mixed", "Music", "Score", "Text"]);
  assert.deepEqual(await titles(true, false, true), ["Mixed", "Music", "Score"]);
});

test("marked-only filtering lists marked songs of every content kind", async () => {
  for (const text of ["{title: Marked text}\nPlain lyrics", "{title: Marked music}\n[G]Plain lyrics", ["{title: Marked score}", ...abc].join("\n")]) {
    const marked = new Song(text);
    marked.Notes = "check";
    db.addSong(marked);
  }
  db.addSong(new Song("{title: Unmarked}\n[G]Plain lyrics"));

  const found = await db.filter("", null, false, false, false, true, SongOrder.Alphabetical);
  assert.deepEqual(
    Array.from(found, (item) => item.song.Title),
    ["Marked music", "Marked score", "Marked text"]
  );
  // With any content toggle on, the content toggles apply to marked songs too.
  const markedScores = await db.filter("", null, false, false, true, true, SongOrder.Alphabetical);
  assert.deepEqual(
    Array.from(markedScores, (item) => item.song.Title),
    ["Marked score"]
  );
  // Unchecking "marked" hides marked songs in every other combination.
  const unmarked = await db.filter("", null, true, true, true, false, SongOrder.Alphabetical);
  assert.deepEqual(
    Array.from(unmarked, (item) => item.song.Title),
    ["Unmarked"]
  );
});
