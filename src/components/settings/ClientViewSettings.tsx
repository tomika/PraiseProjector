import type { Settings } from "../../types";
import { useLocalization } from "../../localization/LocalizationContext";
import {
  CHORD_TRANSITION_STYLES,
  MAX_CHORD_TRANSITION_RECOMMENDATIONS,
  MAX_CHORD_TRANSITION_SECONDS,
  MAX_CHORD_TRANSITION_STEPS,
  normalizeChordTransitionSettings,
} from "../../../common/chord-transition-settings";
import {
  PPD_DEFAULT_WATCH_TIMEOUT_SECONDS,
  PPD_MAX_WATCH_TIMEOUT_SECONDS,
  PPD_MIN_WATCH_TIMEOUT_SECONDS,
  normalizePpdWatchTimeoutSeconds,
} from "../../../common/ppd-control";
import "./ClientViewSettings.css";
interface Props {
  settings: Settings;
  updateSetting: <K extends keyof Settings>(key: K, value: Settings[K]) => void;
}
export default function ClientViewSettings({ settings, updateSetting }: Props) {
  const { t } = useLocalization();
  const transitions = settings.clientViewChordTransitions;
  const updateTransitions = (patch: Partial<typeof transitions>) =>
    updateSetting("clientViewChordTransitions", normalizeChordTransitionSettings({ ...transitions, ...patch }));
  return (
    <div className="client-view-settings">
      <div className="form-group">
        <label htmlFor="automaticViewSwitch">{t("SettingsAutomaticViewSwitch")}</label>
        <select
          id="automaticViewSwitch"
          className="form-control"
          value={settings.automaticViewSwitch}
          onChange={(e) => updateSetting("automaticViewSwitch", e.target.value as Settings["automaticViewSwitch"])}
        >
          <option value="none">{t("SettingsAutomaticViewSwitchNone")}</option>
          <option value="portraitToClient">{t("SettingsAutomaticViewSwitchPortraitToClient")}</option>
          <option value="orientation">{t("SettingsAutomaticViewSwitchOrientation")}</option>
        </select>
        <small className="form-text text-muted">{t("SettingsAutomaticViewSwitchDescription")}</small>
      </div>

      <hr />
      <h6>{t("ClientViewSessionSettings")}</h6>
      <div className="form-group mt-2">
        <label htmlFor="clientViewAutoScanSessions">{t("SettingsClientViewAutoScanSessions")}</label>
        <select
          id="clientViewAutoScanSessions"
          className="form-control"
          value={settings.clientViewAutoScanSessions}
          onChange={(event) => updateSetting("clientViewAutoScanSessions", event.target.value as Settings["clientViewAutoScanSessions"])}
        >
          <option value="off">{t("SettingsClientViewAutoScanSessionsOff")}</option>
          <option value="web">{t("SettingsClientViewAutoScanSessionsWeb")}</option>
          <option value="local">{t("SettingsClientViewAutoScanSessionsLocal")}</option>
          <option value="both">{t("SettingsClientViewAutoScanSessionsBoth")}</option>
        </select>
        <small className="form-text text-muted">{t("SettingsClientViewAutoScanSessionsDescription")}</small>
      </div>
      <div className="form-group mt-2">
        <label htmlFor="clientViewSessionsFoundPopup">{t("SettingsClientViewSessionsFoundPopup")}</label>
        <select
          id="clientViewSessionsFoundPopup"
          className="form-control"
          value={settings.clientViewSessionsFoundPopup}
          onChange={(event) => updateSetting("clientViewSessionsFoundPopup", event.target.value as Settings["clientViewSessionsFoundPopup"])}
        >
          <option value="off">{t("SettingsClientViewAutoScanSessionsOff")}</option>
          <option value="web">{t("SettingsClientViewAutoScanSessionsWeb")}</option>
          <option value="local">{t("SettingsClientViewAutoScanSessionsLocal")}</option>
          <option value="both">{t("SettingsClientViewAutoScanSessionsBoth")}</option>
        </select>
        <small className="form-text text-muted">{t("SettingsClientViewSessionsFoundPopupDescription")}</small>
      </div>
      <div className="form-group mt-2">
        <label htmlFor="ppdWatchTimeoutSeconds">{t("SettingsPpdWatchTimeout")}</label>
        <input
          id="ppdWatchTimeoutSeconds"
          className="form-control"
          type="number"
          min={PPD_MIN_WATCH_TIMEOUT_SECONDS}
          max={PPD_MAX_WATCH_TIMEOUT_SECONDS}
          step={1}
          value={settings.ppdWatchTimeoutSeconds}
          onChange={(event) => {
            const value = parseInt(event.target.value || String(PPD_DEFAULT_WATCH_TIMEOUT_SECONDS), 10);
            updateSetting("ppdWatchTimeoutSeconds", normalizePpdWatchTimeoutSeconds(value));
          }}
        />
        <small className="form-text text-muted">{t("SettingsPpdWatchTimeoutDescription")}</small>
      </div>

      <hr />
      <label className="d-flex align-items-center gap-2 mb-2">
        <input type="checkbox" checked={transitions.enabled} onChange={(event) => updateTransitions({ enabled: event.target.checked })} />
        {t("ChordTransitionsEnabled")}
      </label>
      {transitions.enabled && (
        <div className="d-grid gap-2">
          <label className="d-flex align-items-center gap-2">
            <input type="checkbox" checked={transitions.autoClose} onChange={(event) => updateTransitions({ autoClose: event.target.checked })} />
            {t("ChordTransitionsAutoClose")}
          </label>
          {transitions.autoClose && (
            <label>
              {t("ChordTransitionsSeconds")}
              <input
                className="form-control"
                type="number"
                min={1}
                max={MAX_CHORD_TRANSITION_SECONDS}
                value={transitions.seconds}
                onChange={(event) => updateTransitions({ seconds: Math.min(MAX_CHORD_TRANSITION_SECONDS, Math.max(1, +event.target.value)) })}
              />
            </label>
          )}
          <fieldset>
            <legend className="fs-6 mb-1">{t("ChordTransitionsStyles")}</legend>
            <div className="d-flex gap-3">
              {CHORD_TRANSITION_STYLES.map((style) => {
                const selected = transitions.styles.includes(style);
                return (
                  <label key={style} className="d-flex align-items-center gap-2">
                    <input
                      type="checkbox"
                      checked={selected}
                      disabled={selected && transitions.styles.length === 1}
                      onChange={() =>
                        updateTransitions({ styles: selected ? transitions.styles.filter((item) => item !== style) : [...transitions.styles, style] })
                      }
                    />
                    {t(style === "pop" ? "ChordTransitionsPop" : "ChordTransitionsCadential")}
                  </label>
                );
              })}
            </div>
          </fieldset>
          <div className="row g-2">
            <label className="col">
              {t("ChordTransitionsMinSteps")}
              <input
                className="form-control"
                type="number"
                min={0}
                max={transitions.maxSteps}
                value={transitions.minSteps}
                onChange={(event) => updateTransitions({ minSteps: Math.max(0, Math.min(transitions.maxSteps, +event.target.value)) })}
              />
            </label>
            <label className="col">
              {t("ChordTransitionsMaxSteps")}
              <input
                className="form-control"
                type="number"
                min={transitions.minSteps}
                max={MAX_CHORD_TRANSITION_STEPS}
                value={transitions.maxSteps}
                onChange={(event) =>
                  updateTransitions({ maxSteps: Math.max(transitions.minSteps, Math.min(MAX_CHORD_TRANSITION_STEPS, +event.target.value)) })
                }
              />
            </label>
          </div>
          <label>
            {t("ChordTransitionsMaxRecommendations")}
            <input
              className="form-control"
              type="number"
              min={1}
              max={MAX_CHORD_TRANSITION_RECOMMENDATIONS}
              step={1}
              value={transitions.maxRecommendations}
              onChange={(event) => updateTransitions({ maxRecommendations: event.target.valueAsNumber })}
            />
          </label>
          <label>
            {t("ChordTransitionsOrder")}
            <select
              className="form-control"
              value={transitions.order}
              onChange={(event) => updateTransitions({ order: event.target.value as typeof transitions.order })}
            >
              <option value="quality">{t("ChordTransitionsByQuality")}</option>
              <option value="steps">{t("ChordTransitionsBySteps")}</option>
            </select>
          </label>
          <label>
            {t("ChordTransitionsPlacement")}
            <select
              className="form-control"
              value={transitions.placement}
              onChange={(event) => updateTransitions({ placement: event.target.value as typeof transitions.placement })}
            >
              <option value="next">{t("ChordTransitionsNext")}</option>
              <option value="previous">{t("ChordTransitionsPrevious")}</option>
            </select>
          </label>
        </div>
      )}
    </div>
  );
}
