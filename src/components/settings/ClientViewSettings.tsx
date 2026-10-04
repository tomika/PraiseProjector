import type { Settings } from "../../types";
import { useLocalization } from "../../localization/LocalizationContext";
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
    </div>
  );
}
