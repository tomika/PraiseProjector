import assert from "node:assert/strict";
import { test } from "node:test";
import { parseRemoteDisplayUpdate } from "../remote-display-update";

test("a transpose preference leaves the highlight, title and instructions alone", () => {
  const update = parseRemoteDisplayUpdate("display_update", { id: "song", transpose: "5", preference: "true" });
  assert.equal(update.from, undefined);
  assert.equal(update.to, undefined);
  assert.equal(update.section, undefined);
  assert.equal(update.abcRange, undefined);
  assert.equal(update.instructions, undefined);
  assert.equal(update.title, undefined);
  assert.equal(update.transpose, 5);
});

test("a legacy song selection still switches the song without a range", () => {
  const update = parseRemoteDisplayUpdate("display_update", { id: "other", transpose: "", capo: "2" });
  assert.equal(update.id, "other");
  assert.equal(update.from, undefined, "the renderer starts the new song unhighlighted");
  assert.equal(update.transpose, undefined);
  assert.equal(update.capo, 2);
});

test("a full update keeps its range and still clears what it leaves out", () => {
  const update = parseRemoteDisplayUpdate("display_update", { id: "song", from: "6", to: "9", section: "1" });
  assert.equal(update.from, 6);
  assert.equal(update.to, 9);
  assert.equal(update.section, 1);
  assert.equal(update.instructions, "");
  assert.equal(update.title, "");
});

test("clearing the highlight sends 0..0", () => {
  const update = parseRemoteDisplayUpdate("display_update", { id: "song", from: 0, to: 0 });
  assert.equal(update.from, 0);
  assert.equal(update.to, 0);
});

test("a number that does not parse means no change", () => {
  const update = parseRemoteDisplayUpdate("song_update", { id: "song", transpose: "abc", capo: "" });
  assert.equal(update.transpose, undefined);
  assert.equal(update.capo, undefined);
});
