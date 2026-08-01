import type { TutorialView } from "./tutorialTypes";

export const TUTORIAL_START_EVENT = "pp-tutorial-start";
export const TUTORIAL_START_VISIBLE_EVENT = "pp-tutorial-start-visible";
export const TUTORIAL_CONTINUE_EVENT = "pp-tutorial-continue";

export interface TutorialStartDetail {
  view: TutorialView;
  queued?: boolean;
}

const PENDING_START_KEY = "pp-tutorial-pending-start";
const PENDING_START_TTL_MS = 10_000;
const CONTINUE_OBSERVER_TTL_MS = 30_000;

interface PendingTutorialStart {
  view: TutorialView;
  expiresAt: number;
}

function readPendingTutorialStart(): PendingTutorialStart | null {
  try {
    const raw = sessionStorage.getItem(PENDING_START_KEY);
    if (!raw) return null;
    const pending = JSON.parse(raw) as Partial<PendingTutorialStart>;
    if ((pending.view !== "full" && pending.view !== "client") || typeof pending.expiresAt !== "number" || pending.expiresAt <= Date.now()) {
      sessionStorage.removeItem(PENDING_START_KEY);
      return null;
    }
    return pending as PendingTutorialStart;
  } catch {
    try {
      sessionStorage.removeItem(PENDING_START_KEY);
    } catch {
      // Storage is optional.
    }
    return null;
  }
}

export function requestTutorialStart(view: TutorialView): void {
  window.dispatchEvent(new CustomEvent<TutorialStartDetail>(TUTORIAL_START_EVENT, { detail: { view } }));
}

export function requestVisibleTutorialStart(): void {
  window.dispatchEvent(new Event(TUTORIAL_START_VISIBLE_EVENT));
}

export function requestTutorialContinue(view: TutorialView): void {
  window.dispatchEvent(new CustomEvent<TutorialStartDetail>(TUTORIAL_CONTINUE_EVENT, { detail: { view } }));
}

export function requestTutorialContinueWhenUnblocked(view: TutorialView, blockerSelector: string): void {
  let observer: MutationObserver | null = null;
  let timeoutId: number | null = null;
  let finished = false;
  const finish = (shouldContinue: boolean) => {
    if (finished) return;
    finished = true;
    observer?.disconnect();
    if (timeoutId !== null) window.clearTimeout(timeoutId);
    if (shouldContinue) requestTutorialContinue(view);
  };
  const continueIfReady = () => {
    if (document.querySelector(blockerSelector)) return;
    finish(true);
  };

  if (!document.querySelector(blockerSelector)) {
    requestTutorialContinue(view);
    return;
  }

  observer = new MutationObserver(continueIfReady);
  observer.observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ["class"] });
  timeoutId = window.setTimeout(() => finish(false), CONTINUE_OBSERVER_TTL_MS);
}

export function queueTutorialStart(view: TutorialView): void {
  try {
    sessionStorage.setItem(PENDING_START_KEY, JSON.stringify({ view, expiresAt: Date.now() + PENDING_START_TTL_MS } satisfies PendingTutorialStart));
  } catch {
    // The event still supports same-page view switches when storage is unavailable.
  }
  window.dispatchEvent(new CustomEvent<TutorialStartDetail>(TUTORIAL_START_EVENT, { detail: { view, queued: true } }));
}

export function hasQueuedTutorialStart(view: TutorialView): boolean {
  return readPendingTutorialStart()?.view === view;
}

export function consumeQueuedTutorialStart(view: TutorialView): void {
  try {
    if (readPendingTutorialStart()?.view === view) sessionStorage.removeItem(PENDING_START_KEY);
  } catch {
    // Same-page delivery does not require persistence.
  }
}
