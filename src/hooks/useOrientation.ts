import { useState, useEffect } from "react";
import { createOrientationResizeTracker, orientationOf, type Orientation } from "../utils/viewLayout";

export type { Orientation };

const isTextEntry = (el: Element | null): boolean => {
  if (!el) return false;
  if (el instanceof HTMLTextAreaElement) return true;
  if (el instanceof HTMLInputElement) return !["button", "checkbox", "radio", "range", "color", "file", "submit", "reset", "image"].includes(el.type);
  return el instanceof HTMLElement && el.isContentEditable;
};

const softKeyboardLikely = () => isTextEntry(document.activeElement) && !!window.matchMedia?.("(pointer: coarse)").matches;

export const useOrientation = (): Orientation => {
  const [orientation, setOrientation] = useState<Orientation>(orientationOf(window.innerWidth, window.innerHeight));

  useEffect(() => {
    const track = createOrientationResizeTracker(window.innerWidth);
    const handleResize = () => {
      setOrientation(track(window.innerWidth, window.innerHeight, softKeyboardLikely()));
    };

    window.addEventListener("resize", handleResize);
    window.addEventListener("orientationchange", handleResize);
    return () => {
      window.removeEventListener("resize", handleResize);
      window.removeEventListener("orientationchange", handleResize);
    };
  }, []);

  return orientation;
};
