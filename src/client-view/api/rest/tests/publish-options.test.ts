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
  const highlight = t.mock.method(cloudApi, "sendHighlight", async () => "OK");
  const preference = t.mock.method(cloudApi, "sendDisplayPreference", async () => "OK");
  return { core, send, highlight, preference };
}

type Send = ReturnType<typeof signedInCore>["send"];
const sent = (send: Send, index: number) => send.mock.calls[index]?.arguments[0];
const optionsOf = (send: Send, index: number) => send.mock.calls[index]?.arguments[1];
const songIds = (send: Send) => send.mock.calls.map((call) => call.arguments[0]?.songId);
const listsSent = (send: Send) => send.mock.calls.map((call) => call.arguments[0]?.playlist).filter(Boolean);

/** A held `sendDisplayUpdate` reply: the next call waits until `release()`. */
function holdNextSend(send: Send, reply: DisplayUpdateResult = "DONE") {
  let release = () => {};
  send.mock.mockImplementationOnce(() => new Promise<DisplayUpdateResult>((resolve) => (release = () => resolve(reply))));
  return () => release();
}
const tick = () => new Promise((resolve) => setImmediate(resolve));

test("an unpublished working-list write stays on this client", async (t) => {
  const { core, send } = signedInCore(t);
  const playlist = createPlaylistApi(core);
  await playlist.setPlaylist(ENTRIES, { publish: false });
  assert.deepEqual(core.getPlaylist(), ENTRIES);
  assert.equal(send.mock.callCount(), 0);
  const edited = [...ENTRIES, { songId: "other", title: "Other" }];
  await playlist.setPlaylist(edited);
  assert.equal(send.mock.callCount(), 1, "the pending publish carries the edited list; it is not sent twice");
  assert.deepEqual(sent(send, 0)?.playlist, edited);
  // No song is shown: only the list goes out, never explicit values for the
  // song the session shows.
  assert.equal(sent(send, 0)?.songId, "");
  assert.deepEqual(optionsOf(send, 0), { leaderId: "leader", force: true, ordered: true });
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
  assert.deepEqual(songIds(send), ["song", "song", "song"], "pending state, its settle, then the projection");
});

const SHARED = [
  { songId: "song", title: "Song", transpose: 2, capo: 1, instructions: "Verse" },
  { songId: "next", title: "Next" },
];

/** A shared list opened locally (publish:false), as ClientViewStore does on entry. */
async function openedUnpublished(t: TestContext) {
  const mocks = signedInCore(t);
  await createPlaylistApi(mocks.core).setPlaylist(SHARED, { publish: false });
  await createDisplayApi(mocks.core).project({ songId: "song", transpose: 2, capo: 1, instructions: "Verse" }, { publish: false });
  assert.equal(mocks.send.mock.callCount(), 0);
  return { ...mocks, display: createDisplayApi(mocks.core) };
}

test("the first song step after an unpublished open sends the list with the complete current song first", async (t) => {
  const { send, display } = await openedUnpublished(t);
  await display.project({ songId: "next" });
  assert.deepEqual(sent(send, 0)?.playlist, SHARED, "the session learns the list, so it takes the row's values");
  // The step has already changed this client's display: that is the state sent.
  assert.equal(sent(send, 0)?.songId, "next");
  assert.equal(sent(send, 0)?.capo, -1, "no capo is sent explicitly");
  assert.equal(sent(send, 0)?.instructions, "", "no instructions is sent explicitly");
  assert.deepEqual(optionsOf(send, 0), { leaderId: "leader", force: true, complete: true, timeoutMs: 15_000, ordered: true });
  assert.deepEqual(songIds(send), ["next", "next", "next"], "pending state, its settle, then the step");
  assert.equal(sent(send, 2)?.playlist, undefined);
  await display.project({ songId: "song" });
  assert.equal(listsSent(send).length, 1, "the pending state goes out once");
});

test("a song switch is settled to this client's values, not the account's saved preferences", async (t) => {
  const { send, display } = await openedUnpublished(t);
  await display.project({ songId: "next" });
  // On a switch the backend applies the account's preferences; a same-song
  // complete update then sets what this client shows (and never writes them).
  assert.deepEqual(sent(send, 1), {
    songId: "next",
    from: 0,
    to: 0,
    section: undefined,
    abcRange: undefined,
    sectionRepeatCounts: undefined,
    sectionRepeatNonce: undefined,
    transpose: 0,
    capo: -1,
    song: "",
    instructions: "",
  });
  assert.deepEqual(optionsOf(send, 1), { leaderId: "leader", force: true, complete: true, timeoutMs: 15_000, ordered: true });
  send.mock.resetCalls();
  await display.project({ songId: "song", transpose: 2, capo: 1, instructions: "Verse" });
  assert.deepEqual(songIds(send), ["song", "song"], "every later switch is settled too");
  assert.equal(sent(send, 1)?.transpose, 2);
  assert.equal(sent(send, 1)?.capo, 1);
  assert.equal(sent(send, 1)?.instructions, "Verse");
  send.mock.resetCalls();
  await display.highlight(1, 2, 0);
  await display.project({ songId: "song", transpose: 2, capo: 1, instructions: "Verse" });
  assert.deepEqual(songIds(send), ["song"], "re-sending the song the session shows needs no settle");
});

test("a highlight or preference after an unpublished open first moves the session to the shown song", async (t) => {
  for (const act of [
    (display: ReturnType<typeof createDisplayApi>) => display.highlight(3, 5, 1),
    (display: ReturnType<typeof createDisplayApi>) => display.setTranspose(2, true),
  ]) {
    const { send, display } = await openedUnpublished(t);
    await act(display);
    assert.equal(sent(send, 0)?.songId, "song");
    assert.deepEqual(sent(send, 0)?.playlist, SHARED);
    // Complete, so a session already showing this song cannot keep its own values.
    assert.equal(sent(send, 0)?.transpose, 2);
    assert.equal(sent(send, 0)?.capo, 1);
    assert.equal(sent(send, 0)?.instructions, "Verse");
    send.mock.restore();
  }
});

test("a highlight never lands on another song after a failed song switch", async (t) => {
  const { send, highlight, display } = await openedUnpublished(t);
  send.mock.mockImplementation(async (): Promise<DisplayUpdateResult> => "ERROR");
  await display.highlight(6, 9, 2);
  assert.equal(highlight.mock.callCount(), 0, "the session may still show the previous song");
  await display.project({ songId: "next" });
  await display.highlight(1, 2, 0);
  assert.equal(highlight.mock.callCount(), 0, "a failed step leaves the session's song unknown too");
  send.mock.mockImplementation(async (): Promise<DisplayUpdateResult> => "DONE");
  await display.project({ songId: "next" });
  await display.highlight(1, 2, 0);
  assert.equal(highlight.mock.callCount(), 1, "once the switch is confirmed highlights go out again");
});

test("a page that did not sign in itself publishes to the account the backend resolves", async (t) => {
  const { core, send, display } = await openedUnpublished(t);
  core.leader = null;
  await display.project({ songId: "next" });
  // The backend publishes to the account behind the browser's cookie.
  assert.deepEqual(optionsOf(send, 0), { force: true, complete: true, timeoutMs: 15_000, ordered: true });
  assert.deepEqual(sent(send, 0)?.playlist, SHARED);
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
  assert.deepEqual(sent(send, 2)?.playlist, SHARED, "once an account is reachable the list goes first");
  assert.equal(core.hasUnpublishedState(), false);
});

test("a rejected publish keeps the state pending for the next push", async (t) => {
  const { core, send, display } = await openedUnpublished(t);
  send.mock.mockImplementationOnce(async (): Promise<DisplayUpdateResult> => "UNAUTHORIZED");
  await display.project({ songId: "next" });
  assert.equal(core.hasUnpublishedState(), true);
  await display.project({ songId: "song" });
  assert.equal(listsSent(send).length, 2, "the next push retries it");
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
  assert.deepEqual(sent(send, 0)?.playlist, SHARED);
});

test("concurrent pushes share one pending publish and keep their order", async (t) => {
  const { send, display } = await openedUnpublished(t);
  const release = holdNextSend(send);
  const first = display.project({ songId: "next" });
  const second = display.project({ songId: "song" });
  await tick();
  release();
  await Promise.all([first, second]);
  // The first step had already changed this client's display when the shared
  // publish read it; then each step goes out in the order it was made, and only
  // the song the client still shows is settled (settling "next" would move the
  // session back to it).
  assert.deepEqual(songIds(send), ["next", "next", "song", "song"]);
  assert.equal(listsSent(send).length, 1, "only the shared publish carries the list");
});

test("a list reordered while the pending publish is in flight still reaches the session", async (t) => {
  const { core, send } = await openedUnpublished(t);
  const playlist = createPlaylistApi(core);
  const release = holdNextSend(send);
  const opened = createDisplayApi(core).highlight(1, 2, 0);
  await tick();
  const reordered = [SHARED[1], SHARED[0]];
  const reorder = playlist.setPlaylist(reordered);
  await tick();
  release();
  await Promise.all([opened, reorder]);
  assert.deepEqual(listsSent(send), [SHARED, reordered], "the pending publish carried the old order; the new one follows");
});

test("hosting an online session after an unpublished open sends the list once", async (t) => {
  const { core, send } = await openedUnpublished(t);
  t.mock.method(core, "setNetworkState", () => undefined);
  await createSessionApi(core).createOnline();
  assert.equal(listsSent(send).length, 1, "the pending publish carried the list; it is not seeded again");
  assert.deepEqual(sent(send, 0)?.playlist, SHARED);
});

test("a failed pending publish never stops the user's own push", async (t) => {
  const { core, send, display } = await openedUnpublished(t);
  t.mock.method(console, "warn", () => undefined);
  send.mock.mockImplementationOnce(async (): Promise<DisplayUpdateResult> => {
    throw new Error("network down");
  });
  await display.project({ songId: "next" });
  assert.equal(sent(send, 1)?.songId, "next", "the step itself still goes out");
  assert.equal(core.hasUnpublishedState(), true, "and the list stays pending");
});

test("a preference waiting for the pending publish never lands on a later song", async (t) => {
  const { send, preference, display } = await openedUnpublished(t);
  const release = holdNextSend(send);
  const committed = display.setTranspose(4, true);
  const stepped = display.project({ songId: "next" });
  await tick();
  release();
  await Promise.all([committed, stepped]);
  assert.ok(
    preference.mock.calls.every((call) => call.arguments[0]?.id !== "next"),
    "the transpose set for the earlier song is never applied to the later one"
  );
});

test("an unpublished write during a pending publish stays pending", async (t) => {
  const { core, send, display } = await openedUnpublished(t);
  const release = holdNextSend(send);
  const stepped = display.project({ songId: "next" });
  await tick();
  await createPlaylistApi(core).setPlaylist(ENTRIES, { publish: false });
  release();
  await stepped;
  assert.equal(core.hasUnpublishedState(), true, "the newer list was not in the publish that finished");
});

/** Hold the `onCall`-th `sendDisplayUpdate` reply until `release()`. */
function holdSend(send: Send, onCall: number, reply: DisplayUpdateResult = "DONE") {
  let release = () => {};
  send.mock.mockImplementationOnce(() => new Promise<DisplayUpdateResult>((resolve) => (release = () => resolve(reply))), onCall);
  return () => release();
}
const last = (send: Send) => sent(send, send.mock.callCount() - 1);

/** A signed-in client whose own session shows `song` with this client's values. */
async function settledOn(t: TestContext, request: Parameters<ReturnType<typeof createDisplayApi>["project"]>[0] = { songId: "song" }) {
  const mocks = signedInCore(t);
  const display = createDisplayApi(mocks.core);
  await display.project(request);
  assert.equal(mocks.core.ownSession.shownSongId(), request.songId);
  mocks.send.mock.resetCalls();
  return { ...mocks, display };
}

test("a failed settle keeps the state pending and the next highlight sends the client's values again", async (t) => {
  const { core, send, highlight, display } = await openedUnpublished(t);
  // The pending publish switches the session to the song; setting its values fails.
  send.mock.mockImplementationOnce(async (): Promise<DisplayUpdateResult> => "ERROR", 1);
  await display.highlight(6, 9, 2);
  assert.equal(core.hasUnpublishedState(), true, "the session may still show the profile's values");
  assert.equal(highlight.mock.callCount(), 0, "the session is not known to show the client's values");
  assert.ok(send.mock.callCount() > 2, "the values are sent again");
  assert.equal(last(send)?.songId, "song");
  assert.equal(last(send)?.transpose, 2);
  assert.equal(last(send)?.capo, 1);
  assert.equal(last(send)?.instructions, "Verse");
  assert.equal(last(send)?.from, 6);
  assert.equal(last(send)?.to, 9);
  assert.equal(core.ownSession.shownSongId(), "song");
  await display.highlight(1, 2, 0);
  assert.equal(highlight.mock.callCount(), 1, "once the values are set, highlights go out again");
});

test("a highlight and a transpose made during a song switch reach the session", async (t) => {
  const { core, send, highlight, preference, display } = await settledOn(t);
  const releaseSwitch = holdSend(send, 0);
  const releaseSettle = holdSend(send, 1);
  const stepped = display.project({ songId: "next" });
  await tick();
  const committed = display.setTranspose(5, true);
  await tick();
  releaseSwitch();
  await tick();
  assert.equal(send.mock.callCount(), 2, "the update setting the song's values is on its way");
  assert.equal(sent(send, 1)?.transpose, 5, "it carries the transpose set during the switch");
  // A highlight made while those values are being set follows them.
  await display.highlight(6, 9, 1);
  releaseSettle();
  await Promise.all([stepped, committed]);
  assert.equal(highlight.mock.callCount(), 0);
  // The complete updates set the value; only the minimal update saves it as the
  // account's preference, once the session shows the song.
  assert.deepEqual(
    preference.mock.calls.map((call) => call.arguments[0]),
    [{ id: "next", transpose: 5 }]
  );
  assert.equal(send.mock.callCount(), 3);
  assert.equal(last(send)?.songId, "next");
  assert.equal(last(send)?.transpose, 5);
  assert.equal(last(send)?.from, 6);
  assert.equal(last(send)?.to, 9);
  assert.equal(last(send)?.section, 1);
  assert.equal(core.ownSession.shownSongId(), "next");
});

test("a late reply to an earlier song switch never stops the highlights of the later song", async (t) => {
  const { core, send, highlight, display } = await settledOn(t);
  // B's switch lands at once, the reply setting its values comes last.
  const releaseB = holdSend(send, 1);
  const toB = display.project({ songId: "next" });
  await tick();
  await display.project({ songId: "third" });
  releaseB();
  await toB;
  assert.equal(core.ownSession.shownSongId(), "third");
  await display.highlight(6, 9, 0);
  assert.equal(highlight.mock.callCount(), 1);
});

test("selecting another list row of the song the session shows sends every value of the row", async (t) => {
  const { send, display } = await settledOn(t, { songId: "song", transpose: 3, capo: 2, instructions: "Verse" });
  await display.project({ songId: "song", transpose: 0 });
  assert.equal(send.mock.callCount(), 1, "the session shows the song: it takes the values at once");
  assert.equal(sent(send, 0)?.transpose, 0);
  assert.equal(sent(send, 0)?.capo, -1);
  assert.equal(sent(send, 0)?.instructions, "");
  assert.equal(optionsOf(send, 0)?.complete, true);
});

test("after an account switch a highlight never lands on what the other account's session shows", async (t) => {
  const { core, send, highlight, display } = await settledOn(t);
  // Capabilities read browser globals that Node lacks; they play no part here.
  t.mock.method(core as unknown as { emitCapabilities(): void }, "emitCapabilities", () => undefined);
  core.setAuthed(true, { id: "other", name: "Other" });
  await display.highlight(6, 9, 0);
  assert.equal(highlight.mock.callCount(), 0);
  assert.equal(last(send)?.songId, "song", "the song this client shows goes to the new session");
  assert.equal(last(send)?.from, 6);
  assert.equal(optionsOf(send, send.mock.callCount() - 1)?.leaderId, "other");
  assert.equal(core.ownSession.shownSongId(), "song");
});

test("a page that did not sign in itself carries a highlight to the account the backend resolves", async (t) => {
  const { core, send, highlight, display } = await settledOn(t);
  core.leader = null;
  // A current backend resolves the account behind the browser's cookie itself.
  highlight.mock.mockImplementation(async () => "UPDATED");
  await display.highlight(6, 9, 1);
  assert.equal(highlight.mock.callCount(), 1);
  assert.equal(highlight.mock.calls[0].arguments[0]?.songId, "song", "the lines name their song");
  assert.equal(send.mock.callCount(), 0);
  // An older backend reaches only a named session: a display update carries it.
  highlight.mock.mockImplementation(async () => "NOPE");
  await display.highlight(2, 4, 0);
  assert.equal(send.mock.callCount(), 1, "the session shows the song: one update carries the highlight");
  assert.equal(sent(send, 0)?.songId, "song");
  assert.equal(sent(send, 0)?.from, 2);
  assert.equal(sent(send, 0)?.to, 4);
  assert.equal(optionsOf(send, 0)?.leaderId, undefined);
});

test("after another device moved the session a highlight neither marks its song nor takes it back", async (t) => {
  const { core, send, highlight, display } = await settledOn(t);
  highlight.mock.mockImplementation(async () => "STALE");
  await display.highlight(6, 9, 0);
  assert.equal(core.ownSession.shownSongId(), null);
  assert.equal(core.ownSession.isReleased(), true);
  highlight.mock.mockImplementation(async () => "UPDATED");
  await display.highlight(1, 2, 0);
  assert.equal(send.mock.callCount(), 0, "a tap sends no song of this client's own");
  // Selecting a song takes the session again.
  await display.project({ songId: "next" });
  assert.equal(core.ownSession.shownSongId(), "next");
  assert.equal(core.ownSession.isReleased(), false);
});

test("own-session writes are numbered so a late one never undoes a newer one", async (t) => {
  const { send, highlight, preference, display } = await settledOn(t);
  await display.project({ songId: "next" });
  await display.highlight(1, 2, 0);
  await display.setTranspose(3, true);
  assert.ok(send.mock.calls.every((call) => call.arguments[1]?.ordered === true));
  assert.equal(highlight.mock.calls[0].arguments[0]?.ordered, true);
  assert.deepEqual(preference.mock.calls[0].arguments[2], { ordered: true });
});

test("a preference the backend refuses for another song releases the session", async (t) => {
  const { core, preference, display } = await settledOn(t);
  preference.mock.mockImplementation(async () => "STALE");
  await display.setTranspose(3, true);
  assert.equal(core.ownSession.isReleased(), true);
});

test("saved list instructions stay saved when only setting the song's values fails", async (t) => {
  const { core, send, display } = await settledOn(t);
  core.setPlaylist(ENTRIES);
  // Another device of the account may have moved the session meanwhile.
  core.ownSession.reset();
  t.mock.method(console, "warn", () => undefined);
  send.mock.mockImplementationOnce(async (): Promise<DisplayUpdateResult> => {
    throw new Error("network down");
  }, 1);
  await createPlaylistApi(core).setEntryInstructions("song", "Chorus", () => true);
  assert.equal(sent(send, 0)?.instructions, "Chorus", "the list and the session took the instructions");
  assert.equal(core.getDisplay().instructions, "Chorus");
  assert.equal(core.ownSession.shownSongId(), null, "the next highlight sends the values again");
  await display.highlight(1, 2, 0);
  assert.equal(last(send)?.instructions, "Chorus");
});

test("without control a highlight sends no display update to a session it does not know", async (t) => {
  const { core, send, highlight, display } = await settledOn(t);
  core.ownSession.reset();
  t.mock.method(core, "canControlDisplay", () => false);
  await display.highlight(6, 9, 0);
  assert.equal(send.mock.callCount(), 0);
  assert.equal(highlight.mock.callCount(), 0);
});

test("a preference for a session not known to show the song saves it once the values are sent", async (t) => {
  const { core, send, preference, display } = await settledOn(t);
  core.ownSession.reset();
  await display.setTranspose(3, true);
  assert.equal(last(send)?.transpose, 3, "a complete update sets the value");
  assert.deepEqual(
    preference.mock.calls.map((call) => call.arguments[0]),
    [{ id: "song", transpose: 3 }]
  );
});

test("after another device took the session a list edit sends only the list", async (t) => {
  const { core, send, highlight, display } = await settledOn(t);
  highlight.mock.mockImplementation(async () => "STALE");
  await display.highlight(6, 9, 0);
  await createPlaylistApi(core).setPlaylist([...ENTRIES, { songId: "next", title: "Next" }]);
  assert.equal(send.mock.callCount(), 1);
  assert.equal(sent(send, 0)?.songId, "", "no song of this client's own");
  assert.equal(sent(send, 0)?.from, undefined, "the other device's highlight stays");
  assert.equal(optionsOf(send, 0)?.ordered, true);
  assert.equal(core.ownSession.isReleased(), true);
});
