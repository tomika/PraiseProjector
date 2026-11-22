import assert from "node:assert/strict";
import { test } from "node:test";
import { cloudApi } from "../../../../../common/cloudApi";
import { getEmptyDisplay } from "../../../../../common/pp-utils";
import { RestCore } from "../RestCore";
import { createPlaylistApi } from "../restPorts";

test("transition saves publish the current instructions with the playlist and surface cloud rejections", async (t) => {
  const core = new RestCore();
  core.leader = { id: "leader", name: "Leader" };
  t.mock.method(core, "canControlDisplay", () => true);
  core.setDisplay({
    ...getEmptyDisplay(),
    songId: "next",
    from: 2,
    to: 3,
    section: 2,
    sectionRepeatNonce: 5,
    playlist: [{ songId: "next", title: "Next", instructions: "Verse" }],
    instructions: "Verse",
  });
  const api = createPlaylistApi(core);
  const request = t.mock.method(cloudApi, "sendDisplayUpdate", async () => "UNAUTHORIZED");
  await assert.rejects(
    api.setEntryInstructions("next", "New instructions", () => true),
    /UNAUTHORIZED/
  );
  assert.equal(core.getPlaylist()[0].instructions, "Verse");
  assert.equal(core.getDisplay().section, 2);
  request.mock.mockImplementation(async () => "DONE");
  await api.setEntryInstructions("next", "New instructions", () => true);
  const sent = request.mock.calls[1]?.arguments[0];
  assert.ok(sent?.playlist);
  assert.equal(sent.playlist[0].instructions, "New instructions");
  assert.equal(sent.instructions, "New instructions");
  assert.equal(sent.section, undefined);
  assert.equal(sent.from, 2);
  assert.equal(core.getDisplay().instructions, "New instructions");
  assert.equal(core.getDisplay().section, undefined);
  assert.equal(core.getDisplay().sectionRepeatNonce, undefined);
});
