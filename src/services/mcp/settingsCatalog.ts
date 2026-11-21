/**
 * The settings an MCP client may read and change, with the page and label the user
 * sees in the Settings dialog, so an assistant can say where a setting is and change
 * it by key.
 *
 * Only catalogued keys can be written. Structured settings (ChordPro styles, hardware
 * profiles, score defaults, margins), secrets and the MCP switches themselves are left
 * out on purpose: an assistant must not be able to widen its own access.
 */
import type { Settings } from "../../types";
import { McpToolError } from "./types";

export type SettingValueType = "boolean" | "number" | "string" | "enum" | "color" | "stringList";

export interface SettingDescriptor {
  key: keyof Settings;
  /** Settings dialog tab id, or "preview" (Format tab of the preview panel) / "sessions". */
  page: string;
  /** Localization key of the label; `label` is used when the UI has no single string. */
  labelKey?: string;
  label?: string;
  type: SettingValueType;
  values?: readonly string[];
  min?: number;
  max?: number;
  integer?: boolean;
  writable?: false;
  nullable?: true;
  /** The value is never returned and cannot be set. */
  secret?: boolean;
}

type Strings = Record<string, string>;

const PAGE_LABEL_KEYS: Record<string, string> = {
  general: "SettingsPageGeneral",
  "client-view": "SettingsPageClientView",
  performance: "SettingsPagePerformance",
  searching: "SettingsPageSearching",
  projecting: "SettingsPageProjecting",
  images: "SettingsPageImages",
  leaders: "SettingsPageLeaders",
  sections: "SettingsPageSections",
  "chordpro-styles": "SettingsPageChordProStyles",
  clients: "SettingsPageClients",
  webserver: "SettingsPageWebServer",
  netdisplay: "SettingsPageNetDisplay",
  about: "SettingsPageAbout",
};

const PAGE_LABELS: Record<string, string> = {
  preview: "Preview panel → Format tab",
  sessions: "Sessions dialog",
  "song-tree": "Song library → filter beside the search box",
};

/** Settings dialog tabs an assistant can ask the app to open. */
export const SETTINGS_PAGES: readonly string[] = [...Object.keys(PAGE_LABEL_KEYS), "hardware-control", "score", "mcp"];

const MODE = ["off", "auto", "on"] as const;
const SCAN = ["off", "web", "local", "both"] as const;

const bool = (key: keyof Settings, page: string, labelKey: string): SettingDescriptor => ({ key, page, labelKey, type: "boolean" });
const boolText = (key: keyof Settings, page: string, label: string): SettingDescriptor => ({ key, page, label, type: "boolean" });
const choice = (key: keyof Settings, page: string, labelKey: string, values: readonly string[]): SettingDescriptor => ({
  key,
  page,
  labelKey,
  type: "enum",
  values,
});
const int = (key: keyof Settings, page: string, labelKey: string, min: number, max: number): SettingDescriptor => ({
  key,
  page,
  labelKey,
  type: "number",
  min,
  max,
  integer: true,
});
const color = (key: keyof Settings, page: string, labelKey: string): SettingDescriptor => ({ key, page, labelKey, type: "color" });

export const SETTINGS_CATALOG: readonly SettingDescriptor[] = [
  int("baseFontSize", "general", "SettingsUIFontSize", 8, 32),
  choice("fontSizeMode", "general", "SettingsUIFontSizeMode", ["manual", "auto-resolution", "auto-resolution-dpi"]),
  bool("useFontAwesomeIcons", "general", "SettingsUseFontAwesomeIcons"),
  bool("keepAwake", "general", "SettingsKeepAwake"),
  bool("fullscreen", "general", "SettingsFullscreen"),
  bool("hideChordsInReadonlyEditor", "general", "SettingsHideChordsInEditor"),
  bool("showTooltips", "general", "SettingsShowTooltips"),
  { ...choice("language", "general", "Language", ["en", "hu", "auto"]), writable: false },
  { ...choice("theme", "general", "Theme", ["light", "dark", "auto"]), writable: false },
  { key: "songLanguageFilter", page: "general", labelKey: "SongLanguageFilter", type: "stringList", nullable: true, writable: false },
  {
    key: "preferenceFilter",
    page: "song-tree",
    label: "Preference filter",
    type: "enum",
    values: ["all", "preferred-only", "show-ignored"],
    writable: false,
  },
  choice("defaultChordSystem", "general", "SettingsChordSystem", ["G", "S"]),
  { key: "defaultSongLanguage", page: "general", labelKey: "DefaultSongLanguage", type: "string" },
  int("serverPeekIntervalMinutes", "general", "SettingsPeekIntervalMinutes", 1, 1440),
  int("syncDeclineTimeoutMinutes", "general", "SettingsSyncDeclineTimeoutMinutes", 0, 1440),
  bool("showHeldSongs", "general", "SettingsShowHeldSongs"),
  bool("showCloudNetworkErrorToasts", "general", "SettingsShowCloudNetworkErrorToasts"),

  choice("automaticViewSwitch", "client-view", "SettingsAutomaticViewSwitch", ["none", "portraitToClient", "orientation"]),
  choice("clientViewAutoScanSessions", "client-view", "SettingsClientViewAutoScanSessions", SCAN),
  choice("clientViewSessionsFoundPopup", "client-view", "SettingsClientViewSessionsFoundPopup", SCAN),
  int("ppdWatchTimeoutSeconds", "client-view", "SettingsPpdWatchTimeout", 2, 600),

  choice("fullViewChordProPageTurnMode", "performance", "PerformanceFullViewPageTurn", MODE),
  choice("clientViewPageTurnMode", "performance", "PerformanceClientViewPageTurn", MODE),
  choice("clientViewLivePitchPreviewMode", "performance", "PerformanceLivePitchPreview", MODE),
  choice("uiAnimationMode", "performance", "PerformanceUiAnimations", MODE),
  choice("playlistProjectionCheckMode", "performance", "PerformancePlaylistProjectionCheck", MODE),
  choice("projectedImageCacheMode", "performance", "PerformanceProjectedImageCache", MODE),
  {
    key: "projectionRenderQualityMode",
    page: "performance",
    label: "Projection render quality",
    type: "enum",
    values: ["performance", "auto", "quality"],
  },
  bool("disableHardwareAccelerationOnStartup", "performance", "SettingsDisableHardwareAccelerationOnStartup"),

  choice("searchMethod", "searching", "SearchEngineSelection", ["traditional", "typesense"]),
  { key: "typesenseUrl", page: "searching", labelKey: "TypesenseUrl", type: "string" },
  { key: "typesenseApiKey", page: "searching", label: "Typesense API key", type: "string", secret: true },
  int("searchMaxResults", "searching", "MaximumResults", 0, 100000),
  bool("useTextSimilarities", "searching", "EnableSimilarTextSearch"),
  bool("traditionalSearchCaseSensitive", "searching", "CaseSensitiveSearch"),
  bool("traditionalSearchWholeWords", "searching", "MatchWholeWordsOnly"),

  bool("externalWebDisplayEnabled", "projecting", "SettingsExternalWebDisplay"),
  bool("useNonSplittingWords", "projecting", "SettingsUseNonBreakingWords"),
  { key: "nonSplittingWordList", page: "projecting", label: "Non-breaking words", type: "stringList" },
  bool("displayTextShadowEnabled", "projecting", "SettingsTextShadowEnabled"),
  bool("qrCodeInPreview", "projecting", "SettingsQRCodeVisible"),
  int("qrCodeSizePercent", "projecting", "SettingsQRCodeSize", 5, 50),
  { key: "qrCodeX", page: "projecting", label: "QR code horizontal position (% of image width)", type: "number", min: 0, max: 100 },
  { key: "qrCodeY", page: "projecting", label: "QR code vertical position (% of image height)", type: "number", min: 0, max: 100 },
  bool("warningFlashInPreview", "projecting", "SettingsWarningFlash"),
  boolText("remoteHighlightControlEnabled", "projecting", "Allow authorized tablets to change the projected section"),
  int("remoteHighlightActivityTimeoutSeconds", "projecting", "SettingsRemoteHighlightActivityTimeout", 1, 3600),

  choice("backgroundImageFit", "images", "BackgroundImageFit", [
    "touchInner",
    "touchOuter",
    "stretch",
    "touchInnerMargins",
    "touchOuterMargins",
    "stretchMargins",
  ]),
  { key: "pictureFolder", page: "images", labelKey: "SettingsPictureFolder", type: "string" },
  bool("importImageUseCompression", "images", "ImportConvertToJpeg"),
  bool("importImageUseResize", "images", "ImportResizeImages"),
  int("importImageJpegQuality", "images", "ImportQuality", 1, 100),

  choice("leaderProfileUpdateMode", "leaders", "LeaderProfileUpdateMode", ["leaderPageOnly", "uiChangesAlso", "allSources"]),

  bool("useSectionColoring", "sections", "UseSectionColoring"),
  color("verseSectionColor", "sections", "Verse"),
  color("chorusSectionColor", "sections", "Chorus"),
  color("bridgeSectionColor", "sections", "Bridge"),
  bool("checkSectionsProjectable", "sections", "ShowProjectingProblems"),
  bool("displayAllowFontSizeReduction", "sections", "AutoShrinkFont"),
  int("displayMinimumFontSize", "sections", "MinimumFontSizePt", 0, 400),
  int("displayMinimumFontSizePercent", "sections", "MinimumFontSizePercent", 1, 100),
  choice("displayShowFontSizeReduction", "sections", "ShowShrinkedFontUsage", ["NONE", "SECTIONS", "PLAYLIST", "BOTH"]),
  bool("sectionHighlightInEditor", "sections", "HighlightCurrentSection"),
  bool("realSectionPreview", "sections", "UseRealSlidePreview"),
  bool("previewFontInSections", "sections", "UsePreviewFormat"),

  bool("stylesToClients", "chordpro-styles", "ChordProStylesAdvertiseToClients"),

  bool("allClientsCanUseLeaderMode", "clients", "AllClientsAreAdmins"),
  { key: "leaderModeClients", page: "clients", labelKey: "AdminClients", type: "stringList" },

  bool("iWebEnabled", "webserver", "EnableWebServer"),
  int("webServerPort", "webserver", "ServerPort", 1024, 65535),
  { key: "webServerPath", page: "webserver", labelKey: "RootPath", type: "string" },
  { key: "webServerDomainName", page: "webserver", labelKey: "Domain", type: "string" },
  bool("webServerAcceptLanClientsOnly", "webserver", "WebServerAcceptLanClientsOnly"),
  int("longPollTimeout", "webserver", "MaxResponseTime", 5, 600),
  bool("registerLocalServer", "webserver", "RegisterLocalServer"),
  boolText("ppdSessionEnabled", "sessions", "Nearby session for the PraiseProjector apps (local network / Bluetooth)"),

  choice("netDisplayResolution", "netdisplay", "NetDisplayResolution", ["640x480", "854x480", "1280x720", "1920x1080", "3840x2160"]),
  choice("netDisplayTransitionType", "netdisplay", "NetDisplayTransitionType", ["linear", "ease", "ease-in", "ease-out", "ease-in-out"]),
  bool("netDisplayUseJpegCompression", "netdisplay", "NetDisplayUseJpegCompression"),
  int("netDisplayJpegQuality", "netdisplay", "NetDisplayJpegQuality", 1, 100),
  { key: "netDisplayImageScale", page: "netdisplay", labelKey: "NetDisplayImageScale", type: "number", min: 0.1, max: 1 },
  int("netDisplayTransient", "netdisplay", "NetDisplayTransient", 0, 10000),

  { key: "updateChannel", page: "about", label: "Update channel", type: "enum", values: ["stable", "testing"] },
  bool("suggestTutorialAtStartup", "about", "TutorialStartupSuggestCheckbox"),
  { key: "logLevel", page: "about", label: "Log level (0 debug, 1 info, 2 warning, 3 error, 4 none)", type: "number", min: 0, max: 4, integer: true },

  { key: "displayFontName", page: "preview", label: "Projection font", type: "string" },
  { key: "displayFontSize", page: "preview", label: "Projection font size", type: "number", min: 4, max: 400 },
  { key: "displayFontAlign", page: "preview", label: "Projection text alignment", type: "enum", values: ["left", "center", "right"] },
  boolText("displayFontBold", "preview", "Bold"),
  boolText("displayFontItalic", "preview", "Italic"),
  boolText("displayFontUnderline", "preview", "Underline"),
  { key: "textColor", page: "preview", label: "Projection text color", type: "color" },
  { key: "backgroundColor", page: "preview", label: "Projection background color", type: "color" },
  boolText("contentBasedSections", "preview", "Content based text formatting (sections split by content)"),
  boolText("projectInstructions", "preview", "Use the playlist item's instructions to build the sections"),
  { key: "message", page: "preview", label: "Message shown on the projector (Message tab)", type: "string" },
];

const BY_KEY = new Map<string, SettingDescriptor>(SETTINGS_CATALOG.map((descriptor) => [descriptor.key, descriptor]));

export interface DescribedSetting {
  key: string;
  page: string;
  pageLabel: string;
  label: string;
  help?: string;
  type: SettingValueType;
  values?: readonly string[];
  min?: number;
  max?: number;
  value?: unknown;
  writable: boolean;
  nullable?: true;
}

const HELP_SUFFIXES = ["Description", "Help", "Hint"];

function pageLabel(page: string, strings: Strings): string {
  const key = PAGE_LABEL_KEYS[page];
  return (key && strings[key]) || PAGE_LABELS[page] || page;
}

export function describeSetting(descriptor: SettingDescriptor, settings: Partial<Settings> | null, strings: Strings): DescribedSetting {
  const help = descriptor.labelKey ? HELP_SUFFIXES.map((suffix) => strings[descriptor.labelKey + suffix]).find(Boolean) : undefined;
  const described: DescribedSetting = {
    key: descriptor.key,
    page: descriptor.page,
    pageLabel: pageLabel(descriptor.page, strings),
    label: (descriptor.labelKey && strings[descriptor.labelKey]) || descriptor.label || descriptor.key,
    type: descriptor.type,
    writable: !descriptor.secret && descriptor.writable !== false,
  };
  if (descriptor.nullable) described.nullable = true;
  if (help) described.help = help;
  if (descriptor.values) described.values = descriptor.values;
  if (descriptor.min !== undefined) described.min = descriptor.min;
  if (descriptor.max !== undefined) described.max = descriptor.max;
  if (descriptor.secret) described.value = settings?.[descriptor.key] ? "(set, hidden)" : "(not set)";
  else if (settings) described.value = settings[descriptor.key];
  return described;
}

/** Catalogue entries, optionally of one page and/or matching a search text. */
export function describeSettings(
  settings: Partial<Settings> | null,
  strings: Strings,
  filter: { page?: string; search?: string } = {}
): DescribedSetting[] {
  const needle = filter.search?.trim().toLocaleLowerCase();
  return SETTINGS_CATALOG.filter((descriptor) => !filter.page || descriptor.page === filter.page)
    .map((descriptor) => describeSetting(descriptor, settings, strings))
    .filter((item) => !needle || [item.key, item.label, item.help ?? "", item.pageLabel].some((text) => text.toLocaleLowerCase().includes(needle)));
}

function checkValue(descriptor: SettingDescriptor, value: unknown): string | null {
  switch (descriptor.type) {
    case "boolean":
      return typeof value === "boolean" ? null : "must be true or false";
    case "number": {
      if (typeof value !== "number" || !Number.isFinite(value)) return "must be a number";
      if (descriptor.integer && !Number.isInteger(value)) return "must be a whole number";
      if (descriptor.min !== undefined && value < descriptor.min) return `must be at least ${descriptor.min}`;
      if (descriptor.max !== undefined && value > descriptor.max) return `must be at most ${descriptor.max}`;
      return null;
    }
    case "enum":
      return typeof value === "string" && descriptor.values!.includes(value) ? null : `must be one of: ${descriptor.values!.join(", ")}`;
    case "color":
      return typeof value === "string" && /^#[0-9a-f]{6}$/i.test(value) ? null : "must be a color like #1a2b3c";
    case "stringList":
      return Array.isArray(value) && value.every((item) => typeof item === "string") ? null : "must be a list of texts";
    default:
      return typeof value === "string" && value.length <= 2000 ? null : "must be a text";
  }
}

/** The validated patch. Throws a tool error that names every rejected key. */
export function validateSettingsPatch(changes: Record<string, unknown>): Partial<Settings> {
  const problems: string[] = [];
  const patch: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(changes)) {
    const descriptor = BY_KEY.get(key);
    if (!descriptor) {
      problems.push(`${key}: not a setting that can be changed here (see list_settings)`);
      continue;
    }
    if (descriptor.secret) {
      problems.push(`${key}: secrets can only be entered in the application`);
      continue;
    }
    if (descriptor.writable === false) {
      problems.push(`${key}: read-only here; change it in the application (see list_settings for its location)`);
      continue;
    }
    const problem = checkValue(descriptor, value);
    if (problem) problems.push(`${key}: ${problem}`);
    else patch[key] = value;
  }
  if (!Object.keys(changes).length) problems.push("no changes given");
  if (problems.length) throw new McpToolError(`Nothing was changed. ${problems.join("; ")}`);
  return patch as Partial<Settings>;
}
