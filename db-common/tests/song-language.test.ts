import assert from "node:assert/strict";
import { beforeEach, test } from "node:test";
import { Database } from "../Database";
import { Song } from "../Song";
import { decode } from "../../common/io-utils";
import { songUpdateCodec } from "../../common/pp-codecs";
import { matchesSongLanguage, normalizeSongLanguageFilter, SONG_LANGUAGE_CODES, SONG_LANGUAGE_COUNTRIES } from "../../common/song-language";

const db = Database.getInstance();
db.autoSave = false;
beforeEach(() => db.clear());

function song(language = "hu", version = 10) {
  const value = new Song("{title: Same song}\nShared lyrics", "G", undefined, language);
  value.version = version;
  return value;
}

test("legacy songs default to Hungarian; clone and JSON retain explicit language", () => {
  const original = song("en");
  assert.equal(original.clone().Language, "en");
  assert.equal(Song.fromJSON(JSON.parse(JSON.stringify(original))).Language, "en");
  const legacy = original.toJSON();
  delete legacy.songdata.language;
  assert.equal(Song.fromJSON(legacy).Language, "hu");
  assert.equal(original.ToUpdate().songdata.language, "en");
});

test("wire decoding preserves an omitted language and validates explicit language", () => {
  const legacy = decode(songUpdateCodec, { songId: "song", songdata: { text: "test", system: "G" } });
  assert.equal(legacy.songdata.language, undefined);
  const update = decode(songUpdateCodec, { songId: "song", songdata: { text: "test", system: "G", language: " EN " } });
  assert.equal(update.songdata.language, "en");
  assert.throws(() => decode(songUpdateCodec, { songId: "song", songdata: { text: "test", system: "G", language: "invalid" } }));
});

test("language-only editing remains dirty until reverted, including backup restoration", () => {
  const original = song();
  db.addSong(original);
  const edited = original.clone();
  edited.Language = "en";
  assert.equal(edited.version, 0);
  assert.equal(edited.hasSameContent(original), false);
  db.updateSong(edited);
  assert.equal(db.countUpdatedSongs(), 1);
  assert.equal(db.getBackupSong(original.Id)?.song.Language, "hu");
  const reverted = edited.clone();
  reverted.Language = "hu";
  db.updateSong(reverted);
  assert.equal(reverted.version, original.version);
  assert.equal(db.countUpdatedSongs(), 0);
});

test("language filters apply to browsing and search without changing the sync/upload set", async () => {
  const hu = song("hu", 0);
  const en = song("en", 0);
  db.addSong(hu);
  db.addSong(en);
  const filter = (query: string, languages: string[] | null) =>
    db.filter(query, null, true, true, true, true, 0, {
      typesenseUrl: "",
      typesenseApiKey: "",
      useTextSimilarities: false,
      songLanguageFilter: languages,
    });
  assert.deepEqual(
    Array.from(await filter("", ["hu"]), (found) => found.song.Id),
    [hu.Id]
  );
  assert.deepEqual(
    Array.from(await filter("Shared", ["en"]), (found) => found.song.Id),
    [en.Id]
  );
  assert.equal((await filter("", null)).length, 2);
  assert.equal((await filter("Shared", [])).length, 0);
  assert.equal((await filter("", ["de"])).length, 0);
  assert.equal(db.getSongs().length, 2);
  assert.equal(db.getUpdatedSongs().length, 2);
});

test("guest synchronization detects a language-only conflict and retains the local change", async () => {
  const local = song("en", 0);
  db.addSong(local);
  const remote = { ...local.toJSON(), title: local.Title, version: 20, songdata: { ...local.ToUpdate().songdata, language: "de" } };
  // Exercise the same merge method used by the unauthenticated download path.
  const merge = db as unknown as {
    mergeSongsWithConflicts: (songs: (typeof remote)[], mode: "select") => { conflicts: { localSong: Song; serverSong: Song }[] };
  };
  const result = merge.mergeSongsWithConflicts([remote], "select");
  assert.equal(result.conflicts.length, 1);
  assert.equal(result.conflicts[0]?.serverSong.Language, "de");
  assert.equal(db.getSong(local.Id)?.Language, "en");
});

test("accepting a server language replaces the old backup before the next local edit", () => {
  const original = song("hu", 10);
  db.addSong(original);
  const local = original.clone();
  local.Language = "en";
  db.updateSong(local);
  db.setSong(local.clone());
  assert.equal(db.getBackupSong(local.Id)?.song.Language, "hu");

  const remote = local.clone();
  remote.Language = "de";
  remote.version = 20;
  db.setSong(remote);
  assert.equal(db.getBackupSong(local.Id), undefined);

  const edited = remote.clone();
  edited.Language = "fr";
  db.updateSong(edited);
  assert.equal(db.getBackupSong(local.Id)?.song.Language, "de");
  edited.Language = "de";
  db.updateSong(edited);
  assert.equal(edited.version, 20);
  assert.equal(db.countUpdatedSongs(), 0);
});

for (const conflictMode of ["overwrite", "select"] as const) {
  test(`guest sync clears the previous backup when accepting ${conflictMode === "overwrite" ? "a conflicting" : "an identical"} server version`, () => {
    const original = song("hu", 10);
    db.addSong(original);
    const local = original.clone();
    local.Language = "en";
    db.updateSong(local);
    const remote = {
      ...local.toJSON(),
      title: local.Title,
      version: 20,
      songdata: { ...local.ToUpdate().songdata, language: conflictMode === "overwrite" ? "de" : "en" },
    };
    const merge = db as unknown as {
      mergeSongsWithConflicts: (songs: (typeof remote)[], mode: typeof conflictMode) => { updated: number };
    };
    assert.equal(merge.mergeSongsWithConflicts([remote], conflictMode).updated, 1);
    assert.equal(db.getSong(local.Id)?.version, 20);
    assert.equal(db.getBackupSong(local.Id), undefined);
  });
}

test("language selection distinguishes all, none, malformed settings and outside-filter choices", () => {
  assert.equal(normalizeSongLanguageFilter(undefined), null);
  assert.equal(normalizeSongLanguageFilter("hu"), null);
  assert.deepEqual(normalizeSongLanguageFilter(["HU", "en", "hu", "invalid"]), ["hu", "en"]);
  assert.equal(normalizeSongLanguageFilter(null), null);
  assert.deepEqual(normalizeSongLanguageFilter([]), []);
  assert.equal(matchesSongLanguage("en", ["hu"]), false);
  assert.equal(matchesSongLanguage("en", null), true);
  assert.equal(new Set(SONG_LANGUAGE_CODES).size, SONG_LANGUAGE_CODES.length);
  assert.ok(SONG_LANGUAGE_CODES.every((code) => /^[a-z]{2}$/.test(code)));
  assert.equal(SONG_LANGUAGE_COUNTRIES.hu, "hu");
});
