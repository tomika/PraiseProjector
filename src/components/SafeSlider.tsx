import React, { useEffect, useRef, useState } from "react";

/**
 * A drop-in replacement for `<input type="range">` that is mobile-friendly.
 *
 * On touch devices the native range input jumps the thumb to wherever the user
 * first touches the track, which causes accidental value changes when the user
 * is trying to scroll the page.  SafeSlider solves this by:
 *
 * - Blocking the native touch-to-jump behaviour via a non-passive touchstart
 *   handler.
 * - Requiring an intentional *horizontal* drag gesture (≥ 5 px) before the
 *   value changes.
 * - Forwarding *vertical* gestures to the nearest scrollable ancestor so
 *   settings-page scrolling still works normally.
 *
 * On mouse (desktop) the component behaves identically to a native range input.
 */
const SafeSlider: React.FC<Omit<React.InputHTMLAttributes<HTMLInputElement>, "type">> = ({
  onChange,
  value,
  min = 0,
  max = 100,
  step = 1,
  ...rest
}) => {
  const inputRef = useRef<HTMLInputElement>(null);
  const [localValue, setLocalValue] = useState(Number(value));
  const [isTouchDragging, setIsTouchDragging] = useState(false);
  const isTouchActive = useRef(false);
  const valueRef = useRef(Number(value));

  useEffect(() => {
    valueRef.current = Number(value);
  }, [value]);

  // Store latest onChange in a ref so the touch handler closure always calls
  // the most-recent callback without needing to be recreated.
  const onChangeRef = useRef(onChange);
  useEffect(() => {
    onChangeRef.current = onChange;
  }, [onChange]);

  // Attach imperative (non-passive) touch handlers so we can call
  // preventDefault() to suppress the native jump-to-click behaviour.
  useEffect(() => {
    const el = inputRef.current;
    if (!el) return;

    // --- helpers --------------------------------------------------------

    const findScrollableParent = (node: Element | null): Element | null => {
      let cur = node;
      while (cur) {
        const style = window.getComputedStyle(cur);
        if ((style.overflowY === "auto" || style.overflowY === "scroll") && cur.scrollHeight > cur.clientHeight) {
          return cur;
        }
        cur = cur.parentElement;
      }
      return document.documentElement;
    };

    const calcValueFromDelta = (startValue: number, deltaX: number): number => {
      const rect = el.getBoundingClientRect();
      const numMin = Number(min);
      const numMax = Number(max);
      const numStep = Number(step);
      const range = numMax - numMin;
      const valueDelta = rect.width > 0 ? (deltaX / rect.width) * range : 0;
      const raw = startValue + valueDelta;
      return Math.min(numMax, Math.max(numMin, Math.round(raw / numStep) * numStep));
    };

    const isTouchNearThumb = (clientX: number, currentValue: number): boolean => {
      const rect = el.getBoundingClientRect();
      const numMin = Number(min);
      const numMax = Number(max);
      const range = numMax - numMin;
      if (range <= 0 || rect.width <= 0) return false;

      const pct = (currentValue - numMin) / range;
      const thumbX = rect.left + pct * rect.width;
      // Approximate thumb hit area on mobile.
      return Math.abs(clientX - thumbX) <= 28;
    };

    // --- per-gesture state (reset each touchstart) ----------------------
    let startX = 0;
    let startY = 0;
    let lastY = 0;
    let startValue = 0;
    let intentDetermined = false;
    let isSliding = false;
    let touchCaptureActive = false;
    let scrollableParent: Element | null = null;

    // --- handlers -------------------------------------------------------

    const onTouchStart = (e: TouchEvent) => {
      const touch = e.changedTouches[0];
      startX = touch.clientX;
      startY = touch.clientY;
      lastY = touch.clientY;
      startValue = valueRef.current;
      intentDetermined = false;
      isSliding = false;
      isTouchActive.current = true;
      touchCaptureActive = isTouchNearThumb(touch.clientX, startValue);
      setIsTouchDragging(touchCaptureActive);
      scrollableParent = findScrollableParent(el.parentElement);

      // Prevent the native slider from jumping the thumb to the touch point.
      e.preventDefault();
    };

    const onTouchMove = (e: TouchEvent) => {
      const touch = e.changedTouches[0];

      // Touch did not start on the thumb: treat as scroll-only gesture.
      if (!touchCaptureActive) {
        const delta = lastY - touch.clientY;
        if (scrollableParent) scrollableParent.scrollTop += delta;
        lastY = touch.clientY;
        return;
      }

      const dx = Math.abs(touch.clientX - startX);
      const dy = Math.abs(touch.clientY - startY);

      // Wait until there's enough movement to determine intent.
      if (!intentDetermined) {
        if (dx > 5 || dy > 5) {
          intentDetermined = true;
          isSliding = dx > dy;
          lastY = touch.clientY;
        }
        // No action until intent is clear.
        return;
      }

      if (isSliding) {
        // Horizontal drag → change slider value.
        e.preventDefault();
        const newVal = calcValueFromDelta(startValue, touch.clientX - startX);
        setLocalValue(newVal);
        onChangeRef.current?.({
          target: { value: String(newVal) } as HTMLInputElement,
          currentTarget: { value: String(newVal) } as HTMLInputElement,
        } as React.ChangeEvent<HTMLInputElement>);
      } else {
        // Vertical drag → scroll the nearest scrollable ancestor.
        const delta = lastY - touch.clientY;
        if (scrollableParent) scrollableParent.scrollTop += delta;
        lastY = touch.clientY;
      }
    };

    const onTouchEnd = () => {
      isTouchActive.current = false;
      setIsTouchDragging(false);
      intentDetermined = false;
      isSliding = false;
      touchCaptureActive = false;
    };

    el.addEventListener("touchstart", onTouchStart, { passive: false });
    el.addEventListener("touchmove", onTouchMove, { passive: false });
    el.addEventListener("touchend", onTouchEnd);
    el.addEventListener("touchcancel", onTouchEnd);

    return () => {
      el.removeEventListener("touchstart", onTouchStart);
      el.removeEventListener("touchmove", onTouchMove);
      el.removeEventListener("touchend", onTouchEnd);
      el.removeEventListener("touchcancel", onTouchEnd);
    };
    // min/max/step are read inside the closure; re-register when they change.
    // onChange is accessed through a ref so it is intentionally excluded.
  }, [min, max, step]);

  // Mouse change: delegate directly to the native event.
  const handleMouseChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    // Ignore native touch-generated range events; touch updates are handled manually.
    if (isTouchActive.current) return;
    setLocalValue(Number(e.target.value));
    onChange?.(e);
  };

  return (
    <input
      ref={inputRef}
      type="range"
      value={isTouchDragging ? localValue : Number(value)}
      min={min}
      max={max}
      step={step}
      onChange={handleMouseChange}
      {...rest}
    />
  );
};

export default SafeSlider;
