import assert from "node:assert/strict";
import { test } from "node:test";
import { cloudApi } from "../../../../../common/cloudApi";
import type { SongEntry, SongFound } from "../../../../../common/pp-types";
import { installFakeWindow } from "../../../../../tests/support/browserEnv";
import { createSongApi } from "../restPorts";
import type { RestCore } from "../RestCore";

for (const filter of [["hu"], [], null]) {
  test(`remote catalogue ignores the local language preference ${JSON.stringify(filter)}`, async (context) => {
    const env = installFakeWindow({ storage: { "pp-settings": JSON.stringify({ songLanguageFilter: filter }) } });
    context.after(env.restore);
    context.mock.method(cloudApi, "fetchAllSongs", async () => [
      { songId: "hu-song", title: "Hungarian", version: 1, language: "hu" },
      { songId: "en-song", title: "English", version: 1, songdata: { text: "English", system: "G", language: "en" } },
    ]);
    const emitted: SongEntry[][] = [];
    const api = createSongApi({ songListEvents: { emit: (songs: SongEntry[]) => emitted.push(songs) } } as unknown as RestCore);
    assert.deepEqual(
      (await api.listAllSongs()).map((song) => song.songId),
      ["en-song", "hu-song"]
    );
    assert.equal(emitted[0].length, 2);
  });
}

test("remote search sends no local language filter and preserves the server's results", async (context) => {
  const env = installFakeWindow({ storage: { "pp-settings": JSON.stringify({ songLanguageFilter: [] }) } });
  context.after(env.restore);
  const english: SongFound = { songId: "en", title: "English", language: "en", found: { type: "TITLE", cost: 0 } };
  const search = context.mock.method(cloudApi, "searchSongs", async () => [english, english]);
  const api = createSongApi({} as RestCore);
  assert.deepEqual(await api.searchSongs("English", { limit: 5 }), [english]);
  assert.deepEqual(search.mock.calls[0].arguments, ["English", 5, undefined]);
  await api.searchSongs("English", { songIds: ["en"] });
  assert.deepEqual(search.mock.calls[1].arguments, ["English", undefined, ["en"]]);
});
