import assert from "node:assert/strict";
import { before, test } from "node:test";
import type { TuneObject } from "abcjs";
import { loadAbcjs } from "../abcjs-lazy";
import { stopAllAbcPlayback } from "../abc-playback-registry";
import { playAbcWithSynth, type AbcPlaybackEngine } from "../chordpro_editor";

before(async () => {
  await loadAbcjs();
  // The marker stylesheet is the only DOM the playback start touches.
  (globalThis as { document?: unknown }).document ??= { getElementById: () => ({}) };
});

/** A synth whose init() settles only when the test says so. */
function controllableEngine() {
  const calls: string[] = [];
  let finishInit!: () => void;
  class FakeSynth {
    init() {
      return new Promise<void>((resolve) => {
        finishInit = resolve;
      });
    }
    prime() {
      calls.push("prime");
      return Promise.resolve({ status: "ok", duration: 5 });
    }
    start() {
      calls.push("start");
    }
    stop() {}
  }
  class FakeTiming {
    start() {
      calls.push("timing");
    }
    stop() {}
  }
  const engine = { CreateSynth: FakeSynth, TimingCallbacks: FakeTiming } as unknown as AbcPlaybackEngine;
  return { engine, calls, finishInit: () => finishInit() };
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

test("a playback stopped by a view switch while the synth is loading never starts", async () => {
  const { engine, calls, finishInit } = controllableEngine();
  const errors: unknown[] = [];
  const state = playAbcWithSynth("X:1\nK:C\nCDEF|", {}, (error) => errors.push(error), {} as TuneObject, engine);
  stopAllAbcPlayback();
  finishInit();
  await settle();
  assert.deepEqual(calls, []);
  assert.equal(state.playing, false);
  assert.deepEqual(errors, []);
});

test("an uninterrupted playback starts once the synth is ready", async () => {
  const { engine, calls, finishInit } = controllableEngine();
  const state = playAbcWithSynth("X:1\nK:C\nCDEF|", {}, undefined, {} as TuneObject, engine);
  finishInit();
  await settle();
  assert.deepEqual(calls, ["prime", "start", "timing"]);
  assert.equal(state.playing, true);
  stopAllAbcPlayback();
  assert.equal(state.playing, false, "the registry stops a running playback too");
});
