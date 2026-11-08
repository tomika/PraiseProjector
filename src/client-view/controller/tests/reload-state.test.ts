import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import { getEmptyDisplay } from "../../../../common/pp-utils";
import type { PlaylistEntry, SongEntry } from "../../../../common/pp-types";
import { installFakeWindow } from "../../../../tests/support/browserEnv";
import { createFakeClientApi } from "../../../../tests/support/fakeClientApi";
import { ClientViewStore } from "../ClientViewStore";

const PLAYLIST: PlaylistEntry[] = [
  { songId: "first", title: "First" },
  { songId: "saved", title: "Saved", transpose: 3, capo: 2, instructions: "Verse" },
];
const SONGS = [
  { songId: "alpha", title: "Alpha" },
  { songId: "beta", title: "Beta" },
] as SongEntry[];
const FIRST_PROJECTION = { songId: "first", transpose: 0, capo: undefined, instructions: undefined };

/** Lets queued host echoes and notifications run. */
const settle = () => new Promise((resolve) => setImmediate(resolve));

function fixture(context: TestContext, options: { playlist?: PlaylistEntry[] } = {}) {
  const env = installFakeWindow({ storage: { "pp-settings": JSON.stringify({ clientViewAutoScanSessions: "off" }) } });
  const fake = createFakeClientApi({
    capabilities: { canControlDisplay: true, canEditWorkingPlaylist: true },
    playlist: options.playlist ?? PLAYLIST,
    songs: SONGS,
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

/** A cold start (or F5) with the client view as the shown view. */
const coldStart = { entryMode: "embedded", restorePersistedViewOnEntry: true } as const;

test("a cold start without a session is never empty: the first playlist row is projected", async (context) => {
  const { store, fake } = fixture(context);
  await store.init(coldStart);
  await settle();
  assert.deepEqual(fake.callsTo("display.project"), [[FIRST_PROJECTION]]);
  assert.equal(store.getSnapshot().display.songId, "first");
  assert.deepEqual(fake.callsTo("song.getSongData"), [], "playlist mode shows the host's projection, never a local copy");
});

test("the song the host restores itself wins over the startup row", async (context) => {
  const { store, fake } = fixture(context);
  const project = fake.api.display.project;
  // The host restores its saved row while the startup row waits in its queue.
  context.mock.method(fake.api.display, "project", (...args: Parameters<typeof project>) => {
    const queued = project(...args);
    fake.emitDisplay({ ...getEmptyDisplay(), songId: "saved", song: "Saved host song", transpose: 3, capo: 2 });
    return queued;
  });
  await store.init(coldStart);
  await settle();
  assert.equal(fake.projected.songId, "saved", "the host drops the startup row once it shows its own song");
  assert.equal(store.getSnapshot().display.songId, "saved");

  fake.emitDisplay({ ...getEmptyDisplay(), songId: "later", song: "Later host song" });
  await settle();
  assert.equal(store.getSnapshot().display.songId, "later", "later host restores are followed too");
});

test("a song the host already shows is followed, nothing is projected", async (context) => {
  const { store, fake } = fixture(context);
  fake.projected = { ...getEmptyDisplay(), songId: "live", song: "Live host song" };
  await store.init(coldStart);
  await settle();
  assert.equal(store.getSnapshot().display.songId, "live");
  assert.deepEqual(fake.callsTo("song.getSongData"), []);
  assert.deepEqual(fake.callsTo("display.project"), []);
});

test("with an empty playlist the first database song is loaded", async (context) => {
  const { store, fake } = fixture(context, { playlist: [] });
  await store.init(coldStart);
  await settle();
  assert.equal(store.getSnapshot().display.songId, "alpha");
  assert.equal(store.getSnapshot().navigationMode, "database");
  assert.deepEqual(fake.callsTo("display.project"), [], "a database song is browsed locally, not projected");
});

test("a playlist the host publishes after the startup database song replaces it with its first row", async (context) => {
  const { store, fake } = fixture(context, { playlist: [] });
  await store.init(coldStart);
  await settle();
  await fake.api.playlist.setPlaylist(PLAYLIST);
  await settle();
  assert.deepEqual(fake.callsTo("display.project"), [[FIRST_PROJECTION]]);
  assert.equal(store.getSnapshot().display.songId, "first");
  assert.equal(store.getSnapshot().navigationMode, "playlist");
});

test("a song the host restores after the startup database song is followed", async (context) => {
  const { store, fake } = fixture(context, { playlist: [] });
  await store.init(coldStart);
  await settle();
  fake.emitDisplay({ ...getEmptyDisplay(), songId: "restored", song: "Restored host song" });
  await settle();
  assert.equal(store.getSnapshot().display.songId, "restored");
  assert.equal(store.getSnapshot().navigationMode, "playlist", "back to the navigation the view had before the fallback");
});

test("a song the host restores while the startup database song is loading is followed instead", async (context) => {
  const { store, fake } = fixture(context, { playlist: [] });
  const getSongData = fake.api.song.getSongData;
  context.mock.method(fake.api.song, "getSongData", (songId: string) => {
    fake.emitDisplay({ ...getEmptyDisplay(), songId: "restored", song: "Restored host song" });
    return getSongData(songId);
  });
  await store.init(coldStart);
  await settle();
  assert.equal(store.getSnapshot().display.songId, "restored");
  assert.equal(store.getSnapshot().navigationMode, "playlist");
});

test("a song the user picks after startup is kept when the playlist arrives", async (context) => {
  const { store, fake } = fixture(context, { playlist: [] });
  await store.init(coldStart);
  await settle();
  await store.selectDatabaseSong("beta");
  await fake.api.playlist.setPlaylist(PLAYLIST);
  await settle();
  assert.deepEqual(fake.callsTo("display.project"), []);
  assert.equal(store.getSnapshot().display.songId, "beta");
});

test("a view following a session loads nothing at startup", async (context) => {
  const { store, fake } = fixture(context, { playlist: [] });
  fake.emitNetwork({ status: "watching", transport: "web" });
  await store.init(coldStart);
  await settle();
  assert.deepEqual(fake.callsTo("display.project"), []);
  assert.deepEqual(fake.callsTo("song.getSongData"), []);
});

test("a fresh embedded view switch still follows the host instead of restoring a saved playlist song", async (context) => {
  const { store, fake } = fixture(context);
  await store.init({ entryMode: "embedded" });
  assert.deepEqual(fake.callsTo("song.getSongData"), []);
  assert.deepEqual(fake.callsTo("display.project"), [[FIRST_PROJECTION]]);
});
