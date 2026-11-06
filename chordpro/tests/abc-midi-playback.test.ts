import assert from "node:assert/strict";
import { before, test } from "node:test";
import type { TuneObject } from "abcjs";
import { loadAbcjs } from "../abcjs-lazy";
import { stopAllAbcPlayback } from "../abc-playback-registry";
import { playAbcWithSynth, type AbcPlaybackEngine } from "../chordpro_editor";

before(async () => {
  await loadAbcjs();
  // The marker stylesheet is the only DOM the playback start touches; markers
  // only decorate real elements, so plain objects stand in for SVG nodes.
  (globalThis as { document?: unknown }).document ??= { getElementById: () => ({}) };
  (globalThis as { Element?: unknown }).Element ??= class {};
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

type FakeTiming = { visual: unknown; eventCallback: (event: unknown) => unknown; starts: unknown[][]; stopped: boolean };

/** Ready-to-play synth; every timing animation it creates is recorded. */
function recordingEngine() {
  const timings: FakeTiming[] = [];
  class FakeSynth {
    init() {
      return Promise.resolve();
    }
    prime() {
      return Promise.resolve({ status: "ok", duration: 60 });
    }
    start() {}
    stop() {}
  }
  class RecordingTiming {
    constructor(visual: unknown, options: { eventCallback: (event: unknown) => unknown }) {
      timings.push({ visual, eventCallback: options.eventCallback, starts: [], stopped: false });
    }
    start(...args: unknown[]) {
      timings[timings.length - 1].starts.push(args);
    }
    stop() {
      for (const timing of timings) timing.stopped = true;
    }
  }
  const engine = { CreateSynth: FakeSynth, TimingCallbacks: RecordingTiming } as unknown as AbcPlaybackEngine;
  return { engine, timings };
}

test("the note marker follows a re-rendered score while the audio plays on", async () => {
  const first = { name: "first rendering" } as unknown as TuneObject;
  const second = { name: "second rendering" } as unknown as TuneObject;
  let onScreen: TuneObject | undefined = first;
  const { engine, timings } = recordingEngine();
  const state = playAbcWithSynth("X:1\nK:C\nCDEF|", {}, undefined, () => onScreen, engine);
  await settle();
  assert.equal(state.playing, true);
  assert.equal(timings[0].visual, first);

  const detachedNote = { elements: [[{ isConnected: false }]] };
  // Zoomed to lyrics: no notation on screen, the audio simply continues.
  onScreen = undefined;
  timings[0].eventCallback(detachedNote);
  await settle();
  assert.equal(timings.length, 1);

  // Notation again: the old elements are detached, the marker moves to the new tune.
  onScreen = second;
  timings[0].eventCallback({ elements: [[{ isConnected: true }]] });
  await settle();
  assert.equal(timings.length, 1, "attached elements keep the current animation");
  timings[0].eventCallback(detachedNote);
  await settle();
  assert.equal(timings.length, 2);
  assert.equal(timings[1].visual, second);
  assert.equal(timings[1].starts[0][1], "seconds");
  assert.ok((timings[1].starts[0][0] as number) >= 0);
  assert.equal(state.playing, true);
  stopAllAbcPlayback();
});
