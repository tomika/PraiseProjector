import type { ChordTransitionPlacement, ChordTransitionStyle } from "../common/chord-transition-settings";

export const TRANSITION_INSTRUCTION_PREFIX = "♪⌒♪";

export interface TransitionSongPair {
  from: string;
  to: string;
}

export interface TransitionRecommendation {
  chords: string[];
  style: ChordTransitionStyle;
  rating: number;
}

export interface TransitionInstruction extends TransitionSongPair, TransitionRecommendation {
  placement: ChordTransitionPlacement;
  sourceKey: string;
  targetKey: string;
}

export function transitionInstructionLabel(chords: readonly string[]): string {
  return TRANSITION_INSTRUCTION_PREFIX + " " + chords.join(" → ");
}

/** Older playlists can carry instruction text with escaped line endings. */
export function splitInstructionLines(text: string): string[] {
  try {
    text = JSON.parse('"' + text + '"');
  } catch {
    // Already plain text.
  }
  return text.split(/\r?\n/);
}

export function parseTransitionInstruction(line: string): TransitionInstruction | null {
  if (!line.startsWith(TRANSITION_INSTRUCTION_PREFIX + " ")) return null;
  const tab = line.indexOf("\t");
  if (tab < 0) return null;
  const chords = line.slice(TRANSITION_INSTRUCTION_PREFIX.length + 1, tab).split(" → ");
  if (chords.length < 2 || chords.length > 34 || chords.some((chord) => !chord.trim())) return null;
  try {
    const data: unknown = JSON.parse(line.slice(tab + 1));
    if (!Array.isArray(data) || data.length !== 7) return null;
    const [from, to, placement, sourceKey, targetKey, style, rating] = data;
    if (
      typeof from !== "string" ||
      !from ||
      typeof to !== "string" ||
      !to ||
      (placement !== "previous" && placement !== "next") ||
      typeof sourceKey !== "string" ||
      typeof targetKey !== "string" ||
      (style !== "pop" && style !== "cadential") ||
      typeof rating !== "number" ||
      !Number.isInteger(rating) ||
      rating < 1 ||
      rating > 5
    )
      return null;
    return { from, to, placement, sourceKey, targetKey, chords, style, rating };
  } catch {
    return null;
  }
}

export function matchesTransitionPair(instruction: TransitionSongPair, pair: TransitionSongPair | null | undefined): boolean {
  return instruction.from === pair?.from && instruction.to === pair?.to;
}

export function insertTransitionInstruction(instructions: string, transition: TransitionInstruction): string {
  const { from, to, placement, sourceKey, targetKey, style, rating, chords } = transition;
  const line = transitionInstructionLabel(chords) + "\t" + JSON.stringify([from, to, placement, sourceKey, targetKey, style, rating]);
  const otherLines = instructions.trim()
    ? splitInstructionLines(instructions).filter((item) => {
        const saved = parseTransitionInstruction(item.trim());
        return !saved || saved.placement !== placement || !matchesTransitionPair(saved, transition);
      })
    : [];
  return (placement === "previous" ? [...otherLines, line] : [line, ...otherLines]).join("\n");
}
