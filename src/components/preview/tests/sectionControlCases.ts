/**
 * Input matrix for the full-view section-control golden master: section lists
 * with blocks, unchecked items and repeat groups, every marker/selection
 * combination, and the repeat progress variants that only Enter reads.
 */
export interface CaseSection {
  from: number;
  to: number;
  block: number;
  checked: boolean;
  instructedIndex?: number;
  instructedMultiplier?: number;
  instructedSignature?: string;
}

export interface SectionControlCase {
  fixture: string;
  selected: number;
  next: number;
  repeat: { sectionIndex: number; repeatIndex: number };
  key: string;
}

/** What one key press did: the final marker write, selections and checkbox toggles. */
export interface SectionControlOutcome {
  handled: boolean;
  next: number | null;
  navigatedByKey: boolean;
  selects: [number, Record<string, unknown> | null][];
  toggles: number[];
}

const s = (from: number, to: number, block: number, checked = true, extra: Partial<CaseSection> = {}): CaseSection => ({
  from,
  to,
  block,
  checked,
  ...extra,
});

export const SECTION_FIXTURES: Record<string, CaseSection[]> = {
  empty: [],
  single: [s(0, 4, 0)],
  allUnchecked: [s(0, 2, 0, false), s(2, 4, 0, false), s(4, 6, 1, false)],
  blocksWithUnchecked: [s(0, 2, 0), s(2, 4, 0, false), s(4, 6, 0), s(6, 8, 1), s(8, 10, 1, false), s(10, 12, 2)],
  lastUnchecked: [s(0, 2, 0), s(2, 4, 1), s(4, 6, 1), s(6, 8, 2, false)],
  singleFragmentRepeat: [
    s(0, 2, 0, true, { instructedIndex: 0 }),
    s(2, 4, 1, true, { instructedIndex: 1, instructedMultiplier: 3, instructedSignature: "C" }),
    s(4, 6, 2, true, { instructedIndex: 2 }),
  ],
  multiFragmentRepeat: [
    s(0, 2, 0, true, { instructedIndex: 0 }),
    s(2, 6, 1, true, { instructedIndex: 1, instructedMultiplier: 2, instructedSignature: "R" }),
    s(2, 6, 1, true, { instructedIndex: 1, instructedMultiplier: 2, instructedSignature: "R" }),
    s(6, 8, 2, true, { instructedIndex: 2 }),
    s(8, 10, 2, false, { instructedIndex: 3 }),
  ],
  splitRangesNoJoin: [
    s(0, 2, 0, true, { instructedIndex: 0, instructedMultiplier: 2 }),
    s(2, 4, 0, true, { instructedIndex: 0, instructedMultiplier: 2 }),
    s(4, 6, 1, true, { instructedIndex: 1 }),
  ],
};

export const SECTION_KEYS = [
  "Home",
  "End",
  "PageUp",
  "PageDown",
  "ArrowUp",
  "ArrowDown",
  "ArrowLeft",
  "ArrowRight",
  "Enter",
  "Backspace",
  "Escape",
  " ",
  "Tab",
];

export function* sectionControlCases(): Generator<SectionControlCase> {
  for (const [fixture, sections] of Object.entries(SECTION_FIXTURES)) {
    const indexes = [-1, ...sections.map((_, index) => index)];
    for (const selected of indexes) {
      for (const next of indexes) {
        for (const key of SECTION_KEYS) {
          const repeats =
            key === "Enter" && selected >= 0
              ? [1, 2, 3].map((repeatIndex) => ({ sectionIndex: selected, repeatIndex }))
              : [{ sectionIndex: -1, repeatIndex: 1 }];
          for (const repeat of repeats) yield { fixture, selected, next, repeat, key };
        }
      }
    }
  }
}

export function caseId(c: SectionControlCase): string {
  return `${c.fixture}|s${c.selected}|n${c.next}|r${c.repeat.sectionIndex}:${c.repeat.repeatIndex}|${JSON.stringify(c.key)}`;
}
