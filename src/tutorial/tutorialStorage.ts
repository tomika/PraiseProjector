import type { TutorialCursor, TutorialDefinition, TutorialProgress } from "./tutorialTypes";
import { resolveTutorialCursor } from "./tutorialState";

const STORAGE_PREFIX = "pp-tutorial-progress";

function storageKey(definition: TutorialDefinition): string {
  return `${STORAGE_PREFIX}:${definition.view}`;
}

export function loadTutorialProgress(definition: TutorialDefinition): TutorialCursor | null {
  try {
    const raw = localStorage.getItem(storageKey(definition));
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<TutorialProgress>;
    if (parsed.version !== definition.version || !parsed.cursor || typeof parsed.cursor.primaryId !== "string") return null;
    return resolveTutorialCursor(definition, parsed.cursor) ? parsed.cursor : null;
  } catch {
    return null;
  }
}

export function saveTutorialProgress(definition: TutorialDefinition, cursor: TutorialCursor): void {
  try {
    const progress: TutorialProgress = { version: definition.version, cursor };
    localStorage.setItem(storageKey(definition), JSON.stringify(progress));
  } catch {
    // Persistence is optional in private browser contexts and embedded webviews.
  }
}

export function clearTutorialProgress(definition: TutorialDefinition): void {
  try {
    localStorage.removeItem(storageKey(definition));
  } catch {
    // Persistence is optional in private browser contexts and embedded webviews.
  }
}
