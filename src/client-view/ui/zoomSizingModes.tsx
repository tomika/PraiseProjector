import type { ZoomSizingMode } from "../controller/ClientViewStore";
import { icon } from "./assets";

export interface ZoomSizingModeMeta {
  readonly value: ZoomSizingMode | null;
  readonly label: string;
  readonly icon?: string;
  readonly text?: string;
}

export const ZOOM_OFF_MODE: ZoomSizingModeMeta = { value: null, label: "Off", icon: "zoom.svg" };

// Shared by the zoom dialog, gesture rotation and mode-change toast. Keep the
// icon/text representation here so all three surfaces always show the same glyph.
export const SIZING_MODES: readonly ZoomSizingModeMeta[] = [
  { value: "FIT_PAGE", label: "Fit page", icon: "fitpage.svg" },
  { value: "FIT_WIDTH", label: "Fit width", icon: "scrollpage.svg" },
  { value: "AUTO_HEIGHT", label: "Auto fill", text: "A" },
  { value: "MANUAL", label: "Manual", text: "M" },
];

export const ZOOM_MODE_ROTATION: readonly ZoomSizingModeMeta[] = [ZOOM_OFF_MODE, ...SIZING_MODES];

export function ZoomSizingModeGlyph({ mode, className = "" }: { mode: ZoomSizingModeMeta; className?: string }) {
  return (
    <span className={`cv-zoom-mode-glyph${className ? ` ${className}` : ""}`}>
      {mode.icon ? <img className="btnImg" src={icon(mode.icon)} alt="" /> : <span className="cv-zoom-font-symbol">{mode.text}</span>}
    </span>
  );
}
