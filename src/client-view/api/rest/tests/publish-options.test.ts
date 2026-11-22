import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import { cloudApi, type DisplayUpdateResult } from "../../../../../common/cloudApi";
import { RestCore } from "../RestCore";
import { createDisplayApi, createPlaylistApi, createSessionApi } from "../restPorts";

const ENTRIES = [{ songId: "song", title: "Song" }];

function signedInCore(t: TestContext) {
  const core = new RestCore();
  core.leader = { id: "leader", name: "Leader" };
  t.mock.method(core, "canControlDisplay", () => true);
  t.mock.method(core, "loadSongData", async () => ({ text: "{title:Song}", system: "G" }));
  const send = t.mock.method(cloudApi, "sendDisplayUpdate", async (): Promise<DisplayUpdateResult> => "DONE");
  t.mock.method(cloudApi, "sendHighlight", async () => "OK");
  const preference = t.mock.method(cloudApi, "sendDisplayPreference", async () => "OK");
  return { core, send, preference };
}

test("an unpublished working-list write stays on this client", async (t) => {
  const { core, send } = signedInCore(t);
  const playlist = createPlaylistApi(core);
  await playlist.setPlaylist(ENTRIES, { publish: false });
  assert.deepEqual(core.getPlaylist(), ENTRIES);
  assert.equal(send.mock.callCount(), 0);
  const edited = [...ENTRIES, { songId: "other", title: "Other" }];
  await playlist.setPlaylist(edited);
  assert.equal(send.mock.callCount(), 1, "the pending publish carries the edited list; it is not sent twice");
  const [sent, options] = send.mock.calls[0]?.arguments ?? [];
  assert.deepEqual(sent?.playlist, edited);
  // No song is shown: only the list goes out, never explicit values for the
  // song the session shows.
  assert.equal(sent?.songId, "");
  assert.deepEqual(options, { leaderId: "leader", force: true });
  await playlist.setPlaylist(ENTRIES);
  assert.equal(send.mock.callCount(), 2, "later writes go out as usual");
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
  const { core, send, preference } = signedInCore(t);
  await createPlaylistApi(core).setPlaylist(SHARED, { publish: false });
  await createDisplayApi(core).project({ songId: "song", transpose: 2, capo: 1, instructions: "Verse" }, { publish: false });
  assert.equal(send.mock.callCount(), 0);
  return { core, send, preference, display: createDisplayApi(core) };
}

test("the first song step after an unpublished open sends the list with the complete current song first", async (t) => {
  const { send, display } = await openedUnpublished(t);
  await display.project({ songId: "next" });
  const [pending, step] = send.mock.calls.map((call) => call.arguments);
  assert.deepEqual(pending?.[0]?.playlist, SHARED, "the session learns the list, so it takes the row's values");
  // The step has already changed this client's display: that is the state sent.
  assert.equal(pending?.[0]?.songId, "next");
  assert.equal(pending?.[0]?.capo, -1, "no capo is sent explicitly");
  assert.equal(pending?.[0]?.instructions, "", "no instructions is sent explicitly");
  assert.deepEqual(pending?.[1], { leaderId: "leader", force: true, complete: true });
  assert.equal(step?.[0]?.songId, "next");
  assert.equal(step?.[0]?.playlist, undefined);
  await display.project({ songId: "song" });
  assert.equal(send.mock.callCount(), 3, "the pending state goes out once");
});

test("a highlight or preference after an unpublished open first moves the session to the shown song", async (t) => {
  for (const act of [
    (display: ReturnType<typeof createDisplayApi>) => display.highlight(3, 5, 1),
    (display: ReturnType<typeof createDisplayApi>) => display.setTranspose(2, true),
  ]) {
    const { send, display } = await openedUnpublished(t);
    await act(display);
    const first = send.mock.calls[0]?.arguments[0];
    assert.equal(first?.songId, "song");
    assert.deepEqual(first?.playlist, SHARED);
    // Complete, so a session already showing this song cannot keep its own values.
    assert.equal(first?.transpose, 2);
    assert.equal(first?.capo, 1);
    assert.equal(first?.instructions, "Verse");
    send.mock.restore();
  }
});

test("a page that did not sign in itself publishes to the account the backend resolves", async (t) => {
  const { core, send, display } = await openedUnpublished(t);
  core.leader = null;
  await display.project({ songId: "next" });
  // The backend publishes to the account behind the browser's cookie.
  assert.deepEqual(send.mock.calls[0]?.arguments[1], { force: true, complete: true });
  assert.deepEqual(send.mock.calls[0]?.arguments[0]?.playlist, SHARED);
  assert.equal(core.hasUnpublishedState(), false);
});

test("for an anonymous visitor the state stays pending until an account takes it", async (t) => {
  const { core, send, display } = await openedUnpublished(t);
  core.leader = null;
  send.mock.mockImplementation(async (): Promise<DisplayUpdateResult> => "NO_SESSION");
  await display.project({ songId: "next" });
  assert.equal(send.mock.callCount(), 2, "the pending publish is tried, then the step goes out");
  assert.equal(core.hasUnpublishedState(), true);
  send.mock.mockImplementation(async (): Promise<DisplayUpdateResult> => "DONE");
  await display.project({ songId: "song" });
  assert.deepEqual(send.mock.calls[2]?.arguments[0]?.playlist, SHARED, "once an account is reachable the list goes first");
  assert.equal(core.hasUnpublishedState(), false);
});

test("a rejected publish keeps the state pending for the next push", async (t) => {
  const { core, send, display } = await openedUnpublished(t);
  send.mock.mockImplementationOnce(async (): Promise<DisplayUpdateResult> => "UNAUTHORIZED");
  await display.project({ songId: "next" });
  assert.equal(core.hasUnpublishedState(), true);
  await display.project({ songId: "song" });
  assert.deepEqual(send.mock.calls[2]?.arguments[0]?.playlist, SHARED, "the next push retries it");
  assert.equal(core.hasUnpublishedState(), false);
});

test("while watching another session the own pending state is neither sent nor dropped", async (t) => {
  const { core, send, display } = await openedUnpublished(t);
  const following = t.mock.method(core, "isFollowing", () => true);
  await display.highlight(1, 2, 0);
  assert.equal(send.mock.callCount(), 0, "nothing of the own list goes to the watched session");
  assert.equal(core.hasUnpublishedState(), true);
  following.mock.mockImplementation(() => false);
  await display.project({ songId: "next" });
  assert.deepEqual(send.mock.calls[0]?.arguments[0]?.playlist, SHARED);
});

test("concurrent pushes share one pending publish and keep their order", async (t) => {
  const { send, display } = await openedUnpublished(t);
  let release = () => {};
  send.mock.mockImplementationOnce(() => new Promise<DisplayUpdateResult>((resolve) => (release = () => resolve("DONE"))));
  const first = display.project({ songId: "next" });
  const second = display.project({ songId: "song" });
  await new Promise((resolve) => setImmediate(resolve));
  release();
  await Promise.all([first, second]);
  // The first step had already changed this client's display when the shared
  // publish read it; then each step goes out in the order it was made.
  assert.deepEqual(
    send.mock.calls.map((call) => call.arguments[0]?.songId),
    ["next", "next", "song"]
  );
  assert.ok(send.mock.calls[0]?.arguments[0]?.playlist, "only the shared publish carries the list");
});

test("hosting an online session after an unpublished open sends the list once", async (t) => {
  const { core, send } = await openedUnpublished(t);
  t.mock.method(core, "setNetworkState", () => undefined);
  await createSessionApi(core).createOnline();
  assert.equal(send.mock.callCount(), 2, "the pending publish (with the list) and the display");
  assert.deepEqual(send.mock.calls[0]?.arguments[0]?.playlist, SHARED);
});

test("a failed pending publish never stops the user's own push", async (t) => {
  const { core, send, display } = await openedUnpublished(t);
  t.mock.method(console, "warn", () => undefined);
  send.mock.mockImplementationOnce(async (): Promise<DisplayUpdateResult> => {
    throw new Error("network down");
  });
  await display.project({ songId: "next" });
  assert.equal(send.mock.calls[1]?.arguments[0]?.songId, "next", "the step itself still goes out");
  assert.equal(core.hasUnpublishedState(), true, "and the list stays pending");
});

test("a preference waiting for the pending publish keeps the song it was set for", async (t) => {
  const { send, preference, display } = await openedUnpublished(t);
  let release = () => {};
  send.mock.mockImplementationOnce(() => new Promise<DisplayUpdateResult>((resolve) => (release = () => resolve("DONE"))));
  const committed = display.setTranspose(4, true);
  const stepped = display.project({ songId: "next" });
  await new Promise((resolve) => setImmediate(resolve));
  release();
  await Promise.all([committed, stepped]);
  assert.equal(preference.mock.calls[0]?.arguments[0]?.id, "song");
});

test("an unpublished write during a pending publish stays pending", async (t) => {
  const { core, send, display } = await openedUnpublished(t);
  let release = () => {};
  send.mock.mockImplementationOnce(() => new Promise<DisplayUpdateResult>((resolve) => (release = () => resolve("DONE"))));
  const stepped = display.project({ songId: "next" });
  await new Promise((resolve) => setImmediate(resolve));
  await createPlaylistApi(core).setPlaylist(ENTRIES, { publish: false });
  release();
  await stepped;
  assert.equal(core.hasUnpublishedState(), true, "the newer list was not in the publish that finished");
});
