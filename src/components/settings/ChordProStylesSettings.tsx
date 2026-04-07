import React from "react";
import { Settings } from "../../types";
import { useLocalization } from "../../localization/LocalizationContext";
import type { ChordProDirectiveStyles, ChordProDisplayProperties } from "../../../chordpro/chordpro_styles";

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

  const isPlainObject = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);

  const isValidDisplayStyles = (value: unknown): value is ChordProDisplayProperties => {
    if (!isPlainObject(value)) return false;
    const guitar = value.guitarChordSize;
    const piano = value.pianoChordSize;
    if (!isPlainObject(guitar) || typeof guitar.width !== "number" || typeof guitar.height !== "number") return false;
    if (!isPlainObject(piano) || typeof piano.width !== "number" || typeof piano.height !== "number") return false;
    const requiredNumberKeys = ["horizontalMargin", "verticalMargin", "chordLineHeight", "chordBorder", "lyricsLineHeight", "chordLyricSep"] as const;
    const requiredStringKeys = [
      "tagFont",
      "tagColor",
      "chordFont",
      "chordTextColor",
      "unknownChordTextColor",
      "lyricsFont",
      "lyricsTextColor",
      "sectionBreakColor",
      "highlightColor",
      "chordBoxColor",
      "cursorColor",
      "backgroundColor",
      "lineColor",
      "selectedTextBg",
      "selectedTextFg",
      "commentBg",
      "commentFg",
      "commentBorder",
      "markUnderscoreColor",
    ] as const;
    return (
      requiredNumberKeys.every((key) => typeof value[key] === "number") && requiredStringKeys.every((key) => typeof value[key] === "string")
    );
  };

  const isValidDirectiveStyles = (value: unknown): value is ChordProDirectiveStyles => {
    if (!isPlainObject(value)) return false;
    for (const style of Object.values(value)) {
      if (!isPlainObject(style)) return false;
      if (style.font !== undefined && typeof style.font !== "string") return false;
      if (style.fg !== undefined && typeof style.fg !== "string") return false;
      if (style.bg !== undefined && typeof style.bg !== "string") return false;
      if (style.prefix !== undefined && typeof style.prefix !== "string") return false;
      if (style.align !== undefined && typeof style.align !== "string") return false;
      if (style.height !== undefined && typeof style.height !== "number") return false;
      if (style.indent !== undefined && typeof style.indent !== "number") return false;
    }
    return true;
  };

  const updateThemeStyles = (key: "display" | "directives", text: string) => {
    try {
      const parsed = JSON.parse(text) as unknown;
      if (key === "display" && !isValidDisplayStyles(parsed)) {
        setDisplayError(t("ChordProStylesInvalidJson"));
        return;
      }
      if (key === "directives" && !isValidDirectiveStyles(parsed)) {
        setDirectivesError(t("ChordProStylesInvalidJson"));
        return;
      }
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
