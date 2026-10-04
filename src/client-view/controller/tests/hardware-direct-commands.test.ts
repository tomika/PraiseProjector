import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { createStoreFixture } from "../../../../tests/support/clientViewStoreFixture";
import { directCommandChange, type DirectClientCommand } from "../hardwareCommandChanges";
import { decideClientRow, executeClientRow } from "../../input/clientViewCommands";
import { addableFamilies } from "../../../../common/hardware-action-catalog";
import { isPreselectionCommand } from "../../../../common/hardware-input";

type Fixture = Awaited<ReturnType<typeof createStoreFixture>>;
let f: Fixture;
let activeFixture: Fixture | null = null;
function dispose() {
  activeFixture?.dispose();
  activeFixture = null;
}
afterEach(dispose);
async function setup(options: Parameters<typeof createStoreFixture>[0] = {}) {
  f = await createStoreFixture({ display: { songId: "s1", transpose: 0, capo: 0 }, ...options });
  activeFixture = f;
  return f;
}
const run = (command: DirectClientCommand) => f.store.executeDirectInputCommand(command);

test("hidden chord and diagram memories restore from version-3 device preferences; old snapshots acquire defaults", async () => {
  await setup({
    preferences: {
      "client-view-state": JSON.stringify({
        version: 3,
        displaySettings: { chordBoxType: "NO_CHORDS", lastVisibleChordMode: "PIANO", lastDiagramType: "PIANO" },
      }),
    },
  });
  await run({ action: "chord-visibility", op: "on" });
  assert.equal(f.state().displaySettings.chordBoxType, "PIANO");
  await run({ action: "chord-diagram", op: "off" });
  await run({ action: "chord-diagram", op: "on" });
  assert.equal(f.state().displaySettings.chordBoxType, "PIANO");
  dispose();
  await setup({ preferences: { "client-view-state": JSON.stringify({ version: 3, displaySettings: { chordBoxType: "PIANO" } }) } });
  assert.equal(f.state().displaySettings.lastVisibleChordMode, "PIANO");
  assert.equal(f.state().displaySettings.lastDiagramType, "PIANO");
  await run({ action: "chord-visibility", op: "off" });
  await run({ action: "chord-visibility", op: "on" });
  assert.equal(f.state().displaySettings.chordBoxType, "PIANO");
});

test("all P0 operation/parameter combinations execute the actual store in either context without changing semantic focus", async () => {
  await setup();
  // The preselected-song families edit lists, not the display (hardware-preselection.test.ts).
  for (const family of addableFamilies("client-view").filter((item) => !isPreselectionCommand(item))) {
    for (const op of family.ops) {
      const values = !op.param ? [undefined] : op.param.kind === "enum" ? op.param.values : [op.param.min, op.param.default, op.param.max];
      for (const value of values) {
        const command = {
          action: family.action,
          ...(family.action === "capo-apply" ? {} : { op: op.op }),
          ...(op.param ? { [op.param.name]: value } : {}),
        } as DirectClientCommand;
        for (const options of [false, true]) {
          f.store.toggleOptions(options);
          f.store.hotkeySelectFirstControl();
          const focus = f.state().hotkeyActiveControl;
          const expected = directCommandChange(f.state(), command);
          await run(command);
          for (const [key, val] of Object.entries(expected)) assert.deepEqual(f.state()[key as "capo"], val, JSON.stringify(command));
          assert.equal(f.state().optionsOpen, options);
          assert.equal(f.state().hotkeyActiveControl, focus);
        }
      }
    }
  }
});
test("every fixed transpose/capo value works; repeats emit no change or adapter call; boundaries clamp", async () => {
  await setup();
  for (const action of ["transpose", "capo"] as const) {
    for (let value = action === "transpose" ? -11 : -1; value <= 11; value++) {
      await run({ action, op: "set", value });
      assert.equal(f.state()[action], value);
      const calls = f.fake.calls.length;
      let notifications = 0;
      const unsubscribe = f.store.subscribe(() => notifications++);
      assert.equal(await run({ action, op: "set", value }), false);
      unsubscribe();
      assert.equal(notifications, 0);
      assert.equal(f.fake.calls.length, calls);
    }
    await run({ action, op: "step", step: 1 });
    assert.equal(f.state()[action], 11);
    await run({ action, op: "reset" });
    assert.equal(f.state()[action], 0);
  }
});
test("capo value and use are independent; apply turns it on; negative/zero remain distinct", async () => {
  await setup();
  await run({ action: "capo-use", op: "off" });
  await run({ action: "capo", op: "set", value: -1 });
  assert.equal(f.state().displaySettings.useCapo, false);
  assert.equal(f.state().capo, -1);
  await run({ action: "capo", op: "reset" });
  assert.equal(f.state().displaySettings.useCapo, false);
  assert.equal(f.state().capo, 0);
  await run({ action: "capo-apply", value: 3 });
  assert.equal(f.state().displaySettings.useCapo, true);
  await run({ action: "capo-use", op: "off" });
  await run({ action: "capo-use", op: "on" });
  assert.equal(f.state().capo, 3);
});
test("separate chord memories work with screen selections; idempotent on/off retains the current mode", async () => {
  await setup();
  await run({ action: "chord-visibility", op: "on" });
  f.store.setDisplaySetting("chordBoxType", "PIANO");
  await run({ action: "chord-diagram", op: "on" });
  assert.equal(f.state().displaySettings.chordBoxType, "PIANO");
  await run({ action: "chord-visibility", op: "off" });
  await run({ action: "chord-visibility", op: "on" });
  assert.equal(f.state().displaySettings.chordBoxType, "PIANO");
  await run({ action: "chord-diagram", op: "off" });
  assert.equal(f.state().displaySettings.chordBoxType, "");
  await run({ action: "chord-diagram", op: "on" });
  assert.equal(f.state().displaySettings.chordBoxType, "PIANO");
  for (let i = 0; i < 4; i++) await run({ action: "chord-mode", op: "next" });
  assert.equal(f.state().displaySettings.chordBoxType, "PIANO");
});
test("font commands activate manual zoom, zoom remembers its sizing mode; cyclic off is distinct", async () => {
  await setup();
  await run({ action: "zoom-font", op: "set", value: 64 });
  await run({ action: "zoom-font", op: "step", step: 1 });
  assert.equal(f.state().displaySettings.zoomFontSize, 64);
  assert.equal(f.state().displaySettings.zoomSizingMode, "MANUAL");
  await run({ action: "zoom", op: "off" });
  await run({ action: "zoom", op: "on" });
  assert.equal(f.state().displaySettings.zoomSizingMode, "MANUAL");
  await run({ action: "zoom-mode", op: "next" });
  assert.equal(f.state().displaySettings.maxText, false);
  await run({ action: "zoom-mode", op: "previous" });
  assert.equal(f.state().displaySettings.zoomSizingMode, "MANUAL");
});
test("follower transpose is blocked and capo stays local; a locally browsed song never changes the projected one", async () => {
  await setup({ mode: "Client", capabilities: { canControlDisplay: false } });
  assert.equal(await run({ action: "transpose", op: "set", value: 3 }), false);
  await run({ action: "capo", op: "set", value: 4 });
  assert.equal(f.state().capo, 4);
  assert.equal(f.fake.callsTo("display.setCapo").length, 0);
  dispose();
  await setup({
    songs: [
      { songId: "s1", title: "One" },
      { songId: "s2", title: "Two" },
    ],
  });
  await f.store.selectDatabaseSong("s2");
  await run({ action: "transpose", op: "set", value: 2 });
  assert.equal(f.fake.callsTo("display.setTranspose").length, 0);
});
test("an await cannot commit to another song, profile, disposed target or lost permission; adapter errors propagate", async () => {
  for (const invalidation of ["song", "profile", "permission", "dispose", "network"] as const) {
    await setup();
    const release = f.fake.holdDisplayWrites();
    let current = true;
    const pending = f.store.executeDirectInputCommand({ action: "transpose", op: "set", value: 3 }, () => current);
    if (invalidation === "song") f.fake.projected = { ...f.fake.projected, songId: "other" };
    if (invalidation === "profile") current = false;
    if (invalidation === "permission") {
      f.fake.emitCapabilities({ canControlDisplay: false });
      f.fake.emitNetwork({ status: "watching" });
    }
    if (invalidation === "dispose") f.store.dispose();
    if (invalidation === "network") f.fake.emitNetwork({ status: "offline" });
    release();
    assert.equal(await pending, false);
    assert.equal(f.fake.callsTo("display.setTranspose").filter((call) => call[1] === true).length, 0);
    dispose();
  }
  await setup();
  const hold = f.fake.holdDisplayWrites();
  const repeated = f.store.executeDirectInputCommand({ action: "transpose", op: "set", value: 3 });
  f.fake.emitNetwork({ status: "online" });
  hold();
  assert.equal(await repeated, true, "a poll re-emitting an equal network state keeps the target");
  assert.equal(f.fake.callsTo("display.setTranspose").filter((call) => call[1] === true).length, 1);
  dispose();
  await setup();
  f.fake.api.display.setTranspose = async () => {
    throw new Error("write failed");
  };
  await assert.rejects(run({ action: "transpose", op: "set", value: 3 }), /write failed/);
  assert.equal(await run({ action: "transpose", op: "set", value: NaN }), false);
});
test("direct panel policy and semantic entry check real modal state; execution uses the generation guard", async () => {
  await setup();
  const row = { id: "extra", command: { action: "zoom-font", op: "set", value: 30 } as const };
  f.store.openZoomDialog();
  assert.equal(decideClientRow(f.state(), row, "midi"), "yes");
  assert.equal(decideClientRow(f.state(), { id: "capo", command: { action: "capo", op: "set", value: 2 } }, "midi"), "protected");
  await executeClientRow({ store: f.store, navigateSong: () => {} }, row, { source: "midi", isCurrent: () => false });
  assert.notEqual(f.state().displaySettings.zoomFontSize, 30);
  f.store.openLoginDialog();
  await executeClientRow({ store: f.store, navigateSong: () => {} }, row, { source: "midi", isCurrent: () => true });
  assert.notEqual(f.state().displaySettings.zoomFontSize, 30);
});
