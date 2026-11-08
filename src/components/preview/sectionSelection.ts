import { containsAbcRange } from "../../../common/abc-range";
import type { AbcRange } from "../../../common/pp-types";
import type { SectionItem } from "../../utils/SectionGenerator";
import type { SectionSelectOptions } from "./sectionControlCommands";

type SelectionSection = Pick<SectionItem, "from" | "to" | "instructedIndex" | "abcRange" | "projectionRepeat">;

/** Expanded repeats already have their pass encoded in the row. Joined repeats
 * retain the existing bump/preserve semantics on the same projected row. */
export function getSectionRepeatNonce(
  section: Pick<SectionItem, "projectionRepeat">,
  currentNonce: number,
  options?: Pick<SectionSelectOptions, "bumpRepeatNonce" | "preserveRepeatNonce">
): number {
  return section.projectionRepeat?.index ?? (options?.bumpRepeatNonce ? currentNonce + 1 : options?.preserveRepeatNonce ? currentNonce : 0);
}

/** A remote lyric hit identifies content, not its repeat occurrence. Prefer the
 * selected occurrence, or another page in the same pass through that instruction. */
export function findSectionByLine(
  sections: readonly SelectionSection[],
  selectedIndex: number,
  lineNumber: number,
  section?: number,
  abcRange?: AbcRange
): number {
  const selected = sections[selectedIndex];
  const preferCurrentPass = (matches: (candidate: SelectionSection) => boolean) => {
    if (selected && matches(selected)) return selectedIndex;
    if (selected?.projectionRepeat) {
      const index = sections.findIndex(
        (candidate) =>
          candidate.instructedIndex === selected.instructedIndex &&
          candidate.projectionRepeat?.index === selected.projectionRepeat?.index &&
          matches(candidate)
      );
      if (index >= 0) return index;
    }
    return sections.findIndex(matches);
  };
  const containsLine = (candidate: SelectionSection) => candidate.from <= lineNumber && lineNumber < candidate.to;
  if (abcRange) {
    const index = preferCurrentPass(
      (candidate) =>
        (section == null || candidate.instructedIndex == null || candidate.instructedIndex === section) &&
        !!candidate.abcRange &&
        containsAbcRange(candidate.abcRange, { ...abcRange, to: abcRange.from + 1 })
    );
    if (index >= 0) return index;
  }
  if (section != null) {
    const index = preferCurrentPass((candidate) => candidate.instructedIndex === section && containsLine(candidate));
    if (index >= 0) return index;
    const fallback = preferCurrentPass((candidate) => candidate.instructedIndex === section);
    if (fallback >= 0) return fallback;
  }
  return preferCurrentPass(containsLine);
}
