import React, { useEffect } from "react";
import { Settings } from "../../types";
import { useLocalization } from "../../localization/LocalizationContext";

interface SectionsSettingsProps {
  settings: Settings;
  updateSetting: <K extends keyof Settings>(key: K, value: Settings[K]) => void;
}

const SectionsSettings: React.FC<SectionsSettingsProps> = ({ settings, updateSetting }) => {
  const { t } = useLocalization();

  const handleSectionSelectionChange = (e: React.ChangeEvent<HTMLSelectElement>) => {
    const value = e.target.value;
    updateSetting("sectionSelByEditorLineSel", value === "Click" || value === "Both");
    updateSetting("sectionSelByEditorDblclk", value === "Double Click" || value === "Both");
  };

  const getSectionSelectionValue = () => {
    const line = settings.sectionSelByEditorLineSel;
    const dbl = settings.sectionSelByEditorDblclk;
    if (line && dbl) return "Both";
    if (line) return "Click";
    if (dbl) return "Double Click";
    return "None";
  };

  useEffect(() => {
    if (settings.realSectionPreview) {
      updateSetting("previewFontInSections", true);
    }
  }, [settings.realSectionPreview, updateSetting]);

  return (
    <div className="container-fluid">
      <div className="form-group mb-3">
        <label htmlFor="sectionSelectionMode">{t("SettingsSectionSelectionInEditor")}</label>
        <select className="form-control" id="sectionSelectionMode" value={getSectionSelectionValue()} onChange={handleSectionSelectionChange}>
          <option value="None">{t("SettingsSectionSelNone")}</option>
          <option value="Click">{t("SettingsSectionSelClick")}</option>
          <option value="Double Click">{t("SettingsSectionSelDoubleClick")}</option>
          <option value="Both">{t("SettingsSectionSelBoth")}</option>
        </select>
      </div>

      <div className="form-check">
        <input
          className="form-check-input"
          type="checkbox"
          id="highlightSection"
          checked={settings.sectionHighlightInEditor}
          onChange={(e) => updateSetting("sectionHighlightInEditor", e.target.checked)}
        />
        <label className="form-check-label" htmlFor="highlightSection">
          {t("HighlightCurrentSection")}
        </label>
      </div>
      <div className="form-check">
        <input
          className="form-check-input"
          type="checkbox"
          id="realSectionPreview"
          checked={settings.realSectionPreview}
          onChange={(e) => updateSetting("realSectionPreview", e.target.checked)}
        />
        <label className="form-check-label" htmlFor="realSectionPreview">
          {t("UseRealSlidePreview")}
        </label>
      </div>
      <div className="form-check">
        <input
          className="form-check-input"
          type="checkbox"
          id="previewFormatInSectionList"
          checked={settings.previewFontInSections}
          onChange={(e) => updateSetting("previewFontInSections", e.target.checked)}
          disabled={settings.realSectionPreview}
        />
        <label className="form-check-label" htmlFor="previewFormatInSectionList">
          {t("UsePreviewFormat")}
        </label>
      </div>

      <div className="form-check mt-3">
        <input
          className="form-check-input"
          type="checkbox"
          id="useSectionColoring"
          checked={settings.useSectionColoring}
          onChange={(e) => updateSetting("useSectionColoring", e.target.checked)}
        />
        <label className="form-check-label" htmlFor="useSectionColoring">
          {t("UseSectionColoring")}
        </label>
      </div>
      <fieldset className="border p-2" disabled={!settings.useSectionColoring}>
        <legend className="w-auto">{t("SectionColors")}</legend>
        <div className="form-group row">
          <label htmlFor="verseColor" className="col-sm-4 col-form-label">
            {t("Verse")}
          </label>
          <div className="col-sm-8">
            <input
              type="color"
              className="form-control"
              id="verseColor"
              value={settings.verseSectionColor}
              onChange={(e) => updateSetting("verseSectionColor", e.target.value)}
            />
          </div>
        </div>
        <div className="form-group row">
          <label htmlFor="chorusColor" className="col-sm-4 col-form-label">
            {t("Chorus")}
          </label>
          <div className="col-sm-8">
            <input
              type="color"
              className="form-control"
              id="chorusColor"
              value={settings.chorusSectionColor}
              onChange={(e) => updateSetting("chorusSectionColor", e.target.value)}
            />
          </div>
        </div>
        <div className="form-group row">
          <label htmlFor="bridgeColor" className="col-sm-4 col-form-label">
            {t("Bridge")}
          </label>
          <div className="col-sm-8">
            <input
              type="color"
              className="form-control"
              id="bridgeColor"
              value={settings.bridgeSectionColor}
              onChange={(e) => updateSetting("bridgeSectionColor", e.target.value)}
            />
          </div>
        </div>
      </fieldset>

      <div className="form-check mt-3">
        <input
          className="form-check-input"
          type="checkbox"
          id="showProjectingProblems"
          checked={settings.checkSectionsProjectable}
          onChange={(e) => updateSetting("checkSectionsProjectable", e.target.checked)}
        />
        <label className="form-check-label" htmlFor="showProjectingProblems">
          {t("ShowProjectingProblems")}
        </label>
      </div>
      <div className="form-group row">
        <label htmlFor="projectingErrorColor" className="col-sm-4 col-form-label">
          {t("ErrorBackground")}
        </label>
        <div className="col-sm-8">
          <input
            type="color"
            className="form-control"
            id="projectingErrorColor"
            value={settings.displayCroppedTextBgColor}
            onChange={(e) => updateSetting("displayCroppedTextBgColor", e.target.value)}
            disabled={!settings.checkSectionsProjectable}
          />
        </div>
      </div>

      <div className="form-check mt-3">
        <input
          className="form-check-input"
          type="checkbox"
          id="autoShrinkFont"
          checked={settings.displayAllowFontSizeReduction}
          onChange={(e) => updateSetting("displayAllowFontSizeReduction", e.target.checked)}
        />
        <label className="form-check-label" htmlFor="autoShrinkFont">
          {t("AutoShrinkFont")}
        </label>
      </div>
      <fieldset className="border p-2" disabled={!settings.displayAllowFontSizeReduction}>
        <legend className="w-auto">{t("FontReduction")}</legend>
        <div className="form-group row">
          <label htmlFor="minFontSize" className="col-sm-6 col-form-label">
            {t("MinimumFontSizePt")}
          </label>
          <div className="col-sm-6">
            <input
              type="number"
              className="form-control"
              id="minFontSize"
              value={settings.displayMinimumFontSize}
              onChange={(e) => updateSetting("displayMinimumFontSize", parseInt(e.target.value))}
            />
          </div>
        </div>
        <div className="form-group row">
          <label htmlFor="minFontPercent" className="col-sm-6 col-form-label">
            {t("MinimumFontSizePercent")}
          </label>
          <div className="col-sm-6">
            <input
              type="number"
              className="form-control"
              id="minFontPercent"
              value={settings.displayMinimumFontSizePercent}
              onChange={(e) => updateSetting("displayMinimumFontSizePercent", parseInt(e.target.value))}
            />
          </div>
        </div>
        <div className="form-group row">
          <label htmlFor="shrinkedBgColor" className="col-sm-6 col-form-label">
            {t("ShrinkedBackground")}
          </label>
          <div className="col-sm-6">
            <input
              type="color"
              className="form-control"
              id="shrinkedBgColor"
              value={settings.displayShrinkedTextBgColor}
              onChange={(e) => updateSetting("displayShrinkedTextBgColor", e.target.value)}
            />
          </div>
        </div>
        <div className="form-group">
          <label htmlFor="showShrinkedFontUsage">{t("ShowShrinkedFontUsage")}</label>
          <select
            className="form-control"
            id="showShrinkedFontUsage"
            value={settings.displayShowFontSizeReduction}
            onChange={(e) => updateSetting("displayShowFontSizeReduction", e.target.value as "NONE" | "SECTIONS" | "PLAYLIST" | "BOTH")}
          >
            <option value="NONE">{t("Never")}</option>
            <option value="SECTIONS">{t("SectionsOnly")}</option>
            <option value="PLAYLIST">{t("PlaylistOnly")}</option>
            <option value="BOTH">{t("Both")}</option>
          </select>
        </div>
      </fieldset>
    </div>
  );
};

export default SectionsSettings;
