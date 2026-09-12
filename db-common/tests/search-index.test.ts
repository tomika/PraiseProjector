import assert from "node:assert/strict";
import { test } from "node:test";
import { SongWords } from "../SongWords";
import { Song } from "../Song";
import { DamerauLevenshtein as DL } from "../DamerauLevenshtein";
import { StringExtensions } from "../StringExtensions";

test("infinite limits use the same case-aware edit costs as finite limits", () => {
  for (const [left, right] of [
    ["Isten", "isten"],
    ["Áldás", "Aldás"],
    ["Isten", "Itsen"],
    ["", "Isten"],
  ]) {
    for (const caseSensitive of [false, true]) {
      const unbounded = DL.accentedDamerauLevenshteinDistance(left!, right!, caseSensitive);
      assert.equal(DL.accentedDamerauLevenshteinDistanceBounded(left!, right!, Infinity, caseSensitive), unbounded);
      assert.equal(DL.accentedDamerauLevenshteinDistanceBounded(left!, right!, 100, caseSensitive), unbounded);
    }
  }
});

test("candidate buckets preserve matches with initial edits, short prefixes and accents", () => {
  const index = new SongWords();
  const words = [
    "Isten",
    "isten",
    "Itsen",
    "Xsten",
    "XIsten",
    "Iten",
    "I",
    "Is",
    "Áldás",
    "Aldás",
    "abc",
    "bac",
    "acb",
    "bcd",
    "a",
    "ab",
    "b",
    "xabc",
  ];
  for (const word of words) index.add(new Song(`{title: ${word}}`));
  for (const query of words) {
    for (const prefix of [false, true]) {
      for (const limit of [0, 0.9, 1, 1.5]) {
        const expected = words
          .filter((word) => {
            const target = prefix ? word.substring(0, query.length) : word;
            let cost = DL.accentedDamerauLevenshteinDistanceBounded(query, target, limit, true);
            if (prefix)
              cost = Math.min(
                cost,
                DL.accentedDamerauLevenshteinDistanceBounded(StringExtensions.toUnaccented(query), StringExtensions.toUnaccented(target), limit, true)
              );
            return cost <= limit;
          })
          .sort();
        const actual = [...new Set(index.caseSensitiveMatches(query, prefix, limit).map((p) => p.song.Title))].sort();
        assert.deepEqual(actual, expected, JSON.stringify({ query, prefix, limit }));
      }
    }
  }
});

test("large unrelated vocabularies do not trigger full-word case-sensitive distance calculations", (t) => {
  const index = new SongWords();
  for (let i = 0; i < 5000; i++) index.add(new Song(`{title: Zzz${i}}`));
  index.add(new Song("{title: Isten}"));
  const distance = t.mock.method(DL, "accentedDamerauLevenshteinDistanceBounded");
  assert.ok(index.caseSensitiveMatches("Istenx", true, 1.5).length > 0);
  const fullWordCalls = distance.mock.calls.filter((call) => call.arguments[3] === true).length;
  assert.ok(fullWordCalls < 10, `Expected bucket narrowing; got ${fullWordCalls} full-word comparisons`);
});

test("rebuilding an empty index invalidates previous matches", () => {
  const index = new SongWords();
  index.add(new Song("{title: Isten}"));
  const version = index.version;
  index.rebuild([]);
  assert.ok(index.version > version);
  assert.equal(index.caseSensitiveMatches("Isten", true, 1.5).length, 0);
});
