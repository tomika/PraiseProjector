import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { createStoreFixture } from "../../../../tests/support/clientViewStoreFixture";

type Fixture = Awaited<ReturnType<typeof createStoreFixture>>;
let fixture: Fixture | null = null;
afterEach(() => {
  fixture?.dispose();
  fixture = null;
});

/** The wand's state: "off", "comments" or "instructions". */
function wand(f: Fixture) {
  const { showInstructions, showSongComments } = f.state();
  return showInstructions ? "instructions" : showSongComments ? "comments" : "off";
}

test("the wand cycles off → song comments → instructions → off, and back", async () => {
  const f = (fixture = await createStoreFixture());
  assert.equal(wand(f), "off");
  const forward: string[] = [];
  for (let i = 0; i < 3; i++) {
    f.store.cycleInstructions();
    forward.push(wand(f));
  }
  assert.deepEqual(forward, ["comments", "instructions", "off"]);
  f.store.cycleInstructions(-1);
  assert.equal(wand(f), "instructions");
});

test("instructions on/off (hardware) returns to the last comments choice", async () => {
  const f = (fixture = await createStoreFixture());
  f.store.cycleInstructions();
  f.store.toggleInstructions(true);
  assert.equal(wand(f), "instructions");
  f.store.toggleInstructions(false);
  assert.equal(wand(f), "comments");
});

test("instructions turned on by the wand keep its comments choice for a hotkey off", async () => {
  const f = (fixture = await createStoreFixture());
  f.store.cycleInstructions();
  f.store.cycleInstructions();
  assert.equal(wand(f), "instructions");
  f.store.toggleInstructions(false);
  assert.equal(wand(f), "comments");
});

test("the comments choice survives a reload", async () => {
  const f = (fixture = await createStoreFixture({
    preferences: { "client-view-state": JSON.stringify({ version: 3, showInstructions: false, showSongComments: true }) },
  }));
  assert.equal(wand(f), "comments");
});
