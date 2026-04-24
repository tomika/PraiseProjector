import React from "react";
import { Song } from "../../../db-common/Song";
import {
  ChordProDirectiveStyle,
  ChordProDisplayProperties,
  ChordProThemeStyles,
  cloneDirectiveStyles,
  cloneDisplayProperties,
  createDefaultChordProStylesSettings,
} from "../../../chordpro/chordpro_styles";
import { Settings } from "../../types";
import { useLocalization } from "../../localization/LocalizationContext";
import { useMessageBox } from "../../contexts/MessageBoxContext";
import ChordProEditor from "../ChordProEditor/ChordProEditor";
import SafeSlider from "../SafeSlider";
import "./ChordProStylesSettings.css";

interface ChordProStylesSettingsProps {
  settings: Settings;
  updateSetting: <K extends keyof Settings>(key: K, value: Settings[K]) => void;
}

type ThemeMode = "light" | "dark";
type MarginEdge = "left" | "right" | "top" | "bottom";

type FontParts = {
  family: string;
  size: number;
  bold: boolean;
  italic: boolean;
};

const FONT_FAMILY_OPTIONS = [
  "Arial",
  "Verdana",
  "Tahoma",
  "Trebuchet MS",
  "Times New Roman",
  "Georgia",
  "Courier New",
  "serif",
  "sans-serif",
  "monospace",
];

type FontStyleOption = { family: string; bold: boolean; italic: boolean };

const FONT_STYLE_OPTIONS: FontStyleOption[] = FONT_FAMILY_OPTIONS.flatMap((family) => [
  { family, bold: false, italic: false },
  { family, bold: true, italic: false },
  { family, bold: false, italic: true },
  { family, bold: true, italic: true },
]);

function fontStyleOptionKey(opt: { family: string; bold: boolean; italic: boolean }): string {
  return `${opt.family}${opt.bold ? " Bold" : ""}${opt.italic ? " Italic" : ""}`;
}

function fontStyleOptionLabel(opt: FontStyleOption): string {
  const parts = [opt.family];
  if (opt.bold) parts.push("Bold");
  if (opt.italic) parts.push("Italic");
  return parts.join(" ");
}

const PREVIEW_SONG = `{title:Style Demo}
{subtitle:Live style preview}
{key:D}
{tempo:84}
{composer:PraiseProjector}
{capo:2}
{start_of_grid: Intro}
D F G Am
{end_of_grid}
{start_of_verse: Verse}
[D]Tag preview [A]and regular 
[Bm]chords are [G]visible
{end_of_verse}
{comment:Preview updates immediately}
{start_of_chorus: Chorus}
[D]Directive [A]styles 
and [G]metadata are [D]covered
{end_of_chorus}
{comment_italic:Italic comments are supported}
{start_of_bridge: Bridge}
[Em]Margins can be dragged
[A]directly on this [D]preview
{end_of_bridge}
{comment_box:Boxed comments are supported}`;

const DIRECTIVE_LABELS: Record<string, string> = {
  title: "ChordProStylesDirectiveTitle",
  key: "ChordProStylesDirectiveKey",
  capo: "ChordProStylesDirectiveCapo",
  tempo: "ChordProStylesDirectiveTempo",
  artist: "ChordProStylesDirectiveArtist",
  composer: "ChordProStylesDirectiveComposer",
  lyricist: "ChordProStylesDirectiveLyricist",
  subtitle: "ChordProStylesDirectiveSubtitle",
  copyright: "ChordProStylesDirectiveCopyright",
  album: "ChordProStylesDirectiveAlbum",
  year: "ChordProStylesDirectiveYear",
  time: "ChordProStylesDirectiveTime",
  duration: "ChordProStylesDirectiveDuration",
  start_of_grid: "ChordProStylesDirectiveGrid",
  start_of_chorus: "ChordProStylesDirectiveChorus",
  start_of_verse: "ChordProStylesDirectiveVerse",
  start_of_bridge: "ChordProStylesDirectiveBridge",
};

const DIRECTIVE_ORDER = [
  "title",
  "subtitle",
  "key",
  "capo",
  "tempo",
  "artist",
  "composer",
  "lyricist",
  "copyright",
  "album",
  "year",
  "time",
  "duration",
  "start_of_verse",
  "start_of_chorus",
  "start_of_bridge",
  "start_of_grid",
];

const COLOR_NAME_MAP: Record<string, string> = {
  black: "#000000",
  white: "#ffffff",
  red: "#ff0000",
  blue: "#0000ff",
  orange: "#ffa500",
  yellow: "#ffff00",
  green: "#008000",
  gray: "#808080",
  grey: "#808080",
};

const FONT_TARGETS = [
  { key: "tagFont", label: "ChordProStylesTagFont" },
  { key: "chordFont", label: "ChordProStylesChordFont" },
  { key: "lyricsFont", label: "ChordProStylesLyricsFont" },
] as const;

type FontTargetKey = (typeof FONT_TARGETS)[number]["key"];

type DisplayColorKey =
  | "tagColor"
  | "chordTextColor"
  | "unknownChordTextColor"
  | "lyricsTextColor"
  | "sectionBreakColor"
  | "highlightColor"
  | "chordBoxColor"
  | "cursorColor"
  | "lineColor"
  | "selectedTextBg"
  | "selectedTextFg"
  | "commentBg"
  | "commentFg"
  | "commentBorder"
  | "markUnderscoreColor";

type ColorTarget = { type: "display"; key: DisplayColorKey; label: string } | { type: "directive"; directiveKey: string; label: string };

const DISPLAY_COLOR_TARGETS: ColorTarget[] = [
  { type: "display", key: "tagColor", label: "ChordProStylesTagColor" },
  { type: "display", key: "chordTextColor", label: "ChordProStylesChordTextColor" },
  { type: "display", key: "unknownChordTextColor", label: "ChordProStylesUnknownChordColor" },
  { type: "display", key: "lyricsTextColor", label: "ChordProStylesLyricsTextColor" },
  { type: "display", key: "sectionBreakColor", label: "ChordProStylesSectionBreakColor" },
  { type: "display", key: "highlightColor", label: "ChordProStylesHighlightColor" },
  { type: "display", key: "chordBoxColor", label: "ChordProStylesChordBoxColor" },
  { type: "display", key: "cursorColor", label: "ChordProStylesCursorColor" },
  { type: "display", key: "lineColor", label: "ChordProStylesLineColor" },
  { type: "display", key: "selectedTextBg", label: "ChordProStylesSelectedTextBg" },
  { type: "display", key: "selectedTextFg", label: "ChordProStylesSelectedTextFg" },
  { type: "display", key: "commentBg", label: "ChordProStylesCommentBg" },
  { type: "display", key: "commentFg", label: "ChordProStylesCommentFg" },
  { type: "display", key: "commentBorder", label: "ChordProStylesCommentBorder" },
  { type: "display", key: "markUnderscoreColor", label: "ChordProStylesMarkUnderscoreColor" },
];

const DIRECTIVE_COLOR_TARGETS: ColorTarget[] = DIRECTIVE_ORDER.map((key) => ({
  type: "directive" as const,
  directiveKey: key,
  label: DIRECTIVE_LABELS[key] ? `${DIRECTIVE_LABELS[key]}Color` : key,
}));

function parseFontSpec(font: string | undefined, fallback: FontParts): FontParts {
  if (!font) return fallback;

  const tokens = font.trim().split(/\s+/).filter(Boolean);
  let bold = false;
  let italic = false;
  let size = fallback.size;
  const familyTokens: string[] = [];

  for (const token of tokens) {
    const lower = token.toLowerCase();
    if (lower === "bold") {
      bold = true;
      continue;
    }
    if (lower === "italic") {
      italic = true;
      continue;
    }
    if (/^\d+(?:\.\d+)?px$/i.test(token)) {
      size = Math.round(parseFloat(token));
      continue;
    }
    familyTokens.push(token);
  }

  return {
    family: familyTokens.join(" ") || fallback.family,
    size: Number.isFinite(size) ? size : fallback.size,
    bold,
    italic,
  };
}

function buildFontSpec(font: FontParts): string {
  const parts: string[] = [];
  if (font.bold) parts.push("bold");
  if (font.italic) parts.push("italic");
  parts.push(`${Math.max(1, Math.round(font.size || 14))}px`);
  parts.push((font.family || "Arial").trim());
  return parts.join(" ");
}

function normalizeColorToHex(value: string | undefined, fallback = "#000000"): string {
  if (!value) return fallback;
  const trimmed = value.trim().toLowerCase();
  if (/^#[0-9a-f]{6}$/i.test(trimmed)) return trimmed;
  if (/^#[0-9a-f]{3}$/i.test(trimmed)) {
    return `#${trimmed[1]}${trimmed[1]}${trimmed[2]}${trimmed[2]}${trimmed[3]}${trimmed[3]}`;
  }
  return COLOR_NAME_MAP[trimmed] ?? fallback;
}

function isColorToken(value: string): boolean {
  const token = value.trim().toLowerCase();
  return /^#[0-9a-f]{3,6}$/i.test(token) || token in COLOR_NAME_MAP;
}

function getCommentBorderColor(value: string): string {
  const parts = value.trim().split(/\s+/).filter(Boolean);
  const token = parts.find(isColorToken);
  return normalizeColorToHex(token, "#000000");
}

function updateCommentBorderColor(value: string, color: string): string {
  const normalized = normalizeColorToHex(color, "#000000");
  const parts = value.trim().split(/\s+/).filter(Boolean);
  const index = parts.findIndex(isColorToken);
  if (index >= 0) {
    parts[index] = normalized;
    return parts.join(" ");
  }
  if (parts.length === 0) {
    return `${normalized} 1px solid`;
  }
  return `${normalized} ${parts.join(" ")}`;
}

function humanizeDirectiveName(name: string): string {
  return name
    .replace(/^start_of_/, "")
    .replace(/_/g, " ")
    .replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function cloneTheme(theme: ChordProThemeStyles): ChordProThemeStyles {
  return {
    display: cloneDisplayProperties(theme.display),
    directives: cloneDirectiveStyles(theme.directives),
  };
}

function stripDirectiveBackgrounds(theme: ChordProThemeStyles): ChordProThemeStyles {
  const next = cloneTheme(theme);
  for (const key of Object.keys(next.directives)) {
    if ("bg" in next.directives[key]) {
      delete next.directives[key].bg;
    }
  }
  return next;
}

function clampMargin(value: number, max: number): number {
  return Math.max(0, Math.min(Math.round(value), Math.max(0, Math.floor(max))));
}

const ColorPickerField: React.FC<{
  label: string;
  value: string;
  defaultColor?: string;
  onChange: (next: string) => void;
}> = ({ label, value, defaultColor = "#000000", onChange }) => (
  <label className="form-label chordpro-styles-field">
    <span>{label}</span>
    <input
      type="color"
      className="form-control form-control-color chordpro-styles-color-picker"
      value={normalizeColorToHex(value, defaultColor)}
      onChange={(e) => onChange(e.target.value)}
    />
  </label>
);

const SliderField: React.FC<{
  label: string;
  value: number;
  min: number;
  max: number;
  step?: number;
  onChange: (next: number) => void;
}> = ({ label, value, min, max, step = 1, onChange }) => {
  const clamped = Number.isFinite(value) ? Math.max(min, Math.min(max, value)) : min;
  return (
    <label className="form-label chordpro-styles-field">
      <div className="chordpro-styles-slider-header">
        <span>{label}</span>
        <span className="chordpro-styles-slider-value">{Math.round(clamped * 100) / 100}</span>
      </div>
      <SafeSlider className="form-range" min={min} max={max} step={step} value={clamped} onChange={(e) => onChange(Number(e.target.value))} />
    </label>
  );
};

const FontEditor: React.FC<{
  font: FontParts;
  onChange: (font: FontParts) => void;
  familyLabel: string;
  sizeLabel: string;
  baseFontSize: number;
}> = ({ font, onChange, familyLabel, sizeLabel, baseFontSize }) => {
  const selectedKey = fontStyleOptionKey(font);
  const match = FONT_STYLE_OPTIONS.find((o) => fontStyleOptionKey(o) === selectedKey);
  const selected = match ?? { family: font.family, bold: font.bold, italic: font.italic };
  const scale = Math.round((font.size / baseFontSize) * 100);
  return (
    <div className="chordpro-styles-font-card compact">
      <div className="chordpro-styles-grid">
        <label className="form-label chordpro-styles-field">
          <span>{familyLabel}</span>
          <select
            className="form-select chordpro-styles-font-select"
            value={selectedKey}
            style={{
              fontFamily: selected.family,
              fontWeight: selected.bold ? "bold" : "normal",
              fontStyle: selected.italic ? "italic" : "normal",
            }}
            onChange={(e) => {
              const opt = FONT_STYLE_OPTIONS.find((o) => fontStyleOptionKey(o) === e.target.value);
              if (opt) onChange({ ...font, family: opt.family, bold: opt.bold, italic: opt.italic });
            }}
          >
            {FONT_STYLE_OPTIONS.map((opt) => {
              const key = fontStyleOptionKey(opt);
              return (
                <option
                  key={key}
                  value={key}
                  style={{
                    fontFamily: opt.family,
                    fontWeight: opt.bold ? "bold" : "normal",
                    fontStyle: opt.italic ? "italic" : "normal",
                  }}
                >
                  {fontStyleOptionLabel(opt)}
                </option>
              );
            })}
          </select>
        </label>
        <SliderField
          label={sizeLabel}
          value={scale}
          min={25}
          max={400}
          step={5}
          onChange={(pct) => onChange({ ...font, size: Math.max(1, Math.round((pct / 100) * baseFontSize)) })}
        />
      </div>
    </div>
  );
};

const ChordProStylesSettings: React.FC<ChordProStylesSettingsProps> = ({ settings, updateSetting }) => {
  const { t } = useLocalization();
  const { showConfirm } = useMessageBox();
  const [themeMode, setThemeMode] = React.useState<ThemeMode>("light");
  const [previewSong] = React.useState(() => new Song(PREVIEW_SONG));
  const [fontTarget, setFontTarget] = React.useState<FontTargetKey>("tagFont");
  const [colorTargetIndex, setColorTargetIndex] = React.useState(0);
  const previewFrameRef = React.useRef<HTMLDivElement | null>(null);
  const [previewSize, setPreviewSize] = React.useState({ width: 1, height: 1 });

  const uiFontSize = settings.baseFontSize || 16;
  const prevUiFontSizeRef = React.useRef(uiFontSize);

  const defaultStyles = React.useMemo(() => createDefaultChordProStylesSettings((key) => t(key as never)), [t]);
  const selectedThemeStyles = settings.chordProStyles[themeMode];

  const allColorTargets = React.useMemo<ColorTarget[]>(() => [...DISPLAY_COLOR_TARGETS, ...DIRECTIVE_COLOR_TARGETS], []);
  const selectedColorTarget = allColorTargets[Math.min(colorTargetIndex, allColorTargets.length - 1)] ?? allColorTargets[0];
  const previewSettings = React.useMemo<Settings>(() => {
    const previewTheme = cloneTheme(selectedThemeStyles);
    return {
      ...settings,
      chordProStyles: {
        light: cloneTheme(previewTheme),
        dark: cloneTheme(previewTheme),
      },
    };
  }, [selectedThemeStyles, settings]);

  const directiveKeys = Array.from(
    new Set([
      ...Object.keys(defaultStyles.light.directives),
      ...Object.keys(defaultStyles.dark.directives),
      ...Object.keys(settings.chordProStyles.light.directives),
      ...Object.keys(settings.chordProStyles.dark.directives),
    ])
  ).sort((left, right) => {
    const leftIndex = DIRECTIVE_ORDER.indexOf(left);
    const rightIndex = DIRECTIVE_ORDER.indexOf(right);
    if (leftIndex === -1 && rightIndex === -1) return left.localeCompare(right);
    if (leftIndex === -1) return 1;
    if (rightIndex === -1) return -1;
    return leftIndex - rightIndex;
  });

  const [directiveIndex, setDirectiveIndex] = React.useState(0);
  React.useEffect(() => {
    if (directiveIndex >= directiveKeys.length) {
      setDirectiveIndex(Math.max(0, directiveKeys.length - 1));
    }
  }, [directiveIndex, directiveKeys.length]);

  const selectedDirectiveKey = directiveKeys[Math.min(directiveIndex, Math.max(0, directiveKeys.length - 1))] ?? "title";

  const updateBothThemes = (updater: (light: ChordProThemeStyles, dark: ChordProThemeStyles) => void) => {
    const light = cloneTheme(settings.chordProStyles.light);
    const dark = cloneTheme(settings.chordProStyles.dark);
    updater(light, dark);
    const lightStripped = stripDirectiveBackgrounds(light);
    const darkStripped = stripDirectiveBackgrounds(dark);
    lightStripped.display.backgroundColor = "white";
    darkStripped.display.backgroundColor = "black";
    updateSetting("chordProStyles", { light: lightStripped, dark: darkStripped });
  };

  const updateCurrentTheme = (updater: (theme: ChordProThemeStyles) => void) => {
    const current = cloneTheme(selectedThemeStyles);
    updater(current);
    const stripped = stripDirectiveBackgrounds(current);
    stripped.display.backgroundColor = themeMode === "dark" ? "black" : "white";
    updateSetting("chordProStyles", {
      ...settings.chordProStyles,
      [themeMode]: stripped,
    });
  };

  const updateDisplayCommon = <K extends keyof ChordProDisplayProperties>(key: K, value: ChordProDisplayProperties[K]) => {
    updateBothThemes((light, dark) => {
      light.display[key] = value;
      dark.display[key] = value;
    });
  };

  const updateDisplayColor = <K extends keyof ChordProDisplayProperties>(key: K, value: ChordProDisplayProperties[K]) => {
    updateCurrentTheme((theme) => {
      theme.display[key] = value;
    });
  };

  const updateDirectiveCommon = (
    directiveKey: string,
    patch: Partial<Pick<ChordProDirectiveStyle, "prefix" | "font" | "height" | "align" | "indent" | "hidden">>
  ) => {
    updateBothThemes((light, dark) => {
      light.directives[directiveKey] = {
        ...(light.directives[directiveKey] ?? {}),
        ...patch,
      };
      dark.directives[directiveKey] = {
        ...(dark.directives[directiveKey] ?? {}),
        ...patch,
      };
    });
  };

  const updateDirectiveColor = (directiveKey: string, patch: Partial<Pick<ChordProDirectiveStyle, "fg">>) => {
    updateCurrentTheme((theme) => {
      theme.directives[directiveKey] = {
        ...(theme.directives[directiveKey] ?? {}),
        ...patch,
      };
    });
  };

  const updateColorByTarget = (target: ColorTarget, nextColor: string) => {
    if (target.type === "directive") {
      updateDirectiveColor(target.directiveKey, { fg: nextColor });
      return;
    }
    if (target.key === "commentBorder") {
      updateDisplayColor("commentBorder", updateCommentBorderColor(selectedThemeStyles.display.commentBorder, nextColor));
      return;
    }
    updateDisplayColor(target.key, nextColor as never);
  };

  const getColorByTarget = (target: ColorTarget): string => {
    if (target.type === "directive") {
      return normalizeColorToHex((selectedThemeStyles.directives[target.directiveKey] ?? {}).fg, "#000000");
    }
    if (target.key === "commentBorder") return getCommentBorderColor(selectedThemeStyles.display.commentBorder);
    return (selectedThemeStyles.display[target.key] as string) ?? "#000000";
  };

  const resetThemeColors = () => {
    const defaults = defaultStyles[themeMode];
    updateCurrentTheme((theme) => {
      const colorKeys: (keyof ChordProDisplayProperties)[] = [
        "tagColor",
        "chordTextColor",
        "unknownChordTextColor",
        "lyricsTextColor",
        "sectionBreakColor",
        "highlightColor",
        "chordBoxColor",
        "cursorColor",
        "lineColor",
        "selectedTextBg",
        "selectedTextFg",
        "commentBg",
        "commentFg",
        "commentBorder",
        "markUnderscoreColor",
      ];
      const targetDisplay = theme.display as unknown as Record<string, unknown>;
      const sourceDisplay = defaults.display as unknown as Record<string, unknown>;
      for (const key of colorKeys) {
        targetDisplay[key] = sourceDisplay[key];
      }
      for (const directiveKey of directiveKeys) {
        const defaultDirective = defaults.directives[directiveKey] ?? {};
        theme.directives[directiveKey] = {
          ...(theme.directives[directiveKey] ?? {}),
          fg: defaultDirective.fg,
        };
      }
    });
  };

  const resetSharedLayoutAndFonts = () => {
    updateBothThemes((light, dark) => {
      const fallback = defaultStyles.light;
      const defaultDisplay = fallback.display;
      light.display.horizontalMargin = defaultDisplay.horizontalMargin;
      dark.display.horizontalMargin = defaultDisplay.horizontalMargin;
      light.display.verticalMargin = defaultDisplay.verticalMargin;
      dark.display.verticalMargin = defaultDisplay.verticalMargin;
      light.display.tagFont = defaultDisplay.tagFont;
      dark.display.tagFont = defaultDisplay.tagFont;
      light.display.chordFont = defaultDisplay.chordFont;
      dark.display.chordFont = defaultDisplay.chordFont;
      light.display.chordLineHeight = defaultDisplay.chordLineHeight;
      dark.display.chordLineHeight = defaultDisplay.chordLineHeight;
      light.display.chordBorder = defaultDisplay.chordBorder;
      dark.display.chordBorder = defaultDisplay.chordBorder;
      light.display.lyricsFont = defaultDisplay.lyricsFont;
      dark.display.lyricsFont = defaultDisplay.lyricsFont;
      light.display.lyricsLineHeight = defaultDisplay.lyricsLineHeight;
      dark.display.lyricsLineHeight = defaultDisplay.lyricsLineHeight;
      light.display.chordLyricSep = defaultDisplay.chordLyricSep;
      dark.display.chordLyricSep = defaultDisplay.chordLyricSep;

      const directiveDefaults = fallback.directives;
      for (const directiveKey of directiveKeys) {
        const base = directiveDefaults[directiveKey] ?? {};
        light.directives[directiveKey] = {
          ...(light.directives[directiveKey] ?? {}),
          prefix: base.prefix,
          font: base.font,
          height: base.height,
          align: base.align,
          indent: base.indent,
          hidden: base.hidden,
        };
        dark.directives[directiveKey] = {
          ...(dark.directives[directiveKey] ?? {}),
          prefix: base.prefix,
          font: base.font,
          height: base.height,
          align: base.align,
          indent: base.indent,
          hidden: base.hidden,
        };
      }
    });
  };

  const resetDirectiveStyles = () => {
    updateBothThemes((light, dark) => {
      const lightDefaults = defaultStyles.light.directives;
      const darkDefaults = defaultStyles.dark.directives;
      for (const directiveKey of directiveKeys) {
        const lightBase = lightDefaults[directiveKey] ?? {};
        const darkBase = darkDefaults[directiveKey] ?? {};
        light.directives[directiveKey] = {
          ...(light.directives[directiveKey] ?? {}),
          prefix: lightBase.prefix,
          font: lightBase.font,
          height: lightBase.height,
          align: lightBase.align,
          indent: lightBase.indent,
          hidden: lightBase.hidden,
        };
        dark.directives[directiveKey] = {
          ...(dark.directives[directiveKey] ?? {}),
          prefix: darkBase.prefix,
          font: darkBase.font,
          height: darkBase.height,
          align: darkBase.align,
          indent: darkBase.indent,
          hidden: darkBase.hidden,
        };
      }
    });
  };

  const confirmFactoryDefaultsReset = (onConfirm: () => void) => {
    const snapshot = {
      light: cloneTheme(settings.chordProStyles.light),
      dark: cloneTheme(settings.chordProStyles.dark),
    };
    showConfirm(t("Confirm"), t("ChordProStylesResetFactoryConfirm"), onConfirm, () =>
      updateSetting("chordProStyles", {
        light: cloneTheme(snapshot.light),
        dark: cloneTheme(snapshot.dark),
      })
    );
  };

  React.useEffect(() => {
    const node = previewFrameRef.current;
    if (!node) return;

    const observer = new ResizeObserver((entries) => {
      const entry = entries[0];
      if (!entry) return;
      const width = entry.contentRect.width;
      const height = entry.contentRect.height;
      setPreviewSize({ width, height });
    });

    observer.observe(node);
    return () => observer.disconnect();
  }, []);

  React.useEffect(() => {
    const prev = prevUiFontSizeRef.current;
    if (prev === uiFontSize || prev <= 0) {
      prevUiFontSizeRef.current = uiFontSize;
      return;
    }
    prevUiFontSizeRef.current = uiFontSize;
    const ratio = uiFontSize / prev;
    const rescaleFont = (fontStr: string | undefined): string | undefined => {
      if (!fontStr) return fontStr;
      const fallback: FontParts = { family: "Arial", size: 14, bold: false, italic: false };
      const parsed = parseFontSpec(fontStr, fallback);
      parsed.size = Math.max(1, Math.round(parsed.size * ratio));
      return buildFontSpec(parsed);
    };
    const light = cloneTheme(settings.chordProStyles.light);
    const dark = cloneTheme(settings.chordProStyles.dark);
    for (const theme of [light, dark]) {
      theme.display.tagFont = rescaleFont(theme.display.tagFont) ?? theme.display.tagFont;
      theme.display.chordFont = rescaleFont(theme.display.chordFont) ?? theme.display.chordFont;
      theme.display.lyricsFont = rescaleFont(theme.display.lyricsFont) ?? theme.display.lyricsFont;
      theme.display.chordLineHeight = Math.max(1, Math.round(theme.display.chordLineHeight * ratio));
      theme.display.lyricsLineHeight = Math.max(1, Math.round(theme.display.lyricsLineHeight * ratio));
      theme.display.chordLyricSep = Math.max(0, Math.round(theme.display.chordLyricSep * ratio));
      for (const key of Object.keys(theme.directives)) {
        const d = theme.directives[key];
        if (d.font) d.font = rescaleFont(d.font) ?? d.font;
        if (d.height) d.height = Math.max(1, Math.round(d.height * ratio));
      }
    }
    updateSetting("chordProStyles", { light, dark });
    // eslint-disable-next-line react-hooks/exhaustive-deps -- intentionally only reacts to uiFontSize; including chordProStyles would loop
  }, [uiFontSize]);

  React.useEffect(() => {
    const node = previewFrameRef.current;
    if (!node) return;
    node.style.setProperty("--pp-chordpro-hmargin", `${selectedThemeStyles.display.horizontalMargin}px`);
    node.style.setProperty("--pp-chordpro-vmargin", `${selectedThemeStyles.display.verticalMargin}px`);
    node.style.setProperty("--pp-chordpro-preview-bg", themeMode === "dark" ? "black" : "white");
  }, [selectedThemeStyles.display.horizontalMargin, selectedThemeStyles.display.verticalMargin, themeMode]);

  const applyDraggedMargin = (edge: MarginEdge, clientX: number, clientY: number) => {
    const frame = previewFrameRef.current;
    if (!frame) return;

    const rect = frame.getBoundingClientRect();
    const x = clientX - rect.left;
    const y = clientY - rect.top;

    const maxHorizontal = previewSize.width / 2 - 12;
    const maxVertical = previewSize.height / 2 - 12;

    if (edge === "left") {
      updateDisplayCommon("horizontalMargin", clampMargin(x, maxHorizontal));
      return;
    }
    if (edge === "right") {
      updateDisplayCommon("horizontalMargin", clampMargin(rect.width - x, maxHorizontal));
      return;
    }
    if (edge === "top") {
      updateDisplayCommon("verticalMargin", clampMargin(y, maxVertical));
      return;
    }
    updateDisplayCommon("verticalMargin", clampMargin(rect.height - y, maxVertical));
  };

  const startMarginDrag = (edge: MarginEdge) => (event: React.PointerEvent<HTMLButtonElement>) => {
    event.preventDefault();

    const handleMove = (moveEvent: PointerEvent) => {
      applyDraggedMargin(edge, moveEvent.clientX, moveEvent.clientY);
    };

    const handleUp = () => {
      window.removeEventListener("pointermove", handleMove);
      window.removeEventListener("pointerup", handleUp);
      window.removeEventListener("pointercancel", handleUp);
    };

    window.addEventListener("pointermove", handleMove);
    window.addEventListener("pointerup", handleUp);
    window.addEventListener("pointercancel", handleUp);
  };

  const lyricsFontParts = parseFontSpec(selectedThemeStyles.display.lyricsFont, {
    family: "Arial",
    size: 14,
    bold: false,
    italic: false,
  });
  const lyricsFontSize = lyricsFontParts.size;
  const lyricsLineHeight = selectedThemeStyles.display.lyricsLineHeight;

  const handleDisplayFontChange = (font: FontParts) => {
    if (fontTarget === "lyricsFont" && font.size !== lyricsFontSize && lyricsFontSize > 0) {
      const ratio = font.size / lyricsFontSize;
      updateBothThemes((light, dark) => {
        light.display[fontTarget] = buildFontSpec(font);
        dark.display[fontTarget] = buildFontSpec(font);
        const defaultFallback: FontParts = { family: "Arial", size: 14, bold: false, italic: false };
        for (const key of directiveKeys) {
          for (const theme of [light, dark]) {
            const d = theme.directives[key];
            if (d?.font) {
              const parsed = parseFontSpec(d.font, defaultFallback);
              parsed.size = Math.max(1, Math.round(parsed.size * ratio));
              d.font = buildFontSpec(parsed);
            }
          }
        }
      });
    } else {
      updateDisplayCommon(fontTarget, buildFontSpec(font));
    }
  };

  const currentFont = parseFontSpec(selectedThemeStyles.display[fontTarget], {
    family: "Arial",
    size: 14,
    bold: fontTarget === "tagFont",
    italic: false,
  });

  const selectedDirective = selectedThemeStyles.directives[selectedDirectiveKey] ?? {};
  const directiveFont = parseFontSpec(
    selectedDirective.font,
    parseFontSpec(selectedThemeStyles.display.lyricsFont, {
      family: "Arial",
      size: 14,
      bold: false,
      italic: false,
    })
  );

  const directiveTitleKey = DIRECTIVE_LABELS[selectedDirectiveKey];
  const directiveTitle = directiveTitleKey ? t(directiveTitleKey as never) : humanizeDirectiveName(selectedDirectiveKey);

  return (
    <div className="chordpro-styles-settings general-settings-root">
      <div className="chordpro-styles-main">
        <aside className="chordpro-styles-preview-column">
          <div className="card chordpro-styles-card chordpro-styles-preview-card">
            <div className="card-body">
              <div className="chordpro-styles-section-header">
                <div>
                  <h6 className="mb-1">{t("ChordProStylesPreview")}</h6>
                </div>
              </div>
              <div ref={previewFrameRef} className="chordpro-styles-preview-frame">
                <ChordProEditor
                  key={`preview-${themeMode}`}
                  song={previewSong}
                  settings={previewSettings}
                  previewOnly={true}
                  forceThemeMode={themeMode}
                />
                <div className="chordpro-styles-preview-overlay" aria-hidden="true">
                  <div className="chordpro-styles-preview-canvas-border"></div>
                  <div className="chordpro-styles-preview-margin-box"></div>
                  <button type="button" className="chordpro-styles-margin-handle left" onPointerDown={startMarginDrag("left")}></button>
                  <button type="button" className="chordpro-styles-margin-handle right" onPointerDown={startMarginDrag("right")}></button>
                  <button type="button" className="chordpro-styles-margin-handle top" onPointerDown={startMarginDrag("top")}></button>
                  <button type="button" className="chordpro-styles-margin-handle bottom" onPointerDown={startMarginDrag("bottom")}></button>
                </div>
              </div>
            </div>
          </div>
        </aside>

        <div className="chordpro-styles-controls-column">
          <section className="card chordpro-styles-card">
            <div className="card-body">
              <div className="chordpro-styles-section-header">
                <div>
                  <h6 className="mb-1">{t("ChordProStylesTextColorsSection")}</h6>
                  <p className="text-muted mb-0">{t("ChordProStylesCommonSettingsHint")}</p>
                </div>
                <button
                  type="button"
                  className="btn btn-sm btn-outline-secondary"
                  onClick={() => confirmFactoryDefaultsReset(resetSharedLayoutAndFonts)}
                >
                  {t("ChordProStylesResetShared")}
                </button>
              </div>

              <div className="chordpro-styles-font-target-row">
                <label className="form-label chordpro-styles-field">
                  <span>{t("ChordProStylesFontTarget")}</span>
                  <select className="form-select" value={fontTarget} onChange={(e) => setFontTarget(e.target.value as FontTargetKey)}>
                    {FONT_TARGETS.map((target) => (
                      <option key={target.key} value={target.key}>
                        {t(target.label as never)}
                      </option>
                    ))}
                  </select>
                </label>
                <FontEditor
                  font={currentFont}
                  onChange={handleDisplayFontChange}
                  familyLabel={t("ChordProStylesFontFamily")}
                  sizeLabel={t("ChordProStylesFontSize")}
                  baseFontSize={uiFontSize}
                />
              </div>

              <div className="chordpro-styles-grid">
                <SliderField
                  label={t("ChordProStylesHorizontalMargin")}
                  value={selectedThemeStyles.display.horizontalMargin}
                  min={0}
                  max={120}
                  onChange={(value) => updateDisplayCommon("horizontalMargin", value)}
                />
                <SliderField
                  label={t("ChordProStylesVerticalMargin")}
                  value={selectedThemeStyles.display.verticalMargin}
                  min={0}
                  max={120}
                  onChange={(value) => updateDisplayCommon("verticalMargin", value)}
                />
                <SliderField
                  label={t("ChordProStylesChordLineHeight")}
                  value={selectedThemeStyles.display.chordLineHeight}
                  min={10}
                  max={70}
                  onChange={(value) => updateDisplayCommon("chordLineHeight", value)}
                />
                <SliderField
                  label={t("ChordProStylesLyricsLineHeight")}
                  value={selectedThemeStyles.display.lyricsLineHeight}
                  min={10}
                  max={70}
                  onChange={(value) => {
                    if (lyricsLineHeight > 0 && value !== lyricsLineHeight) {
                      const ratio = value / lyricsLineHeight;
                      updateBothThemes((light, dark) => {
                        light.display.lyricsLineHeight = value;
                        dark.display.lyricsLineHeight = value;
                        for (const key of Object.keys(light.directives)) {
                          const ld = light.directives[key];
                          if (ld.height) ld.height = Math.max(1, Math.round(ld.height * ratio));
                          const dd = dark.directives[key];
                          if (dd?.height) dd.height = Math.max(1, Math.round(dd.height * ratio));
                        }
                      });
                    } else {
                      updateDisplayCommon("lyricsLineHeight", value);
                    }
                  }}
                />
                <SliderField
                  label={t("ChordProStylesChordLyricsGap")}
                  value={selectedThemeStyles.display.chordLyricSep}
                  min={0}
                  max={30}
                  onChange={(value) => updateDisplayCommon("chordLyricSep", value)}
                />
                <SliderField
                  label={t("ChordProStylesChordBorder")}
                  value={selectedThemeStyles.display.chordBorder}
                  min={0}
                  max={10}
                  onChange={(value) => updateDisplayCommon("chordBorder", value)}
                />
              </div>
            </div>
          </section>

          <section className="card chordpro-styles-card">
            <div className="card-body">
              <div className="chordpro-styles-section-header">
                <div>
                  <h6 className="mb-1">{t("ChordProStylesColorSection")}</h6>
                  <p className="text-muted mb-0">{t("ChordProStylesThemeOnlyHint")}</p>
                </div>
                <button type="button" className="btn btn-sm btn-outline-secondary" onClick={() => confirmFactoryDefaultsReset(resetThemeColors)}>
                  {t("ChordProStylesResetThemeColors")}
                </button>
              </div>

              <div className="chordpro-styles-color-target-row">
                <label htmlFor="chordproStylesThemeMode" className="form-label chordpro-styles-field">
                  <span>{t("ChordProStylesThemeMode")}</span>
                  <select
                    id="chordproStylesThemeMode"
                    className="form-select chordpro-styles-theme-select"
                    value={themeMode}
                    onChange={(e) => setThemeMode(e.target.value as ThemeMode)}
                  >
                    <option value="light">{t("ThemeLight")}</option>
                    <option value="dark">{t("ThemeDark")}</option>
                  </select>
                </label>
              </div>

              <div className="chordpro-styles-color-target-row">
                <label className="form-label chordpro-styles-field">
                  <span>{t("ChordProStylesColorTarget")}</span>
                  <select className="form-select" value={colorTargetIndex} onChange={(e) => setColorTargetIndex(Number(e.target.value))}>
                    {allColorTargets.map((target, index) => (
                      <option key={target.type === "display" ? target.key : `dir-${target.directiveKey}`} value={index}>
                        {t(target.label as never)}
                      </option>
                    ))}
                  </select>
                </label>
                <ColorPickerField
                  label={t("ChordProStylesColorSection")}
                  value={getColorByTarget(selectedColorTarget)}
                  onChange={(value) => updateColorByTarget(selectedColorTarget, value)}
                />
              </div>
            </div>
          </section>

          <section className="card chordpro-styles-card">
            <div className="card-body">
              <div className="chordpro-styles-section-header">
                <div>
                  <h6 className="mb-1">{t("ChordProStylesDirectiveSection")}</h6>
                  <p className="text-muted mb-0">{t("ChordProStylesDirectiveHelp")}</p>
                </div>
                <button type="button" className="btn btn-sm btn-outline-secondary" onClick={() => confirmFactoryDefaultsReset(resetDirectiveStyles)}>
                  {t("ChordProStylesResetDirectiveStyles")}
                </button>
              </div>

              <div className="chordpro-styles-directive-pager">
                <button
                  type="button"
                  className="btn btn-sm btn-outline-secondary"
                  onClick={() => setDirectiveIndex((prev) => Math.max(0, prev - 1))}
                  disabled={directiveIndex <= 0}
                >
                  {t("ChordProStylesPrevious")}
                </button>
                <label className="form-label mb-0 chordpro-styles-directive-select-wrap">
                  <span className="visually-hidden">{t("ChordProStylesDirectiveSection")}</span>
                  <select
                    className="form-select"
                    value={selectedDirectiveKey}
                    onChange={(e) => setDirectiveIndex(Math.max(0, directiveKeys.indexOf(e.target.value)))}
                  >
                    {directiveKeys.map((directiveKey) => {
                      const keyLabel = DIRECTIVE_LABELS[directiveKey];
                      const label = keyLabel ? t(keyLabel as never) : humanizeDirectiveName(directiveKey);
                      return (
                        <option key={directiveKey} value={directiveKey}>
                          {label}
                        </option>
                      );
                    })}
                  </select>
                </label>
                <button
                  type="button"
                  className="btn btn-sm btn-outline-secondary"
                  onClick={() => setDirectiveIndex((prev) => Math.min(directiveKeys.length - 1, prev + 1))}
                  disabled={directiveIndex >= directiveKeys.length - 1}
                >
                  {t("ChordProStylesNext")}
                </button>
              </div>

              <div className="chordpro-styles-directive-card compact">
                <div className="chordpro-styles-directive-header">
                  <h6 className="mb-0">{directiveTitle}</h6>
                </div>

                {!selectedDirectiveKey.startsWith("start_of_") && (
                  <label className="chordpro-styles-toggle">
                    <input
                      type="checkbox"
                      className="form-check-input me-2"
                      checked={!(selectedDirective.hidden ?? false)}
                      onChange={(e) => updateDirectiveCommon(selectedDirectiveKey, { hidden: !e.target.checked })}
                    />
                    <span>{t("ChordProStylesMetaRowVisible")}</span>
                  </label>
                )}

                <div className="chordpro-styles-grid">
                  <label className="form-label chordpro-styles-field">
                    <span>{t("ChordProStylesPrefix")}</span>
                    <input
                      type="text"
                      className="form-control"
                      value={selectedDirective.prefix ?? ""}
                      onChange={(e) => updateDirectiveCommon(selectedDirectiveKey, { prefix: e.target.value })}
                    />
                  </label>
                  <label className="form-label chordpro-styles-field">
                    <span>{t("ChordProStylesAlign")}</span>
                    <select
                      className="form-select"
                      value={selectedDirective.align ?? ""}
                      onChange={(e) =>
                        updateDirectiveCommon(selectedDirectiveKey, {
                          align: e.target.value || undefined,
                        })
                      }
                    >
                      <option value="">{t("SettingsSectionSelNone")}</option>
                      <option value="left">{t("ChordProStylesAlignLeft")}</option>
                      <option value="center">{t("ChordProStylesAlignCenter")}</option>
                      <option value="right">{t("ChordProStylesAlignRight")}</option>
                    </select>
                  </label>
                  <SliderField
                    label={t("ChordProStylesHeight")}
                    value={
                      lyricsLineHeight > 0 ? Math.round(((selectedDirective.height ?? 0) / lyricsLineHeight) * 100) : (selectedDirective.height ?? 0)
                    }
                    min={0}
                    max={400}
                    step={5}
                    onChange={(pct) =>
                      updateDirectiveCommon(selectedDirectiveKey, { height: Math.max(0, Math.round((pct / 100) * lyricsLineHeight)) })
                    }
                  />
                  <SliderField
                    label={t("ChordProStylesIndent")}
                    value={selectedDirective.indent ?? 0}
                    min={0}
                    max={40}
                    onChange={(value) => updateDirectiveCommon(selectedDirectiveKey, { indent: value })}
                  />
                </div>

                <FontEditor
                  font={directiveFont}
                  onChange={(font) => updateDirectiveCommon(selectedDirectiveKey, { font: buildFontSpec(font) })}
                  familyLabel={t("ChordProStylesFontFamily")}
                  sizeLabel={t("ChordProStylesFontSize")}
                  baseFontSize={lyricsFontSize}
                />
              </div>
            </div>
          </section>
        </div>
      </div>
    </div>
  );
};

export default ChordProStylesSettings;
