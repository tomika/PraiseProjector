import assert from "node:assert/strict";
import { before, test } from "node:test";
import type { NoteTimingEvent, TuneObject } from "abcjs";
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
  const state = playAbcWithSynth("X:1\nK:C\nCDEF|", {}, { onError: (error) => errors.push(error), visual: {} as TuneObject, engine });
  stopAllAbcPlayback();
  finishInit();
  await settle();
  assert.deepEqual(calls, []);
  assert.equal(state.playing, false);
  assert.deepEqual(errors, []);
});

test("an uninterrupted playback starts once the synth is ready", async () => {
  const { engine, calls, finishInit } = controllableEngine();
  const state = playAbcWithSynth("X:1\nK:C\nCDEF|", {}, { visual: {} as TuneObject, engine });
  finishInit();
  await settle();
  assert.deepEqual(calls, ["prime", "start", "timing"]);
  assert.equal(state.playing, true);
  stopAllAbcPlayback();
  assert.equal(state.playing, false, "the registry stops a running playback too");
});

type FakeTiming = { visual: unknown; eventCallback: (event: unknown) => unknown; starts: unknown[][]; stopped: boolean };

/** Ready-to-play synth; every timing animation and synth seek is recorded. */
function recordingEngine(noteTimings?: (visual: unknown) => NoteTimingEvent[]) {
  const timings: FakeTiming[] = [];
  const synth = { seeks: [] as unknown[][], started: 0 };
  class FakeSynth {
    init() {
      return Promise.resolve();
    }
    prime() {
      return Promise.resolve({ status: "ok", duration: 60 });
    }
    seek(...args: unknown[]) {
      synth.seeks.push(args);
    }
    start() {
      synth.started += 1;
    }
    stop() {}
  }
  class RecordingTiming {
    noteTimings?: NoteTimingEvent[];
    private readonly record: FakeTiming;
    constructor(visual: unknown, options: { eventCallback: (event: unknown) => unknown }) {
      this.noteTimings = noteTimings?.(visual);
      this.record = { visual, eventCallback: options.eventCallback, starts: [], stopped: false };
      timings.push(this.record);
    }
    start(...args: unknown[]) {
      this.record.starts.push(args);
    }
    stop() {
      this.record.stopped = true;
    }
  }
  const engine = { CreateSynth: FakeSynth, TimingCallbacks: RecordingTiming } as unknown as AbcPlaybackEngine;
  return { engine, timings, synth };
}

/** A note event whose marker target is a stand-in element. */
function noteEvent(milliseconds: number, left: number, line = 0) {
  const element = Object.assign(new (globalThis as unknown as { Element: new () => object }).Element(), {
    isConnected: true,
    classList: { add() {}, remove() {} },
  });
  return { type: "event", milliseconds, left, width: 10, top: line * 100, height: 60, line, elements: [[element]] } as unknown as NoteTimingEvent;
}

test("the note marker follows a re-rendered score while the audio plays on", async () => {
  const first = { name: "first rendering" } as unknown as TuneObject;
  const second = { name: "second rendering" } as unknown as TuneObject;
  let onScreen: TuneObject | undefined = first;
  const { engine, timings } = recordingEngine();
  const state = playAbcWithSynth("X:1\nK:C\nCDEF|", {}, { visual: () => onScreen, engine });
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

test("a double-clicked note starts the audio and the marker at its own time", async () => {
  const tune = { name: "on screen" } as unknown as TuneObject;
  const notes = [noteEvent(0, 10), noteEvent(500, 30), noteEvent(1000, 50)];
  const { engine, timings, synth } = recordingEngine(() => notes);
  let offered: readonly NoteTimingEvent[] = [];
  const state = playAbcWithSynth(
    "X:1\nK:C\nCDE|",
    {},
    {
      visual: tune,
      engine,
      startAt: (events) => {
        offered = events;
        return 500;
      },
    }
  );
  await settle();
  assert.equal(offered, notes, "the start is chosen from the tune's own timings");
  assert.deepEqual(synth.seeks, [[0.5, "seconds"]]);
  assert.equal(synth.started, 1);
  assert.deepEqual(timings[0].starts, [[0.5, "seconds"]]);
  assert.equal(state.currentTime, 0.5);
  stopAllAbcPlayback();
});

test("a start beyond the audio plays the whole score", async () => {
  const { engine, timings, synth } = recordingEngine(() => []);
  playAbcWithSynth("X:1\nK:C\nC|", {}, { visual: {} as TuneObject, engine, startAt: () => 120_000 });
  await settle();
  assert.deepEqual(synth.seeks, []);
  assert.deepEqual(timings[0].starts, [[]]);
  stopAllAbcPlayback();
});

test("a host re-render moves the marker at once, even before the next note", async () => {
  const first = { name: "before resize" } as unknown as TuneObject;
  const second = { name: "after resize" } as unknown as TuneObject;
  let onScreen = first;
  const listeners = new Set<() => void>();
  const { engine, timings } = recordingEngine(() => [noteEvent(0, 10), noteEvent(500, 30)]);
  const state = playAbcWithSynth(
    "X:1\nK:C\nCD|",
    {},
    {
      visual: () => onScreen,
      engine,
      watchScore: (listener) => {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
    }
  );
  await settle();
  assert.equal(listeners.size, 1, "watching starts with the audio");

  // A commit that left the same tune on screen changes nothing.
  for (const listener of listeners) listener();
  assert.equal(timings.length, 1);

  onScreen = second;
  for (const listener of listeners) listener();
  assert.equal(timings.length, 2);
  assert.equal(timings[1].visual, second);
  assert.equal(timings[0].stopped, true);
  assert.equal(timings[1].starts[0][1], "seconds");

  state.stop();
  assert.equal(listeners.size, 0, "a stopped playback stops watching");
});

test("an unengraved tune leaves the running marker animation in place", async () => {
  const first = { name: "engraved" } as unknown as TuneObject;
  const blank = { name: "not engraved" } as unknown as TuneObject;
  let onScreen = first;
  let listener: (() => void) | undefined;
  const { engine, timings } = recordingEngine((visual) => (visual === blank ? [] : [noteEvent(0, 10)]));
  playAbcWithSynth(
    "X:1\nK:C\nC|",
    {},
    {
      visual: () => onScreen,
      engine,
      watchScore: (next) => {
        listener = next;
        return () => undefined;
      },
    }
  );
  await settle();
  onScreen = blank;
  listener?.();
  assert.equal(timings.length, 2, "the candidate animation was built");
  assert.equal(timings[0].stopped, false, "but the running one keeps going");
  stopAllAbcPlayback();
});
