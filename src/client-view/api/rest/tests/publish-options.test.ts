import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import { cloudApi } from "../../../../../common/cloudApi";
import { RestCore } from "../RestCore";
import { createDisplayApi, createPlaylistApi } from "../restPorts";

const ENTRIES = [{ songId: "song", title: "Song" }];

function signedInCore(t: TestContext) {
  const core = new RestCore();
  core.leader = { id: "leader", name: "Leader" };
  t.mock.method(core, "canControlDisplay", () => true);
  t.mock.method(core, "loadSongData", async () => ({ text: "{title:Song}", system: "G" }));
  const send = t.mock.method(cloudApi, "sendDisplayUpdate", async () => "DONE");
  return { core, send };
}

test("an unpublished working-list write stays on this client", async (t) => {
  const { core, send } = signedInCore(t);
  const playlist = createPlaylistApi(core);
  await playlist.setPlaylist(ENTRIES, { publish: false });
  assert.deepEqual(core.getPlaylist(), ENTRIES);
  assert.equal(send.mock.callCount(), 0);
  await playlist.setPlaylist(ENTRIES);
  assert.equal(send.mock.callCount(), 1, "a normal write still reaches the session");
});

test("an unpublished projection changes only this client's display", async (t) => {
  const { core, send } = signedInCore(t);
  const display = createDisplayApi(core);
  await display.project({ songId: "song", transpose: 2 }, { publish: false });
  assert.equal(core.getDisplay().songId, "song");
  assert.equal(core.getDisplay().transpose, 2);
  assert.equal(send.mock.callCount(), 0);
  await display.project({ songId: "song" });
  assert.equal(send.mock.callCount(), 2, "a normal projection reaches the session, after the pending state");
});

const SHARED = [
  { songId: "song", title: "Song", transpose: 2, capo: 1, instructions: "Verse" },
  { songId: "next", title: "Next" },
];

/** A shared list opened locally (publish:false), as ClientViewStore does on entry. */
async function openedUnpublished(t: TestContext) {
  const { core, send } = signedInCore(t);
  await createPlaylistApi(core).setPlaylist(SHARED, { publish: false });
  await createDisplayApi(core).project({ songId: "song", transpose: 2, capo: 1, instructions: "Verse" }, { publish: false });
  assert.equal(send.mock.callCount(), 0);
  return { core, send, display: createDisplayApi(core) };
}

test("the first song step after an unpublished open sends the working list with it", async (t) => {
  const { send, display } = await openedUnpublished(t);
  await display.project({ songId: "next" });
  const [list, step] = send.mock.calls.map((call) => call.arguments[0]);
  assert.deepEqual(list?.playlist, SHARED, "the session learns the list, so it takes the row's values");
  assert.equal(step?.songId, "next");
  assert.equal(step?.playlist, undefined);
  await display.project({ songId: "song" });
  assert.equal(send.mock.callCount(), 3, "the list goes out once");
});

test("a highlight or preference after an unpublished open first moves the session to the shown song", async (t) => {
  for (const act of [
    (display: ReturnType<typeof createDisplayApi>) => display.highlight(3, 5, 1),
    (display: ReturnType<typeof createDisplayApi>) => display.setTranspose(4, true),
  ]) {
    const { send, display } = await openedUnpublished(t);
    t.mock.method(cloudApi, "sendHighlight", async () => "OK");
    t.mock.method(cloudApi, "sendDisplayPreference", async () => "OK");
    await act(display);
    const first = send.mock.calls[0]?.arguments[0];
    assert.equal(first?.songId, "song");
    assert.deepEqual(first?.playlist, SHARED);
    send.mock.restore();
  }
});
