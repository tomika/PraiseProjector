import { useCallback, useLayoutEffect, useRef } from "react";

const LONG_PRESS_MS = 500;

export interface LongPressHandlers {
  onPointerDown: (e: React.PointerEvent) => void;
  onPointerUp: (e: React.PointerEvent) => void;
  onPointerLeave: () => void;
  onPointerCancel: () => void;
  onContextMenu: (e: React.MouseEvent) => void;
}

/**
 * Returns stable event handlers implementing long-press + contextmenu detection.
 * Short tap (<500 ms) calls onShortPress; hold or right-click calls onLongPress.
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
  const fired = useRef(false);
  // When the hold-timer fires on a touch device the OS then ALSO emits a
  // `contextmenu` event for the same gesture — which would invoke onLongPress a
  // second time (toggling a toggle back off, or double-requesting). Record when the
  // timer last fired so onContextMenu can ignore that OS-generated follow-up while
  // still honouring a genuine, standalone right-click.
  const lastLongFire = useRef(0);

  const fireLong = useCallback(() => {
    fired.current = true;
    lastLongFire.current = Date.now();
    longRef.current();
  }, []);

  const onPointerDown = useCallback(
    (e: React.PointerEvent) => {
      if (e.button !== 0) return;
      e.preventDefault();
      fired.current = false;
      timer.current = setTimeout(fireLong, LONG_PRESS_MS);
    },
    [fireLong]
  );

  const onPointerUp = useCallback((e: React.PointerEvent) => {
    if (e.button !== 0) return;
    clearTimeout(timer.current);
    if (!fired.current) shortRef.current();
  }, []);

  const cancel = useCallback(() => {
    clearTimeout(timer.current);
    fired.current = true;
  }, []);

  const onContextMenu = useCallback(
    (e: React.MouseEvent) => {
      e.preventDefault();
      clearTimeout(timer.current);
      // Skip the OS contextmenu that trails a touch long-press we already handled.
      if (Date.now() - lastLongFire.current < 700) return;
      fireLong();
    },
    [fireLong]
  );

  return {
    onPointerDown,
    onPointerUp,
    onPointerLeave: cancel,
    onPointerCancel: cancel,
    onContextMenu,
  };
}
