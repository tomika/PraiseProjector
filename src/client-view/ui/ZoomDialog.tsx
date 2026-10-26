/**
 * ZoomPanel — the maxText (zoom) sub-controls, shown as a contextmenu-like panel
 * anchored below the zoom button in OptionsBar. Mirrors the original
 * #zoomSettingsDialog: title/meta visibility, line wrapping, section-tag mode,
 * and text sizing.
 *
 * Changes are applied immediately (no OK button). The panel is opened by
 * long-pressing / right-clicking the zoom button and closed by clicking outside.
 *
 * Title and Meta labels use a strikethrough + blue glow when their hide-option is
 * on, matching the original `input:checked + label { text-shadow: … }` style; the ♪
 * (ABC block) button cycles notation / chords only / hidden in the same look. Auto
 * wrap has no label — it is the wrap.svg glyph, glowing (not struck through) when on.
 */

import { useClientViewState, useClientViewStore } from "../controller/ClientViewContext";
import { icon } from "./assets";
import type { ZoomAbcMode, ZoomTagMode } from "../controller/ClientViewStore";
import { SIZING_MODES, ZoomSizingModeGlyph } from "./zoomSizingModes";

const TAG_MODES: Array<{ value: ZoomTagMode; label: string }> = [
  { value: "VISIBLE", label: "Verse" },
  { value: "ABBREV", label: "V" },
  { value: "HIDDEN", label: "—" },
];

// Cycled by the ♪ toggle: plain = notation, glow + chord mark = chord grid only,
// glow + strikethrough = hidden.
const ABC_MODES: Array<{ value: ZoomAbcMode; title: string }> = [
  { value: "NOTATION", title: "ABC blocks: full notation" },
  { value: "CHORDS", title: "ABC blocks: chords only" },
  { value: "HIDDEN", title: "ABC blocks: hidden" },
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
  const abcModeIndex = Math.max(
    0,
    ABC_MODES.findIndex((mode) => mode.value === s.zoomAbcMode)
  );
  const abcMode = ABC_MODES[abcModeIndex];
  const nextAbcMode = ABC_MODES[(abcModeIndex + 1) % ABC_MODES.length];

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
      <button
        type="button"
        className="cv-zoom-toggle cv-zoom-abc-toggle"
        data-mode={abcMode.value}
        title={abcMode.title}
        aria-label={abcMode.title}
        onClick={() => store.setDisplaySetting("zoomAbcMode", nextAbcMode.value)}
      >
        <span className="cv-zoom-label">
          {"♪"}
          {abcMode.value === "CHORDS" && <sup className="cv-zoom-abc-chord">C</sup>}
        </span>
      </button>
      <label className="cv-zoom-toggle cv-zoom-wrap-toggle" title="Auto wrap">
        <input type="checkbox" checked={s.zoomAutoWrap} onChange={(e) => store.setDisplaySetting("zoomAutoWrap", e.target.checked)} />
        <span className="cv-zoom-label">
          <img className="cv-zoom-wrap-icon" src={icon("wrap.svg")} alt="Auto wrap" />
        </span>
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

      <div className="cv-zoom-row cv-zoom-sizing-row" aria-label="Text sizing mode">
        {SIZING_MODES.map((mode) => (
          <button
            key={mode.value}
            type="button"
            className={`cv-zoom-btn cv-zoom-mode-btn${s.zoomSizingMode === mode.value ? " active" : ""}`}
            title={mode.label}
            aria-label={mode.label}
            aria-pressed={s.zoomSizingMode === mode.value}
            onClick={() => mode.value && store.setZoomSizingMode(mode.value)}
          >
            <ZoomSizingModeGlyph mode={mode} />
          </button>
        ))}
      </div>

      {s.zoomSizingMode === "MANUAL" && (
        <label className="cv-zoom-font-row">
          <input
            type="range"
            min="10"
            max="64"
            step="1"
            value={s.zoomFontSize}
            onChange={(event) => store.setManualZoomFontSize(Number(event.target.value))}
          />
          <output>{s.zoomFontSize}px</output>
        </label>
      )}
    </div>
  );
}
