/**
 * HighlightOpacityDialog — inline popup with a slider for tuning the
 * highlighted-section background opacity. Rendered inside a `position:relative`
 * wrapper in OptionsBar so it appears directly below the lamp button.
 * Mirrors the legacy praiseprojector.ts openHighlightOpacityPopup().
 */

import { useEffect, useRef } from "react";
import { useClientViewState, useClientViewStore } from "../controller/ClientViewContext";

export function HighlightOpacityDialog() {
  const store = useClientViewStore();
  const state = useClientViewState();
  const opacity = state.highlightOpacity;
  const fillRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (fillRef.current) fillRef.current.style.opacity = String(opacity);
  }, [opacity]);

  return (
    <div className="cv-opacity-popup" onPointerDown={(e) => e.stopPropagation()}>
      {/* Live preview swatch */}
      <div className="cv-opacity-preview">
        <div ref={fillRef} className="cv-opacity-preview-fill" />
      </div>

      {/* Vertical range slider: writing-mode + direction=rtl puts 100% at top */}
      <input
        type="range"
        className="cv-opacity-slider"
        min={0}
        max={100}
        step={1}
        title="Highlight opacity"
        value={Math.round(opacity * 100)}
        onChange={(e) => store.setHighlightOpacity(Number(e.target.value) / 100)}
        autoFocus
      />

      <span className="cv-opacity-label">{Math.round(opacity * 100)}%</span>
    </div>
  );
}
