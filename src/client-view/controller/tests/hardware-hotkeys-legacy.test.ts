/**
 * Characterization of the legacy, focus-dependent hotkey commands that the 13
 * client-view base rows dispatch (R01, R09, R10, R11, R12). These expectations
 * were recorded against the pre-refactor store and must stay green.
 */
import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { createStoreFixture, tick } from "../../../../tests/support/clientViewStoreFixture";

type Fixture = Awaited<ReturnType<typeof createStoreFixture>>;
let fixture: Fixture | null = null;
afterEach(() => {
  fixture?.dispose();
  fixture = null;
});

const songs = [
  { songId: "s1", title: "One" },
  { songId: "s2", title: "Two" },
  { songId: "s3", title: "Three" },
];

async function setup(options: Parameters<typeof createStoreFixture>[0] = {}) {
  fixture = await createStoreFixture({ songs, display: { songId: "s1", transpose: 0, capo: 0 }, ...options });
  // A wide pane auto-opens the options panel on first load; start in the song view.
  fixture.store.toggleOptions(false);
  return fixture;
}

function cycle(f: Fixture, wrap = true) {
  const seen: (string | null)[] = [];
  for (let i = 0; i < 8; i++) {
    f.store.hotkeySelectControl(true, wrap);
    seen.push(f.state().hotkeyActiveControl);
  }
  return seen;
}

test("song-view control cycle order on a wide pane", async () => {
  const f = await setup();
  assert.deepEqual(cycle(f), ["fullscreen", "instructions", "capo", "transpose", "fullscreen", "instructions", "capo", "transpose"]);
});

test("song-view control cycle order on a paging (portrait) layout", async () => {
  const f = await setup({ window: { width: 600, height: 900 } });
  assert.deepEqual(cycle(f).slice(0, 4), ["instructions", "capo", "transpose", "fullscreen"]);
});

test("a follower client never reaches the transpose control and sees the network indicator", async () => {
  const f = await setup({ mode: "Client", capabilities: { canControlDisplay: false } });
  assert.deepEqual(cycle(f).slice(0, 5), ["fullscreen", "instructions", "capo", "network", "fullscreen"]);
});

test("options-panel controls clamp without wrapping and include highlight only when usable", async () => {
  const f = await setup();
  f.store.toggleOptions(true);
  const seen: (string | null)[] = [];
  for (let i = 0; i < 11; i++) {
    f.store.hotkeySelectControl(true);
    seen.push(f.state().hotkeyActiveControl);
  }
  assert.deepEqual(seen, [
    "chord-box",
    "chord-mode",
    "no-sec-chord-dup",
    "subscript",
    "auto-tone",
    "bb",
    "simplified",
    "max-text",
    "theme",
    "theme",
    "theme",
  ]);
  f.store.hotkeySelectControl(false);
  assert.equal(f.state().hotkeyActiveControl, "max-text");
  f.store.hotkeySelectFirstControl();
  assert.equal(f.state().hotkeyActiveControl, "chord-box");
  f.store.hotkeyClearControl();
  assert.equal(f.state().hotkeyActiveControl, null);
});

test("chord-box control cycles in both directions", async () => {
  const f = await setup();
  f.store.toggleOptions(true);
  f.store.hotkeySelectFirstControl();
  const forward: string[] = [];
  for (let i = 0; i < 4; i++) {
    f.store.hotkeyChangeControl(i % 2 === 0 ? 0 : 1);
    forward.push(f.state().displaySettings.chordBoxType);
  }
  assert.deepEqual(forward, ["GUITAR", "PIANO", "NO_CHORDS", ""]);
  f.store.hotkeyChangeControl(-1);
  assert.equal(f.state().displaySettings.chordBoxType, "NO_CHORDS");
});

test("chord-mode control: activate cycles, +/- clamp at the ends", async () => {
  const f = await setup();
  f.store.toggleOptions(true);
  f.store.hotkeySelectControl(true);
  f.store.hotkeySelectControl(true);
  assert.equal(f.state().hotkeyActiveControl, "chord-mode");
  const values: number[] = [];
  for (const direction of [0, 0, 0, 1, 1, 1, -1, -1, -1] as const) {
    f.store.hotkeyChangeControl(direction);
    values.push(f.state().displaySettings.chordMode);
  }
  assert.deepEqual(values, [1, 3, 0, 1, 3, 3, 1, 0, 0]);
});

test("boolean option controls toggle their display setting only", async () => {
  const f = await setup();
  f.store.toggleOptions(true);
  const cases: [string, keyof ReturnType<Fixture["state"]>["displaySettings"]][] = [
    ["no-sec-chord-dup", "noSecChordDup"],
    ["subscript", "subscript"],
    ["auto-tone", "autoTone"],
    ["bb", "bb"],
    ["simplified", "simplified"],
    ["max-text", "maxText"],
  ];
  for (const [control, key] of cases) {
    while (f.state().hotkeyActiveControl !== control) f.store.hotkeySelectControl(true);
    const before = f.state().displaySettings;
    f.store.hotkeyChangeControl(0);
    const after = f.state().displaySettings;
    assert.equal(after[key], !before[key], control);
    assert.deepEqual({ ...after, [key]: before[key] }, before, `${control} changes nothing else`);
    assert.equal(f.state().optionsOpen, true);
    assert.equal(f.state().hotkeyActiveControl, control);
  }
});

test("theme control walks the shared pp-settings.theme preference", async () => {
  const f = await setup();
  f.store.toggleOptions(true);
  while (f.state().hotkeyActiveControl !== "theme") f.store.hotkeySelectControl(true);
  const themes: string[] = [];
  for (let i = 0; i < 3; i++) {
    f.store.hotkeyChangeControl(1);
    themes.push(JSON.parse(f.env.window.localStorage.getItem("pp-settings")!).theme);
  }
  assert.deepEqual(themes, ["light", "dark", "auto"]);
});

test("capo control: legacy use-capo toggling through the value range", async () => {
  const f = await setup();
  while (f.state().hotkeyActiveControl !== "capo") f.store.hotkeySelectControl(true, true);
  f.store.setDisplaySetting("useCapo", false);
  f.store.hotkeyChangeControl(-1);
  assert.equal(f.state().displaySettings.useCapo, false, "decrease never enables capo");
  f.store.hotkeyChangeControl(1);
  assert.equal(f.state().displaySettings.useCapo, true, "increase first only enables capo");
  assert.equal(f.state().capo, 0, "…without changing the value");
  f.store.hotkeyChangeControl(-1);
  await tick();
  assert.equal(f.state().capo, -1);
  f.store.hotkeyChangeControl(-1);
  assert.equal(f.state().displaySettings.useCapo, false, "decrease below -1 turns capo off");
  assert.equal(f.state().capo, -1, "…and keeps the stored value");
  assert.deepEqual(f.fake.callsTo("display.setCapo"), [
    [-1, false],
    [-1, true],
  ]);
});

test("capo and transpose controls clamp at their domain bounds", async () => {
  const f = await setup();
  while (f.state().hotkeyActiveControl !== "capo") f.store.hotkeySelectControl(true, true);
  for (let i = 0; i < 14; i++) {
    f.store.hotkeyChangeControl(1);
    await tick();
  }
  assert.equal(f.state().capo, 11);
  f.store.hotkeySelectControl(true, true);
  assert.equal(f.state().hotkeyActiveControl, "transpose");
  for (let i = 0; i < 14; i++) {
    f.store.hotkeyChangeControl(-1);
    await tick();
  }
  assert.equal(f.state().transpose, -11);
  const transposeCalls = f.fake.callsTo("display.setTranspose");
  assert.deepEqual(transposeCalls.slice(0, 2), [
    [-1, false],
    [-1, true],
  ]);
  assert.deepEqual(transposeCalls.at(-1), [-11, true]);
});

test("transpose of a locally viewed, non-projected song stays local (R12)", async () => {
  const f = await setup();
  f.fake.projected = { ...f.fake.projected, songId: "other-projected" };
  while (f.state().hotkeyActiveControl !== "transpose") f.store.hotkeySelectControl(true, true);
  f.store.hotkeyChangeControl(1);
  await tick();
  assert.equal(f.state().transpose, 1);
  assert.deepEqual(f.fake.callsTo("display.setTranspose"), []);
});

test("instructions, fullscreen and network controls reach their store actions", async () => {
  const f = await setup({ mode: "Client", capabilities: { canControlDisplay: false } });
  const select = (control: string) => {
    while (f.state().hotkeyActiveControl !== control) f.store.hotkeySelectControl(true, true);
  };
  select("instructions");
  const shown = f.state().showInstructions;
  f.store.hotkeyChangeControl(0);
  assert.equal(f.state().showInstructions, !shown);
  select("fullscreen");
  f.store.hotkeyChangeControl(0);
  await tick();
  select("network");
  f.store.hotkeyChangeControl(0);
  await tick();
  assert.equal(f.fake.callsTo("device.toggleFullScreen").length, 1);
  assert.equal(f.fake.callsTo("session.reconnect").length, 1);
});

test("hotkey options toggle: opening preselects the current song, closing applies the moved selection", async () => {
  const f = await setup();
  f.store.toggleOptions(false);
  f.store.setListMode("database");
  await f.store.hotkeyToggleOptions();
  assert.equal(f.state().optionsOpen, true);
  assert.equal(f.state().hotkeySongId, "s1");
  f.store.hotkeyMoveSongSelection(true);
  f.store.hotkeyMoveSongSelection(true);
  f.store.hotkeyMoveSongSelection(true);
  assert.equal(f.state().hotkeySongId, "s3", "selection clamps at the end of the visible list");
  f.store.hotkeyMoveSongSelection(false);
  assert.equal(f.state().hotkeySongId, "s2");
  await f.store.hotkeyToggleOptions();
  assert.equal(f.state().optionsOpen, false);
  assert.equal(f.state().hotkeySongId, null);
  assert.deepEqual(f.fake.callsTo("song.getSongData").at(-1), ["s2"]);
});

test("closing via hotkey without moving the selection does not reload the song", async () => {
  const f = await setup();
  f.store.toggleOptions(false);
  await f.store.hotkeyToggleOptions();
  const loads = f.fake.callsTo("song.getSongData").length;
  await f.store.hotkeyToggleOptions();
  assert.equal(f.fake.callsTo("song.getSongData").length, loads);
});
