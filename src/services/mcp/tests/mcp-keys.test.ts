/** Key estimate: the app's real key detector behind get_song, validate_chordpro and estimate_song_keys. */
import assert from "node:assert/strict";
import { test } from "node:test";
import { estimateSongKey } from "../songKey";
import { createMcpTools } from "../tools";
import { fakeHost, fakeState, song } from "./fakeHost";

const verse = (tag: string, chords: string) =>
  `{start_of_verse: ${tag}}\n${chords
    .split(" ")
    .map((chord) => `[${chord}]szó`)
    .join(" ")}\n{end_of_verse}`;

test("the estimate comes from the chords and is compared with the stated key", () => {
  assert.deepEqual(estimateSongKey(`{key: D}\n${verse("V", "D G A7 D")}`, "G"), {
    estimatedKey: "D",
    statedKey: "D",
    agreesWithStatedKey: true,
    statedKeyTonicUsed: true,
  });
  assert.deepEqual(estimateSongKey(`{key: C}\n${verse("V", "D G A7 D")}`, "G"), {
    estimatedKey: "D",
    statedKey: "C",
    agreesWithStatedKey: false,
    statedKeyTonicUsed: false,
  });
  assert.deepEqual(estimateSongKey(verse("V", "Am Dm E7 Am"), "G"), { estimatedKey: "Am", statedKey: "" });
  // Enharmonic spellings of the same key agree.
  assert.equal(estimateSongKey(`{key: F#}\n${verse("V", "Gb Cb Db7 Gb")}`, "S").agreesWithStatedKey, true);
  // A relative minor read as its major: the estimate disagrees, but the stated tonic chord is there.
  assert.deepEqual(estimateSongKey(`{key: Am}\n${verse("V", "C F G C Am")}`, "G"), {
    estimatedKey: "C",
    statedKey: "Am",
    agreesWithStatedKey: false,
    statedKeyTonicUsed: true,
  });
  assert.deepEqual(estimateSongKey("{key: G}\ncsak szöveg", "G"), { estimatedKey: null, statedKey: "G" });
});

test("a key change lists the key of every run of chords", () => {
  const estimate = estimateSongKey([verse("Verse 1", "C F G7 C"), verse("Verse 2", "D G A7 D"), verse("Verse 3 +2", "C F G7 C")].join("\n"), "G");
  assert.equal(estimate.estimatedKey, "C");
  assert.deepEqual(
    estimate.sectionKeys?.map(({ section, writtenKey, soundingKey, semitonesFromBase }) => [section, writtenKey, soundingKey, semitonesFromBase]),
    [
      ["Verse 1", "C", "C", 0],
      ["Verse 2", "D", "D", 2],
      ["Verse 3", "C", "D", 2],
    ]
  );
  assert.equal(estimate.sectionKeys?.[2].sectionTranspose, 2);
});

test("estimate_song_keys answers for several songs and refuses unknown ids", async () => {
  const state = fakeState();
  state.songs = [song("a", "Első", `{key: C}\n${verse("V", "D G A7 D")}`, "C"), song("b", "Második", verse("V", "Am Dm E7 Am"))];
  const host = fakeHost(state);
  const tool = createMcpTools({ strings: { en: {}, hu: {} }, help: { tutorials: [], tooltips: { en: {}, hu: {} } } }).find(
    (candidate) => candidate.name === "estimate_song_keys"
  )!;
  const result = (await tool.run({ songIds: ["a", "b", "a"] }, host)) as { songs: Record<string, unknown>[] };
  assert.deepEqual(result.songs, [
    { songId: "a", title: "Első", estimatedKey: "D", statedKey: "C", agreesWithStatedKey: false, statedKeyTonicUsed: false },
    { songId: "b", title: "Második", estimatedKey: "Am", statedKey: "" },
  ]);
  await assert.rejects(async () => tool.run({ songIds: ["nincs"] }, host));
});
