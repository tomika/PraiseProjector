/**
 * ZoomPanel — the maxText (zoom) sub-controls, shown as a contextmenu-like panel
 * anchored below the zoom button in OptionsBar. Mirrors the original
 * #zoomSettingsDialog: title/meta visibility, section-tag mode, and FIT vs SCROLL.
 *
 * Changes are applied immediately (no OK button). The panel is opened by
 * long-pressing / right-clicking the zoom button and closed by clicking outside.
 *
 * Title and Meta labels use a strikethrough + blue glow when their hide-option is
 * on, matching the original `input:checked + label { text-shadow: … }` style.
 */

import { useClientViewState, useClientViewStore } from "../controller/ClientViewContext";
import type { ZoomTagMode } from "../controller/ClientViewStore";
import { icon } from "./assets";

const TAG_MODES: Array<{ value: ZoomTagMode; label: string }> = [
  { value: "VISIBLE", label: "Verse" },
  { value: "ABBREV", label: "V" },
  { value: "HIDDEN", label: "—" },
];

export function ZoomPanel() {
  const store = useClientViewStore();
  const { displaySettings: s } = useClientViewState();
  const tagModeIndex = Math.max(
    0,
    TAG_MODES.findIndex((mode) => mode.value === s.zoomTagMode)
  );
  const tagMode = TAG_MODES[tagModeIndex];
  const nextTagMode = TAG_MODES[(tagModeIndex + 1) % TAG_MODES.length];

  return (
    <div className="cv-zoom-panel">
      {/* Title / Meta: plain label when visible, strikethrough + glow when hidden. */}
      <label className="cv-zoom-toggle">
        <input type="checkbox" checked={s.zoomHideTitle} onChange={(e) => store.setDisplaySetting("zoomHideTitle", e.target.checked)} />
        <span className="cv-zoom-label">Title</span>
      </label>
      <label className="cv-zoom-toggle">
        <input type="checkbox" checked={s.zoomHideMeta} onChange={(e) => store.setDisplaySetting("zoomHideMeta", e.target.checked)} />
        <span className="cv-zoom-label">Meta</span>
      </label>

      <div className="cv-zoom-row">
        <button
          type="button"
          className="cv-zoom-btn active cv-zoom-cycle-btn"
          title={`Section tag display: ${tagMode.label}`}
          onClick={() => store.setDisplaySetting("zoomTagMode", nextTagMode.value)}
        >
          {tagMode.label}
        </button>
      </div>

      <div className="cv-zoom-row">
        <button
          type="button"
          className="cv-zoom-btn active cv-zoom-cycle-btn"
          title={s.zoomScrollable ? "Scroll" : "Fit page"}
          onClick={() => store.setDisplaySetting("zoomScrollable", !s.zoomScrollable)}
        >
          <img className="btnImg" src={icon(s.zoomScrollable ? "scrollpage.svg" : "fitpage.svg")} alt="" />
        </button>
      </div>
    </div>
  );
}
