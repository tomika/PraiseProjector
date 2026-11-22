import assert from "node:assert/strict";
import { test } from "node:test";
import { ChordProDocument, getChordSystem } from "../../../../chordpro/chordpro_base";
import { Instructions } from "../../../../chordpro/chordpro_instructions";
import { projectDisplaySequence } from "../../../../chordpro/render/display-plan";
import { insertTransitionInstruction, parseTransitionInstruction } from "../../../../chordpro/transition-instruction";
import { MAX_CHORD_TRANSITION_RECOMMENDATIONS, normalizeChordTransitionSettings } from "../../../../common/chord-transition-settings";
import { CLIENT_BASE_ROWS } from "../../../../common/hardware-input";
import type { Display } from "../../../../common/pp-types";
import { createStoreFixture, tick } from "../../../../tests/support/clientViewStoreFixture";
import { decideClientRow, executeClientRow } from "../../input/clientViewCommands";
import { recommendSongTransition } from "../songTransitions";

const settings = normalizeChordTransitionSettings({ enabled: true, order: "steps", autoClose: false });
const before: Display = {
  songId: "before",
  system: "S",
  song: "{key: C}\n{start_of_grid: Intro}\n| C G7 |\n{end_of_grid}\n{start_of_verse: Verse}\n[Am]the verse [F]\n{end_of_verse}",
  from: 0,
  to: 0,
  transpose: 0,
};
const after: Display = {
  ...before,
  songId: "after",
  song: "{key: D}\n{start_of_verse: Verse}\n[D]the verse\n{end_of_verse}\n{start_of_grid: Intro}\n| Bm A7 |\n{end_of_grid}",
};
const playlist = [before, after, { songId: "third" }].map(({ songId }) => ({ songId, title: songId }));

test("endpoints come from the highlight, the instructed order or the raw song, including grids", async () => {
  const source = { ...before, instructions: "Verse\nIntro", capo: 4 };
  const target = { ...after, instructions: "Intro +2\nVerse" };
  const instructed = await recommendSongTransition(source, target, undefined, settings, true);
  assert.ok(instructed);
  assert.deepEqual(instructed.recommendations[0].chords, ["G7", "C#m"]);
  assert.ok(instructed.recommendations.every((item) => item.chords[0] === "G7" && item.chords.at(-1) === "C#m"));
  assert.equal(instructed.durationMs, 0);
  const highlighted = await recommendSongTransition(source, target, { ...source, from: 5, to: 6 }, settings, true);
  assert.equal(highlighted?.recommendations[0].chords[0], "F");
  const raw = await recommendSongTransition(before, after, undefined, settings, true);
  assert.deepEqual(raw?.recommendations[0].chords, ["F", "D"]);
  assert.equal(await recommendSongTransition(before, { ...after, song: after.song.replace("key: D", "key: C") }, undefined, settings, true), null);
});

test("the maximum leaves room for both enabled styles and preserves the chosen order", async () => {
  for (const order of ["steps", "quality"] as const) {
    const options = { ...settings, order, maxRecommendations: 4 };
    const dialog = await recommendSongTransition(before, after, undefined, options, true);
    assert.ok(dialog);
    const { recommendations } = dialog;
    assert.equal(recommendations.length, options.maxRecommendations);
    for (const style of ["pop", "cadential"] as const) {
      const sameStyle = recommendations.filter((item) => item.style === style);
      assert.equal(sameStyle.length, 2);
      assert.equal(Math.max(...sameStyle.map(({ rating }) => rating)), 5);
    }
    assert.equal(new Set(recommendations.map(({ chords }) => chords.join(" "))).size, recommendations.length);
    if (order === "steps") {
      const lengths = recommendations.map(({ chords }) => chords.length);
      assert.deepEqual(
        lengths,
        [...lengths].sort((a, b) => a - b)
      );
    } else {
      const ratings = recommendations.map(({ rating }) => rating);
      assert.deepEqual(
        ratings,
        [...ratings].sort((a, b) => b - a)
      );
    }
  }
});

test("the recommendation limit is a ceiling, with a default for older settings", async () => {
  assert.equal(settings.maxRecommendations, 5);
  assert.equal(normalizeChordTransitionSettings({ maxRecommendations: 0 }).maxRecommendations, 1);
  assert.equal(normalizeChordTransitionSettings({ maxRecommendations: 999 }).maxRecommendations, MAX_CHORD_TRANSITION_RECOMMENDATIONS);
  const one = await recommendSongTransition(before, after, undefined, { ...settings, maxRecommendations: 1 }, true);
  assert.equal(one?.recommendations.length, 1);
  const direct = await recommendSongTransition(before, after, undefined, { ...settings, maxSteps: 0 }, true);
  assert.equal(direct?.recommendations.length, 1);
  const pop = await recommendSongTransition(before, after, undefined, { ...settings, styles: ["pop"], maxRecommendations: 3 }, true);
  assert.deepEqual(
    pop?.recommendations.map(({ style }) => style),
    ["pop", "pop", "pop"]
  );
});

test("dialog style switches fill freed slots and reset for the next song change", async (t) => {
  const f = await createStoreFixture({
    config: { entryMode: "embedded" },
    settings: { clientViewChordTransitions: { ...settings, maxRecommendations: 4, styles: ["pop"] } },
    display: before,
    playlist,
  });
  t.after(f.dispose);
  f.fake.emitDisplay(after);
  await tick();
  const initial = f.state().transitionDialog;
  assert.ok(initial && !initial.saved);
  assert.deepEqual(initial.styles, ["pop"]);
  assert.equal(initial.recommendations.length, 4);
  f.store.toggleChordTransitionStyle("cadential");
  const mixed = f.state().transitionDialog;
  assert.ok(mixed && !mixed.saved);
  assert.deepEqual(mixed.styles, ["pop", "cadential"]);
  assert.equal(mixed.recommendations.filter(({ style }) => style === "pop").length, 2);

  f.store.toggleChordTransitionStyle("cadential");
  const pop = f.state().transitionDialog;
  assert.ok(pop && !pop.saved);
  assert.deepEqual(pop.styles, ["pop"]);
  assert.deepEqual(
    pop.recommendations.map(({ style }) => style),
    ["pop", "pop", "pop", "pop"]
  );
  assert.equal(pop.pair, mixed.pair);
  assert.ok(pop.recommendations.every(({ chords }) => chords[0] === "F" && chords.at(-1) === "D"));
  f.store.toggleChordTransitionStyle("pop");
  assert.equal(f.state().transitionDialog, pop);

  f.store.toggleChordTransitionStyle("cadential");
  assert.deepEqual(f.state().transitionDialog?.recommendations, mixed.recommendations);
  f.store.toggleChordTransitionStyle("pop");
  assert.deepEqual(
    f.state().transitionDialog?.recommendations.map(({ style }) => style),
    Array(4).fill("cadential")
  );

  f.fake.emitDisplay(before);
  await tick();
  const next = f.state().transitionDialog;
  assert.ok(next && !next.saved);
  assert.deepEqual(next.styles, ["pop"]);
});

test("a transition instruction is a round-trippable comment and keeps plain song rows", () => {
  const transition = {
    from: before.songId,
    to: after.songId,
    placement: "next",
    sourceKey: "C",
    targetKey: "D",
    chords: ["F", "A7", "D"],
    rating: 5,
    style: "cadential",
  } as const;
  const text = insertTransitionInstruction("", { ...transition, chords: [...transition.chords] });
  assert.deepEqual(parseTransitionInstruction(text), transition);
  const document = new ChordProDocument(getChordSystem("S"), "[D]Plain song");
  const instructions = new Instructions();
  instructions.parse(text, document);
  const render = () => projectDisplaySequence({ document, readOnly: true, instructions, instructionsMode: "FULL" }).lines;
  assert.equal(instructions.format(), text);
  assert.deepEqual(
    render().map(({ line }) => line.lyrics),
    ["♪⌒♪ F → A7 → D", "Plain song"]
  );
  instructions.transitionVisible = () => false;
  assert.deepEqual(
    render().map(({ line }) => line.lyrics),
    ["Plain song"]
  );
  instructions.parse(
    insertTransitionInstruction("Verse\\nIntro", { ...transition, chords: [...transition.chords] }),
    new ChordProDocument(getChordSystem("S"), before.song)
  );
  assert.deepEqual(
    instructions.items.slice(1).map(({ value }) => value),
    ["Verse", "Intro"]
  );
});

test("locally saved instructions survive host echoes and can be edited while the same song is projected", async (t) => {
  const f = await createStoreFixture({
    config: { entryMode: "embedded" },
    settings: { clientViewChordTransitions: settings },
    display: before,
    songs: playlist,
    playlist,
  });
  t.after(f.dispose);
  t.mock.method(f.fake.api.song, "getSongData", async (songId: string) => ({ text: (songId === before.songId ? before : after).song, system: "S" }));
  await f.store.selectDatabaseSong(before.songId);
  await f.store.selectDatabaseSong(after.songId);
  await tick();
  const dialog = f.state().transitionDialog;
  assert.ok(dialog && f.store.canSaveChordTransition(dialog));
  const lostWrite = t.mock.method(f.fake.api.device, "setPreference", () => undefined);
  await assert.rejects(f.store.saveChordTransition(dialog, dialog.recommendations[0]), /not saved/);
  assert.equal(f.state().transitionDialog, dialog);
  lostWrite.mock.restore();
  await f.store.saveChordTransition(dialog, dialog.recommendations[0]);
  const saved = f.state().display.instructions;
  assert.match(saved ?? "", /♪⌒♪/);
  f.fake.emitDisplay({ ...after, instructions: "Verse" });
  assert.equal(f.state().display.instructions, saved);
  await f.store.saveInstructions("");
  f.fake.emitDisplay({ ...after, instructions: "Verse" });
  assert.equal(f.state().display.instructions, "");
  assert.deepEqual(f.fake.callsTo("display.setInstructions"), []);
});

test("existing dialogs and the first frame of a followed session do not start a transition popup", async (t) => {
  const f = await createStoreFixture({
    config: { entryMode: "embedded" },
    settings: { clientViewChordTransitions: settings },
    display: before,
    playlist,
  });
  t.after(f.dispose);
  f.store.openAbout();
  f.fake.emitDisplay(after);
  await tick();
  assert.equal(f.state().transitionDialog, null);
  f.store.closeAbout();

  f.fake.emitNetwork({ status: "startup", transport: "web" });
  f.fake.emitNetwork({ status: "watching", transport: "web" });
  f.fake.emitDisplay(before);
  await tick();
  assert.equal(f.state().transitionDialog, null);
  f.fake.emitDisplay(after);
  await tick();
  assert.ok(f.state().transitionDialog);
  f.store.openAbout();
  assert.equal(f.state().transitionDialog, null);
});

test("the store remembers a cleared highlight, saves the previous playlist row, and recalls only a forward neighbour", async (t) => {
  const f = await createStoreFixture({
    config: { entryMode: "embedded" },
    settings: { clientViewChordTransitions: { ...settings, placement: "previous" } },
    capabilities: { canControlDisplay: true, canEditWorkingPlaylist: true },
    display: before,
    playlist,
  });
  t.after(f.dispose);
  f.fake.emitDisplay({ ...before, from: 2, to: 3 });
  f.fake.emitDisplay(before);
  f.fake.emitDisplay(after);
  await tick();
  const dialog = f.state().transitionDialog;
  assert.ok(dialog);
  assert.equal(dialog.recommendations[0].chords[0], "G7");
  assert.equal(f.store.canSaveChordTransition(dialog), true);
  await f.store.saveChordTransition(dialog, dialog.recommendations[0]);
  const savedText = String(f.fake.callsTo("playlist.setEntryInstructions")[0][1]);
  const saved = parseTransitionInstruction(savedText.split("\n").at(-1)!);
  assert.equal(saved?.placement, "previous");
  assert.equal(f.state().display.instructions, undefined);
  f.fake.emitDisplay({ ...before, instructions: savedText });
  await tick();
  assert.equal(f.state().transitionDialog?.saved, false);
  assert.equal(f.store.canSaveChordTransition(f.state().transitionDialog!), false);
  f.fake.emitDisplay(after);
  await tick();
  assert.equal(f.state().transitionDialog?.saved, true);
  const recalled = f.state().transitionDialog;
  f.store.toggleChordTransitionStyle("pop");
  assert.equal(f.state().transitionDialog, recalled);
  assert.deepEqual(
    f.state().transitionDialog?.recommendations.map((item) => item.chords),
    [saved?.chords]
  );
  f.store.dismissChordTransition();
  f.store.toggleInstructions(true);
  f.fake.emitDisplay({ ...before, instructions: savedText });
  await tick();
  f.fake.emitDisplay(after);
  await tick();
  assert.equal(f.state().transitionDialog, null);
});

test("a paging hardware event dismisses the dialog without turning again, and a jump cannot save", async (t) => {
  const f = await createStoreFixture({
    config: { entryMode: "embedded" },
    settings: { clientViewChordTransitions: settings },
    display: before,
    playlist,
  });
  t.after(f.dispose);
  f.fake.emitDisplay({ ...after, songId: "third" });
  await tick();
  assert.ok(f.state().transitionDialog);
  assert.equal(f.store.canSaveChordTransition(f.state().transitionDialog!), false);
  const row = CLIENT_BASE_ROWS.find(({ command }) => command.action === "show-next-song")!;
  assert.equal(decideClientRow(f.state(), row, "midi"), "yes");
  await executeClientRow({ store: f.store, navigateSong: () => assert.fail("song changed") }, row, { isCurrent: () => true, source: "midi" });
  assert.equal(f.state().transitionDialog, null);
  assert.equal(f.state().display.songId, "third");
});

test("a paging hardware event still turns while the recommendation is being calculated", async (t) => {
  const f = await createStoreFixture({
    config: { entryMode: "embedded" },
    settings: { clientViewChordTransitions: settings },
    display: before,
    playlist,
  });
  t.after(f.dispose);
  f.fake.emitDisplay(after);
  assert.equal(f.state().transitionDialog, null);
  const row = CLIENT_BASE_ROWS.find(({ command }) => command.action === "show-next-song")!;
  const turns: boolean[] = [];
  await executeClientRow({ store: f.store, navigateSong: (next) => void turns.push(next) }, row, { isCurrent: () => true, source: "midi" });
  assert.deepEqual(turns, [true]);
});

test("a prepended transition is visible only after its exact forward turn, and session followers cannot save", async (t) => {
  const f = await createStoreFixture({
    config: { entryMode: "embedded" },
    settings: { clientViewChordTransitions: settings },
    capabilities: { canControlDisplay: true, canEditWorkingPlaylist: true },
    display: before,
    playlist,
  });
  t.after(f.dispose);
  f.fake.emitDisplay({ ...after, from: 2, to: 3, section: 0, sectionRepeatNonce: 2 });
  await tick();
  const dialog = f.state().transitionDialog!;
  assert.ok(dialog && f.store.canSaveChordTransition(dialog));
  await f.store.saveChordTransition(dialog, dialog.recommendations[0]);
  const instructions = f.state().display.instructions;
  assert.equal(f.state().display.section, undefined);
  assert.equal(f.state().display.sectionRepeatNonce, undefined);
  assert.equal(f.state().display.from, 2);
  assert.equal(f.state().display.to, 3);
  const saved = parseTransitionInstruction(instructions?.split("\n")[0] ?? "");
  assert.equal(saved?.placement, "next");
  assert.ok(saved && f.store.transitionInstructionVisible(saved));

  f.fake.emitDisplay({ ...before, songId: "third", playlist: f.fake.api.playlist.getPlaylist() });
  await tick();
  f.fake.emitDisplay({ ...after, instructions });
  await tick();
  assert.equal(f.state().transitionDialog?.saved, false);
  assert.equal(f.store.transitionInstructionVisible(saved), false);

  f.fake.emitNetwork({ status: "watching", transport: "ppd" });
  f.fake.emitDisplay(before);
  await tick();
  f.fake.emitDisplay(after);
  await tick();
  assert.ok(f.state().transitionDialog);
  assert.equal(f.store.canSaveChordTransition(f.state().transitionDialog!), false);
});
