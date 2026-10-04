/**
 * The client-view hardware target over a real store: modal and setting-panel
 * protection, legacy song-view/options contexts, and the base-row command
 * mapping onto the store's semantic methods.
 */
import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { CLIENT_BASE_ROWS, type ClientCommand, type HardwareActionRow } from "../../../../common/hardware-input";
import { clientContext, decideClientRow, executeClientRow } from "../clientViewCommands";
import { createStoreFixture, tick } from "../../../../tests/support/clientViewStoreFixture";

type Fixture = Awaited<ReturnType<typeof createStoreFixture>>;
let fixture: Fixture | null = null;
afterEach(() => {
  fixture?.dispose();
  fixture = null;
});

const row = (action: string) => CLIENT_BASE_ROWS.find((candidate) => candidate.command.action === action) as HardwareActionRow<ClientCommand>;
const context = { isCurrent: () => true, source: "keyboard" as const };

async function setup() {
  fixture = await createStoreFixture({
    songs: [
      { songId: "s1", title: "One" },
      { songId: "s2", title: "Two" },
    ],
    display: { songId: "s1" },
  });
  fixture.store.toggleOptions(false);
  return fixture;
}

test("legacy rows follow the song-view / options contexts", async () => {
  const f = await setup();
  assert.equal(clientContext(f.state()), "song-view");
  assert.equal(decideClientRow(f.state(), row("show-next-song"), "keyboard"), "yes");
  assert.equal(decideClientRow(f.state(), row("select-next-visible-song"), "keyboard"), "no");
  assert.equal(decideClientRow(f.state(), row("toggle-options"), "midi"), "yes");
  f.store.toggleOptions(true);
  assert.equal(clientContext(f.state()), "options");
  assert.equal(decideClientRow(f.state(), row("show-next-song"), "keyboard"), "fallback", "the song beside the open panel can still turn");
  assert.equal(decideClientRow(f.state(), row("show-previous-song"), "midi"), "fallback");
  assert.equal(decideClientRow(f.state(), row("cycle-next-main-control"), "keyboard"), "no");
  assert.equal(decideClientRow(f.state(), row("select-next-visible-song"), "keyboard"), "yes");
  f.store.toggleOptions(false);
  assert.equal(decideClientRow(f.state(), row("select-next-visible-song"), "keyboard"), "no", "no fallback into the hidden list");
});

test("real modals protect every row; setting panels protect the legacy navigation", async () => {
  const f = await setup();
  f.store.openLoginDialog();
  assert.equal(decideClientRow(f.state(), row("toggle-options"), "keyboard"), "protected");
  f.store.closeLoginDialog();
  f.store.openAbout();
  assert.equal(decideClientRow(f.state(), row("toggle-options"), "midi"), "protected");
  f.store.closeAbout();
  void f.store.confirm("erase");
  assert.equal(decideClientRow(f.state(), row("clear-control"), "keyboard"), "protected");
  f.store.resolveConfirm(false);
  f.store.openZoomDialog();
  assert.equal(decideClientRow(f.state(), row("show-next-song"), "keyboard"), "protected");
  f.store.closeZoomDialog();
  f.store.openHighlightOpacityDialog();
  assert.equal(decideClientRow(f.state(), row("show-next-song"), "keyboard"), "protected");
  f.store.closeHighlightOpacityDialog();
  f.store.openInstructionsEditor();
  assert.equal(decideClientRow(f.state(), row("show-next-song"), "keyboard"), "protected");
  f.store.closeInstructionsEditor();
  assert.equal(decideClientRow(f.state(), row("show-next-song"), "keyboard"), "yes");
  // A full-app dialog portaled over the embedded client view (DB sync, message box).
  assert.equal(decideClientRow(f.state(), row("show-next-song"), "keyboard", true), "protected");
  assert.equal(decideClientRow(f.state(), { id: "x", command: { action: "capo", op: "set", value: 2 } }, "midi", true), "protected");
});

test("base rows execute the same store methods the legacy dispatcher called", async () => {
  const f = await setup();
  const navigations: boolean[] = [];
  const deps = { store: f.store, navigateSong: (next: boolean) => navigations.push(next) };
  executeClientRow(deps, row("show-next-song"), context);
  executeClientRow(deps, row("show-previous-song"), context);
  assert.deepEqual(navigations, [true, false]);
  await executeClientRow(deps, row("toggle-options"), context);
  assert.equal(f.state().optionsOpen, true);
  assert.equal(f.state().hotkeySongId, "s1");
  executeClientRow(deps, row("select-next-visible-song"), context);
  assert.equal(f.state().hotkeySongId, "s2");
  executeClientRow(deps, row("select-previous-visible-song"), context);
  assert.equal(f.state().hotkeySongId, "s1");
  executeClientRow(deps, row("select-first-control"), context);
  assert.equal(f.state().hotkeyActiveControl, "chord-box");
  executeClientRow(deps, row("select-next-option-control"), context);
  assert.equal(f.state().hotkeyActiveControl, "chord-mode");
  executeClientRow(deps, row("select-previous-option-control"), context);
  assert.equal(f.state().hotkeyActiveControl, "chord-box");
  executeClientRow(deps, row("activate-option-control"), context);
  assert.equal(f.state().displaySettings.chordBoxType, "GUITAR");
  executeClientRow(deps, row("clear-control"), context);
  assert.equal(f.state().hotkeyActiveControl, null);
  f.store.toggleOptions(false);
  executeClientRow(deps, row("cycle-next-main-control"), context);
  assert.equal(f.state().hotkeyActiveControl, "fullscreen");
  executeClientRow(deps, row("cycle-next-main-control"), context);
  executeClientRow(deps, row("increase-main-control"), context);
  assert.equal(f.state().showInstructions, true);
  executeClientRow(deps, row("decrease-main-control"), context);
  assert.equal(f.state().showInstructions, false);
  await tick();
});
