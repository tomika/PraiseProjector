import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useLocalization } from "../localization/LocalizationContext";
import {
  consumeQueuedTutorialStart,
  hasQueuedTutorialStart,
  queueTutorialStart,
  TUTORIAL_CONTINUE_EVENT,
  TUTORIAL_START_EVENT,
  TUTORIAL_START_VISIBLE_EVENT,
  type TutorialStartDetail,
} from "./tutorialEvents";
import { getTutorialDefinition } from "./tutorialDefinitions";
import {
  firstBranchCursor,
  firstDetailCursor,
  initialTutorialCursor,
  nextTutorialCursor,
  previousTutorialCursor,
  resolveTutorialCursor,
} from "./tutorialState";
import { clearTutorialProgress, loadTutorialProgress, saveTutorialProgress } from "./tutorialStorage";
import type {
  TutorialBeforeStartResult,
  TutorialCleanup,
  TutorialCommand,
  TutorialCursor,
  TutorialDefinition,
  TutorialStep,
  TutorialView,
} from "./tutorialTypes";
import { getTutorialUiCopy } from "./tutorialUiCopy";
import "./tutorial.css";

type TutorialPhase = "closed" | "resume" | "tour";
type Rect = { left: number; top: number; width: number; height: number };
type Position = { left: number; top: number };

interface TutorialHostProps {
  view: TutorialView;
  onBeforeStart?: () => TutorialBeforeStartResult;
  onCommand?: (command: TutorialCommand) => void;
}

const TARGET_PADDING = 7;
const SCREEN_MARGIN = 12;
// Target discovery is driven by DOM/layout events. This timeout is only a safety
// boundary for genuinely unavailable targets, so an observer can never live forever.
const TARGET_WAIT_SAFETY_MS = 1200;
const MISSING_TARGET_DISPLAY_MS = 500;
const START_BLOCKED_TOAST_MS = 5000;
const BLOCKING_DIALOG_SELECTOR = [
  ".messagebox-overlay",
  ".modal-backdrop.show",
  ".sessions-modal-backdrop",
  ".song-importer-backdrop",
  ".instructions-editor-backdrop",
  ".cv-modal-backdrop",
].join(", ");

function isVisible(element: HTMLElement): boolean {
  const rect = element.getBoundingClientRect();
  const style = window.getComputedStyle(element);
  return rect.width > 0 && rect.height > 0 && style.visibility !== "hidden" && style.display !== "none";
}

function findTarget(step: TutorialStep): HTMLElement | null {
  const selectors = typeof step.target === "string" ? [step.target] : step.target;
  for (const selector of selectors) {
    const target = Array.from(document.querySelectorAll<HTMLElement>(selector)).find(isVisible);
    if (target) return target;
  }
  return null;
}

function findHighlightTargets(step: TutorialStep, primaryTarget: HTMLElement): HTMLElement[] {
  if (!step.highlightTargets?.length) return [primaryTarget];
  const targets = step.highlightTargets.flatMap((selector) => Array.from(document.querySelectorAll<HTMLElement>(selector)).filter(isVisible));
  return targets.length ? Array.from(new Set(targets)) : [primaryTarget];
}

function findTutorialCursorForElement(definition: TutorialDefinition, sourceElement: Element | null): TutorialCursor | null {
  if (!(sourceElement instanceof HTMLElement) || sourceElement === document.body) return null;

  const candidates: Array<{
    cursor: TutorialCursor;
    exact: boolean;
    area: number;
    selectorIndex: number;
    depth: number;
    order: number;
  }> = [];
  let order = 0;

  const collect = (step: TutorialStep, cursor: TutorialCursor, depth: number) => {
    const stepOrder = order++;
    const selectors = typeof step.target === "string" ? [step.target] : step.target;
    selectors.forEach((selector, selectorIndex) => {
      for (const target of document.querySelectorAll<HTMLElement>(selector)) {
        if (!isVisible(target) || (target !== sourceElement && !target.contains(sourceElement))) continue;
        const rect = target.getBoundingClientRect();
        candidates.push({
          cursor,
          exact: target === sourceElement,
          area: Math.max(1, rect.width * rect.height),
          selectorIndex,
          depth,
          order: stepOrder,
        });
      }
    });
  };

  definition.steps.forEach((primary) => {
    collect(primary, { primaryId: primary.id }, 0);
    primary.details?.forEach((detail) => collect(detail, { primaryId: primary.id, detailId: detail.id }, 1));
  });

  candidates.sort(
    (a, b) => Number(b.exact) - Number(a.exact) || a.area - b.area || a.selectorIndex - b.selectorIndex || b.depth - a.depth || a.order - b.order
  );
  return candidates[0]?.cursor ?? null;
}

function nextFrame(): Promise<void> {
  return new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
}

function waitForTarget(step: TutorialStep, signal: AbortSignal): Promise<HTMLElement | null> {
  const immediateTarget = findTarget(step);
  if (immediateTarget || signal.aborted) return Promise.resolve(immediateTarget);

  return new Promise((resolve) => {
    let settled = false;
    let checkFrame: number | null = null;
    let timeoutId: number | null = null;
    const observer = new MutationObserver(scheduleCheck);
    const finish = (target: HTMLElement | null) => {
      if (settled) return;
      settled = true;
      observer.disconnect();
      window.removeEventListener("resize", scheduleCheck);
      window.removeEventListener("orientationchange", scheduleCheck);
      signal.removeEventListener("abort", abort);
      if (timeoutId !== null) window.clearTimeout(timeoutId);
      if (checkFrame !== null) cancelAnimationFrame(checkFrame);
      resolve(target);
    };
    const check = () => {
      checkFrame = null;
      if (signal.aborted) {
        finish(null);
        return;
      }
      const target = findTarget(step);
      if (target) finish(target);
    };
    function scheduleCheck() {
      if (checkFrame === null) checkFrame = requestAnimationFrame(check);
    }
    function abort() {
      finish(null);
    }

    // The tutorial overlay is portalled directly under body, so observing the
    // application root avoids waking this observer for the wizard's own DOM updates.
    const applicationRoot = document.getElementById("root") ?? document.body;
    observer.observe(applicationRoot, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ["class", "hidden", "style"],
    });
    window.addEventListener("resize", scheduleCheck);
    window.addEventListener("orientationchange", scheduleCheck);
    signal.addEventListener("abort", abort, { once: true });
    timeoutId = window.setTimeout(() => finish(findTarget(step)), TARGET_WAIT_SAFETY_MS);
    scheduleCheck();
  });
}

function paddedBounds(elements: readonly HTMLElement[]): Rect {
  const rects = elements.map((element) => element.getBoundingClientRect());
  const left = Math.max(4, Math.min(...rects.map((rect) => rect.left)) - TARGET_PADDING);
  const top = Math.max(4, Math.min(...rects.map((rect) => rect.top)) - TARGET_PADDING);
  const right = Math.min(window.innerWidth - 4, Math.max(...rects.map((rect) => rect.right)) + TARGET_PADDING);
  const bottom = Math.min(window.innerHeight - 4, Math.max(...rects.map((rect) => rect.bottom)) + TARGET_PADDING);
  return { left, top, width: Math.max(0, right - left), height: Math.max(0, bottom - top) };
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(Math.max(value, minimum), Math.max(minimum, maximum));
}

function placeWizard(target: Rect, wizard: DOMRect): Position {
  const gap = 14;
  const maxLeft = window.innerWidth - wizard.width - SCREEN_MARGIN;
  const maxTop = window.innerHeight - wizard.height - SCREEN_MARGIN;
  const centeredLeft = clamp(target.left + target.width / 2 - wizard.width / 2, SCREEN_MARGIN, maxLeft);

  if (window.innerHeight - (target.top + target.height) >= wizard.height + gap + SCREEN_MARGIN) {
    return { left: centeredLeft, top: target.top + target.height + gap };
  }
  if (target.top >= wizard.height + gap + SCREEN_MARGIN) {
    return { left: centeredLeft, top: target.top - wizard.height - gap };
  }
  if (window.innerWidth - (target.left + target.width) >= wizard.width + gap + SCREEN_MARGIN) {
    return { left: target.left + target.width + gap, top: clamp(target.top, SCREEN_MARGIN, maxTop) };
  }
  if (target.left >= wizard.width + gap + SCREEN_MARGIN) {
    return { left: target.left - wizard.width - gap, top: clamp(target.top, SCREEN_MARGIN, maxTop) };
  }
  return {
    left: clamp(window.innerWidth - wizard.width - SCREEN_MARGIN, SCREEN_MARGIN, maxLeft),
    top: clamp(window.innerHeight - wizard.height - SCREEN_MARGIN, SCREEN_MARGIN, maxTop),
  };
}

export function TutorialHost({ view, onBeforeStart, onCommand }: TutorialHostProps) {
  const { language } = useLocalization();
  const ui = getTutorialUiCopy(language);
  const definition = useMemo(() => getTutorialDefinition(view), [view]);
  const markerRef = useRef<HTMLSpanElement>(null);
  const wizardRef = useRef<HTMLDivElement>(null);
  const targetRef = useRef<HTMLElement | null>(null);
  const highlightTargetsRef = useRef<HTMLElement[]>([]);
  const targetRecoveryUsedRef = useRef(false);
  const cleanupRef = useRef<TutorialCleanup | null>(null);
  const stepCleanupRef = useRef<TutorialCleanup | null>(null);
  const initialFocusRef = useRef<HTMLElement | null>(null);
  const lastPointerRef = useRef<{ x: number; y: number } | null>(null);
  const blockedToastTimerRef = useRef<number | null>(null);
  const beforeStartRef = useRef(onBeforeStart);
  const commandRef = useRef(onCommand);
  const [phase, setPhase] = useState<TutorialPhase>("closed");
  const [cursor, setCursor] = useState<TutorialCursor | null>(null);
  const [resumeCursor, setResumeCursor] = useState<TutorialCursor | null>(null);
  const [resumeFocusCursor, setResumeFocusCursor] = useState<TutorialCursor | null>(null);
  const [missingTarget, setMissingTarget] = useState(false);
  const [startBlocked, setStartBlocked] = useState(false);
  const [targetRect, setTargetRect] = useState<Rect | null>(null);
  const [wizardPosition, setWizardPosition] = useState<Position>({ left: SCREEN_MARGIN, top: SCREEN_MARGIN });
  const phaseRef = useRef<TutorialPhase>("closed");
  const cursorRef = useRef(cursor);

  // Keep event-driven starts in sync with the DOM commit. In particular, a
  // MutationObserver may request continuation as soon as a blocking dialog is
  // removed, before passive effects would publish the latest onBeforeStart.
  useLayoutEffect(() => {
    beforeStartRef.current = onBeforeStart;
    commandRef.current = onCommand;
    cursorRef.current = cursor;
  }, [cursor, onBeforeStart, onCommand]);

  const updatePhase = useCallback((nextPhase: TutorialPhase) => {
    phaseRef.current = nextPhase;
    setPhase(nextPhase);
  }, []);

  const notifyStartBlocked = useCallback(() => {
    if (blockedToastTimerRef.current !== null) window.clearTimeout(blockedToastTimerRef.current);
    setStartBlocked(true);
    blockedToastTimerRef.current = window.setTimeout(() => {
      blockedToastTimerRef.current = null;
      setStartBlocked(false);
    }, START_BLOCKED_TOAST_MS);
  }, []);

  const clearStartBlocked = useCallback(() => {
    if (blockedToastTimerRef.current !== null) window.clearTimeout(blockedToastTimerRef.current);
    blockedToastTimerRef.current = null;
    setStartBlocked(false);
  }, []);

  useEffect(
    () => () => {
      if (blockedToastTimerRef.current !== null) window.clearTimeout(blockedToastTimerRef.current);
    },
    []
  );

  const resolved = useMemo(() => (cursor ? resolveTutorialCursor(definition, cursor) : null), [cursor, definition]);
  const resumeFocusResolved = useMemo(
    () => (resumeFocusCursor ? resolveTutorialCursor(definition, resumeFocusCursor) : null),
    [definition, resumeFocusCursor]
  );
  const localized = resolved?.step.text[language];
  const activeStepId = phase === "tour" ? resolved?.step.id : undefined;

  useLayoutEffect(() => {
    if (!activeStepId) return;
    document.body.dataset.ppTutorialStep = activeStepId;
    return () => {
      if (document.body.dataset.ppTutorialStep === activeStepId) delete document.body.dataset.ppTutorialStep;
    };
  }, [activeStepId]);

  const hostIsVisible = useCallback(() => !!markerRef.current?.getClientRects().length, []);

  const restoreApplication = useCallback(() => {
    const cleanup = cleanupRef.current;
    cleanupRef.current = null;
    cleanup?.();
  }, []);

  const cleanupPreparedStep = useCallback(() => {
    const cleanup = stepCleanupRef.current;
    stepCleanupRef.current = null;
    cleanup?.();
  }, []);

  const restoreInitialFocus = useCallback(() => {
    const focusTarget = initialFocusRef.current;
    initialFocusRef.current = null;
    if (!focusTarget) return;
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        if (hostIsVisible() && focusTarget.isConnected && isVisible(focusTarget)) focusTarget.focus({ preventScroll: true });
      });
    });
  }, [hostIsVisible]);

  const closeTutorial = useCallback(
    (completed: boolean) => {
      phaseRef.current = "closed";
      const current = cursorRef.current;
      if (completed) clearTutorialProgress(definition);
      else if (current) saveTutorialProgress(definition, current);
      cleanupPreparedStep();
      definition.cleanup?.();
      targetRef.current = null;
      setMissingTarget(false);
      setTargetRect(null);
      setCursor(null);
      setResumeCursor(null);
      setResumeFocusCursor(null);
      updatePhase("closed");
      restoreApplication();
      restoreInitialFocus();
    },
    [cleanupPreparedStep, definition, restoreApplication, restoreInitialFocus, updatePhase]
  );

  const begin = useCallback(
    (focusedCursor: TutorialCursor | null = null, notifyIfBlocked = true): boolean => {
      if (phaseRef.current !== "closed" || !hostIsVisible()) return false;
      phaseRef.current = "tour";
      initialFocusRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
      const cleanup = beforeStartRef.current?.();
      if (cleanup === false) {
        phaseRef.current = "closed";
        initialFocusRef.current = null;
        if (notifyIfBlocked) notifyStartBlocked();
        return false;
      }
      clearStartBlocked();
      cleanupRef.current = typeof cleanup === "function" ? cleanup : null;
      const saved = loadTutorialProgress(definition);
      setMissingTarget(false);
      setTargetRect(null);
      if (saved) {
        setResumeCursor(saved);
        setResumeFocusCursor(focusedCursor);
        updatePhase("resume");
        return true;
      }
      setResumeFocusCursor(null);
      const initial = initialTutorialCursor(definition);
      if (!initial) {
        phaseRef.current = "closed";
        initialFocusRef.current = null;
        restoreApplication();
        return false;
      }
      setCursor(initial);
      updatePhase("tour");
      return true;
    },
    [clearStartBlocked, definition, hostIsVisible, notifyStartBlocked, restoreApplication, updatePhase]
  );

  const continueSaved = useCallback((): boolean => {
    if (phaseRef.current !== "closed" || !hostIsVisible()) return false;
    const saved = loadTutorialProgress(definition);
    if (!saved) {
      return begin();
    }
    phaseRef.current = "tour";
    initialFocusRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const cleanup = beforeStartRef.current?.();
    if (cleanup === false) {
      phaseRef.current = "closed";
      initialFocusRef.current = null;
      notifyStartBlocked();
      return false;
    }
    clearStartBlocked();
    cleanupRef.current = typeof cleanup === "function" ? cleanup : null;
    setMissingTarget(false);
    setTargetRect(null);
    setResumeCursor(null);
    setResumeFocusCursor(null);
    setCursor(saved);
    updatePhase("tour");
    return true;
  }, [begin, clearStartBlocked, definition, hostIsVisible, notifyStartBlocked, updatePhase]);

  const goNext = useCallback(() => {
    if (!resolved) return;
    const next = nextTutorialCursor(definition, resolved);
    if (next) setCursor(next);
    else closeTutorial(true);
  }, [closeTutorial, definition, resolved]);

  const skipUnavailableStep = useCallback(() => {
    setMissingTarget(false);
    // An unavailable target still counts as traversed. In particular, an
    // unavailable final step must complete the tour instead of saving a cursor
    // that can only reopen and be skipped forever.
    goNext();
  }, [goNext]);

  const goBack = useCallback(() => {
    if (!resolved) return;
    const previous = previousTutorialCursor(definition, resolved);
    if (previous) setCursor(previous);
  }, [definition, resolved]);

  const showDetails = useCallback(() => {
    if (!resolved) return;
    const detail = firstDetailCursor(resolved);
    if (detail) setCursor(detail);
  }, [resolved]);

  const showBranch = useCallback(
    (branchId: string) => {
      if (!resolved) return;
      const branch = firstBranchCursor(resolved, branchId);
      if (branch) setCursor(branch);
    },
    [resolved]
  );

  const runCommand = useCallback(
    (command: TutorialCommand) => {
      if (command === "switch-client") queueTutorialStart("client");
      if (command === "switch-full") queueTutorialStart("full");
      closeTutorial(false);
      requestAnimationFrame(() => commandRef.current?.(command));
    },
    [closeTutorial]
  );

  useEffect(() => {
    let retryTimer: number | undefined;
    let retryDeadline = 0;
    const clearRetryTimer = () => {
      if (retryTimer === undefined) return;
      window.clearTimeout(retryTimer);
      retryTimer = undefined;
    };
    const beginQueued = () => {
      if (hostIsVisible() && phaseRef.current === "closed") {
        if (begin(null, false)) {
          consumeQueuedTutorialStart(view);
          clearRetryTimer();
          return;
        }
      }
      if (performance.now() >= retryDeadline) {
        consumeQueuedTutorialStart(view);
        clearRetryTimer();
        return;
      }
      retryTimer = window.setTimeout(beginQueued, 50);
    };
    const startQueuedRetry = () => {
      clearRetryTimer();
      retryDeadline = performance.now() + 10_000;
      beginQueued();
    };
    const onStart = (event: Event) => {
      const detail = (event as CustomEvent<TutorialStartDetail>).detail;
      if (detail?.view !== view) return;
      if (detail.queued) startQueuedRetry();
      else {
        clearRetryTimer();
        begin();
      }
    };
    const onStartVisible = () => {
      if (hostIsVisible()) begin();
    };
    const onContinue = (event: Event) => {
      const detail = (event as CustomEvent<TutorialStartDetail>).detail;
      if (detail?.view === view) continueSaved();
    };
    window.addEventListener(TUTORIAL_START_EVENT, onStart);
    window.addEventListener(TUTORIAL_START_VISIBLE_EVENT, onStartVisible);
    window.addEventListener(TUTORIAL_CONTINUE_EVENT, onContinue);
    if (hasQueuedTutorialStart(view)) startQueuedRetry();
    return () => {
      window.removeEventListener(TUTORIAL_START_EVENT, onStart);
      window.removeEventListener(TUTORIAL_START_VISIBLE_EVENT, onStartVisible);
      window.removeEventListener(TUTORIAL_CONTINUE_EVENT, onContinue);
      clearRetryTimer();
    };
  }, [begin, continueSaved, hostIsVisible, view]);

  useEffect(() => {
    const rememberPointer = (event: PointerEvent) => {
      lastPointerRef.current = { x: event.clientX, y: event.clientY };
    };
    window.addEventListener("pointermove", rememberPointer, { capture: true, passive: true });
    window.addEventListener("pointerdown", rememberPointer, { capture: true, passive: true });
    return () => {
      window.removeEventListener("pointermove", rememberPointer, true);
      window.removeEventListener("pointerdown", rememberPointer, true);
    };
  }, []);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "F1" && phaseRef.current === "closed" && hostIsVisible()) {
        event.preventDefault();
        event.stopImmediatePropagation();
        if (document.querySelector(BLOCKING_DIALOG_SELECTOR)) {
          notifyStartBlocked();
          return;
        }
        const focusedCursor = findTutorialCursorForElement(definition, document.activeElement);
        const pointer = lastPointerRef.current;
        const hoveredElement = !focusedCursor && pointer ? document.elementFromPoint(pointer.x, pointer.y) : null;
        begin(focusedCursor ?? findTutorialCursorForElement(definition, hoveredElement));
        return;
      }
      if (phaseRef.current === "closed") return;
      if (event.target instanceof Element && event.target.closest(".messagebox-overlay")) return;
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopImmediatePropagation();
        closeTutorial(false);
        return;
      }
      if (event.key === "Tab" || wizardRef.current?.contains(event.target as Node)) return;
      event.preventDefault();
      event.stopImmediatePropagation();
    };
    window.addEventListener("keydown", onKeyDown, true);
    return () => window.removeEventListener("keydown", onKeyDown, true);
  }, [begin, closeTutorial, definition, hostIsVisible, notifyStartBlocked]);

  useEffect(() => {
    if (phase === "closed") return;
    let checkFrame: number | null = null;
    const checkHostVisibility = () => {
      if (checkFrame !== null) return;
      checkFrame = requestAnimationFrame(() => {
        checkFrame = null;
        if (!hostIsVisible()) closeTutorial(false);
      });
    };
    const mutationObserver = new MutationObserver(checkHostVisibility);
    for (let ancestor = markerRef.current?.parentElement; ancestor; ancestor = ancestor.parentElement) {
      mutationObserver.observe(ancestor, { attributes: true, attributeFilter: ["class", "hidden", "style"] });
    }
    const intersectionObserver = typeof IntersectionObserver === "undefined" ? null : new IntersectionObserver(checkHostVisibility);
    if (markerRef.current) intersectionObserver?.observe(markerRef.current);
    window.addEventListener("resize", checkHostVisibility);
    window.addEventListener("orientationchange", checkHostVisibility);
    checkHostVisibility();
    return () => {
      mutationObserver.disconnect();
      intersectionObserver?.disconnect();
      window.removeEventListener("resize", checkHostVisibility);
      window.removeEventListener("orientationchange", checkHostVisibility);
      if (checkFrame !== null) cancelAnimationFrame(checkFrame);
    };
  }, [closeTutorial, hostIsVisible, phase]);

  useEffect(() => {
    if (phase !== "tour" || !cursor || !resolved) return;
    saveTutorialProgress(definition, cursor);
    let cancelled = false;
    const targetAbort = new AbortController();

    const prepareTarget = async () => {
      // The previous step's cleanup runs first, and the prepare() calls below
      // follow within the same tick. A cleanup that dismisses a modal surface can
      // leave a short input fence behind (see openClientTutorialValuePicker), which
      // would swallow a synthetic click issued by the prepare() of this step.
      cleanupPreparedStep();
      const stepCleanups: TutorialCleanup[] = [];
      const registerCleanup = (cleanup: void | TutorialCleanup) => {
        if (!cleanup) return;
        stepCleanups.push(cleanup);
        stepCleanupRef.current = () => {
          for (let index = stepCleanups.length - 1; index >= 0; index -= 1) stepCleanups[index]();
        };
      };
      targetRef.current = null;
      targetRecoveryUsedRef.current = false;
      setMissingTarget(false);
      setTargetRect(null);
      registerCleanup(resolved.primary.prepare?.());
      await nextFrame();
      if (cancelled) return;
      if (resolved.detailIndex !== null) registerCleanup(resolved.step.prepare?.());
      await nextFrame();
      if (cancelled) return;
      const target = await waitForTarget(resolved.step, targetAbort.signal);
      if (cancelled) return;
      if (!target) {
        setMissingTarget(true);
        return;
      }
      target.scrollIntoView({ block: "nearest", inline: "nearest", behavior: "auto" });
      await nextFrame();
      if (cancelled) return;
      targetRef.current = target;
      highlightTargetsRef.current = findHighlightTargets(resolved.step, target);
      setTargetRect(paddedBounds(highlightTargetsRef.current));
    };

    void prepareTarget();
    return () => {
      cancelled = true;
      targetAbort.abort();
      cleanupPreparedStep();
    };
  }, [cleanupPreparedStep, cursor, definition, phase, resolved]);

  useEffect(() => {
    if (phase !== "tour" || !missingTarget || !resolved) return;
    const timer = window.setTimeout(() => {
      const recoveredTarget = findTarget(resolved.step);
      if (!recoveredTarget || targetRecoveryUsedRef.current) {
        skipUnavailableStep();
        return;
      }
      // Recover at most once per step. A repeatedly blinking target otherwise
      // alternates forever between spotlight and missing-target states.
      targetRecoveryUsedRef.current = true;
      recoveredTarget.scrollIntoView({ block: "nearest", inline: "nearest", behavior: "auto" });
      targetRef.current = recoveredTarget;
      highlightTargetsRef.current = findHighlightTargets(resolved.step, recoveredTarget);
      setTargetRect(paddedBounds(highlightTargetsRef.current));
      setMissingTarget(false);
    }, MISSING_TARGET_DISPLAY_MS);
    return () => window.clearTimeout(timer);
  }, [missingTarget, phase, resolved, skipUnavailableStep]);

  useLayoutEffect(() => {
    if (phase !== "tour" || !targetRect || !wizardRef.current) return;
    let updateFrame: number | null = null;
    let disappearanceFrame: number | null = null;
    const confirmTargetDisappeared = () => {
      if (disappearanceFrame !== null) return;
      disappearanceFrame = requestAnimationFrame(() => {
        disappearanceFrame = requestAnimationFrame(() => {
          disappearanceFrame = null;
          const target = targetRef.current;
          if (!target || isVisible(target)) {
            if (target) scheduleUpdate();
            return;
          }
          targetRef.current = null;
          setTargetRect(null);
          setMissingTarget(true);
        });
      });
    };
    const update = () => {
      const target = targetRef.current;
      const wizard = wizardRef.current;
      if (!target || !wizard) return;
      const visibleHighlightTargets = highlightTargetsRef.current.filter(isVisible);
      if (!visibleHighlightTargets.length) {
        confirmTargetDisappeared();
        return;
      }
      const nextRect = paddedBounds(visibleHighlightTargets);
      setTargetRect((current) =>
        current &&
        current.left === nextRect.left &&
        current.top === nextRect.top &&
        current.width === nextRect.width &&
        current.height === nextRect.height
          ? current
          : nextRect
      );
      const nextPosition = placeWizard(nextRect, wizard.getBoundingClientRect());
      setWizardPosition((current) => (current.left === nextPosition.left && current.top === nextPosition.top ? current : nextPosition));
    };
    const scheduleUpdate = () => {
      if (updateFrame !== null) return;
      updateFrame = requestAnimationFrame(() => {
        updateFrame = null;
        update();
      });
    };

    update();
    const observer = new ResizeObserver(scheduleUpdate);
    highlightTargetsRef.current.forEach((target) => observer.observe(target));
    window.addEventListener("resize", scheduleUpdate);
    window.addEventListener("scroll", scheduleUpdate, true);
    return () => {
      observer.disconnect();
      window.removeEventListener("resize", scheduleUpdate);
      window.removeEventListener("scroll", scheduleUpdate, true);
      if (updateFrame !== null) cancelAnimationFrame(updateFrame);
      if (disappearanceFrame !== null) cancelAnimationFrame(disappearanceFrame);
    };
  }, [phase, targetRect]);

  useEffect(() => {
    if (phase === "closed") return;
    const frame = requestAnimationFrame(() => wizardRef.current?.querySelector<HTMLElement>(".pp-tutorial-primary-action")?.focus());
    return () => cancelAnimationFrame(frame);
  }, [cursor, phase]);

  const dots = resolved?.detailIndex === null ? definition.steps : (resolved?.branch?.steps ?? resolved?.primary.details);
  const dotIndex = resolved?.detailIndex ?? resolved?.primaryIndex ?? 0;
  const hasBack = !!(resolved && previousTutorialCursor(definition, resolved));
  const hasNext = !!(resolved && nextTutorialCursor(definition, resolved));
  const hasDetails = resolved?.detailIndex === null && !!resolved.primary.details?.length;
  const branches = resolved?.detailIndex === null ? resolved.primary.branches : undefined;
  const stepActions = resolved?.step.actions;

  const overlay =
    phase === "closed"
      ? null
      : createPortal(
          <div
            className={`pp-tutorial-layer${targetRect ? " has-target" : ""}`}
            onPointerDownCapture={(event) => event.stopPropagation()}
            onMouseDownCapture={(event) => event.stopPropagation()}
          >
            <div className="pp-tutorial-blocker" aria-hidden="true" />
            {targetRect && (
              <div
                className="pp-tutorial-spotlight"
                style={{ left: targetRect.left, top: targetRect.top, width: targetRect.width, height: targetRect.height }}
                aria-hidden="true"
              />
            )}
            <div
              ref={wizardRef}
              className={`pp-tutorial-wizard${phase === "resume" ? " pp-tutorial-resume" : ""}${phase === "tour" && !targetRect ? " pp-tutorial-waiting" : ""}`}
              style={phase === "tour" && targetRect ? wizardPosition : undefined}
              role="dialog"
              aria-modal="true"
              aria-labelledby="pp-tutorial-title"
            >
              <button type="button" className="pp-tutorial-exit" onClick={() => closeTutorial(false)} aria-label={ui.exit} title={ui.exit}>
                <span>{ui.exit}</span>
                <span aria-hidden="true">×</span>
              </button>
              {phase === "resume" ? (
                <>
                  <h2 id="pp-tutorial-title">{ui.resumeTitle}</h2>
                  <p>{ui.resumeBody}</p>
                  <div className="pp-tutorial-actions pp-tutorial-resume-actions">
                    <button
                      type="button"
                      className="pp-tutorial-button pp-tutorial-secondary"
                      onClick={() => {
                        clearTutorialProgress(definition);
                        const initial = initialTutorialCursor(definition);
                        if (initial) {
                          setResumeCursor(null);
                          setResumeFocusCursor(null);
                          setCursor(initial);
                          updatePhase("tour");
                        }
                      }}
                    >
                      {ui.restart}
                    </button>
                    <button
                      type="button"
                      className="pp-tutorial-button pp-tutorial-primary pp-tutorial-primary-action"
                      onClick={() => {
                        if (resumeCursor) {
                          setResumeFocusCursor(null);
                          setCursor(resumeCursor);
                          updatePhase("tour");
                        }
                      }}
                    >
                      {ui.resume}
                    </button>
                    {resumeFocusCursor && resumeFocusResolved && (
                      <button
                        type="button"
                        className="pp-tutorial-button pp-tutorial-secondary pp-tutorial-resume-from-focus"
                        onClick={() => {
                          setResumeCursor(null);
                          setResumeFocusCursor(null);
                          setCursor(resumeFocusCursor);
                          updatePhase("tour");
                        }}
                      >
                        {ui.resumeFromFocus.replace("{item}", resumeFocusResolved.step.text[language].title)}
                      </button>
                    )}
                  </div>
                </>
              ) : (
                <>
                  <div className="pp-tutorial-layer-label">
                    {resolved?.detailIndex === null ? ui.overview : resolved?.branch ? resolved.branch.label[language] : ui.detailsLayer}
                  </div>
                  <h2 id="pp-tutorial-title">{localized?.title}</h2>
                  <p aria-live="polite">{missingTarget ? ui.missingTarget : localized?.body}</p>
                  {!!stepActions?.length && (
                    <div className="pp-tutorial-command-actions">
                      {stepActions.map((action) => (
                        <button
                          key={action.id}
                          type="button"
                          className="pp-tutorial-button pp-tutorial-command"
                          onClick={() => runCommand(action.command)}
                        >
                          {action.label[language]}
                        </button>
                      ))}
                    </div>
                  )}
                  {dots && dots.length > 1 && (
                    <div className="pp-tutorial-progress" aria-label={`${dotIndex + 1}/${dots.length}`}>
                      {dots.map((step, index) => (
                        <span key={step.id} className={`pp-tutorial-dot${index === dotIndex ? " active" : ""}`} aria-hidden="true" />
                      ))}
                    </div>
                  )}
                  <div className="pp-tutorial-actions">
                    <div className="pp-tutorial-actions-left">
                      {hasBack && (
                        <button type="button" className="pp-tutorial-button pp-tutorial-secondary" onClick={goBack}>
                          {ui.back}
                        </button>
                      )}
                      {hasDetails && (
                        <button type="button" className="pp-tutorial-button pp-tutorial-secondary" onClick={showDetails}>
                          {ui.details}
                        </button>
                      )}
                    </div>
                    <button type="button" className="pp-tutorial-button pp-tutorial-primary pp-tutorial-primary-action" onClick={goNext}>
                      {hasNext ? ui.next : ui.finish}
                    </button>
                  </div>
                  {!!branches?.length && (
                    <div className="pp-tutorial-branch-actions">
                      {branches.map((branch) => (
                        <button
                          key={branch.id}
                          type="button"
                          className="pp-tutorial-button pp-tutorial-secondary pp-tutorial-branch"
                          onClick={() => showBranch(branch.id)}
                        >
                          {branch.label[language]}
                        </button>
                      ))}
                    </div>
                  )}
                </>
              )}
            </div>
          </div>,
          document.body
        );

  const blockedToast = startBlocked
    ? createPortal(
        <div className="pp-tutorial-start-blocked" role="status" aria-live="polite">
          {ui.startBlocked}
        </div>,
        document.body
      )
    : null;

  return (
    <>
      <span ref={markerRef} className="pp-tutorial-host-marker" aria-hidden="true" />
      {blockedToast}
      {overlay}
    </>
  );
}
