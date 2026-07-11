import { useCallback, useLayoutEffect, useRef } from "react";

/**
 * Long-press detection strategy — native-first, timer-fallback:
 *
 * Where the platform fires a native long-press `contextmenu` (Android touch,
 * desktop right-click), THAT is the preferred signal: it honours the user's
 * OS-level touch-and-hold delay (an accessibility setting on Android). Our own
 * timer sits slightly ABOVE the default ~500 ms platform delay so the native
 * event normally wins; the timer is the universal fallback for platforms that
 * never fire contextmenu for touch (iOS Safari/WebKit) and for WebViews with
 * long-click suppressed natively.
 */
const LONG_PRESS_MS = 650;
/** Movement beyond this is a drag/scroll, not a hold — the press is voided. */
const MOVE_SLOP_PX = 10;

export interface LongPressHandlers {
  onPointerDown: (e: React.PointerEvent) => void;
  onPointerMove: (e: React.PointerEvent) => void;
  onPointerUp: (e: React.PointerEvent) => void;
  onPointerLeave: () => void;
  onPointerCancel: () => void;
  onContextMenu: (e: React.MouseEvent) => void;
}

/**
 * Returns stable event handlers implementing long-press + contextmenu detection.
 * Short tap (released before the hold delay) calls onShortPress; a hold or a
 * native contextmenu (touch long-press / right-click) calls onLongPress.
 * Spread the returned object directly onto a button or label element.
 */
export function useLongPress(onShortPress: () => void, onLongPress: () => void): LongPressHandlers {
  const shortRef = useRef(onShortPress);
  const longRef = useRef(onLongPress);
  // Update after every render so callbacks always see the latest actions without
  // needing to be in useCallback deps (useLayoutEffect runs before the next paint,
  // so refs are current before any user interaction can fire).
  useLayoutEffect(() => {
    shortRef.current = onShortPress;
    longRef.current = onLongPress;
  });

  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  /** True once THIS interaction has long-fired (or was voided): suppresses the
   *  short press on release and the OS contextmenu that can trail our own timer
   *  by up to the platform's (accessibility-adjustable) hold delay. */
  const fired = useRef(false);
  const pressing = useRef(false);
  const startX = useRef(0);
  const startY = useRef(0);

  const fireLong = useCallback(() => {
    fired.current = true;
    longRef.current();
  }, []);

  const onPointerDown = useCallback(
    (e: React.PointerEvent) => {
      // Reset per interaction — for EVERY button, so a genuine right-click's
      // contextmenu is never swallowed by a stale `fired` from a previous press.
      fired.current = false;
      if (e.button !== 0) return;
      e.preventDefault();
      pressing.current = true;
      startX.current = e.clientX;
      startY.current = e.clientY;
      clearTimeout(timer.current);
      timer.current = setTimeout(fireLong, LONG_PRESS_MS);
    },
    [fireLong]
  );

  // A press that wanders past the slop is a drag (page swipe, scroll) — neither
  // short nor long may fire from it.
  const onPointerMove = useCallback((e: React.PointerEvent) => {
    if (!pressing.current) return;
    if (Math.hypot(e.clientX - startX.current, e.clientY - startY.current) > MOVE_SLOP_PX) {
      pressing.current = false;
      clearTimeout(timer.current);
      fired.current = true;
    }
  }, []);

  const onPointerUp = useCallback((e: React.PointerEvent) => {
    if (e.button !== 0) return;
    pressing.current = false;
    clearTimeout(timer.current);
    if (!fired.current) shortRef.current();
  }, []);

  const cancel = useCallback(() => {
    pressing.current = false;
    clearTimeout(timer.current);
    fired.current = true;
  }, []);

  const onContextMenu = useCallback(
    (e: React.MouseEvent) => {
      e.preventDefault();
      clearTimeout(timer.current);
      // This press already long-fired via our timer — the OS contextmenu may
      // still trail it (Android fires it at the user's hold-delay setting, which
      // can be 1.5 s); don't fire twice.
      if (fired.current) return;
      fireLong();
    },
    [fireLong]
  );

  return {
    onPointerDown,
    onPointerMove,
    onPointerUp,
    onPointerLeave: cancel,
    onPointerCancel: cancel,
    onContextMenu,
  };
}
