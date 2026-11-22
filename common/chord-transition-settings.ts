export const CHORD_TRANSITION_STYLES = ["pop", "cadential"] as const;
export type ChordTransitionStyle = (typeof CHORD_TRANSITION_STYLES)[number];
export type ChordTransitionPlacement = "previous" | "next";
export const MAX_CHORD_TRANSITION_STEPS = 32;
export const MAX_CHORD_TRANSITION_SECONDS = 300;
export const MAX_CHORD_TRANSITION_RECOMMENDATIONS = 20;

export interface ChordTransitionSettings {
  enabled: boolean;
  autoClose: boolean;
  seconds: number;
  styles: ChordTransitionStyle[];
  minSteps: number;
  maxSteps: number;
  maxRecommendations: number;
  order: "steps" | "quality";
  placement: ChordTransitionPlacement;
}

export function normalizeChordTransitionSettings(value?: Partial<ChordTransitionSettings> | null): ChordTransitionSettings {
  const bounded = (input: unknown, fallback: number, min: number, max: number) =>
    typeof input === "number" && Number.isFinite(input) ? Math.min(max, Math.max(min, Math.trunc(input))) : fallback;
  const styles = Array.isArray(value?.styles) ? CHORD_TRANSITION_STYLES.filter((style) => value.styles?.includes(style)) : [];
  const minSteps = bounded(value?.minSteps, 0, 0, MAX_CHORD_TRANSITION_STEPS);
  return {
    enabled: value?.enabled === true,
    autoClose: value?.autoClose !== false,
    seconds: bounded(value?.seconds, 8, 1, MAX_CHORD_TRANSITION_SECONDS),
    styles: styles.length ? styles : [...CHORD_TRANSITION_STYLES],
    minSteps,
    maxSteps: Math.max(minSteps, bounded(value?.maxSteps, 4, 0, MAX_CHORD_TRANSITION_STEPS)),
    maxRecommendations: bounded(value?.maxRecommendations, 5, 1, MAX_CHORD_TRANSITION_RECOMMENDATIONS),
    order: value?.order === "steps" ? "steps" : "quality",
    placement: value?.placement === "previous" ? "previous" : "next",
  };
}
