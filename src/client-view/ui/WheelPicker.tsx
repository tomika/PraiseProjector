/**
 * WheelPicker — shared vertical "radio tuner" popup for the toolbar Transpose
 * and Capo controls (see MainToolbar). Shows the selected value plus 3
 * neighbours above and below; dragging, the mouse wheel, tapping a visible
 * neighbour, or the arrow keys change the value, applying every detent
 * immediately via onChange. Pure UI — no store/API imports — portalled to
 * document.body so it floats above the client view, like the modal dialogs.
 */

import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";

export interface WheelPickerProps {
  /** Ordered values, rendered top→bottom in array order (ascending for both callers). */
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
  ariaLabel: string;
}

const ITEM_H = 36;
const VISIBLE = 7;
const HEIGHT = VISIBLE * ITEM_H;
const WIDTH = 72;
const CENTER_TOP = (HEIGHT - ITEM_H) / 2;
/** Below this much total pointer travel, a release is a tap, not a drag. */
const TAP_SLOP_PX = 6;

const offsetFor = (indexFloat: number) => CENTER_TOP - indexFloat * ITEM_H;

// Preferred below the anchor; flipped above if that would overflow the
// viewport bottom; centered as a last resort on a viewport too short for
// either. Horizontally centered on the anchor, then clamped to the viewport —
// the toolbar is a vertical side column in wide-pane layout, so the popup can
// need to shift sideways too.
function computePosition(anchor: HTMLElement): { top: number; left: number } {
  const rect = anchor.getBoundingClientRect();
  const preferredTop = rect.bottom + 6;
  const aboveTop = rect.top - 6 - HEIGHT;
  let top: number;
  if (preferredTop + HEIGHT <= window.innerHeight) {
    top = preferredTop;
  } else if (aboveTop >= 0) {
    top = aboveTop;
  } else {
    top = Math.max(8, (window.innerHeight - HEIGHT) / 2);
  }
  const centeredLeft = rect.left + rect.width / 2 - WIDTH / 2;
  const left = Math.max(8, Math.min(centeredLeft, window.innerWidth - WIDTH - 8));
  return { top, left };
}

export function WheelPicker({ values, value, format, valueText, onChange, onClose, anchor, ariaLabel }: WheelPickerProps) {
  const clampIndex = (i: number) => Math.max(0, Math.min(values.length - 1, i));
  const indexOfValue = (v: number) => {
    const i = values.indexOf(v);
    return i === -1 ? 0 : i;
  };

  const wheelRef = useRef<HTMLDivElement | null>(null);
  const trackRef = useRef<HTMLDivElement | null>(null);
  const currentIndexRef = useRef(clampIndex(indexOfValue(value)));
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

  const [place, setPlace] = useState(() => computePosition(anchor));

  const writeTransform = (posFloat: number) => {
    if (trackRef.current) trackRef.current.style.transform = `translateY(${offsetFor(posFloat)}px)`;
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

  // Recompute the fixed position on open and on viewport resize.
  useEffect(() => {
    const recompute = () => setPlace(computePosition(anchor));
    recompute();
    window.addEventListener("resize", recompute);
    return () => window.removeEventListener("resize", recompute);
  }, [anchor]);

  // Take focus on open.
  useEffect(() => {
    wheelRef.current?.focus();
  }, []);

  // Hand focus back to the trigger button whenever the popup closes.
  useEffect(() => {
    return () => anchor.focus();
  }, [anchor]);

  // Outside pointerdown closes the popup — except on the anchor itself (its
  // own onClick toggles the popup instead of close-then-reopen; see
  // MainToolbar) or inside the wheel (selecting a value must never close it).
  // Base pattern copied from MoreMenu's dismissal effect, but captured (not
  // bubbled) and stopped so the SAME tap can never also reach whatever's
  // underneath (a song row, another toolbar button, ...) — dismissing the
  // wheel must be the only effect of that interaction. Stopping this
  // pointerdown doesn't stop the browser's separate, later `click` for the
  // same gesture, so that's swallowed too, via a listener kept independent of
  // this component's own lifecycle (it must outlive the unmount onClose()
  // triggers) that removes itself once it fires, or after a short timeout if
  // the gesture never completes as a click (e.g. it turned into a drag).
  useEffect(() => {
    const onDocPointerDown = (event: PointerEvent) => {
      const target = event.target as Node;
      if (wheelRef.current?.contains(target)) return;
      if (anchor.contains(target)) return;
      event.preventDefault();
      event.stopPropagation();
      const swallowClick = (e: MouseEvent) => {
        e.preventDefault();
        e.stopPropagation();
      };
      document.addEventListener("click", swallowClick, { capture: true, once: true });
      window.setTimeout(() => document.removeEventListener("click", swallowClick, true), 500);
      onClose();
    };
    document.addEventListener("pointerdown", onDocPointerDown, true);
    return () => document.removeEventListener("pointerdown", onDocPointerDown, true);
  }, [anchor, onClose]);

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
    const raw = startPosRef.current + (startYRef.current - e.clientY) / ITEM_H;
    const clamped = Math.max(0, Math.min(values.length - 1, raw));
    posRef.current = clamped;
    writeTransform(clamped);
    const rounded = Math.round(clamped);
    if (rounded !== currentIndexRef.current) {
      commitIndex(rounded);
      navigator.vibrate?.(8);
    }
  };

  // Shared by pointerup (checkTap: a short tap jumps to the tapped row) and
  // pointercancel (never a tap — just settle where the drag left off).
  const endGesture = (e: React.PointerEvent<HTMLDivElement>, checkTap: boolean) => {
    if (pointerIdRef.current !== e.pointerId) return;
    pointerIdRef.current = null;
    if (checkTap && travelRef.current < TAP_SLOP_PX) {
      const rect = wheelRef.current?.getBoundingClientRect();
      const offsetY = rect ? e.clientY - rect.top : CENTER_TOP;
      settleTo(posRef.current + (offsetY - CENTER_TOP) / ITEM_H);
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
    if (e.key === "ArrowUp") {
      e.preventDefault();
      settleTo(currentIndexRef.current + 1);
    } else if (e.key === "ArrowDown") {
      e.preventDefault();
      settleTo(currentIndexRef.current - 1);
    } else if (e.key === "Escape" || e.key === "Enter") {
      e.preventDefault();
      onClose();
    }
  };

  const currentValue = values[currentIndex];
  const describe = valueText ?? format;

  return createPortal(
    <div
      ref={wheelRef}
      className="cv-wheel"
      role="slider"
      tabIndex={0}
      aria-label={ariaLabel}
      aria-valuemin={values[0]}
      aria-valuemax={values[values.length - 1]}
      aria-valuenow={currentValue}
      aria-valuetext={describe(currentValue)}
      style={{ top: place.top, left: place.left }}
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
        style={{ transform: `translateY(${offsetFor(posRef.current)}px)` }}
      >
        {values.map((v, i) => (
          <div key={v} className={`cv-wheel-item${i === currentIndex ? " cv-wheel-current" : ""}`}>
            {format(v)}
          </div>
        ))}
      </div>
      <div className="cv-wheel-highlight" />
    </div>,
    document.body
  );
}
