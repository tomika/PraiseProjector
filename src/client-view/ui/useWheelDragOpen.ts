import { useCallback, useLayoutEffect, useRef } from "react";

/**
 * useWheelDragOpen — opens a WheelPicker the instant the user DRAGS off a trigger
 * element ALONG the wheel's own axis, and hands the in-flight pointer to the
 * freshly-opened wheel (see WheelPicker's `initialDrag`) so it begins turning
 * immediately — as if the finger had been rotating it from the first touch.
 *
 * It is purely additive: the trigger keeps its existing tap / long-press
 * behaviour; only a deliberate along-axis drag past the threshold opens the wheel.
 * Spread `handlers` onto the trigger element (composing with any existing pointer
 * handlers), and call `consumeDragOpenClick()` at the top of the trigger's onClick
 * so the click that trails a drag-open does not re-toggle the control.
 *
 * Pointer delivery: touch and pen are implicitly captured to the trigger on
 * pointerdown, so their moves always arrive here — we deliberately do NOT capture
 * them, which keeps the platform long-press `contextmenu` (the capo control relies
 * on it) intact. Mouse has no implicit capture, so we capture it explicitly to
 * catch a fast flick that would otherwise leave the element mid-move.
 */
export interface WheelDragOpenPayload {
  pointerId: number;
  startClientX: number;
  startClientY: number;
}

export interface WheelDragOpenHandlers {
  onPointerDown: (e: React.PointerEvent) => void;
  onPointerMove: (e: React.PointerEvent) => void;
  onPointerUp: (e: React.PointerEvent) => void;
  onPointerCancel: (e: React.PointerEvent) => void;
}

export interface WheelDragOpenOptions {
  /** The opened wheel's orientation — the axis a drag must follow to trigger. */
  orientation: "horizontal" | "vertical";
  /** Fired once, when an along-axis drag crosses the threshold. The payload's
   *  coordinates are the ORIGINAL touch-down point, so the adopting wheel turns
   *  continuously (no jump) from where the finger first pressed. */
  onOpen: (payload: WheelDragOpenPayload) => void;
  /** When false the gesture is inert (e.g. the capo picker while capo is off). */
  enabled?: boolean;
  /** Along-axis travel (px) that opens the wheel. Defaults to the same slop that
   *  voids a long-press, so the one movement both cancels the press and opens. */
  thresholdPx?: number;
}

export interface UseWheelDragOpenResult {
  handlers: WheelDragOpenHandlers;
  /** Returns true (once) if a drag has just opened the wheel, so the trailing
   *  click can be ignored. Reading it clears the flag. */
  consumeDragOpenClick: () => boolean;
}

const DEFAULT_THRESHOLD_PX = 10;

export function useWheelDragOpen({
  orientation,
  onOpen,
  enabled = true,
  thresholdPx = DEFAULT_THRESHOLD_PX,
}: WheelDragOpenOptions): UseWheelDragOpenResult {
  // Refreshed every render (same pattern as useLongPress) so the handlers —
  // created once below — always read the latest options without re-binding.
  const onOpenRef = useRef(onOpen);
  const orientationRef = useRef(orientation);
  const enabledRef = useRef(enabled);
  const thresholdRef = useRef(thresholdPx);
  useLayoutEffect(() => {
    onOpenRef.current = onOpen;
    orientationRef.current = orientation;
    enabledRef.current = enabled;
    thresholdRef.current = thresholdPx;
  });

  const pointerIdRef = useRef<number | null>(null);
  const startXRef = useRef(0);
  const startYRef = useRef(0);
  /** This gesture has already opened the wheel — ignore further moves. */
  const openedRef = useRef(false);
  /** A drag just opened the wheel; the trailing click must be swallowed. */
  const dragOpenClickRef = useRef(false);

  const onPointerDown = useCallback((e: React.PointerEvent) => {
    // Reset per interaction so a stale "just drag-opened" flag from an earlier
    // gesture can never swallow a later genuine tap's click.
    openedRef.current = false;
    dragOpenClickRef.current = false;
    if (e.button !== 0) return; // primary button / touch / pen contact only
    if (!enabledRef.current) return;
    pointerIdRef.current = e.pointerId;
    startXRef.current = e.clientX;
    startYRef.current = e.clientY;
    // Touch/pen are already implicitly captured to this element; capturing mouse
    // too keeps a fast flick that leaves the element from escaping detection. We
    // never capture touch/pen so the native long-press contextmenu still fires.
    if (e.pointerType === "mouse") {
      try {
        (e.currentTarget as Element).setPointerCapture(e.pointerId);
      } catch {
        /* best-effort; the small threshold usually keeps the cursor in-bounds */
      }
    }
  }, []);

  const onPointerMove = useCallback((e: React.PointerEvent) => {
    if (openedRef.current || pointerIdRef.current !== e.pointerId || !enabledRef.current) return;
    const dx = e.clientX - startXRef.current;
    const dy = e.clientY - startYRef.current;
    const along = orientationRef.current === "horizontal" ? Math.abs(dx) : Math.abs(dy);
    const cross = orientationRef.current === "horizontal" ? Math.abs(dy) : Math.abs(dx);
    // A decisive move ALONG the wheel's axis (either direction): past the
    // threshold and more along-axis than across it, so a cross-axis scroll or
    // swipe never opens the wheel.
    if (along >= thresholdRef.current && along >= cross) {
      openedRef.current = true;
      dragOpenClickRef.current = true;
      onOpenRef.current({ pointerId: e.pointerId, startClientX: startXRef.current, startClientY: startYRef.current });
    }
  }, []);

  // On a drag-open the wheel takes over the pointer, so its up/cancel is delivered
  // to the wheel, not here; this only clears state for presses that never opened.
  const clearPointer = useCallback((e: React.PointerEvent) => {
    if (pointerIdRef.current === e.pointerId) pointerIdRef.current = null;
  }, []);

  const consumeDragOpenClick = useCallback(() => {
    if (!dragOpenClickRef.current) return false;
    dragOpenClickRef.current = false;
    return true;
  }, []);

  return {
    handlers: { onPointerDown, onPointerMove, onPointerUp: clearPointer, onPointerCancel: clearPointer },
    consumeDragOpenClick,
  };
}
