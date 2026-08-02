import type { Language } from "../localization/LocalizationContext";

export type TutorialView = "full" | "client";

export interface TutorialText {
  title: string;
  body: string;
}

export type LocalizedTutorialText = Record<Language, TutorialText>;

export type LocalizedTutorialLabel = Record<Language, string>;

export type TutorialCommand = "sync-now" | "switch-client" | "switch-full";

export interface TutorialAction {
  id: string;
  label: LocalizedTutorialLabel;
  command: TutorialCommand;
}

export interface TutorialBranch {
  id: string;
  label: LocalizedTutorialLabel;
  steps: readonly TutorialStep[];
}

export interface TutorialStep {
  id: string;
  target: string | readonly string[];
  text: LocalizedTutorialText;
  /** Additional targets that share one tutorial spotlight with the primary target. */
  highlightTargets?: readonly string[];
  prepare?: () => void | TutorialCleanup;
  details?: readonly TutorialStep[];
  branches?: readonly TutorialBranch[];
  actions?: readonly TutorialAction[];
}

export interface TutorialDefinition {
  view: TutorialView;
  version: number;
  steps: readonly TutorialStep[];
  cleanup?: () => void;
}

export interface TutorialCursor {
  primaryId: string;
  detailId?: string;
  branchId?: string;
}

export interface TutorialProgress {
  version: number;
  cursor: TutorialCursor;
}

export type TutorialCleanup = () => void;
export type TutorialBeforeStartResult = void | false | TutorialCleanup;
