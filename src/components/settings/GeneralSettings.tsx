import React from "react";
import { Settings } from "../../types";
import { useTheme, ThemeSetting } from "../../contexts/ThemeContext";
import { useLocalization, LanguageSetting } from "../../localization/LocalizationContext";
import { calculateAutoFontSize } from "../../hooks/useResponsiveFontSize";
import "./GeneralSettings.css";

interface GeneralSettingsProps {
  settings: Settings;
  updateSetting: <K extends keyof Settings>(key: K, value: Settings[K]) => void;
}

const GeneralSettings: React.FC<GeneralSettingsProps> = ({ settings, updateSetting }) => {
  const { themeSetting, setThemeSetting } = useTheme();
  const { languageSetting, setLanguageSetting, t } = useLocalization();
  const isManualFontSize = settings.fontSizeMode === "manual";
  const screenMajorSize = Math.max(window.screen.width || 0, window.screen.height || 0);
  const autoFontSizePreview =
    settings.fontSizeMode === "auto-resolution-dpi"
      ? calculateAutoFontSize(screenMajorSize, window.devicePixelRatio || 1, "auto-resolution-dpi")
      : calculateAutoFontSize(screenMajorSize, window.devicePixelRatio || 1, "auto-resolution");

  return (
    <div className="container-fluid general-settings-root">
      <div className="row">
        <div className="col-12">
          <div className="form-group">
            <label htmlFor="themeSelect">{t("Theme")}</label>
            <select id="themeSelect" className="form-control" value={themeSetting} onChange={(e) => setThemeSetting(e.target.value as ThemeSetting)}>
              <option value="auto">{t("ThemeAuto")}</option>
              <option value="light">{t("ThemeLight")}</option>
              <option value="dark">{t("ThemeDark")}</option>
            </select>
            <small className="form-text text-muted">{t("ThemeDescription")}</small>
          </div>
          <div className="form-group">
            <label htmlFor="languageSelect">{t("Language")}</label>
            <select
              id="languageSelect"
              className="form-control"
              value={languageSetting}
              onChange={(e) => setLanguageSetting(e.target.value as LanguageSetting)}
            >
              <option value="auto">{t("LanguageAuto")}</option>
              <option value="en">English</option>
              <option value="hu">Magyar</option>
            </select>
            <small className="form-text text-muted">{t("LanguageDescription")}</small>
          </div>
          <div className="form-check">
            <input
              className="form-check-input"
              type="checkbox"
              id="useFontAwesomeIcons"
              checked={settings.useFontAwesomeIcons}
              onChange={(e) => updateSetting("useFontAwesomeIcons", e.target.checked)}
            />
            <label className="form-check-label" htmlFor="useFontAwesomeIcons">
              {t("SettingsUseFontAwesomeIcons")}
            </label>
          </div>
          <div className="form-group">
            <label htmlFor="fontSizeMode">{t("SettingsUIFontSizeMode")}</label>
            <select
              id="fontSizeMode"
              className="form-control"
              value={settings.fontSizeMode}
              onChange={(e) => {
                const mode = e.target.value as Settings["fontSizeMode"];
                updateSetting("fontSizeMode", mode);
              }}
            >
              <option value="manual">{t("SettingsUIFontSizeModeManual")}</option>
              <option value="auto-resolution">{t("SettingsUIFontSizeModeAutoResolution")}</option>
              <option value="auto-resolution-dpi">{t("SettingsUIFontSizeModeAutoResolutionDpi")}</option>
            </select>
            <small className="form-text text-muted">{t("SettingsUIFontSizeModeDescription")}</small>
          </div>
          <div className={`form-group ${isManualFontSize ? "" : "disabled"}`}>
            <label htmlFor="baseFontSize">{t("SettingsUIFontSize")}</label>
            <select
              id="baseFontSize"
              className="form-control"
              value={isManualFontSize ? settings.baseFontSize : autoFontSizePreview}
              onChange={(e) => updateSetting("baseFontSize", parseInt(e.target.value))}
              disabled={!isManualFontSize}
            >
              <option value="10">{t("SettingsFontSizeExtraSmall")}</option>
              <option value="12">{t("SettingsFontSizeSmall")}</option>
              <option value="14">{t("SettingsFontSizeMedium")}</option>
              <option value="16">{t("SettingsFontSizeNormal")}</option>
              <option value="18">{t("SettingsFontSizeLarge")}</option>
              <option value="20">{t("SettingsFontSizeExtraLarge")}</option>
              <option value="22">{t("SettingsFontSizeXXLarge")}</option>
            </select>
            <small className="form-text text-muted">{t("SettingsUIFontSizeDescription")}</small>
          </div>
          <div className="form-group">
            <label htmlFor="defaultChordSystem">{t("SettingsChordSystem")}</label>
            <select id="defaultChordSystem" className="form-control" value="G" disabled>
              <option value="G">{t("SettingsChordSystemGerman")}</option>
              <option value="S">{t("SettingsChordSystemStandard")}</option>
            </select>
          </div>
          <div className="form-check">
            <input
              className="form-check-input"
              type="checkbox"
              id="keepAwake"
              checked={settings.keepAwake}
              onChange={(e) => updateSetting("keepAwake", e.target.checked)}
            />
            <label className="form-check-label" htmlFor="keepAwake">
              {t("SettingsKeepAwake")}
            </label>
          </div>
          <div className="form-check">
            <input
              className="form-check-input"
              type="checkbox"
              id="fullscreen"
              checked={settings.fullscreen}
              onChange={(e) => updateSetting("fullscreen", e.target.checked)}
            />
            <label className="form-check-label" htmlFor="fullscreen">
              {t("SettingsFullscreen")}
            </label>
          </div>
          <div className="form-check">
            <input
              className="form-check-input"
              type="checkbox"
              id="hideChordsInEditor"
              checked={settings.hideChordsInReadonlyEditor}
              onChange={(e) => updateSetting("hideChordsInReadonlyEditor", e.target.checked)}
            />
            <label className="form-check-label" htmlFor="hideChordsInEditor">
              {t("SettingsHideChordsInEditor")}
            </label>
          </div>
          <div className="form-check">
            <input
              className="form-check-input"
              type="checkbox"
              id="showTooltips"
              checked={settings.showTooltips}
              onChange={(e) => updateSetting("showTooltips", e.target.checked)}
            />
            <label className="form-check-label" htmlFor="showTooltips">
              {t("SettingsShowTooltips")}
            </label>
          </div>
          <div className="form-group">
            <label htmlFor="serverPeekIntervalMinutes">{t("SettingsPeekIntervalMinutes")}</label>
            <input
              id="serverPeekIntervalMinutes"
              className="form-control"
              type="number"
              min={1}
              max={1440}
              step={1}
              value={settings.serverPeekIntervalMinutes}
              onChange={(e) => updateSetting("serverPeekIntervalMinutes", Math.max(1, parseInt(e.target.value || "0", 10) || 1))}
            />
            <small className="form-text text-muted">{t("SettingsPeekIntervalMinutesDescription")}</small>
          </div>
          <div className="form-group">
            <label htmlFor="syncDeclineTimeoutMinutes">{t("SettingsSyncDeclineTimeoutMinutes")}</label>
            <input
              id="syncDeclineTimeoutMinutes"
              className="form-control"
              type="number"
              min={0}
              max={1440}
              step={1}
              value={settings.syncDeclineTimeoutMinutes}
              onChange={(e) => updateSetting("syncDeclineTimeoutMinutes", Math.max(0, Math.min(1440, parseInt(e.target.value || "0", 10) || 0)))}
            />
            <small className="form-text text-muted">{t("SettingsSyncDeclineTimeoutMinutesDescription")}</small>
          </div>
        </div>
      </div>
    </div>
  );
};

export default GeneralSettings;
