import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import { installFakeWindow } from "../../../../tests/support/browserEnv";
import { createFakeClientApi } from "../../../../tests/support/fakeClientApi";
import { ClientViewStore } from "../ClientViewStore";

async function fixture(context: TestContext) {
  const env = installFakeWindow({ storage: { "pp-settings": JSON.stringify({ clientViewAutoScanSessions: "off" }) } });
  const fake = createFakeClientApi({ display: { songId: "projected", instructions: "Verse" } });
  const store = new ClientViewStore(fake.api);
  context.after(() => {
    store.dispose();
    env.restore();
  });
  await store.init({ entryMode: "embedded" });
  return { store, fake };
}

test("saving instructions applies locally without waiting for a display echo, and reopening retains them", async (context) => {
  const { store, fake } = await fixture(context);
  store.openInstructionsEditor();
  await store.saveInstructions("Vsz 1 2x\nVsz 2");
  assert.deepEqual(fake.callsTo("display.setInstructions"), [["Vsz 1 2x\nVsz 2"]]);
  assert.equal(store.getSnapshot().display.instructions, "Vsz 1 2x\nVsz 2");
  assert.equal(store.getSnapshot().instructionsEditorOpen, false);
  store.openInstructionsEditor();
  assert.equal(store.getSnapshot().instructionsEditorText, "Vsz 1 2x\nVsz 2");
});

test("resetting instructions sends an explicit empty value to the host", async (context) => {
  const { store, fake } = await fixture(context);
  await store.saveInstructions("");
  assert.deepEqual(fake.callsTo("display.setInstructions"), [[""]]);
  assert.equal(store.getSnapshot().display.instructions, "");
});

test("saving instructions for a locally opened song leaves the projected song alone", async (context) => {
  const { store, fake } = await fixture(context);
  await store.selectDatabaseSong("local");
  store.openInstructionsEditor();
  await store.saveInstructions("Vsz 1 2x");
  assert.deepEqual(fake.callsTo("display.setInstructions"), []);
  assert.equal(store.getSnapshot().display.songId, "local");
  assert.equal(store.getSnapshot().display.instructions, "Vsz 1 2x");
  assert.equal(fake.projected.instructions, "Verse");
});

test("a rejected save retains the draft and leaves the instructions dialog open", async (context) => {
  const { store, fake } = await fixture(context);
  context.mock.method(fake.api.display, "setInstructions", async () => {
    throw new Error("offline");
  });
  store.openInstructionsEditor();
  await assert.rejects(store.saveInstructions("Vsz 1 2x"), /offline/);
  assert.equal(store.getSnapshot().instructionsEditorOpen, true);
  assert.equal(store.getSnapshot().display.instructions, "Verse");
});

test("a delayed save does not overwrite a song selected in the meantime", async (context) => {
  const { store, fake } = await fixture(context);
  let complete!: () => void;
  context.mock.method(
    fake.api.display,
    "setInstructions",
    () =>
      new Promise<void>((resolve) => {
        complete = resolve;
      })
  );
  store.openInstructionsEditor();
  const saving = store.saveInstructions("Vsz 1 2x");
  await store.selectDatabaseSong("local");
  store.openInstructionsEditor();
  complete();
  await saving;
  assert.equal(store.getSnapshot().display.songId, "local");
  assert.equal(store.getSnapshot().display.instructions, undefined);
  assert.equal(store.getSnapshot().instructionsEditorOpen, true);
});

test("a delayed save from an earlier client-view session cannot close or overwrite a newly opened editor", async (context) => {
  const { store, fake } = await fixture(context);
  let complete!: () => void;
  context.mock.method(
    fake.api.display,
    "setInstructions",
    () =>
      new Promise<void>((resolve) => {
        complete = resolve;
      })
  );
  store.openInstructionsEditor();
  const saving = store.saveInstructions("Old edit");
  store.dispose();
  await store.init({ entryMode: "embedded" });
  store.openInstructionsEditor();
  store.setInstructionsEditorText("New edit");
  complete();
  await saving;
  assert.equal(store.getSnapshot().instructionsEditorOpen, true);
  assert.equal(store.getSnapshot().instructionsEditorText, "New edit");
  assert.equal(store.getSnapshot().display.instructions, "Verse");
});
