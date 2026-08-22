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
  { value: "MANUAL", label: "Manual font size", text: "M" },
];

export const ZOOM_MODE_ROTATION: readonly ZoomSizingModeMeta[] = [ZOOM_OFF_MODE, ...SIZING_MODES];

/** The meta for one mode, so a surface that changes the mode WITHOUT rotating (a
 *  pinch handing an automatic fit over to MANUAL) can show the same toast glyph the
 *  rotation does, instead of hard-coding a second copy of that mode's label/icon. */
export function zoomSizingModeMeta(value: ZoomSizingMode | null): ZoomSizingModeMeta {
  return ZOOM_MODE_ROTATION.find((mode) => mode.value === value) ?? ZOOM_OFF_MODE;
}

export function ZoomSizingModeGlyph({ mode, className = "" }: { mode: ZoomSizingModeMeta; className?: string }) {
  return (
    <span className={`cv-zoom-mode-glyph${className ? ` ${className}` : ""}`}>
      {mode.icon ? <img className="btnImg" src={icon(mode.icon)} alt="" /> : <span className="cv-zoom-font-symbol">{mode.text}</span>}
    </span>
  );
}
