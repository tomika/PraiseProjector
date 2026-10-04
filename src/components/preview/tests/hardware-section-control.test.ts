/**
 * T10 — the semantic section commands reproduce the recorded golden master of
 * the original PreviewPanel handler on every case (R06, R07), plus readable
 * spot checks of the rules that must never be "simplified".
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import {
  SECTION_LIST_KEY_COMMANDS,
  buildSectionRepeatCounts,
  decideSectionControl,
  getNextCheckedIndex,
  repeatGroupBounds,
  sectionRepeatTotal,
  type ControlSection,
  type SectionControlDecision,
  type SectionListCommand,
} from "../sectionControlCommands";
import { SECTION_FIXTURES, caseId, sectionControlCases, type SectionControlOutcome } from "./sectionControlCases";

const golden = JSON.parse(readFileSync(new URL("./fixtures/section-control.golden.json", import.meta.url), "utf8")) as Record<
  string,
  SectionControlOutcome
>;

function decide(
  sections: ControlSection[],
  command: SectionListCommand,
  selected: number,
  next: number,
  repeat = { sectionIndex: -1, repeatIndex: 1 }
) {
  const counts = buildSectionRepeatCounts(sections);
  return decideSectionControl(command, {
    sections,
    selectedIndex: selected,
    nextIndex: next,
    repeatProgress: repeat,
    repeatGroupBounds: (index) => repeatGroupBounds(sections, counts, index),
  });
}

function toOutcome(decision: SectionControlDecision | null): SectionControlOutcome {
  return {
    handled: decision !== null,
    next: decision?.next ?? null,
    navigatedByKey: decision?.next !== undefined,
    selects: decision?.select ? [[decision.select.index, (decision.select.options as Record<string, unknown> | undefined) ?? null]] : [],
    toggles: decision?.toggle !== undefined ? [decision.toggle] : [],
  };
}

test("every recorded case of the original handler is reproduced", () => {
  let checked = 0;
  for (const c of sectionControlCases()) {
    const command = SECTION_LIST_KEY_COMMANDS[c.key];
    const outcome = command
      ? toOutcome(decide(SECTION_FIXTURES[c.fixture], command, c.selected, c.next, c.repeat))
      : { handled: false, next: null, navigatedByKey: false, selects: [], toggles: [] };
    assert.deepEqual(outcome, golden[caseId(c)], caseId(c));
    checked++;
  }
  assert.equal(checked, Object.keys(golden).length);
});

const blocks = SECTION_FIXTURES.blocksWithUnchecked;

test("marker moves never project; only Enter/Backspace/Escape select", () => {
  for (const command of ["next-down", "next-up", "next-first", "next-last", "next-next-block", "next-previous-block"] as const) {
    assert.equal(decide(blocks, command, 0, 2)?.select, undefined, command);
  }
  assert.deepEqual(decide(blocks, "project-next-or-repeat", 0, 2)?.select, { index: 2 });
  assert.deepEqual(decide(blocks, "clear-projected-selection", 3, 5)?.select, { index: -1 });
});

test("Backspace projects the first section of the current block even when it is unchecked", () => {
  const sections: ControlSection[] = [
    { from: 0, to: 2, block: 0, checked: true },
    { from: 2, to: 4, block: 1, checked: false },
    { from: 4, to: 6, block: 1, checked: true },
  ];
  assert.deepEqual(decide(sections, "project-current-block-start", 2, -1)?.select, { index: 1 });
  assert.deepEqual(decide(sections, "project-current-block-start", -1, 0), {});
});

test("Enter advances the repeat at the end of the group and then leaves it", () => {
  const repeat = SECTION_FIXTURES.singleFragmentRepeat;
  assert.equal(sectionRepeatTotal(repeat[1], buildSectionRepeatCounts(repeat)), 3);
  assert.deepEqual(decide(repeat, "project-next-or-repeat", 1, 2, { sectionIndex: 1, repeatIndex: 1 })?.select, {
    index: 1,
    options: { repeatIndexOverride: 2, bumpRepeatNonce: true, forceEmit: true },
  });
  assert.deepEqual(decide(repeat, "project-next-or-repeat", 1, 2, { sectionIndex: 1, repeatIndex: 3 })?.select, { index: 2 });
  const multi = SECTION_FIXTURES.multiFragmentRepeat;
  assert.deepEqual(decide(multi, "project-next-or-repeat", 1, 2, { sectionIndex: 1, repeatIndex: 1 })?.select, {
    index: 2,
    options: { repeatIndexOverride: 1, preserveRepeatNonce: true },
  });
});

test("unchecked sections are skipped by the marker and an empty list is not handled", () => {
  assert.deepEqual(decide(blocks, "next-down", 0, 0), { next: 2 });
  assert.deepEqual(decide(SECTION_FIXTURES.allUnchecked, "next-down", -1, -1), {});
  assert.equal(decide([], "next-down", -1, -1), null);
  assert.deepEqual(decide(blocks, "toggle-current-projectability", 4, 5), { toggle: 4 });
  assert.deepEqual(decide(blocks, "toggle-current-projectability", -1, 5), {});
});

test("the section list key map covers the eight base commands, the aliases and the list-local keys", () => {
  assert.deepEqual(SECTION_LIST_KEY_COMMANDS, {
    ArrowDown: "next-down",
    ArrowRight: "next-down",
    ArrowUp: "next-up",
    ArrowLeft: "next-up",
    Home: "next-first",
    End: "next-last",
    PageDown: "next-next-block",
    PageUp: "next-previous-block",
    " ": "toggle-current-projectability",
    Enter: "project-next-or-repeat",
    Backspace: "project-current-block-start",
    Escape: "clear-projected-selection",
  });
});

test("repeat helpers: totals, fallbacks and group edges", () => {
  const counts = [{ section: 1, from: 2, to: 4, multiplier: 2.7 }];
  assert.equal(sectionRepeatTotal({ from: 0, to: 2, block: 0 }, counts), 1, "not instructed");
  assert.equal(sectionRepeatTotal({ from: 2, to: 4, block: 1, instructedIndex: 1 }, counts), 2, "multiplier floors to at least 2");
  assert.equal(sectionRepeatTotal({ from: 8, to: 9, block: 1, instructedIndex: 1 }, counts), 2, "falls back to the section's entry");
  assert.equal(sectionRepeatTotal({ from: 8, to: 9, block: 1, instructedIndex: 5 }, counts), 1, "no entry");
  assert.equal(sectionRepeatTotal({ from: 2, to: 4, block: 1, instructedIndex: 1 }, [{ section: 1, from: 2, to: 4, multiplier: Number.NaN }]), 1);
  assert.equal(sectionRepeatTotal({ from: 2, to: 4, block: 1, instructedIndex: 1 }, undefined), 1);
  const sections = [
    { from: 0, to: 2, block: 0, instructedIndex: 1 },
    { from: 2, to: 3, block: 0, instructedIndex: 1 },
    { from: 3, to: 4, block: 0, instructedIndex: 1 },
    { from: 4, to: 6, block: 0, instructedIndex: 1 },
  ];
  assert.deepEqual(repeatGroupBounds(sections, counts, 1), { start: 1, end: 2, repeatTotal: 2 }, "neighbours outside the entry range end the group");
  assert.deepEqual(repeatGroupBounds(sections, counts, 9), { start: 9, end: 9, repeatTotal: 1 });
});

test("getNextCheckedIndex wraps once and handles an empty list", () => {
  assert.equal(getNextCheckedIndex(0, [], -1), -1);
  const sections = [
    { from: 0, to: 1, block: 0, checked: true },
    { from: 1, to: 2, block: 0, checked: false },
  ];
  assert.equal(getNextCheckedIndex(0, sections, -1), 0, "wraps back to itself");
  assert.equal(getNextCheckedIndex(0, sections, 0), 0, "the selected one is accepted after the wrap");
});
