/**
 * WheelPicker — shared vertical "radio tuner" popup for the toolbar Transpose
 * and Capo controls (see MainToolbar). Shows the selected value plus 3
 * neighbours above and below; dragging, the mouse wheel, tapping a visible
 * neighbour, or the arrow keys change the value, applying every detent
 * immediately via onChange. Pure UI — no store/API imports — portalled to
 * document.body so it floats above the client view, like the modal dialogs.
 */

import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties } from "react";
import { createPortal } from "react-dom";

export interface WheelPickerProps {
  /** Ordered values, rendered top→bottom or left→right in array order. */
  values: number[];
  /** Currently selected value (controlled). */
  value: number;
  /** Display label for a value (may return "—" style placeholders). */
  format: (v: number) => string;
  /** aria-valuetext override, e.g. "no capo" for −1. Falls back to format(). */
  valueText?: (v: number) => string;
  /** Fired on EVERY detent change (drag crossing a detent, wheel step, tap, arrow key). */
  onChange: (v: number) => void;
  /** Fired on outside pointerdown, Escape or Enter. Never fired by value selection. */
  onClose: () => void;
  /** Toolbar button the popup is anchored to (also excluded from outside-click). */
  anchor: HTMLElement;
  /** Wheel direction. The original vertical picker remains the default. */
  orientation?: "vertical" | "horizontal";
  /** The centered detent is positioned over this element. In horizontal mode it
   * also matches the element's dimensions exactly. */
  selectionAnchor?: HTMLElement;
  /** When the popup was summoned by a drag that STARTED on the trigger element
   * (see useWheelDragOpen), the in-flight pointer to adopt on mount so the wheel
   * opens already mid-rotation — no separate press is needed to begin turning it.
   * The coordinates are the ORIGINAL touch-down point, which keeps the rotation
   * continuous (no jump) from the moment the finger first pressed the trigger. */
  initialDrag?: { pointerId: number; startClientX: number; startClientY: number };
  ariaLabel: string;
  /** The view's dark state. Required because this popup is portalled to
   *  document.body: no `#mainView:not(.dark)` descendant selector can reach it,
   *  so it cannot inherit the client view's light/dark tokens (client-view.css
   *  defaults them to DARK on :root) and must carry the theme down as a class. */
  dark: boolean;
}

const ITEM_H = 36;
const VISIBLE = 7;
const VERTICAL_HEIGHT = VISIBLE * ITEM_H;
const VERTICAL_WIDTH = 72;
const CENTER_ITEM = Math.floor(VISIBLE / 2);
/** Below this much total pointer travel, a release is a tap, not a drag. */
const TAP_SLOP_PX = 6;
const BLOCKED_OUTSIDE_EVENTS = [
  "pointerdown",
  "pointermove",
  "pointerup",
  "pointercancel",
  "mousedown",
  "mousemove",
  "mouseup",
  "touchstart",
  "touchmove",
  "touchend",
  "touchcancel",
  "wheel",
  "click",
  "dblclick",
  "contextmenu",
] as const;
const POST_CLOSE_EVENT_FENCE_MS = 500;

type WheelOrientation = "vertical" | "horizontal";
type WheelMetrics = { itemWidth: number; itemHeight: number; width: number; height: number };

function blockEvent(event: Event) {
  event.preventDefault();
  event.stopImmediatePropagation();
}

// A pointer tap's `click` (and compatibility mouse/touch events) are delivered
// after the picker has unmounted. Keep a short document-level fence alive so the
// closing gesture cannot activate an element that has just been exposed below it.
function armPostCloseEventFence() {
  const swallow = (event: Event) => blockEvent(event);
  const remove = () => BLOCKED_OUTSIDE_EVENTS.forEach((type) => document.removeEventListener(type, swallow, true));
  BLOCKED_OUTSIDE_EVENTS.forEach((type) => document.addEventListener(type, swallow, { capture: true, passive: false }));
  window.setTimeout(remove, POST_CLOSE_EVENT_FENCE_MS);
}

function getMetrics(orientation: WheelOrientation, selectionAnchor?: HTMLElement): WheelMetrics {
  if (orientation === "horizontal") {
    const rect = selectionAnchor?.getBoundingClientRect();
    const itemWidth = Math.max(1, rect?.width ?? ITEM_H);
    const itemHeight = Math.max(1, rect?.height ?? ITEM_H);
    return { itemWidth, itemHeight, width: VISIBLE * itemWidth, height: itemHeight };
  }
  return { itemWidth: VERTICAL_WIDTH, itemHeight: ITEM_H, width: VERTICAL_WIDTH, height: VERTICAL_HEIGHT };
}

// Preferred below the anchor; flipped above if that would overflow the
// viewport bottom; centered as a last resort on a viewport too short for
// either. Horizontally centered on the anchor, then clamped to the viewport —
// the toolbar is a vertical side column in wide-pane layout, so the popup can
// need to shift sideways too.
function computePosition(
  anchor: HTMLElement,
  orientation: WheelOrientation,
  metrics: WheelMetrics,
  selectionAnchor?: HTMLElement
): { top: number; left: number } {
  if (selectionAnchor) {
    const rect = selectionAnchor.getBoundingClientRect();
    if (orientation === "vertical") {
      return {
        top: rect.top + rect.height / 2 - (CENTER_ITEM + 0.5) * metrics.itemHeight,
        left: rect.left + rect.width / 2 - metrics.width / 2,
      };
    }
    // Do not clamp this position: keeping the center detent directly over the
    // value being edited is more important than showing every neighbour at a
    // viewport edge. The picker itself is clipped naturally by the viewport.
    return { top: rect.top, left: rect.left - CENTER_ITEM * metrics.itemWidth };
  }

  const rect = anchor.getBoundingClientRect();
  const preferredTop = rect.bottom + 6;
  const aboveTop = rect.top - 6 - metrics.height;
  let top: number;
  if (preferredTop + metrics.height <= window.innerHeight) {
    top = preferredTop;
  } else if (aboveTop >= 0) {
    top = aboveTop;
  } else {
    top = Math.max(8, (window.innerHeight - metrics.height) / 2);
  }
  const centeredLeft = rect.left + rect.width / 2 - metrics.width / 2;
  const left = Math.max(8, Math.min(centeredLeft, window.innerWidth - metrics.width - 8));
  return { top, left };
}

export function WheelPicker({
  values,
  value,
  format,
  valueText,
  onChange,
  onClose,
  anchor,
  orientation = "vertical",
  selectionAnchor,
  initialDrag,
  ariaLabel,
  dark,
}: WheelPickerProps) {
  const clampIndex = (i: number) => Math.max(0, Math.min(values.length - 1, i));
  const indexOfValue = (v: number) => {
    const i = values.indexOf(v);
    return i === -1 ? 0 : i;
  };

  const wheelRef = useRef<HTMLDivElement | null>(null);
  const trackRef = useRef<HTMLDivElement | null>(null);
  const currentIndexRef = useRef(clampIndex(indexOfValue(value)));
  const openingValueRef = useRef(value);
  const [currentIndex, setCurrentIndex] = useState(currentIndexRef.current);

  // Float index driving the track's live on-screen position. Written only
  // from drag/settle handlers (see the INTENTIONAL note on its render read
  // below) — never derived from currentIndex, which would snap the track back
  // to an integer offset on every detent crossing mid-drag.
  const posRef = useRef(currentIndexRef.current);
  const pointerIdRef = useRef<number | null>(null);
  const startXRef = useRef(0);
  const startYRef = useRef(0);
  const startPosRef = useRef(0);
  const travelRef = useRef(0);
  const tappedItemIndexRef = useRef<number | null>(null);

  // Geometry is intentionally captured once, at open. Moving a visible picker
  // during layout, resize or value changes makes a drag feel detached from the
  // user's pointer, so it remains fixed until this instance closes.
  const [metrics] = useState(() => getMetrics(orientation, selectionAnchor));
  const [place] = useState(() => computePosition(anchor, orientation, metrics, selectionAnchor));

  const offsetFor = (indexFloat: number) =>
    orientation === "horizontal"
      ? CENTER_ITEM * metrics.itemWidth - indexFloat * metrics.itemWidth
      : CENTER_ITEM * metrics.itemHeight - indexFloat * metrics.itemHeight;

  const writeTransform = (posFloat: number) => {
    if (trackRef.current) {
      const offset = offsetFor(posFloat);
      trackRef.current.style.transform = orientation === "horizontal" ? `translateX(${offset}px)` : `translateY(${offset}px)`;
    }
  };

  // Updates the committed value (aria + the current-item class) and notifies
  // the caller; a no-op if `index` (clamped) matches what's already committed.
  const commitIndex = (index: number) => {
    const clamped = clampIndex(index);
    if (clamped !== currentIndexRef.current) {
      currentIndexRef.current = clamped;
      setCurrentIndex(clamped);
      onChange(values[clamped]);
    }
    return clamped;
  };

  // End-of-gesture settle: round to the nearest detent, commit it, and
  // re-enable the snap transition for the final animated move into place.
  const settleTo = (indexFloat: number) => {
    const clamped = commitIndex(Math.round(indexFloat));
    posRef.current = clamped;
    trackRef.current?.classList.add("cv-wheel-snap");
    writeTransform(clamped);
  };

  // Outside dismissal is a cancel operation: restore the value that was active
  // when this picker instance opened before letting the caller close it.
  const revertToOpeningValue = () => {
    const openingIndex = clampIndex(indexOfValue(openingValueRef.current));
    if (openingIndex === currentIndexRef.current) return;
    currentIndexRef.current = openingIndex;
    posRef.current = openingIndex;
    setCurrentIndex(openingIndex);
    onChange(values[openingIndex]);
  };

  // Take focus on open.
  useEffect(() => {
    wheelRef.current?.focus();
  }, []);

  // Adopt an in-flight drag (opened via useWheelDragOpen). Runs in a layout
  // effect — before paint — so pointer capture moves from the trigger element to
  // the wheel as early as possible, and the very next pointermove already rotates
  // the wheel. The refs are seeded exactly as handlePointerDown would, but from
  // the ORIGINAL touch-down point, so there is no jump when rotation begins.
  // travelRef starts past the tap slop so the release settles (and the wheel
  // stays open) instead of being read as a tap that would close it.
  useLayoutEffect(() => {
    if (!initialDrag) return;
    const el = wheelRef.current;
    if (!el) return;
    try {
      el.setPointerCapture(initialDrag.pointerId);
    } catch {
      // The pointer may already be up (a flick shorter than one frame); the
      // wheel then just stays open at its current value.
      return;
    }
    pointerIdRef.current = initialDrag.pointerId;
    startXRef.current = initialDrag.startClientX;
    startYRef.current = initialDrag.startClientY;
    startPosRef.current = posRef.current;
    travelRef.current = TAP_SLOP_PX + 1;
    trackRef.current?.classList.remove("cv-wheel-snap");
    // eslint-disable-next-line react-hooks/exhaustive-deps -- adopt the pointer exactly once, at mount
  }, []);

  // Hand focus back to the trigger button whenever the popup closes.
  useEffect(() => {
    return () => anchor.focus();
  }, [anchor]);

  // Kept current every render (same ref-refresh pattern as settleToRef below) so
  // the document listeners — registered once on mount — always call the latest
  // onClose/revert closures without having to re-register on every render.
  const onCloseRef = useRef(onClose);
  const revertToOpeningValueRef = useRef(revertToOpeningValue);
  useLayoutEffect(() => {
    onCloseRef.current = onClose;
    revertToOpeningValueRef.current = revertToOpeningValue;
  });

  // This is a modal interaction surface, even though it is not a dialog: while
  // open, pointer, mouse and touch events outside it must never reach the page.
  // An outside press dismisses it, but that same press (and its later events)
  // remains consumed by the post-close fence above.
  useEffect(() => {
    let closing = false;
    const onDocumentEvent = (event: Event) => {
      const target = event.target;
      if (target instanceof Node && wheelRef.current?.contains(target)) return;
      blockEvent(event);
      const beginsInteraction = event.type === "pointerdown" || event.type === "mousedown" || event.type === "touchstart";
      if (beginsInteraction && !closing) {
        closing = true;
        revertToOpeningValueRef.current();
        armPostCloseEventFence();
        onCloseRef.current();
      }
    };
    BLOCKED_OUTSIDE_EVENTS.forEach((type) => document.addEventListener(type, onDocumentEvent, { capture: true, passive: false }));
    return () => BLOCKED_OUTSIDE_EVENTS.forEach((type) => document.removeEventListener(type, onDocumentEvent, true));
  }, []);

  // If the controlled value changes from outside while no drag is active,
  // snap the track to it (the snap transition stays enabled outside a drag).
  useEffect(() => {
    if (pointerIdRef.current !== null) return;
    const next = clampIndex(indexOfValue(value));
    if (next !== currentIndexRef.current) {
      currentIndexRef.current = next;
      setCurrentIndex(next);
      posRef.current = next;
      trackRef.current?.classList.add("cv-wheel-snap");
      writeTransform(next);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- only re-sync when the controlled value itself changes
  }, [value]);

  const handlePointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    const item = e.target instanceof Element ? e.target.closest<HTMLElement>("[data-wheel-index]") : null;
    const itemIndex = item ? Number(item.dataset.wheelIndex) : Number.NaN;
    tappedItemIndexRef.current = Number.isInteger(itemIndex) ? itemIndex : null;
    wheelRef.current?.setPointerCapture(e.pointerId);
    pointerIdRef.current = e.pointerId;
    startXRef.current = e.clientX;
    startYRef.current = e.clientY;
    startPosRef.current = posRef.current;
    travelRef.current = 0;
    trackRef.current?.classList.remove("cv-wheel-snap");
  };

  const handlePointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    if (pointerIdRef.current !== e.pointerId) return;
    travelRef.current = Math.max(travelRef.current, Math.hypot(e.clientX - startXRef.current, e.clientY - startYRef.current));
    const axisTravel = orientation === "horizontal" ? startXRef.current - e.clientX : startYRef.current - e.clientY;
    const itemSize = orientation === "horizontal" ? metrics.itemWidth : metrics.itemHeight;
    const raw = startPosRef.current + axisTravel / itemSize;
    const clamped = Math.max(0, Math.min(values.length - 1, raw));
    posRef.current = clamped;
    writeTransform(clamped);
    const rounded = Math.round(clamped);
    if (rounded !== currentIndexRef.current) {
      commitIndex(rounded);
      navigator.vibrate?.(8);
    }
  };

  // Shared by pointerup (a short tap selects the tapped row and closes) and
  // pointercancel (never a tap — just settle where the drag left off).
  const endGesture = (e: React.PointerEvent<HTMLDivElement>, checkTap: boolean) => {
    if (pointerIdRef.current !== e.pointerId) return;
    pointerIdRef.current = null;
    if (checkTap && travelRef.current < TAP_SLOP_PX) {
      const tappedItemIndex = tappedItemIndexRef.current;
      if (tappedItemIndex !== null) {
        settleTo(tappedItemIndex);
      } else {
        // A tap on the wheel's empty area (rather than a value) still settles
        // to the closest detent, but value taps use their DOM index above.
        const rect = wheelRef.current?.getBoundingClientRect();
        const itemSize = orientation === "horizontal" ? metrics.itemWidth : metrics.itemHeight;
        const offset = rect ? (orientation === "horizontal" ? e.clientX - rect.left : e.clientY - rect.top) : CENTER_ITEM * itemSize;
        settleTo(posRef.current + (offset - CENTER_ITEM * itemSize) / itemSize);
      }
      armPostCloseEventFence();
      onClose();
    } else {
      settleTo(posRef.current);
    }
  };

  // Kept current every render (mirrors useLongPress's identical ref-refresh
  // pattern) so the native listener below — attached once on mount — always
  // calls the latest closure instead of the one from whatever render it was
  // attached during.
  const settleToRef = useRef(settleTo);
  useLayoutEffect(() => {
    settleToRef.current = settleTo;
  });

  // React's synthetic onWheel is registered passive (matching the browser's
  // own scroll-performance default for wheel listeners), so e.preventDefault()
  // inside a JSX onWheel handler is silently ignored — attaching the DOM
  // listener directly is the only way to make it non-passive.
  useEffect(() => {
    const el = wheelRef.current;
    if (!el) return;
    const onWheelNative = (e: WheelEvent) => {
      e.preventDefault();
      settleToRef.current(currentIndexRef.current + (e.deltaY < 0 ? 1 : -1));
    };
    el.addEventListener("wheel", onWheelNative, { passive: false });
    return () => el.removeEventListener("wheel", onWheelNative);
  }, []);

  const handleKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    const incrementKey = orientation === "horizontal" ? "ArrowRight" : "ArrowUp";
    const decrementKey = orientation === "horizontal" ? "ArrowLeft" : "ArrowDown";
    if (e.key === incrementKey) {
      e.preventDefault();
      settleTo(currentIndexRef.current + 1);
    } else if (e.key === decrementKey) {
      e.preventDefault();
      settleTo(currentIndexRef.current - 1);
    } else if (e.key === "Escape" || e.key === "Enter") {
      e.preventDefault();
      onClose();
    }
  };

  const currentValue = values[currentIndex];
  const describe = valueText ?? format;
  const wheelStyle = {
    top: place.top,
    left: place.left,
    "--cv-wheel-item-width": `${metrics.itemWidth}px`,
    "--cv-wheel-item-height": `${metrics.itemHeight}px`,
  } as CSSProperties;

  return createPortal(
    <div
      ref={wheelRef}
      className={`cv-wheel cv-wheel-${orientation}${dark ? "" : " cv-wheel-light"}`}
      role="slider"
      tabIndex={0}
      aria-label={ariaLabel}
      aria-valuemin={values[0]}
      aria-valuemax={values[values.length - 1]}
      aria-valuenow={currentValue}
      aria-valuetext={describe(currentValue)}
      aria-orientation={orientation}
      style={wheelStyle}
      onPointerDown={handlePointerDown}
      onPointerMove={handlePointerMove}
      onPointerUp={(e) => endGesture(e, true)}
      onPointerCancel={(e) => endGesture(e, false)}
      onKeyDown={handleKeyDown}
    >
      <div
        ref={trackRef}
        className="cv-wheel-track cv-wheel-snap"
        // INTENTIONAL: posRef is the live drag position; reading it here (not
        // currentIndex state) keeps a mid-drag detent commit from snapping the
        // track back to an integer offset before the finger lifts.
        style={{
          transform: orientation === "horizontal" ? `translateX(${offsetFor(posRef.current)}px)` : `translateY(${offsetFor(posRef.current)}px)`,
        }}
      >
        {values.map((v, i) => (
          <div key={v} className={`cv-wheel-item${i === currentIndex ? " cv-wheel-current" : ""}`} data-wheel-index={i}>
            {format(v)}
          </div>
        ))}
      </div>
      <div className="cv-wheel-highlight" />
    </div>,
    document.body
  );
}
