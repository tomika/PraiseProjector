import React from "react";
import { Settings } from "../../types";
import { useTheme, ThemeSetting } from "../../contexts/ThemeContext";
import { useLocalization, LanguageSetting } from "../../localization/LocalizationContext";
import "./GeneralSettings.css";

const MAX_MARGIN_SUM = 95;

type MarginSide = "top" | "left" | "right" | "bottom";

interface GeneralSettingsProps {
  settings: Settings;
  updateSetting: <K extends keyof Settings>(key: K, value: Settings[K]) => void;
}

const GeneralSettings: React.FC<GeneralSettingsProps> = ({ settings, updateSetting }) => {
  const { themeSetting, setThemeSetting } = useTheme();
  const { languageSetting, setLanguageSetting, t } = useLocalization();
  const marginPreviewRef = React.useRef<HTMLDivElement | null>(null);
  const marginPreviewInnerRef = React.useRef<HTMLDivElement | null>(null);
  const [draggingMarginSide, setDraggingMarginSide] = React.useState<MarginSide | null>(null);

  const clampMarginValue = (value: number, oppositeValue: number) => {
    const normalizedValue = Number.isFinite(value) ? value : 0;
    return Math.max(0, Math.min(MAX_MARGIN_SUM - oppositeValue, Math.round(normalizedValue)));
  };

  const updateDisplayMargin = (side: MarginSide, nextValue: number) => {
    const currentRect = settings.displayBorderRect;

    switch (side) {
      case "top":
        updateSetting("displayBorderRect", {
          ...currentRect,
          top: clampMarginValue(nextValue, currentRect.height),
        });
        return;
      case "bottom":
        updateSetting("displayBorderRect", {
          ...currentRect,
          height: clampMarginValue(nextValue, currentRect.top),
        });
        return;
      case "left":
        updateSetting("displayBorderRect", {
          ...currentRect,
          left: clampMarginValue(nextValue, currentRect.width),
        });
        return;
      case "right":
        updateSetting("displayBorderRect", {
          ...currentRect,
          width: clampMarginValue(nextValue, currentRect.left),
        });
    }
  };

  const handleMarginInputChange = (side: MarginSide) => (e: React.ChangeEvent<HTMLInputElement>) => {
    updateDisplayMargin(side, parseInt(e.target.value || "0", 10) || 0);
  };

  const startMarginDrag = (side: MarginSide) => (e: React.PointerEvent<HTMLDivElement>) => {
    e.preventDefault();
    setDraggingMarginSide(side);
  };

  React.useEffect(() => {
    if (!draggingMarginSide) {
      return undefined;
    }

    const handlePointerMove = (event: PointerEvent) => {
      const previewBounds = marginPreviewRef.current?.getBoundingClientRect();
      if (!previewBounds || !previewBounds.width || !previewBounds.height) {
        return;
      }

      switch (draggingMarginSide) {
        case "left":
          updateDisplayMargin("left", ((event.clientX - previewBounds.left) / previewBounds.width) * 100);
          return;
        case "right":
          updateDisplayMargin("right", ((previewBounds.right - event.clientX) / previewBounds.width) * 100);
          return;
        case "top":
          updateDisplayMargin("top", ((event.clientY - previewBounds.top) / previewBounds.height) * 100);
          return;
        case "bottom":
          updateDisplayMargin("bottom", ((previewBounds.bottom - event.clientY) / previewBounds.height) * 100);
      }
    };

    const handlePointerUp = () => {
      setDraggingMarginSide(null);
    };

    window.addEventListener("pointermove", handlePointerMove);
    window.addEventListener("pointerup", handlePointerUp);

    return () => {
      window.removeEventListener("pointermove", handlePointerMove);
      window.removeEventListener("pointerup", handlePointerUp);
    };
  }, [draggingMarginSide, settings.displayBorderRect]);

  React.useEffect(() => {
    if (!marginPreviewInnerRef.current) {
      return;
    }

    marginPreviewInnerRef.current.style.left = `${settings.displayBorderRect.left}%`;
    marginPreviewInnerRef.current.style.top = `${settings.displayBorderRect.top}%`;
    marginPreviewInnerRef.current.style.right = `${settings.displayBorderRect.width}%`;
    marginPreviewInnerRef.current.style.bottom = `${settings.displayBorderRect.height}%`;
  }, [settings.displayBorderRect]);

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

  return (
    <div className="container-fluid general-settings-root">
      <div className="row">
        <div className="col-md-6">
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
            <label htmlFor="baseFontSize">{t("SettingsUIFontSize")}</label>
            <select
              id="baseFontSize"
              className="form-control"
              value={settings.baseFontSize}
              onChange={(e) => updateSetting("baseFontSize", parseInt(e.target.value))}
              disabled={settings.autoAdjustFontSize}
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
          <div className="form-check">
            <input
              className="form-check-input"
              type="checkbox"
              id="autoAdjustFontSize"
              checked={settings.autoAdjustFontSize}
              onChange={(e) => updateSetting("autoAdjustFontSize", e.target.checked)}
            />
            <label className="form-check-label" htmlFor="autoAdjustFontSize">
              {t("SettingsAutoAdjustFontSize")}
            </label>
            <small className="form-text text-muted">{t("SettingsAutoAdjustFontSizeDescription")}</small>
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
              id="enableExternalWebDisplay"
              checked={settings.externalWebDisplayEnabled}
              onChange={(e) => updateSetting("externalWebDisplayEnabled", e.target.checked)}
            />
            <label className="form-check-label" htmlFor="enableExternalWebDisplay">
              {t("SettingsExternalWebDisplay")}
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
          <div className="form-group">
            <label htmlFor="sectionSelectionMode">{t("SettingsSectionSelectionInEditor")}</label>
            <select className="form-control" id="sectionSelectionMode" value={getSectionSelectionValue()} onChange={handleSectionSelectionChange}>
              <option value="None">{t("SettingsSectionSelNone")}</option>
              <option value="Click">{t("SettingsSectionSelClick")}</option>
              <option value="Double Click">{t("SettingsSectionSelDoubleClick")}</option>
              <option value="Both">{t("SettingsSectionSelBoth")}</option>
            </select>
          </div>
        </div>
        <div className="col-md-6 general-settings-right-col">
          <div className="border p-2 margin-fieldset">
            <div className="margin-editor">
              {/* Title in top-left */}
              <div className="margin-title">{t("SettingsMargins")}</div>
              {/* Top input */}
              <div className="margin-input-top margin-input">
                <label htmlFor="marginTop">{t("SettingsMarginTop")}</label>
                <input
                  type="number"
                  className="form-control form-control-sm"
                  id="marginTop"
                  value={settings.displayBorderRect.top}
                  min={0}
                  max={MAX_MARGIN_SUM - settings.displayBorderRect.height}
                  onChange={handleMarginInputChange("top")}
                />
              </div>

              {/* Left input */}
              <div className="margin-input-left margin-input">
                <label htmlFor="marginLeft">{t("SettingsMarginLeft")}</label>
                <input
                  type="number"
                  className="form-control form-control-sm"
                  id="marginLeft"
                  value={settings.displayBorderRect.left}
                  min={0}
                  max={MAX_MARGIN_SUM - settings.displayBorderRect.width}
                  onChange={handleMarginInputChange("left")}
                />
              </div>

              {/* Center preview */}
              <div className={`margin-preview-box${draggingMarginSide ? " is-dragging" : ""}`} ref={marginPreviewRef}>
                <div className="margin-preview-inner" ref={marginPreviewInnerRef}>
                  <div className="margin-drag-handle margin-drag-handle-top" onPointerDown={startMarginDrag("top")} />
                  <div className="margin-drag-handle margin-drag-handle-right" onPointerDown={startMarginDrag("right")} />
                  <div className="margin-drag-handle margin-drag-handle-bottom" onPointerDown={startMarginDrag("bottom")} />
                  <div className="margin-drag-handle margin-drag-handle-left" onPointerDown={startMarginDrag("left")} />
                  <span className="margin-preview-text">Hallelujah!</span>
                </div>
              </div>

              {/* Right input */}
              <div className="margin-input-right margin-input">
                <label htmlFor="marginRight">{t("SettingsMarginRight")}</label>
                <input
                  type="number"
                  className="form-control form-control-sm"
                  id="marginRight"
                  value={settings.displayBorderRect.width}
                  min={0}
                  max={MAX_MARGIN_SUM - settings.displayBorderRect.left}
                  onChange={handleMarginInputChange("right")}
                />
              </div>

              {/* Bottom input */}
              <div className="margin-input-bottom margin-input">
                <label htmlFor="marginBottom">{t("SettingsMarginBottom")}</label>
                <input
                  type="number"
                  className="form-control form-control-sm"
                  id="marginBottom"
                  value={settings.displayBorderRect.height}
                  min={0}
                  max={MAX_MARGIN_SUM - settings.displayBorderRect.top}
                  onChange={handleMarginInputChange("bottom")}
                />
              </div>
            </div>
            <div className="margin-preview-help text-muted">{t("SettingsMarginPreviewHelp")}</div>
          </div>
          <div className="form-group mt-3 non-breaking-words-group">
            <div className="form-check">
              <input
                className="form-check-input"
                type="checkbox"
                id="useNonBreakingWords"
                checked={settings.useNonSplittingWords}
                onChange={(e) => updateSetting("useNonSplittingWords", e.target.checked)}
              />
              <label className="form-check-label" htmlFor="useNonBreakingWords">
                {t("SettingsUseNonBreakingWords")}
              </label>
            </div>
            <textarea
              className="form-control"
              id="nonBreakingWordsList"
              placeholder={t("SettingsNonBreakingWordsPlaceholder")}
              value={settings.nonSplittingWordList.join("\n")}
              onChange={(e) => updateSetting("nonSplittingWordList", e.target.value.split("\n"))}
              disabled={!settings.useNonSplittingWords}
            ></textarea>
          </div>
        </div>
      </div>
    </div>
  );
};

export default GeneralSettings;
