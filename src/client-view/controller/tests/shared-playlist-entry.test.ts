import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import type { LeaderDBProfile, PlaylistEntry } from "../../../../common/pp-types";
import type { ClientConfig } from "../../api/ClientApi";
import { installFakeWindow } from "../../../../tests/support/browserEnv";
import { createFakeClientApi } from "../../../../tests/support/fakeClientApi";
import { ClientViewStore } from "../ClientViewStore";

const SHARED: PlaylistEntry[] = [
  { songId: "first", title: "First" },
  { songId: "second", title: "Second", transpose: 2, capo: 1, instructions: "Verse" },
  { songId: "third", title: "Third" },
];
/** The working list holds normalized rows (toPlaylistEntry), with every field present. */
const WORKING = SHARED.map(({ songId, title, transpose, capo, instructions }) => ({ songId, title, transpose, capo, instructions }));
const PROFILES: LeaderDBProfile[] = [
  { leaderId: "leader-1", leaderName: "Leader", version: 1, preferences: [], playlists: [{ label: "2026.11.22", songs: SHARED }] },
];
/** A `/public.html?l=leader-1/2026.11.22@1` link, as mountClientView parses it. */
const SHARED_LINK: ClientConfig = { entryMode: "standalone", initialPlaylistId: "leader-1/2026.11.22", initialPlaylistIndex: 1 };
const SECOND_PROJECTION = { songId: "second", transpose: 2, capo: 1, instructions: "Verse" };

const settle = () => new Promise((resolve) => setImmediate(resolve));

function fixture(context: TestContext, options: { playlist?: PlaylistEntry[]; storageScope?: "local" | "remote" } = {}) {
  const env = installFakeWindow({ storage: { "pp-settings": JSON.stringify({ clientViewAutoScanSessions: "off" }) } });
  const fake = createFakeClientApi({
    capabilities: { canControlDisplay: true, canEditWorkingPlaylist: true },
    // The shared-link page runs on the cloud (Rest) adapter.
    storageScope: options.storageScope ?? "remote",
    playlist: options.playlist ?? [],
    leaderProfiles: PROFILES,
    // Like RestCore, a projection comes back through the display subscription.
    hostEcho: true,
  });
  const store = new ClientViewStore(fake.api);
  context.after(() => {
    store.dispose();
    env.restore();
  });
  return { store, fake };
}

test("a shared list link opens the list as the working list, at the linked row", async (context) => {
  const { store } = fixture(context);
  await store.init(SHARED_LINK);
  await settle();
  const state = store.getSnapshot();
  assert.deepEqual(state.playlist, WORKING);
  assert.equal(state.navigationMode, "playlist");
  assert.equal(state.listMode, "playlist");
  assert.equal(state.display.songId, "second");
  assert.equal(state.selectedLeaderId, "leader-1", "the leader-lists picker still shows the source list");
  assert.equal(state.selectedPlaylistLabel, "2026.11.22");
});

test("opening a shared list publishes nothing: the account's live session is left alone", async (context) => {
  const { store, fake } = fixture(context);
  await store.init(SHARED_LINK);
  await settle();
  assert.deepEqual(fake.callsTo("playlist.setPlaylist"), [[WORKING, { publish: false }]]);
  assert.deepEqual(fake.callsTo("display.project"), [[SECOND_PROJECTION, { publish: false }]]);
});

test("the user's own next step publishes as usual", async (context) => {
  const { store, fake } = fixture(context);
  await store.init(SHARED_LINK);
  await settle();
  await store.nextSong();
  assert.deepEqual(fake.callsTo("display.project").at(-1), [{ songId: "third", transpose: 0, capo: undefined, instructions: undefined }]);
});

test("a follower keeps browsing the shared list as a leader list", async (context) => {
  const { store, fake } = fixture(context);
  await store.init({ ...SHARED_LINK, follow: true });
  await settle();
  const state = store.getSnapshot();
  assert.equal(state.navigationMode, "archive");
  assert.equal(state.listMode, "leaderlists");
  assert.equal(state.display.songId, "second");
  assert.deepEqual(fake.callsTo("playlist.setPlaylist"), []);
  assert.deepEqual(fake.callsTo("display.project"), []);
});

test("an existing working list is never replaced by a shared list", async (context) => {
  const own = [{ songId: "own", title: "Own" }];
  const { store, fake } = fixture(context, { playlist: own });
  await store.init(SHARED_LINK);
  await settle();
  const state = store.getSnapshot();
  assert.deepEqual(state.playlist, own);
  assert.equal(state.navigationMode, "archive");
  assert.equal(state.display.songId, "second");
  assert.deepEqual(fake.callsTo("playlist.setPlaylist"), []);
});

test("an in-process client never opens a shared list as its working list", async (context) => {
  const { store, fake } = fixture(context, { storageScope: "local" });
  await store.init(SHARED_LINK);
  await settle();
  assert.equal(store.getSnapshot().navigationMode, "archive");
  assert.deepEqual(fake.callsTo("playlist.setPlaylist"), [], "the host's list and projection stay untouched");
  assert.deepEqual(fake.callsTo("display.project"), []);
});
