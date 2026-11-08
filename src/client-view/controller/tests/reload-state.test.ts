import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import { getEmptyDisplay } from "../../../../common/pp-utils";
import type { PlaylistEntry } from "../../../../common/pp-types";
import { installFakeWindow } from "../../../../tests/support/browserEnv";
import { createFakeClientApi } from "../../../../tests/support/fakeClientApi";
import { ClientViewStore } from "../ClientViewStore";

const PLAYLIST: PlaylistEntry[] = [
  { songId: "first", title: "First" },
  { songId: "saved", title: "Saved", transpose: 3, capo: 2, instructions: "Verse" },
];
const FIRST_PROJECTION = { songId: "first", transpose: 0, capo: undefined, instructions: undefined };

/** Lets queued host echoes and notifications run. */
const settle = () => new Promise((resolve) => setImmediate(resolve));

function fixture(context: TestContext) {
  const env = installFakeWindow({ storage: { "pp-settings": JSON.stringify({ clientViewAutoScanSessions: "off" }) } });
  const fake = createFakeClientApi({
    capabilities: { canControlDisplay: true, canEditWorkingPlaylist: true },
    playlist: PLAYLIST,
    preferences: {
      "client-view-state": JSON.stringify({
        version: 3,
        navigationMode: "playlist",
        listMode: "playlist",
        songId: "saved",
        transpose: 3,
        capo: 2,
      }),
    },
    hostEcho: true,
  });
  const store = new ClientViewStore(fake.api);
  context.after(() => {
    store.dispose();
    env.restore();
  });
  return { store, fake };
}

const reload = { entryMode: "embedded", restorePersistedViewOnEntry: true } as const;

test("embedded F5 shows the song the host restores, never projecting or loading one of its own", async (context) => {
  const { store, fake } = fixture(context);
  await store.init(reload);
  assert.deepEqual(fake.callsTo("display.project"), [], "neither the saved nor the first row is projected over the host's restore");

  fake.emitDisplay({ ...getEmptyDisplay(), songId: "saved", song: "Saved host song", transpose: 3, capo: 2 });
  await settle();
  assert.equal(store.getSnapshot().display.songId, "saved");
  assert.equal(store.getSnapshot().navigationMode, "playlist");
  assert.deepEqual(fake.callsTo("display.project"), []);
  assert.deepEqual(fake.callsTo("song.getSongData"), [], "playlist mode shows the host's projection, never a local copy");
});

test("while the host restores, playlist and display notifications never pick the first row", async (context) => {
  const { store, fake } = fixture(context);
  await store.init(reload);
  await fake.api.playlist.setPlaylist(PLAYLIST);
  // Every host display change (here: a message) re-notifies the playlist too.
  fake.emitDisplay({ ...getEmptyDisplay(), playlist: PLAYLIST, message: "Welcome" });
  await settle();
  assert.deepEqual(fake.callsTo("display.project"), []);
});

test("once the host has shown a song, an emptied display gets the first row again", async (context) => {
  const { store, fake } = fixture(context);
  await store.init(reload);
  fake.emitDisplay({ ...getEmptyDisplay(), songId: "saved", song: "Saved host song" });
  fake.emitDisplay({ ...getEmptyDisplay(), playlist: PLAYLIST });
  await settle();
  assert.deepEqual(fake.callsTo("display.project"), [[FIRST_PROJECTION]]);
});

test("a song the user picks after an embedded reload is kept", async (context) => {
  const { store, fake } = fixture(context);
  await store.init(reload);
  await store.selectDatabaseSong("other");
  await fake.api.playlist.setPlaylist(PLAYLIST);
  await settle();
  assert.deepEqual(fake.callsTo("display.project"), []);
  assert.equal(store.getSnapshot().display.songId, "other");
});

test("a live host projection wins over the saved playlist snapshot", async (context) => {
  const { store, fake } = fixture(context);
  fake.projected = { ...getEmptyDisplay(), songId: "live", song: "Live host song" };
  await store.init(reload);
  await settle();
  assert.equal(store.getSnapshot().display.songId, "live");
  assert.deepEqual(fake.callsTo("song.getSongData"), []);
  assert.deepEqual(fake.callsTo("display.project"), []);
});

test("a fresh embedded view switch still follows the host instead of restoring a saved playlist song", async (context) => {
  const { store, fake } = fixture(context);
  await store.init({ entryMode: "embedded" });
  assert.deepEqual(fake.callsTo("song.getSongData"), []);
  assert.deepEqual(fake.callsTo("display.project"), [[FIRST_PROJECTION]]);
});
