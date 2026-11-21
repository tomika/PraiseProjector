import assert from "node:assert/strict";
import { test } from "node:test";
import { IconType } from "../../IconService";
import { buildHelpTopics, searchHelp } from "../help";
import { appHelpSources } from "../helpSources";

test("help search distinguishes song preferences from saved favorite playlists", () => {
  const en = buildHelpTopics(appHelpSources, "en");
  const hu = buildHelpTopics(appHelpSources, "hu");

  for (const query of ["favorite song", "preferred song", "How do I mark a favorite song?"]) {
    assert.equal(searchHelp(en, query, 4)[0]?.id, "full/song-tree", query);
  }
  for (const query of ["kedvelt dal", "szív ikon", "sziv ikon"]) {
    assert.equal(searchHelp(hu, query, 4)[0]?.id, "full/song-tree", query);
  }
  assert.equal(searchHelp(en, "favorite playlist", 4)[0]?.id, "full/playlist");
  assert.equal(searchHelp(hu, "kedvenc műsortár", 4)[0]?.id, "full/playlist");
});

test("web help can include control icons while preserving the searchable text", () => {
  for (const language of ["en", "hu"] as const) {
    const plain = buildHelpTopics(appHelpSources, language);
    const illustrated = buildHelpTopics(appHelpSources, language, { includeIcons: true });
    assert.deepEqual(
      illustrated.map(({ lines: _lines, ...topic }) => topic),
      plain
    );
    assert.ok(plain.every((topic) => !Object.hasOwn(topic, "lines")));

    const songTree = illustrated.find((topic) => topic.id === "full/song-tree");
    assert.ok(songTree?.lines?.some((line) => line.icons?.includes(IconType.HEART_FILLED)));
    const toolbar = illustrated.find((topic) => topic.id === "buttons/toolbar");
    assert.ok(toolbar?.lines?.some((line) => line.icons?.includes(IconType.PRINT)));
  }
});
