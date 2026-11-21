import assert from "node:assert/strict";
import { test } from "node:test";
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
