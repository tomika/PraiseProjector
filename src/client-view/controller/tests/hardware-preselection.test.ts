/**
 * Hardware commands on the preselected song of the options panel's list, over
 * a real store: show it, add it to / remove it from the working playlist, move
 * it there, set its playlist transpose/capo — only while the panel is open, only
 * with something to do, and the playlist edits only where the playlist is editable.
 */
import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import {
  baseRowId,
  clientRowContexts,
  CLIENT_BASE_ROWS,
  type ClientCommand,
  type HardwareActionRow,
  type HardwareKeyboardBinding,
  type PreselectionCommand,
} from "../../../../common/hardware-input";
import { profileConflicts } from "../../../../common/hardware-input-conflicts";
import type { PlaylistEntry } from "../../../../common/pp-types";
import { createStoreFixture, tick } from "../../../../tests/support/clientViewStoreFixture";
import { decideClientRow, executeClientRow } from "../../input/clientViewCommands";
import type { ClientViewState } from "../ClientViewStore";
import { preselectionPlan, selectedLeaderEntriesOf, visibleListRows } from "../preselectionCommands";

type Fixture = Awaited<ReturnType<typeof createStoreFixture>>;
let fixture: Fixture | null = null;
afterEach(() => {
  fixture?.dispose();
  fixture = null;
});

const SONGS = [
  { songId: "s1", title: "One" },
  { songId: "s2", title: "Two" },
  { songId: "s3", title: "Three" },
];
const PLAYLIST: PlaylistEntry[] = [
  { songId: "p1", title: "P One" },
  { songId: "p2", title: "P Two", transpose: 1 },
  { songId: "p3", title: "P Three" },
];
const context = { isCurrent: () => true, source: "keyboard" as const };
const song = (op: Extract<PreselectionCommand, { action: "preselected-song" }>["op"]): PreselectionCommand => ({ action: "preselected-song", op });
const row = (command: PreselectionCommand): HardwareActionRow<ClientCommand> => ({ id: "extra", command });

async function setup(options: { editable?: boolean; mode?: "App" | "Client" } = {}) {
  fixture = await createStoreFixture({
    songs: SONGS,
    playlist: PLAYLIST,
    display: { songId: "s1" },
    mode: options.mode,
    capabilities: { canEditWorkingPlaylist: options.editable ?? true, canControlDisplay: options.mode !== "Client" },
  });
  fixture.store.toggleOptions(false);
  return fixture;
}
/** Opens the options panel on a list and preselects its n-th row. */
function preselect(f: Fixture, listMode: "database" | "playlist", index: number) {
  f.store.setListMode(listMode);
  f.store.toggleOptions(true);
  const target = visibleListRows(f.state())[index].songId;
  for (let step = 0; step < 10 && f.state().hotkeySongId !== target; step++) {
    const at = visibleListRows(f.state()).findIndex((entry) => entry.songId === (f.state().hotkeySongId ?? f.state().display.songId));
    f.store.hotkeyMoveSongSelection(at < index);
  }
  assert.equal(f.state().hotkeySongId, target);
}
const run = (f: Fixture, command: PreselectionCommand) => executeClientRow({ store: f.store, navigateSong: () => undefined }, row(command), context);
const ids = (f: Fixture) => f.state().playlist.map((entry) => entry.songId);

test("only with the options panel open and a visible preselected row; a closed panel leaves the key to song-view rows", async () => {
  const f = await setup();
  assert.equal(decideClientRow(f.state(), row(song("show")), "keyboard"), "no");
  assert.equal(preselectionPlan(f.state(), song("playlist-add")), null);
  assert.equal(await f.store.executePreselectionCommand(song("playlist-add")), false);
  f.store.toggleOptions(true);
  assert.equal(decideClientRow(f.state(), row(song("show")), "keyboard"), "no", "the shown song itself: nothing to show");
  assert.equal(decideClientRow(f.state(), row(song("playlist-add")), "midi"), "yes", "before any move the shown song is the target");
  f.store.setListMode("leaderlists");
  assert.equal(preselectionPlan(f.state(), song("playlist-add")), null, "no leader playlist selected: no visible row");
  assert.deepEqual(clientRowContexts(row(song("move-up"))), ["options"]);
});

test("show: the preselected row is shown as a click would; the feedback names it", async () => {
  const f = await setup();
  preselect(f, "database", 1);
  assert.equal(decideClientRow(f.state(), row(song("show")), "keyboard"), "yes");
  assert.deepEqual(await run(f, song("show")), { value: "Two" });
  await tick();
  assert.deepEqual(f.fake.callsTo("song.getSongData").at(-1), ["s2"]);
  assert.equal(f.state().display.songId, "s2");
  preselect(f, "playlist", 2);
  assert.deepEqual(await run(f, song("show")), { value: "P Three" });
  assert.equal(f.state().navigationMode, "playlist");
});

test("database list: add to / remove from the playlist (toggle too); the cursor stays on the song", async () => {
  const f = await setup();
  preselect(f, "database", 1);
  assert.equal(preselectionPlan(f.state(), song("playlist-remove")), null, "not in the playlist yet");
  assert.deepEqual(await run(f, song("playlist-add")), { value: true });
  assert.deepEqual(ids(f), ["p1", "p2", "p3", "s2"]);
  assert.equal(preselectionPlan(f.state(), song("playlist-add")), null, "already there");
  assert.deepEqual(await run(f, song("playlist-toggle")), { value: false });
  assert.deepEqual(ids(f), ["p1", "p2", "p3"]);
  assert.equal(f.state().hotkeySongId, "s2");
  assert.deepEqual(await run(f, song("playlist-toggle")), { value: true });
  assert.deepEqual(ids(f), ["p1", "p2", "p3", "s2"]);
  for (const command of [song("move-up"), song("move-down"), { action: "preselected-transpose", op: "step", step: 1 } as const]) {
    assert.equal(preselectionPlan(f.state(), command), null, `${JSON.stringify(command)} needs the playlist list itself`);
  }
});

test("playlist list: moving stops at the ends and reports the new position", async () => {
  const f = await setup();
  preselect(f, "playlist", 1);
  assert.deepEqual(await run(f, song("move-up")), { value: "1/3" });
  assert.deepEqual(ids(f), ["p2", "p1", "p3"]);
  assert.equal(f.state().hotkeySongId, "p2", "the cursor travels with the song");
  assert.equal(decideClientRow(f.state(), row(song("move-up")), "keyboard"), "no", "already first");
  await run(f, song("move-down"));
  await run(f, song("move-down"));
  assert.deepEqual(ids(f), ["p1", "p3", "p2"]);
  assert.equal(preselectionPlan(f.state(), song("move-down")), null, "already last");
});

test("playlist list: transpose and capo of the entry step with clamping, set and reset; no-ops have nothing to do", async () => {
  const f = await setup();
  preselect(f, "playlist", 1);
  const entry = () => f.state().playlist.find((item) => item.songId === "p2")!;
  assert.deepEqual(await run(f, { action: "preselected-transpose", op: "step", step: 2 }), { value: 3 });
  assert.equal(entry().transpose, 3);
  await run(f, { action: "preselected-transpose", op: "step", step: 11 });
  assert.equal(entry().transpose, 11);
  assert.equal(preselectionPlan(f.state(), { action: "preselected-transpose", op: "step", step: 1 }), null, "clamped at the top");
  await run(f, { action: "preselected-transpose", op: "set", value: -4 });
  assert.equal(entry().transpose, -4);
  await run(f, { action: "preselected-transpose", op: "reset" });
  assert.equal(entry().transpose, 0);
  assert.equal(preselectionPlan(f.state(), { action: "preselected-transpose", op: "reset" }), null);
  assert.deepEqual(await run(f, { action: "preselected-capo", op: "step", step: -3 }), { value: -1 });
  assert.equal(entry().capo, -1);
  await run(f, { action: "preselected-capo", op: "set", value: 5 });
  assert.equal(entry().capo, 5);
  await run(f, { action: "preselected-capo", op: "reset" });
  assert.equal(entry().capo, 0);
  assert.equal(entry().title, "P Two", "the rest of the entry stays");
});

test("playlist list: a removed row leaves the list, the cursor moves to the next row, or the previous at the end", async () => {
  const f = await setup();
  preselect(f, "playlist", 1);
  assert.deepEqual(await run(f, song("playlist-remove")), { value: false });
  assert.deepEqual(ids(f), ["p1", "p3"]);
  assert.equal(f.state().hotkeySongId, "p3");
  await run(f, song("playlist-toggle"));
  assert.deepEqual(ids(f), ["p1"]);
  assert.equal(f.state().hotkeySongId, "p1");
  await run(f, song("playlist-remove"));
  assert.deepEqual(ids(f), []);
  assert.equal(f.state().hotkeySongId, null);
});

test("a read-only playlist allows only showing; a follower view and open setting panels get nothing", async () => {
  let f = await setup({ editable: false });
  preselect(f, "database", 1);
  assert.equal(decideClientRow(f.state(), row(song("playlist-add")), "keyboard"), "no");
  assert.equal(decideClientRow(f.state(), row(song("show")), "keyboard"), "yes");
  f.store.openZoomDialog();
  assert.equal(decideClientRow(f.state(), row(song("show")), "keyboard"), "protected");
  f.dispose();
  f = fixture = await setup({ mode: "Client" });
  preselect(f, "database", 1);
  assert.equal(decideClientRow(f.state(), row(song("show")), "keyboard"), "no");
  assert.equal(await f.store.executePreselectionCommand(song("show")), false);
  assert.equal(await f.store.executePreselectionCommand(song("show"), () => false), false);
});

test("a key may serve a preselection row in the options panel and a song-view row elsewhere", () => {
  const key = (id: string, rowId: string): HardwareKeyboardBinding => ({
    id,
    rowId,
    kind: "keyboard",
    match: "code",
    key: "F7",
    ctrl: false,
    alt: false,
    shift: false,
    meta: false,
  });
  const profile = {
    id: "p",
    name: "P",
    extraRows: [{ id: "move", command: song("move-down") }],
    bindings: [key("a", "move"), key("b", baseRowId("client-view", "show-next-song"))],
  };
  assert.deepEqual(profileConflicts("client-view", profile), []);
  const optionsRow = CLIENT_BASE_ROWS.find((item) => item.command.action === "select-next-visible-song")!;
  assert.equal(profileConflicts("client-view", { ...profile, bindings: [key("a", "move"), key("b", optionsRow.id)] }).length, 1);
});

test("the visible rows follow the list mode: playlist filter, leader playlist, database search", () => {
  const found = (songId: string) => ({ songId, title: songId, found: { type: "TITLE" as const, cost: 0 } });
  const base = {
    listMode: "playlist",
    playlist: PLAYLIST,
    playlistFilterText: "",
    playlistSearching: false,
    playlistSearchResults: [],
    songs: SONGS,
    searchText: "",
    searching: false,
    searchResults: [],
    leaderProfiles: [{ leaderId: "l1", playlists: [{ label: "2026-10-04", songs: [PLAYLIST[2]] }] }],
    selectedLeaderId: null,
    selectedPlaylistLabel: null,
  };
  const rows = (patch: Record<string, unknown>) => visibleListRows({ ...base, ...patch } as unknown as ClientViewState).map((entry) => entry.songId);
  assert.deepEqual(rows({}), ["p1", "p2", "p3"]);
  assert.deepEqual(rows({ playlistFilterText: "three", playlistSearchResults: [found("p3")] }), ["p3"]);
  assert.deepEqual(rows({ playlistFilterText: "three", playlistSearching: true }), ["p1", "p2", "p3"], "no result yet: the list stays");
  assert.deepEqual(rows({ listMode: "leaderlists" }), [], "no leader selected");
  assert.deepEqual(rows({ listMode: "leaderlists", selectedLeaderId: "l1" }), [], "no dated playlist selected");
  assert.deepEqual(rows({ listMode: "leaderlists", selectedLeaderId: "l1", selectedPlaylistLabel: "2026-10-04" }), ["p3"]);
  assert.deepEqual(selectedLeaderEntriesOf({ ...base, selectedLeaderId: "l2" } as unknown as ClientViewState), []);
  assert.deepEqual(rows({ listMode: "database" }), ["s1", "s2", "s3"]);
  assert.deepEqual(rows({ listMode: "database", searchText: "tw", searchResults: [found("s2")] }), ["s2"]);
  assert.deepEqual(rows({ listMode: "database", searchText: "tw", searching: true }), ["s1", "s2", "s3"], "searching without results yet");
});

test("an entry without a stored transpose/capo counts from zero", async () => {
  const f = await setup();
  preselect(f, "playlist", 0);
  assert.equal(preselectionPlan(f.state(), { action: "preselected-transpose", op: "reset" }), null);
  assert.deepEqual(await run(f, { action: "preselected-transpose", op: "step", step: -2 }), { value: -2 });
  await run(f, { action: "preselected-capo", op: "set", value: 3 });
  assert.equal(preselectionPlan(f.state(), { action: "preselected-capo", op: "set", value: 3 }), null, "already 3");
});

/** Holds the given method of the fake API until the returned release is called. */
function hold<T extends object, K extends keyof T>(target: T, key: K, when: (...args: never[]) => boolean = () => true) {
  const original = target[key] as unknown as (...args: unknown[]) => Promise<unknown>;
  let release!: () => void;
  const gate = new Promise<void>((resolve) => (release = resolve));
  (target as Record<K, unknown>)[key] = async (...args: unknown[]) => {
    if ((when as (...args: unknown[]) => boolean)(...args)) await gate;
    return original(...args);
  };
  return release;
}

test("a slow show never lands over a newer selection, nor after the command stopped being current; no feedback then", async () => {
  const f = await setup();
  preselect(f, "database", 1);
  const release = hold(f.fake.api.song, "getSongData", (songId: string) => songId === "s2");
  const pending = run(f, song("show"));
  assert.equal(await f.store.selectDatabaseSong("s3"), true, "a click meanwhile");
  release();
  assert.equal(await pending, false);
  assert.equal(f.state().display.songId, "s3", "the newer selection stays");

  preselect(f, "database", 0);
  let current = true;
  const releaseAgain = hold(f.fake.api.song, "getSongData", (songId: string) => songId === "s1");
  const stale = executeClientRow({ store: f.store, navigateSong: () => undefined }, row(song("show")), { ...context, isCurrent: () => current });
  current = false;
  releaseAgain();
  assert.equal(await stale, false);
  assert.equal(f.state().display.songId, "s3", "a command that stopped being current changes nothing");
});

test("of two clicks the later one wins, however slow the earlier load is", async () => {
  const f = await setup();
  const release = hold(f.fake.api.song, "getSongData", (songId: string) => songId === "s2");
  const slow = f.store.selectDatabaseSong("s2");
  await f.store.selectDatabaseSong("s3");
  release();
  assert.equal(await slow, false);
  assert.equal(f.state().display.songId, "s3");
});

test("the legacy Home close shows the preselected song only while its command is current", async () => {
  const f = await setup();
  preselect(f, "database", 1);
  let current = true;
  const release = hold(f.fake.api.song, "getSongData", (songId: string) => songId === "s2");
  const closing = f.store.hotkeyToggleOptions(() => current);
  current = false;
  release();
  await closing;
  assert.equal(f.state().display.songId, "s1");
});

test("a late removal leaves a cursor moved meanwhile alone, and a stale one changes no cursor and reports nothing", async () => {
  const f = await setup();
  preselect(f, "playlist", 0);
  let release = hold(f.fake.api.playlist, "setPlaylist");
  const removing = run(f, song("playlist-remove"));
  f.store.hotkeyMoveSongSelection(true);
  f.store.hotkeyMoveSongSelection(true);
  assert.equal(f.state().hotkeySongId, "p3");
  release();
  assert.deepEqual(await removing, { value: false });
  assert.deepEqual(ids(f), ["p2", "p3"]);
  assert.equal(f.state().hotkeySongId, "p3", "the user's newer cursor stays");

  let current = true;
  release = hold(f.fake.api.playlist, "setPlaylist");
  const stale = f.store.executePreselectionCommand(song("playlist-remove"), () => current);
  current = false;
  release();
  assert.equal(await stale, false);
  assert.equal(f.state().hotkeySongId, "p3");
});

test("playlist edits that finish after their command stopped being current report nothing", async () => {
  const f = await setup();
  preselect(f, "playlist", 1);
  for (const command of [song("move-up"), { action: "preselected-transpose", op: "step", step: 1 } as const, song("playlist-remove")]) {
    let current = true;
    const release = hold(f.fake.api.playlist, "setPlaylist");
    const pending = f.store.executePreselectionCommand(command, () => current);
    current = false;
    release();
    assert.equal(await pending, false, JSON.stringify(command));
  }
  preselect(f, "database", 0);
  let current = true;
  const release = hold(f.fake.api.playlist, "setPlaylist");
  const adding = f.store.executePreselectionCommand(song("playlist-add"), () => current);
  current = false;
  release();
  assert.equal(await adding, false);
});

test("a slow playlist projection never lands over a newer selection: the adapter drops it before the display changes", async () => {
  const f = await setup();
  preselect(f, "playlist", 1);
  const release = hold(f.fake.api.display, "project", (request: { songId: string }) => request.songId === "p2");
  const slow = run(f, song("show"));
  assert.equal(await f.store.selectPlaylistEntry(PLAYLIST[2]), true, "a click on P3 meanwhile");
  release();
  assert.equal(await slow, false);
  assert.equal(f.fake.projected.songId, "p3");
  assert.deepEqual(
    f.fake.callsTo("display.project").map(([request]) => (request as { songId: string }).songId),
    ["p3"],
    "P2 never reached the projection"
  );
});
