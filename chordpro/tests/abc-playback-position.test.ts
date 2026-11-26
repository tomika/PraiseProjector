import assert from "node:assert/strict";
import test from "node:test";
import type { NoteTimingEvent } from "abcjs";
import { abcEventAt, abcScorePoint, abcStartMilliseconds, type AbcScoreSvg } from "../abc-playback-position";

function svg(
  rect: { left: number; top: number; width: number; height: number },
  attributes: Record<string, string>,
  viewBox?: DOMRect | null
): AbcScoreSvg {
  return {
    getBoundingClientRect: () => rect,
    getAttribute: (name) => attributes[name] ?? null,
    viewBox: { baseVal: viewBox ?? null },
  };
}

function note(milliseconds: number, left: number, line: number, width = 10): NoteTimingEvent {
  return { type: "event", milliseconds, millisecondsPerMeasure: 2000, left, width, top: 40 + line * 100, height: 60, line };
}

test("client points map into the score's own units through CSS scaling and the viewBox", () => {
  // Rendered at half size (the renderer's ABC scale) with a widened viewBox.
  const scaled = svg({ left: 100, top: 50, width: 325, height: 100 }, { width: "650", height: "200" }, {
    x: -25,
    y: 0,
    width: 650,
    height: 200,
  } as DOMRect);
  assert.deepEqual(abcScorePoint(scaled, 100, 50), { x: -25, y: 0 });
  assert.deepEqual(abcScorePoint(scaled, 262.5, 100), { x: 300, y: 100 });

  // No viewBox: Chrome reports a zero rect, Firefox null. The attributes are the units.
  for (const absent of [{ x: 0, y: 0, width: 0, height: 0 } as DOMRect, null]) {
    const plain = svg({ left: 0, top: 0, width: 300, height: 100 }, { width: "600", height: "200" }, absent);
    assert.deepEqual(abcScorePoint(plain, 150, 50), { x: 300, y: 100 });
  }
});

test("a score without a visible box has no playback point", () => {
  assert.equal(abcScorePoint(svg({ left: 0, top: 0, width: 0, height: 0 }, { width: "600", height: "200" }), 1, 1), null);
});

test("playback starts at the nearest note of the staff system under the point", () => {
  const timings = [
    note(0, 20, 0),
    { type: "bar", milliseconds: 1000, millisecondsPerMeasure: 2000 } as unknown as NoteTimingEvent,
    note(1000, 120, 0),
    note(2000, 220, 0),
    note(3000, 20, 1),
    note(4000, 120, 1),
    { type: "end", milliseconds: 5000, millisecondsPerMeasure: 2000 } as NoteTimingEvent,
  ];
  assert.equal(abcStartMilliseconds(timings, { x: 130, y: 70 }), 1000, "on the note");
  assert.equal(abcStartMilliseconds(timings, { x: 160, y: 70 }), 1000, "nearer to it than to the next one");
  assert.equal(abcStartMilliseconds(timings, { x: 900, y: 70 }), 2000, "past the system's last note");
  assert.equal(abcStartMilliseconds(timings, { x: 125, y: 175 }), 4000, "on the second system");
  assert.equal(abcStartMilliseconds(timings, { x: 125, y: 110 }), 1000, "lyrics just below a system belong to it");
  assert.equal(abcStartMilliseconds(timings, { x: 125, y: 400 }), 4000, "below the last system");
  assert.equal(abcStartMilliseconds(timings, { x: 125, y: 10 }), 0, "the title area plays the whole score");
});

test("a repeated passage starts at its first pass", () => {
  const timings = [note(0, 20, 0), note(1000, 120, 0), note(2000, 20, 0), note(3000, 120, 0)];
  assert.equal(abcStartMilliseconds(timings, { x: 120, y: 60 }), 1000);
});

test("tied continuations and scores without placed notes play from the beginning", () => {
  const tie = { type: "event", milliseconds: 500, millisecondsPerMeasure: 2000, left: undefined, top: 40, height: 60, line: 0 } as NoteTimingEvent;
  assert.equal(abcStartMilliseconds([tie], { x: 10, y: 60 }), 0);
  assert.equal(abcStartMilliseconds([], { x: 10, y: 60 }), 0);
});

test("the sounding note is the last one that started", () => {
  const timings = [note(0, 20, 0), note(1000, 120, 0), note(2000, 220, 0)];
  assert.equal(abcEventAt(timings, 1500), timings[1]);
  assert.equal(abcEventAt(timings, 1000), timings[1]);
  assert.equal(abcEventAt(timings, -1), null);
});
