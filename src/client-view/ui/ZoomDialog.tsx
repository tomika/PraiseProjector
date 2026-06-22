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
        {TAG_MODES.map((m) => (
          <button
            key={m.value}
            type="button"
            className={`cv-zoom-btn${s.zoomTagMode === m.value ? " active" : ""}`}
            title="Section tag display"
            onClick={() => store.setDisplaySetting("zoomTagMode", m.value)}
          >
            {m.label}
          </button>
        ))}
      </div>

      <div className="cv-zoom-row">
        <button
          type="button"
          className={`cv-zoom-btn${!s.zoomScrollable ? " active" : ""}`}
          title="Fit page"
          onClick={() => store.setDisplaySetting("zoomScrollable", false)}
        >
          <img className="btnImg" src={icon("fitpage.svg")} alt="Fit page" />
        </button>
        <button
          type="button"
          className={`cv-zoom-btn${s.zoomScrollable ? " active" : ""}`}
          title="Scroll (full width)"
          onClick={() => store.setDisplaySetting("zoomScrollable", true)}
        >
          <img className="btnImg" src={icon("scrollpage.svg")} alt="Scroll" />
        </button>
      </div>
    </div>
  );
}
