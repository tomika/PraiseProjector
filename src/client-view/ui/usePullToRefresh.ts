/**
 * usePullToRefresh — the client-view "pull down from the top" gesture, ported
 * faithfully from the legacy client's loadingCircle handlers in
 * public/client/praiseprojector.ts (installPullToRefreshInputHandlers +
 * mainToolbarReloadHandler + moveLoadingCircle / updateLoadingCircle /
 * checkLoadingCircle). Touch AND mouse, armed only when the scroll container is at
 * the top (scrollTop ≤ 2).
 *
 * Legacy behaviour this reproduces (the parts that were wrong before):
 *
 *  1. The spinner tracks the finger 1:1, hard-clamped at the arm distance — no
 *     rubber-band. Legacy `moveLoadingCircle` set the circle's top to
 *     `min(frameElement.clientHeight / 5, pos)`.
 *
 *  2. Below the arm distance the ring does NOT spin; instead its progress arc
 *     winds up as you pull down and unwinds as you pull back up, proportional to
 *     how far through the arm distance you are. Legacy `updateLoadingCircle` (the
 *     non-max branch) drove this via `perc` → `strokeDashoffset`. This is the
 *     `progress` value (0..1) exposed here.
 *
 *  3. There is a definite stopping point: once the pull passes the arm distance
 *     the ring clamps in place, starts SPINNING (legacy `animate` class) and the
 *     escalation level begins climbing — one level every {@link LEVEL_HOLD_MS}
 *     (legacy loadingCircleLevelChangeTimeout = 2000 ms), capped at `maxLevel`.
 *     Pulling back above the arm distance disarms it (stops spinning, level → 0,
 *     arc unwinds again).
 *
 * On release the hook calls `onRelease(level)` with the held level and keeps the
 * spinner in its "syncing" phase until that promise settles. The level→action
 * mapping (sync / replace-db / clear-data) lives in the controller, not here.
 *
 * The pure helpers ({@link pullOffset}, {@link pullProgress},
 * {@link levelForHoldTime}) are unit-tested in usePullToRefresh.test.ts.
 */

import { useEffect, useRef, useState, type RefObject } from "react";

/** Hold time (ms) per escalation level once armed. Legacy
 *  loadingCircleLevelChangeTimeout. */
export const LEVEL_HOLD_MS = 2000;

/** Fraction of the viewport height the pull must travel to arm (legacy used
 *  ~`clientHeight / 5` of the full song-page div). */
export const ARM_DISTANCE_FRACTION = 0.22;

/** Default arm distance (px) when the viewport height can't be measured. */
export const DEFAULT_ARM_DISTANCE = 140;

/** Pure: the visual position (px) of the spinner — follows the finger 1:1 up to
 *  the arm distance, then hard-clamps there (legacy clamped the circle top to
 *  `clientHeight / 5`; no rubber-band). */
export function pullOffset(distance: number, armDistance: number): number {
  if (distance <= 0) return 0;
  return Math.min(distance, armDistance);
}

/** Pure: the progress-arc fill fraction (0..1) while pulling — proportional to
 *  how far through the arm distance the pull is. Winds up as you pull down and
 *  unwinds as you pull back up (legacy updateLoadingCircle's `perc`). */
export function pullProgress(distance: number, armDistance: number): number {
  if (distance <= 0) return 0;
  return Math.min(distance / armDistance, 1);
}

/** Pure: the escalation level (0..maxLevel) for a pull held past the arm distance
 *  for `heldMs` ms. `heldMs < 0` means "not armed" → level 0. Once armed it starts
 *  at level 1 and climbs one level per {@link LEVEL_HOLD_MS}, capped at `maxLevel`
 *  (0 disables the gesture entirely). */
export function levelForHoldTime(heldMs: number, maxLevel: number, holdMs: number = LEVEL_HOLD_MS): number {
  if (maxLevel <= 0 || heldMs < 0) return 0;
  return Math.min(1 + Math.floor(heldMs / holdMs), maxLevel);
}

export type PullPhase = "idle" | "pulling" | "armed" | "syncing";

export interface PullToRefresh {
  /** Attach to the toolbar / main-view container the pull is anchored to. */
  containerRef: RefObject<HTMLDivElement>;
  phase: PullPhase;
  /** Visual pull offset in px (0 when idle). */
  offset: number;
  /** Progress-arc fill fraction (0..1) while pulling below the arm distance. */
  progress: number;
  /** Currently armed level (0..maxLevel) — the action that fires on release. */
  level: number;
}

export interface UsePullToRefreshOptions {
  /** Highest level the active backend offers (3 = Direct embed; 1 = Rest reload-only). */
  maxLevel: number;
  /** Fired on release with the armed level (>0). Keep the spinner until it settles. */
  onRelease: (level: number) => void | Promise<void>;
  /** Override the arm distance (px). Default: container clientHeight/5 (legacy). */
  armDistance?: number;
  /** Override the per-level hold time (tests, tuning). */
  levelHoldMs?: number;
  /** Override the "scrolled to top" check (default: containerRef.scrollTop ≤ 2)
   *  — for gestures anchored to a wrapper whose INNER element is the scroller
   *  (e.g. the leader-playlists picker, where #list scrolls, not the wrapper). */
  atTop?: () => boolean;
}

export function usePullToRefresh({
  maxLevel,
  onRelease,
  armDistance,
  levelHoldMs = LEVEL_HOLD_MS,
  atTop: atTopOverride,
}: UsePullToRefreshOptions): PullToRefresh {
  const containerRef = useRef<HTMLDivElement>(null);
  const [phase, setPhase] = useState<PullPhase>("idle");
  const [offset, setOffset] = useState(0);
  const [progress, setProgress] = useState(0);
  const [level, setLevel] = useState(0);

  // Gesture tracking (refs so the listeners, attached once, stay current).
  const startYRef = useRef<number | null>(null);
  const startXRef = useRef(0);
  const draggingRef = useRef(false);
  const touchIdRef = useRef<number | null>(null); // identifier of the single tracked touch
  const armRef = useRef(armDistance ?? DEFAULT_ARM_DISTANCE); // arm distance for the live gesture
  const armedAtRef = useRef<number | null>(null); // timestamp the pull armed, or null
  const levelRef = useRef(0);
  const tickRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const phaseRef = useRef(phase);
  const onReleaseRef = useRef(onRelease);
  const atTopOverrideRef = useRef(atTopOverride);

  useEffect(() => {
    phaseRef.current = phase;
  }, [phase]);

  useEffect(() => {
    onReleaseRef.current = onRelease;
  }, [onRelease]);

  useEffect(() => {
    atTopOverrideRef.current = atTopOverride;
  }, [atTopOverride]);

  useEffect(() => {
    const el = containerRef.current;
    if (!el || maxLevel <= 0) return;

    // Legacy arm point: a fraction of the full song-page div height. The gesture
    // container here is the short toolbar, so measure the viewport instead —
    // otherwise the proportion collapses and the spinner barely descends.
    const measureArmDistance = () => {
      if (armDistance) return armDistance;
      const h = (typeof window !== "undefined" && window.innerHeight) || el.clientHeight || 0;
      return h * ARM_DISTANCE_FRACTION || DEFAULT_ARM_DISTANCE;
    };
    const atTop = () => (atTopOverrideRef.current ? atTopOverrideRef.current() : el.scrollTop <= 2);

    const stopTick = () => {
      if (tickRef.current != null) {
        clearInterval(tickRef.current);
        tickRef.current = null;
      }
    };
    const setArmedLevel = () => {
      const heldMs = armedAtRef.current == null ? -1 : Date.now() - armedAtRef.current;
      const lvl = levelForHoldTime(heldMs, maxLevel, levelHoldMs);
      levelRef.current = lvl;
      setLevel(lvl);
    };
    const reset = () => {
      stopTick();
      startYRef.current = null;
      draggingRef.current = false;
      armedAtRef.current = null;
      levelRef.current = 0;
      setPhase("idle");
      setOffset(0);
      setProgress(0);
      setLevel(0);
    };
    const disarm = () => {
      stopTick();
      armedAtRef.current = null;
      levelRef.current = 0;
      setLevel(0);
    };
    const arm = () => {
      armedAtRef.current = Date.now();
      setPhase("armed");
      setProgress(1);
      setArmedLevel();
      // While held, the level climbs purely by elapsed time (legacy updateLevels
      // ran on a 100 ms cadence).
      stopTick();
      tickRef.current = setInterval(setArmedLevel, 100);
    };

    const begin = (x: number, y: number) => {
      if (phaseRef.current === "syncing") return;
      if (!atTop()) {
        startYRef.current = null;
        return;
      }
      armRef.current = measureArmDistance();
      startYRef.current = y;
      startXRef.current = x;
      draggingRef.current = false;
    };
    const move = (x: number, y: number, prevent: () => void) => {
      if (startYRef.current == null || phaseRef.current === "syncing") return;
      const dy = y - startYRef.current;
      const dx = x - startXRef.current;
      if (!draggingRef.current) {
        // Only engage on a clear downward pull (not a horizontal swipe or scroll-up).
        if (dy < 8 || dy <= Math.abs(dx)) return;
        draggingRef.current = true;
      }
      prevent();
      const armDist = armRef.current;
      setOffset(pullOffset(dy, armDist));
      const past = dy >= armDist;
      if (past) {
        if (armedAtRef.current == null) arm();
      } else {
        if (armedAtRef.current != null) disarm();
        setPhase("pulling");
        setProgress(pullProgress(dy, armDist));
      }
    };
    const end = () => {
      if (startYRef.current == null) return;
      stopTick();
      startYRef.current = null;
      draggingRef.current = false;
      const lvl = levelRef.current;
      armedAtRef.current = null;
      if (lvl <= 0) {
        reset();
        return;
      }
      // Hold the spinner in "syncing" (still rotating) until the action settles
      // (then reset — unless the action reloads the page first). The watchdog
      // frees the gesture if the action's promise never settles (hung network):
      // otherwise `begin` refuses every later pull and the gesture is dead for
      // the rest of the session.
      setPhase("syncing");
      setOffset(armRef.current);
      setProgress(1);
      setLevel(lvl);
      levelRef.current = 0;
      const settle = () => {
        if (phaseRef.current === "syncing") reset();
      };
      const watchdog = setTimeout(settle, 30000);
      Promise.resolve(onReleaseRef.current(lvl)).finally(() => {
        clearTimeout(watchdog);
        settle();
      });
    };

    // Track ONE touch by identifier. e.touches[0] is the oldest GLOBAL touch —
    // with a second finger resting elsewhere the pull would jump to that finger's
    // coordinates (or an extra toolbar touch would restart/derail the pull, in the
    // worst case releasing a level the user never armed).
    const findTouch = (list: TouchList, id: number): Touch | null => {
      for (let i = 0; i < list.length; i++) if (list[i].identifier === id) return list[i];
      return null;
    };
    const onTouchStart = (e: TouchEvent) => {
      // Recover from a tracked stream that ended without touchend/touchcancel
      // (app switch mid-pull): if the tracked identifier is no longer among the
      // live touches, it is gone for good — release it so the gesture can't stay
      // wedged for the rest of the session.
      if (touchIdRef.current !== null && !findTouch(e.touches, touchIdRef.current)) {
        touchIdRef.current = null;
        if (phaseRef.current !== "syncing") reset();
        else startYRef.current = null;
      }
      if (touchIdRef.current !== null || startYRef.current != null) return; // already tracking a pull
      const t = e.changedTouches[0];
      if (!t) return;
      touchIdRef.current = t.identifier;
      begin(t.pageX, t.pageY);
    };
    const onTouchMove = (e: TouchEvent) => {
      if (touchIdRef.current == null) return;
      const t = findTouch(e.touches, touchIdRef.current);
      if (t) move(t.pageX, t.pageY, () => e.preventDefault());
    };
    const onTouchEnd = (e: TouchEvent) => {
      if (touchIdRef.current == null) return;
      // Only the tracked finger's lift ends the pull; other fingers are ignored.
      if (!findTouch(e.changedTouches, touchIdRef.current)) return;
      touchIdRef.current = null;
      end();
    };

    let mouseDown = false;
    const onMouseDown = (e: MouseEvent) => {
      if (e.button !== 0) return;
      mouseDown = true;
      begin(e.clientX, e.clientY);
    };
    const onMouseMove = (e: MouseEvent) => {
      if (mouseDown) move(e.clientX, e.clientY, () => e.preventDefault());
    };
    const onSelectStart = (e: Event) => {
      // Selection starts before mousemove reaches the pull threshold, so
      // preventing mousemove alone is too late. Suppress it only while a valid
      // pull candidate is being tracked from the top of this container.
      if (mouseDown && startYRef.current != null) e.preventDefault();
    };
    const onMouseUp = () => {
      if (!mouseDown) return;
      mouseDown = false;
      end();
    };

    const passive: AddEventListenerOptions = { passive: false };
    el.addEventListener("touchstart", onTouchStart, passive);
    el.addEventListener("touchmove", onTouchMove, passive);
    el.addEventListener("touchend", onTouchEnd);
    el.addEventListener("touchcancel", onTouchEnd);
    el.addEventListener("mousedown", onMouseDown);
    el.addEventListener("selectstart", onSelectStart);
    window.addEventListener("mousemove", onMouseMove, passive);
    window.addEventListener("mouseup", onMouseUp);
    return () => {
      stopTick();
      el.removeEventListener("touchstart", onTouchStart);
      el.removeEventListener("touchmove", onTouchMove);
      el.removeEventListener("touchend", onTouchEnd);
      el.removeEventListener("touchcancel", onTouchEnd);
      el.removeEventListener("mousedown", onMouseDown);
      el.removeEventListener("selectstart", onSelectStart);
      window.removeEventListener("mousemove", onMouseMove);
      window.removeEventListener("mouseup", onMouseUp);
    };
  }, [maxLevel, armDistance, levelHoldMs]);

  return { containerRef, phase, offset, progress, level };
}
