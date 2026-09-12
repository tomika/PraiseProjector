import assert from "node:assert/strict";
import { beforeEach, test } from "node:test";
import { Database, DatabaseSettings, FoundReason, SongOrder } from "../Database";
import { Song } from "../Song";
import { Leader } from "../Leader";

const db = Database.getInstance();
db.autoSave = false;

beforeEach(() => {
  for (const song of db.getSongs()) db.removeSong(song.Id);
});

function add(title: string, lyrics = "", metadata = "") {
  const song = new Song(`{title: ${title}}\n${metadata}\n${lyrics}`);
  db.addSong(song);
  return song;
}

function search(query: string, settings: Partial<DatabaseSettings> = {}) {
  return db.filter(query, null, true, true, true, SongOrder.Alphabetical, {
    typesenseUrl: "",
    typesenseApiKey: "",
    searchMethod: "traditional",
    useTextSimilarities: false,
    ...settings,
  });
}

for (const traditionalSearchWholeWords of [false, true]) {
  for (const traditionalSearchCaseSensitive of [false, true]) {
    for (const useTextSimilarities of [false, true]) {
      const settings = { traditionalSearchWholeWords, traditionalSearchCaseSensitive, useTextSimilarities };
      test(`search toggle combination ${JSON.stringify(settings)}`, async () => {
        add("Isten");
        assert.equal((await search("Isten", settings)).length, 1);
        assert.equal((await search("isten", settings)).length, traditionalSearchCaseSensitive ? 0 : 1);
        assert.equal((await search("Istenx", settings)).length, useTextSimilarities ? 1 : 0);
        assert.equal((await search("Istenx ", settings)).length, useTextSimilarities ? 1 : 0);
        assert.equal((await search("Is", settings)).length, traditionalSearchWholeWords ? 0 : 1);
      });
    }
  }
}

test("case-sensitive search finds lyrics even when the title has the wrong case", async () => {
  const song = add("isten", "Isten");
  const results = await search("Isten", { traditionalSearchCaseSensitive: true });
  assert.equal(results.length, 1);
  assert.equal(results[0]?.song.Id, song.Id);
  assert.notEqual(results[0]?.reason, FoundReason.Title);
});

test("case-sensitive search checks the actual word occurrence", async () => {
  add("isten xIsten");
  assert.equal((await search("Isten", { traditionalSearchCaseSensitive: true })).length, 0);
});

test("case-sensitive fuzzy matching tolerates typos and accents but not case-only changes", async () => {
  add("Áldás");
  const settings = { traditionalSearchCaseSensitive: true, useTextSimilarities: true, traditionalSearchWholeWords: true };
  for (const query of ["Áldás", "Aldás", "Áldsá"]) {
    assert.equal((await search(query, settings)).length, 1, query);
  }
  for (const query of ["áldás", "aldás", "ÁLDÁS"]) {
    assert.equal((await search(query, settings)).length, 0, query);
  }
});

test("words can match across title, lyrics and metadata with constraints enabled", async () => {
  add("Áld", "Erő", "{artist: Szerző}");
  assert.equal((await search("Szerző", { traditionalSearchCaseSensitive: true })).length, 1);
  assert.equal((await search("Áld Erő Szerző ", { traditionalSearchCaseSensitive: true, traditionalSearchWholeWords: true })).length, 1);
});

test("whole words handle accented boundaries, punctuation and decomposed Unicode", async () => {
  add("Áld Erő");
  for (const query of ["Áld", "Áld ", "Erő", "Erő ", "Áld, Erő!", "A\u0301ld "]) {
    assert.equal((await search(query, { traditionalSearchWholeWords: true })).length, 1, query);
  }
  assert.equal((await search("Er", { traditionalSearchWholeWords: true })).length, 0);
});

test("unknown query terms cannot be dropped, regardless of their position", async () => {
  add("Isten");
  for (const useTextSimilarities of [false, true]) {
    for (const query of ["Isten qzxqzx ", "qzxqzx Isten", "Isten qzxqzx Isten", "qzxqzx", "!!!"]) {
      assert.equal((await search(query, { useTextSimilarities })).length, 0, query);
    }
  }
});

test("switching settings invalidates cached results and preserves prefix versus whole-word behavior", async () => {
  add("Isten");
  for (const useTextSimilarities of [false, true, false]) {
    assert.equal((await search("Istenx", { useTextSimilarities })).length, useTextSimilarities ? 1 : 0);
  }
  for (const traditionalSearchCaseSensitive of [false, true, false]) {
    assert.equal((await search("isten", { traditionalSearchCaseSensitive })).length, traditionalSearchCaseSensitive ? 0 : 1);
  }
  assert.equal((await search("Is")).length, 1);
  assert.equal((await search("Is ")).length, 0);
});

test("case-preserving word positions are removed and rebuilt with the index", async () => {
  const song = add("Isten");
  assert.equal((await search("Isten", { traditionalSearchCaseSensitive: true })).length, 1);
  db.removeSong(song.Id);
  add("isten");
  assert.equal((await search("Isten", { traditionalSearchCaseSensitive: true })).length, 0);
  db.words.rebuild(db.getSongs());
  assert.equal(db.words.caseSensitiveMatches("Isten", false, 0).length, 0);
  assert.ok(db.words.caseSensitiveMatches("isten", false, 0).length > 0);
});

test("snippets highlight only accepted case-sensitive positions", async () => {
  add("isten Isten");
  const results = await search("Isten", { traditionalSearchCaseSensitive: true });
  assert.equal(results[0]?.snippet, "isten <mark>Isten</mark>");
});

test("snippets obey whole-word and similarity switches", async () => {
  add("Isteni Istenx Isten");
  const results = await search("Isten", { traditionalSearchWholeWords: true });
  assert.equal(results[0]?.snippet, "Isteni Istenx <mark>Isten</mark>");
});

test("snippets use matched lyric and metadata positions with Unicode and HTML escaping", async () => {
  const song = add("different", "isten <Isten>", "{artist: isten Isten}");
  const results = await search("Isten", { traditionalSearchCaseSensitive: true });
  assert.equal(results[0]?.song.Id, song.Id);
  assert.match(results[0]?.snippet ?? "", /^isten &lt;<mark>Isten<\/mark>&gt;/);
  db.removeSong(song.Id);
  add("different", "", "{artist: isten Isten}");
  assert.match((await search("Isten", { traditionalSearchCaseSensitive: true }))[0]?.snippet ?? "", /: isten <mark>Isten<\/mark>$/);
});

test("a scattered match is highlighted in the region that actually holds the words", async () => {
  add("alpha beta gamma", "delta epsilon");
  const results = await search("alpha gamma ");
  assert.equal(results.length, 1);
  assert.equal(results[0]?.snippet, "<mark>alpha</mark> beta <mark>gamma</mark>");
});

test("an accepted song is never rendered without a highlight", async () => {
  add("alpha beta gamma", "delta epsilon", "{artist: zeta}");
  for (const query of ["alpha gamma ", "alpha zeta ", "delta zeta ", "alpha delta zeta "]) {
    const results = await search(query);
    assert.equal(results.length, 1, query);
    assert.match(results[0]?.snippet ?? "", /<mark>/, query);
  }
});

test("filter cache keys cannot collide across expression and leader boundaries", async () => {
  add("Isten");
  const settings = { typesenseUrl: "", typesenseApiKey: "", searchMethod: "traditional" as const, useTextSimilarities: false };
  const withLeader = await db.filter("Isten", new Leader("x", "X"), true, true, true, SongOrder.Alphabetical, settings);
  assert.equal(withLeader.length, 1);
  // Guards the key separators: joined without them, "Isten" + "x" and "Istenx" + "" would
  // produce the same key and this would be served from the cached result above.
  assert.equal((await search("Istenx")).length, 0);
});
