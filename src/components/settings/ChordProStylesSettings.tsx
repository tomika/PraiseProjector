import React from "react";
import { Settings } from "../../types";
import { useLocalization } from "../../localization/LocalizationContext";

interface ChordProStylesSettingsProps {
  settings: Settings;
  updateSetting: <K extends keyof Settings>(key: K, value: Settings[K]) => void;
}

const ChordProStylesSettings: React.FC<ChordProStylesSettingsProps> = ({ settings, updateSetting }) => {
  const { t } = useLocalization();
  const [themeMode, setThemeMode] = React.useState<"light" | "dark">("light");
  const [displayJson, setDisplayJson] = React.useState("");
  const [directivesJson, setDirectivesJson] = React.useState("");
  const [displayError, setDisplayError] = React.useState<string | null>(null);
  const [directivesError, setDirectivesError] = React.useState<string | null>(null);

  React.useEffect(() => {
    const activeThemeStyles = settings.chordProStyles[themeMode];
    setDisplayJson(JSON.stringify(activeThemeStyles.display, null, 2));
    setDirectivesJson(JSON.stringify(activeThemeStyles.directives, null, 2));
    setDisplayError(null);
    setDirectivesError(null);
  }, [settings.chordProStyles, themeMode]);

  const updateThemeStyles = (key: "display" | "directives", text: string) => {
    try {
      const parsed = JSON.parse(text) as unknown;
      const themeStyles = settings.chordProStyles[themeMode];
      updateSetting("chordProStyles", {
        ...settings.chordProStyles,
        [themeMode]: {
          ...themeStyles,
          [key]: parsed,
        },
      });
      if (key === "display") {
        setDisplayError(null);
      } else {
        setDirectivesError(null);
      }
    } catch {
      if (key === "display") {
        setDisplayError(t("ChordProStylesInvalidJson"));
      } else {
        setDirectivesError(t("ChordProStylesInvalidJson"));
      }
    }
  };

  return (
    <div className="container-fluid">
      <div className="row">
        <div className="col-12">
          <div className="form-group">
            <label htmlFor="chordproStylesThemeMode">{t("ChordProStylesThemeMode")}</label>
            <select
              id="chordproStylesThemeMode"
              className="form-control"
              value={themeMode}
              onChange={(e) => setThemeMode(e.target.value as "light" | "dark")}
            >
              <option value="light">{t("ThemeLight")}</option>
              <option value="dark">{t("ThemeDark")}</option>
            </select>
            <small className="form-text text-muted">{t("ChordProStylesDescription")}</small>
          </div>

          <div className="form-group">
            <label htmlFor="chordproDisplayStylesJson">{t("ChordProStylesDisplayJson")}</label>
            <textarea
              id="chordproDisplayStylesJson"
              className={`form-control font-monospace ${displayError ? "is-invalid" : ""}`}
              rows={14}
              value={displayJson}
              onChange={(e) => setDisplayJson(e.target.value)}
              onBlur={(e) => updateThemeStyles("display", e.target.value)}
            />
            {displayError && <div className="invalid-feedback d-block">{displayError}</div>}
          </div>

          <div className="form-group">
            <label htmlFor="chordproDirectiveStylesJson">{t("ChordProStylesDirectiveJson")}</label>
            <textarea
              id="chordproDirectiveStylesJson"
              className={`form-control font-monospace ${directivesError ? "is-invalid" : ""}`}
              rows={14}
              value={directivesJson}
              onChange={(e) => setDirectivesJson(e.target.value)}
              onBlur={(e) => updateThemeStyles("directives", e.target.value)}
            />
            {directivesError && <div className="invalid-feedback d-block">{directivesError}</div>}
          </div>
        </div>
      </div>
    </div>
  );
};

export default ChordProStylesSettings;
