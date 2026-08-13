// The style shapes are a cross-boundary contract and live in `common/`; this module owns
// the factories that build them. Re-exported so existing importers keep one import site.
import type {
  ChordProDirectiveStyle,
  ChordProDirectiveStyles,
  ChordProDisplayProperties,
  ChordProStylesSettings,
  ChordProThemeStyles,
} from "../common/chordpro-styles";

export type {
  ChordProDirectiveStyle,
  ChordProDirectiveStyles,
  ChordProDisplayProperties,
  ChordProStylesSettings,
  ChordProThemeStyles,
} from "../common/chordpro-styles";

type PrefixLocalizer = (key: string) => string;

export function defaultDisplayProperties(darkMode?: boolean): ChordProDisplayProperties {
  // Read the current UI font size set by ResponsiveFontSizeManager (default is 16px).
  // Prefer computed style so this still works even when font size comes from CSS, not inline style.
  const rootPx =
    typeof document !== "undefined"
      ? parseFloat(getComputedStyle(document.documentElement).fontSize || document.documentElement.style.fontSize || "16") || 16
      : 16;
  const scale = rootPx / 16;
  const px = (base: number) => `${Math.round(base * scale)}px`;
  const lineH = (base: number) => Math.round(base * scale);

  const def = {
    horizontalMargin: 5,
    verticalMargin: 5,
    tagFont: `bold ${px(14)} arial`,
    tagColor: "black",
    chordFont: `${px(14)} arial`,
    chordLineHeight: lineH(16),
    chordTextColor: "red",
    unknownChordTextColor: "orange",
    chordBorder: 2,
    lyricsFont: `${px(14)} sherif`,
    lyricsLineHeight: lineH(16),
    lyricsTextColor: "#808080",
    chordLyricSep: lineH(7),
    sectionBreakColor: "blue",
    highlightColor: "#e5e781",
    chordBoxColor: "black",
    cursorColor: "black",
    backgroundColor: "white",
    lineColor: "black",
    selectedTextBg: "blue",
    selectedTextFg: "#fefeff",
    commentBg: "grey",
    commentFg: "black",
    commentBorder: "black 1px solid",
    guitarChordSize: {
      width: 50,
      height: 60,
    },
    pianoChordSize: {
      width: 60,
      height: 40,
    },
    markUnderscoreColor: "red",
  };

  if (darkMode) {
    for (const key of Object.keys(def) as (keyof typeof def)[]) {
      if (def[key] === "black") (def as Record<string, unknown>)[key] = "white";
      else if (def[key] === "white") (def as Record<string, unknown>)[key] = "black";
    }
    def.highlightColor = "#a5a741";
  }

  return def;
}

export function defaultStyles(lyricsFont: string, darkMode?: boolean, localize?: PrefixLocalizer): ChordProDirectiveStyles {
  const localizedPrefix = (key: string, fallback: string) => {
    const translated = localize?.(key);
    return translated && translated !== key ? translated : fallback;
  };

  const style = {
    title: {
      font: "bold 32px times",
      fg: "blue",
      bg: "white",
      height: 38,
      align: "center",
    },
    key: {
      prefix: localizedPrefix("MetaKey", "Key"),
      font: "12px sherif",
      fg: "gray",
      bg: "white",
      height: 14,
    },
    capo: {
      prefix: localizedPrefix("MetaCapo", "Capo"),
      font: "14px sherif",
      fg: "#404040",
      bg: "white",
      height: 18,
    },
    tempo: {
      prefix: localizedPrefix("MetaTempo", "Tempo"),
      font: "10px sherif",
      fg: "gray",
      bg: "white",
      height: 14,
    },
    composer: {
      prefix: localizedPrefix("MetaComposer", "Composer"),
      font: "10px sherif",
      fg: "gray",
      bg: "white",
      height: 14,
    },
    subtitle: {
      prefix: localizedPrefix("MetaSubtitle", "Subtitle"),
      font: "10px sherif",
      fg: "gray",
      bg: "white",
      height: 14,
    },
    copyright: {
      prefix: localizedPrefix("MetaCopyright", "Copyright"),
      font: "10px sherif",
      fg: "gray",
      bg: "white",
      height: 14,
    },
    artist: {
      prefix: localizedPrefix("MetaArtist", "Artist"),
      font: "10px sherif",
      fg: "gray",
      bg: "white",
      height: 14,
      hidden: true,
    },
    lyricist: {
      prefix: localizedPrefix("MetaLyricist", "Lyricist"),
      font: "10px sherif",
      fg: "gray",
      bg: "white",
      height: 14,
      hidden: true,
    },
    album: {
      prefix: localizedPrefix("MetaAlbum", "Album"),
      font: "10px sherif",
      fg: "gray",
      bg: "white",
      height: 14,
      hidden: true,
    },
    year: {
      prefix: localizedPrefix("MetaYear", "Year"),
      font: "10px sherif",
      fg: "gray",
      bg: "white",
      height: 14,
      hidden: true,
    },
    time: {
      prefix: localizedPrefix("MetaTime", "Time"),
      font: "10px sherif",
      fg: "gray",
      bg: "white",
      height: 14,
      hidden: true,
    },
    duration: {
      prefix: localizedPrefix("MetaDuration", "Duration"),
      font: "10px sherif",
      fg: "gray",
      bg: "white",
      height: 14,
      hidden: true,
    },
    start_of_grid: {
      font: "bold " + lyricsFont,
      fg: "black",
      bg: "white",
      indent: 5,
    },
    start_of_chorus: {
      font: "bold " + lyricsFont,
      fg: "black",
      bg: "white",
      indent: 15,
    },
    start_of_verse: {
      font: lyricsFont,
      fg: "black",
      bg: "white",
    },
    start_of_bridge: {
      font: "bold italic " + lyricsFont,
      fg: "black",
      bg: "white",
      indent: 10,
    },
  };

  if (darkMode) {
    const invert = (obj: { bg: string; fg: string }) => {
      for (const key of ["bg", "fg"] as const)
        if (obj[key] === "black") obj[key] = "white";
        else if (obj[key] === "white") obj[key] = "black";
    };
    for (const key of Object.keys(style) as (keyof typeof style)[]) invert(style[key]);
  }

  return style;
}

export function cloneDisplayProperties(display: ChordProDisplayProperties): ChordProDisplayProperties {
  return {
    ...display,
    guitarChordSize: { ...display.guitarChordSize },
    pianoChordSize: { ...display.pianoChordSize },
  };
}

export function cloneDirectiveStyles(styles: ChordProDirectiveStyles): ChordProDirectiveStyles {
  const clone: ChordProDirectiveStyles = {};
  for (const [key, value] of Object.entries(styles)) {
    clone[key] = { ...value };
  }
  return clone;
}

export function createDefaultChordProStylesSettings(localize?: PrefixLocalizer): ChordProStylesSettings {
  const lightDisplay = defaultDisplayProperties(false);
  const darkDisplay = defaultDisplayProperties(true);
  return {
    light: {
      display: cloneDisplayProperties(lightDisplay),
      directives: cloneDirectiveStyles(defaultStyles(lightDisplay.lyricsFont, false, localize)),
    },
    dark: {
      display: cloneDisplayProperties(darkDisplay),
      directives: cloneDirectiveStyles(defaultStyles(darkDisplay.lyricsFont, true, localize)),
    },
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function validValue(value: unknown, fallback: unknown): boolean {
  if (typeof fallback === "number") return typeof value === "number" && Number.isFinite(value);
  return typeof value === typeof fallback;
}

function normalizeDisplayProperties(value: unknown, fallback: ChordProDisplayProperties): ChordProDisplayProperties {
  const source = isRecord(value) ? value : {};
  const normalized: Record<string, unknown> = { ...source };

  for (const [key, defaultValue] of Object.entries(fallback)) {
    if (key === "guitarChordSize" || key === "pianoChordSize") continue;
    normalized[key] = validValue(source[key], defaultValue) ? source[key] : defaultValue;
  }

  for (const key of ["guitarChordSize", "pianoChordSize"] as const) {
    const defaultSize = fallback[key];
    const sourceSize = isRecord(source[key]) ? source[key] : {};
    normalized[key] = {
      ...sourceSize,
      width: validValue(sourceSize.width, defaultSize.width) ? sourceSize.width : defaultSize.width,
      height: validValue(sourceSize.height, defaultSize.height) ? sourceSize.height : defaultSize.height,
    };
  }

  return normalized as ChordProDisplayProperties;
}

function normalizeDirectiveStyle(value: unknown, fallback: ChordProDirectiveStyle = {}): ChordProDirectiveStyle {
  const source = isRecord(value) ? value : {};
  const normalized: Record<string, unknown> = { ...source };
  const schema = {
    prefix: "string",
    font: "string",
    fg: "string",
    bg: "string",
    height: "number",
    align: "string",
    indent: "number",
    hidden: "boolean",
  } as const;

  for (const [key, type] of Object.entries(schema)) {
    const sourceValue = source[key];
    const fallbackValue = fallback[key as keyof ChordProDirectiveStyle];
    const sourceIsValid = typeof sourceValue === type && (type !== "number" || (typeof sourceValue === "number" && Number.isFinite(sourceValue)));
    if (sourceIsValid) normalized[key] = sourceValue;
    else if (fallbackValue !== undefined) normalized[key] = fallbackValue;
    else delete normalized[key];
  }

  return normalized as ChordProDirectiveStyle;
}

function normalizeThemeStyles(value: unknown, fallback: ChordProThemeStyles): ChordProThemeStyles {
  const source = isRecord(value) ? value : {};
  const sourceDirectives = isRecord(source.directives) ? source.directives : {};
  const directives: ChordProDirectiveStyles = {};

  for (const key of new Set([...Object.keys(fallback.directives), ...Object.keys(sourceDirectives)])) {
    directives[key] = normalizeDirectiveStyle(sourceDirectives[key], fallback.directives[key]);
  }

  return {
    ...source,
    display: normalizeDisplayProperties(source.display, fallback.display),
    directives,
  } as ChordProThemeStyles;
}

/**
 * Upgrade partial or older style payloads without changing the persisted wire
 * shape. Known valid values win, missing/invalid known fields get current
 * defaults, and unknown fields/directives survive for forward compatibility.
 */
export function normalizeChordProStyles(
  value: unknown,
  localize?: PrefixLocalizer,
  suppliedDefaults?: ChordProStylesSettings
): ChordProStylesSettings {
  const defaults = suppliedDefaults ?? createDefaultChordProStylesSettings(localize);
  const source = isRecord(value) ? value : {};
  return {
    ...source,
    light: normalizeThemeStyles(source.light, defaults.light),
    dark: normalizeThemeStyles(source.dark, defaults.dark),
  } as ChordProStylesSettings;
}
