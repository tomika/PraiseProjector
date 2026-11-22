import assert from "node:assert/strict";
import test from "node:test";
import { generateChordTransition, rankChordTransitions } from "../chord-transition";

const endpoints = ["C", "D", "C", "D"] as const;

test("range search ranks multiple distinct alternatives across lengths", () => {
  for (const style of ["pop", "cadential"] as const) {
    const options = { style, limit: 8, minSteps: 0, maxSteps: 4 };
    const ranked = rankChordTransitions(...endpoints, options);
    const fixed = Array.from({ length: 5 }, (_, steps) => rankChordTransitions(...endpoints, { steps, style, limit: 8 })).flat();
    fixed.sort((a, b) => b.score - a.score || a.chords.length - b.chords.length);
    assert.deepEqual(ranked, fixed.slice(0, 8));
    assert.equal(new Set(ranked.map((r) => r.chords.join(" "))).size, 8);
    assert.ok(new Set(ranked.map((r) => r.chords.length)).size > 1);
    assert.deepEqual(generateChordTransition(...endpoints, options), ranked[0].chords);
  }
  assert.deepEqual(generateChordTransition(...endpoints), ["Em", "A7"]);
  assert.deepEqual(generateChordTransition(...endpoints, { style: "pop" }), ["G"]);
});

test("direct transitions and inclusive bounds", () => {
  const [direct] = rankChordTransitions("Am", "Am", "Am", "Am", { maxSteps: 0 });
  assert.deepEqual(direct.chords, []);
  assert.ok(Number.isFinite(direct.score));
  assert.throws(() => rankChordTransitions(...endpoints, { minSteps: 4, maxSteps: 3 }), RangeError);
  assert.throws(() => rankChordTransitions(...endpoints, { steps: 2, minSteps: 1 }), RangeError);
});

test("ranking by steps fills the limit with the shortest available bridges", () => {
  const options = { style: "cadential", limit: 5 } as const;
  const shortest = rankChordTransitions(...endpoints, { ...options, minSteps: 0, maxSteps: 4, order: "steps" });
  const fixed = [0, 1, 2, 3, 4].flatMap((steps) => rankChordTransitions(...endpoints, { ...options, steps }));
  assert.deepEqual(shortest, fixed.slice(0, options.limit));
});
