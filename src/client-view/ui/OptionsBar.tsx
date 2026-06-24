/**
 * OptionsBar — the two-row control strip at the top of the options panel. It
 * holds the chord-display controls (which drive `displaySettings` → SongView's
 * `setDisplayMode()`, exactly like praiseprojector.ts `displayChanged()`) plus
 * the panel chrome: the close button ends the FIRST row, the more-menu ends the
 * SECOND row, so the two line up at the right edge. (Renamed from ChordOptionsBar
 * since it is no longer only chord options.)
 */

import { useEffect, useRef } from "react";
import { useClientViewState, useClientViewStore } from "../controller/ClientViewContext";
import type { ChordBoxKind, DarkMode, DisplaySettings } from "../controller/ClientViewStore";
import { HighlightOpacityDialog } from "./HighlightOpacityDialog";
import { MoreMenu } from "./MoreMenu";
import { ZoomPanel } from "./ZoomDialog";
import { icon } from "./assets";
import { useLongPress } from "./useLongPress";

const CHORD_BOX_ICON: Record<ChordBoxKind, string> = {
  "": "am.svg",
  GUITAR: "guitarchord.svg",
  PIANO: "pianochord.svg",
  NO_CHORDS: "nochordbox.svg",
};

const DARK_ICON: Record<DarkMode, string> = {
  auto: "autolight.svg",
  light: "day.svg",
  dark: "night.svg",
};

const CHORD_MODES: Array<{ value: DisplaySettings["chordMode"]; label: string }> = [
  { value: 0, label: "Am" },
  { value: 1, label: "am" },
  { value: 3, label: "a" },
];

export function OptionsBar({ onHome }: { onHome?: () => void }) {
  const store = useClientViewStore();
  const state = useClientViewState();
  const s = state.displaySettings;
  const lampWrapRef = useRef<HTMLDivElement>(null);
  const zoomWrapRef = useRef<HTMLDivElement>(null);

  // Close the opacity popup when the user clicks/taps outside the lamp wrapper.
  useEffect(() => {
    if (!state.highlightOpacityDialogOpen) return;
    const onOutside = (e: PointerEvent) => {
      if (!lampWrapRef.current?.contains(e.target as Node)) {
        store.closeHighlightOpacityDialog();
      }
    };
    const timerId = setTimeout(() => document.addEventListener("pointerdown", onOutside), 0);
    return () => {
      clearTimeout(timerId);
      document.removeEventListener("pointerdown", onOutside);
    };
  }, [state.highlightOpacityDialogOpen, store]);

  // Close the zoom panel when the user clicks/taps outside the zoom wrapper.
  useEffect(() => {
    if (!state.zoomDialogOpen) return;
    const onOutside = (e: PointerEvent) => {
      if (!zoomWrapRef.current?.contains(e.target as Node)) {
        store.closeZoomDialog();
      }
    };
    const timerId = setTimeout(() => document.addEventListener("pointerdown", onOutside), 0);
    return () => {
      clearTimeout(timerId);
      document.removeEventListener("pointerdown", onOutside);
    };
  }, [state.zoomDialogOpen, store]);

  const lampClickCount = useRef(0);
  const lampLastClick = useRef(0);
  const onLampShortPress = () => {
    const now = Date.now();
    lampClickCount.current = now - lampLastClick.current > 250 ? 1 : lampClickCount.current + 1;
    lampLastClick.current = now;
    if (lampClickCount.current >= 4) {
      lampClickCount.current = 0;
      lampLastClick.current = 0;
      store.toggleHighlightControl();
    } else if (lampClickCount.current === 1) {
      store.toggleHighlight();
    }
  };
  const lampPress = useLongPress(onLampShortPress, () => store.openHighlightOpacityDialog());

  // Long-press for the zoom (maxText) button: short = toggle, long = settings panel.
  const zoomPress = useLongPress(
    () => store.setDisplaySetting("maxText", !s.maxText),
    () => store.openZoomDialog()
  );

  // Show the lamp button when the user has display control (leader/host) or
  // when following an online session where permission can be requested.
  const showLampButton = state.capabilities.canControlDisplay || state.mode === "Client";

  const highlightIcon = state.highlightControl ? "hand.svg" : "lamp.svg";
  const highlightTitle = state.highlightControl
    ? "Highlight control on — long-press to opacity control)"
    : state.highlightOn
      ? "Highlight on — click to turn off, long-press to opacity control)"
      : "Highlight off — click to turn on, long-press to opacity control)";

  return (
    <div className="cv-options-bar">
      <div className="cv-options-row">
        <button type="button" className="cv-iconbtn" title="Chord box (none / guitar / piano / no chords)" onClick={() => store.cycleChordBox()}>
          <img className="btnImg" src={icon(CHORD_BOX_ICON[s.chordBoxType])} alt="Chord box" />
        </button>

        <select
          className="cv-select"
          title="Minor chord display"
          value={s.chordMode}
          onChange={(e) => store.setDisplaySetting("chordMode", Number(e.target.value) as DisplaySettings["chordMode"])}
        >
          {CHORD_MODES.map((mode) => (
            <option key={mode.value} value={mode.value}>
              {mode.label}
            </option>
          ))}
        </select>

        <label className="cv-opt" title="No duplicate section chords">
          <input type="checkbox" checked={s.noSecChordDup} onChange={(e) => store.setDisplaySetting("noSecChordDup", e.target.checked)} />
          {/* "V1 Am / V2 Am(struck)" — sits side-by-side on wide screens, stacks on
            narrow ones (see .cv-secdup), exactly like the original. */}
          <span className="cv-secdup">
            <span>V1&nbsp;Am</span>
            <span>
              V2&nbsp;<s>Am</s>
            </span>
          </span>
        </label>

        <label className="cv-opt" title="Subscript chord modifiers">
          <input type="checkbox" checked={s.subscript} onChange={(e) => store.setDisplaySetting("subscript", e.target.checked)} />
          <span>
            A<sup>m7</sup>
          </span>
        </label>

        <label className="cv-opt" title="Auto key (transpose chords into the song key)">
          <input type="checkbox" checked={s.autoTone} onChange={(e) => store.setDisplaySetting("autoTone", e.target.checked)} />
          <span>Ab</span>
        </label>

        {/* Close ends the first row (lines up with the more-menu below it). */}
        <button type="button" id="closeOptions" className="cv-iconbtn" title="Close" onClick={() => store.toggleOptions(false)}>
          <img className="btnImg cv-opt-icon" src={icon("close-up.svg")} alt="Close" />
        </button>
      </div>

      <div className="cv-options-row">
        {showLampButton && (
          <div ref={lampWrapRef} className="cv-lamp-wrap">
            <button type="button" className="cv-iconbtn" title={highlightTitle} {...lampPress}>
              {state.highlightPending ? (
                <img className="cv-opt-icon cv-highlight-loader" src={icon("gear.svg")} alt="Waiting for permission" />
              ) : (
                <img
                  className={`btnImg cv-opt-icon ${state.highlightOn ? "cv-color-icon" : "cv-mono-icon"}`}
                  src={icon(highlightIcon)}
                  alt="Highlight"
                />
              )}
            </button>
            {state.highlightOpacityDialogOpen && <HighlightOpacityDialog />}
          </div>
        )}

        <label className="cv-opt" title="B♭ notation">
          <input type="checkbox" checked={s.bb} onChange={(e) => store.setDisplaySetting("bb", e.target.checked)} />
          <span>Bb</span>
        </label>

        <label className="cv-opt" title="Simplify complex chords">
          <input type="checkbox" checked={s.simplified} onChange={(e) => store.setDisplaySetting("simplified", e.target.checked)} />
          <span>
            A
            <sup>
              m<s>7#5</s>
            </sup>
          </span>
        </label>

        {/* Zoom (maxText): short press toggles; long press / right-click opens the
            inline settings panel below. Use a button (like highlight) so pointer
            handling is consistent across click/tap devices. */}
        <div ref={zoomWrapRef} className="cv-zoom-wrap">
          <button
            type="button"
            className={`cv-iconbtn cv-zoom-btn${s.maxText ? " cv-zoom-btn-on" : ""}`}
            title="Maximise text (hold for zoom options)"
            aria-pressed={s.maxText}
            {...zoomPress}
          >
            <img className="btnImg cv-opt-icon" src={icon("zoom.svg")} alt="Zoom" />
          </button>
          {state.zoomDialogOpen && <ZoomPanel />}
        </div>

        <button type="button" className="cv-iconbtn" title="Dark mode (auto / light / dark)" onClick={() => store.cycleDarkMode()}>
          <img className="btnImg cv-opt-icon" src={icon(DARK_ICON[s.darkMode])} alt="Dark mode" />
        </button>

        {/* Leader-mode switch (legacy chkAdmin): only offered where the backend
            grants the right to lead. On = this client controls/edits; off = plain
            follower. Sits to the left of the more-menu. */}
        {state.capabilities.leaderModeAvailable && (
          <button
            type="button"
            className={`cv-iconbtn cv-leaderbtn${state.leaderMode ? " cv-toolbtn-on" : ""}`}
            title={state.leaderMode ? "Leader mode on — tap to follow" : "Leader mode off — tap to lead"}
            aria-pressed={state.leaderMode}
            onClick={() => store.toggleLeaderMode()}
          >
            <img className="btnImg cv-opt-icon" src={icon("leader.svg")} alt="Leader mode" />
          </button>
        )}

        {/* More-menu ends the second row, directly under the close button. */}
        <MoreMenu onHome={onHome} />
      </div>
    </div>
  );
}
