/**
 * Semantic full-view section commands and their pure decisions.
 *
 * The Preview panel keeps owning the section list, the projected selection, the
 * repeat progress and every projection side effect. This module only computes
 * what a command does from a snapshot of that state; the panel applies the
 * decision through its existing setters. The section list keys, the eight
 * Controls-tab buttons and the hardware runtime all enter through the same
 * command, so none of them can drift from the others.
 *
 * The decisions are moved verbatim from the original `handleSectionListAction`
 * (themselves ports of the C# SectionListBox.OnKeyDown) and are verified
 * against a golden master recorded from that handler.
 */
import type { SectionControlCommand } from "../../../common/hardware-input";
import type { Display } from "../../../common/pp-types";

/** The eight base commands plus the two list-local ones (Escape / Space). */
export type SectionListCommand = SectionControlCommand | "clear-projected-selection" | "toggle-current-projectability";

/** The section list's original keyboard mapping (logical `event.key`). The factory
 *  full-view profile reproduces its eight base keys; see FACTORY_FULL_PROFILE. */
export const SECTION_LIST_KEY_COMMANDS: Readonly<Record<string, SectionListCommand>> = {
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
};

/** Keys the section list still handles itself: Escape / Space are list-local
 *  features, not hardware base rows. The eight base keys reach the panel only
 *  through the hardware router and the active full-view profile. */
export const SECTION_LIST_LOCAL_KEY_COMMANDS: Readonly<Record<string, SectionListCommand>> = {
  " ": "toggle-current-projectability",
  Escape: "clear-projected-selection",
};

export interface ControlSection {
  from: number;
  to: number;
  block: number;
  checked: boolean;
  instructedIndex?: number;
  instructedMultiplier?: number;
  instructedSignature?: string;
}

/** The fields the repeat-group computations read (a SectionItem also qualifies). */
export type RepeatSection = Omit<ControlSection, "checked">;

export interface RepeatGroup {
  start: number;
  end: number;
  repeatTotal: number;
}

export type SectionRepeatCounts = Display["sectionRepeatCounts"];

export interface SectionSelectOptions {
  repeatIndexOverride?: number;
  bumpRepeatNonce?: boolean;
  preserveRepeatNonce?: boolean;
  forceEmit?: boolean;
}

export interface SectionControlState {
  sections: readonly ControlSection[];
  selectedIndex: number;
  nextIndex: number;
  repeatProgress: { sectionIndex: number; repeatIndex: number };
  repeatGroupBounds: (index: number) => RepeatGroup;
}

/** What a command does: move the next marker, project a section, toggle a checkbox
 *  — or nothing (an empty decision is still a handled command). */
export interface SectionControlDecision {
  next?: number;
  select?: { index: number; options?: SectionSelectOptions };
  toggle?: number;
}

/** Repeat groups of instructed sections; a group joins only when every fragment shares one row. */
export function buildSectionRepeatCounts(sectionList: readonly RepeatSection[]): SectionRepeatCounts {
  const grouped = new Map<string, { section: number; from: number; to: number; multiplier: number; uniqueRanges: Set<string> }>();
  for (const section of sectionList) {
    const multiplier = section.instructedMultiplier ?? 1;
    if (section.instructedIndex == null || multiplier <= 1) continue;
    // `block` keeps distinct same-signature occurrences separate.
    const key = `${section.instructedIndex}|${section.block}|${multiplier}|${section.instructedSignature || ""}`;
    const existing = grouped.get(key);
    if (!existing) {
      grouped.set(key, {
        section: section.instructedIndex,
        from: section.from,
        to: section.to,
        multiplier,
        uniqueRanges: new Set<string>([`${section.from}:${section.to}`]),
      });
      continue;
    }
    existing.from = Math.min(existing.from, section.from);
    existing.to = Math.max(existing.to, section.to);
    existing.uniqueRanges.add(`${section.from}:${section.to}`);
  }

  const result = Array.from(grouped.values())
    // Join repeats only when whole repeated section fits one projected row.
    .filter((x) => x.uniqueRanges.size === 1)
    .map(({ section, from, to, multiplier }) => ({ section, from, to, multiplier }))
    .sort((a, b) => a.section - b.section || a.from - b.from || a.to - b.to);
  return result.length > 0 ? result : undefined;
}

export function sectionRepeatTotal(section: RepeatSection, sectionRepeatCounts: SectionRepeatCounts): number {
  if (section.instructedIndex == null) return 1;
  const containing = sectionRepeatCounts?.find(
    (item) => item.section === section.instructedIndex && item.from <= section.from && section.to <= item.to
  );
  const fallback = sectionRepeatCounts?.find((item) => item.section === section.instructedIndex);
  const multiplier = containing?.multiplier ?? fallback?.multiplier ?? 1;
  if (!Number.isFinite(multiplier) || multiplier <= 1) return 1;
  return Math.max(2, Math.floor(multiplier));
}

export function repeatGroupBounds(sections: readonly RepeatSection[], sectionRepeatCounts: SectionRepeatCounts, index: number): RepeatGroup {
  if (index < 0 || index >= sections.length) return { start: index, end: index, repeatTotal: 1 };
  const section = sections[index];
  if (section.instructedIndex == null) return { start: index, end: index, repeatTotal: 1 };

  const repeatEntry = sectionRepeatCounts?.find(
    (item) => item.section === section.instructedIndex && item.from <= section.from && section.to <= item.to
  );

  const repeatTotal =
    repeatEntry && Number.isFinite(repeatEntry.multiplier) && repeatEntry.multiplier > 1 ? Math.max(2, Math.floor(repeatEntry.multiplier)) : 1;

  if (!repeatEntry || repeatTotal <= 1) return { start: index, end: index, repeatTotal: 1 };

  let start = index;
  while (start > 0) {
    const prev = sections[start - 1];
    if (prev.instructedIndex !== section.instructedIndex) break;
    if (prev.from < repeatEntry.from || prev.to > repeatEntry.to) break;
    start--;
  }

  let end = index;
  while (end + 1 < sections.length) {
    const next = sections[end + 1];
    if (next.instructedIndex !== section.instructedIndex) break;
    if (next.from < repeatEntry.from || next.to > repeatEntry.to) break;
    end++;
  }

  return { start, end, repeatTotal };
}

/** Next checked section after `startIndex`, wrapping once (C# GetNextOf). */
export function getNextCheckedIndex(startIndex: number, sectionList: readonly ControlSection[], selectedIndex: number): number {
  if (sectionList.length === 0) return -1;

  const start = startIndex < 0 ? -1 : startIndex;
  let acceptSelected = false;

  for (let i = start + 1; i !== start; i++) {
    if (i >= sectionList.length) {
      i = 0;
      if (acceptSelected) break;
      acceptSelected = true;
    }

    if (sectionList[i].checked && (acceptSelected || selectedIndex !== i)) {
      return i;
    }
  }

  return -1;
}

/** Decides a command against a state snapshot; `null` = not handled (empty list). */
export function decideSectionControl(command: SectionListCommand, state: SectionControlState): SectionControlDecision | null {
  const { sections, selectedIndex, nextIndex } = state;
  if (sections.length === 0) return null;

  const isValidNextIndex = (i: number) => i >= 0 && i < sections.length && i !== selectedIndex && sections[i].checked;
  const repeatIndexOf = (index: number) => (state.repeatProgress.sectionIndex === index ? state.repeatProgress.repeatIndex : 1);

  switch (command) {
    case "next-down": {
      const newNext = getNextCheckedIndex(nextIndex, sections, selectedIndex);
      return newNext >= 0 ? { next: newNext } : {};
    }

    case "next-up": {
      // Find the item whose next would be the current next marker.
      for (let i = 0; i < sections.length; i++) {
        if (i !== selectedIndex && sections[i].checked && getNextCheckedIndex(i, sections, selectedIndex) === nextIndex) return { next: i };
      }
      return {};
    }

    case "next-first": {
      let i = 0;
      while (i < sections.length && !isValidNextIndex(i)) i++;
      return i < sections.length ? { next: i } : {};
    }

    case "next-last": {
      let i = sections.length - 1;
      while (i >= 0 && !isValidNextIndex(i)) i--;
      return i >= 0 ? { next: i } : {};
    }

    case "next-next-block": {
      let i = nextIndex >= 0 ? nextIndex : selectedIndex >= 0 ? selectedIndex : 0;
      if (i >= 0 && i < sections.length) {
        const block = sections[i].block;
        while (i < sections.length && sections[i].block === block) i++;
        while (i < sections.length && !isValidNextIndex(i)) i++;
        if (i < sections.length) return { next: i };
      }
      return {};
    }

    case "next-previous-block": {
      // Same scan as the original handler: inside the previous block the LAST
      // marker write wins, i.e. the block's first valid section.
      let i = nextIndex >= 0 ? nextIndex : selectedIndex >= 0 ? selectedIndex : sections.length - 1;
      let found = false;
      let next: number | undefined;
      while (!found && i-- > 0) {
        const block = sections[i].block;
        for (; i >= 0 && sections[i].block === block; i--) {
          if (isValidNextIndex(i)) {
            found = true;
            next = i;
          }
        }
      }
      return next !== undefined ? { next } : {};
    }

    case "toggle-current-projectability":
      return selectedIndex >= 0 ? { toggle: selectedIndex } : {};

    case "project-next-or-repeat": {
      // Advance repeats at the end of the split-group, not per fragment.
      if (selectedIndex >= 0 && sections[selectedIndex]) {
        const group = state.repeatGroupBounds(selectedIndex);
        const repeatIndex = repeatIndexOf(selectedIndex);
        if (group.repeatTotal > 1 && selectedIndex === group.end && repeatIndex < group.repeatTotal) {
          return { select: { index: group.start, options: { repeatIndexOverride: repeatIndex + 1, bumpRepeatNonce: true, forceEmit: true } } };
        }
      }
      if (nextIndex >= 0) {
        const selectedGroup = state.repeatGroupBounds(selectedIndex);
        const nextInSameGroup = selectedIndex >= 0 && nextIndex >= selectedGroup.start && nextIndex <= selectedGroup.end;
        if (nextInSameGroup && selectedGroup.repeatTotal > 1) {
          return { select: { index: nextIndex, options: { repeatIndexOverride: repeatIndexOf(selectedIndex), preserveRepeatNonce: true } } };
        }
        return { select: { index: nextIndex } };
      }
      return {};
    }

    case "project-current-block-start": {
      // The first section of the projected block, checked or not.
      if (selectedIndex >= 0) {
        const currentBlock = sections[selectedIndex].block;
        let i = selectedIndex;
        while (i >= 0 && sections[i].block === currentBlock) i--;
        if (i + 1 < sections.length) return { select: { index: i + 1 } };
      }
      return {};
    }

    case "clear-projected-selection":
      return { select: { index: -1 } };
  }
}
