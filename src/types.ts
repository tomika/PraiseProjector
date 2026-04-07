import type { ChordProStylesSettings } from "../chordpro/chordpro_styles";

export interface Settings {
  displayBorderRect: {
    left: number;
    top: number;
    width: number;
    height: number;
  };
  // Display/Preview settings
  displayFontName: string;
  displayFontSize: number;
  displayFontAlign: "left" | "center" | "right";
  displayFontBold: boolean;
  displayFontItalic: boolean;
  displayFontUnderline: boolean;
  displayTextShadowEnabled: boolean;
  displayTextShadowOffset: number;
  displayTextShadowBlur: number;
  displayTextShadowColor: string;
  displayTextShadowOpacity: number;
  backgroundColor: string;
  textColor: string;
  textBorderColor: string;
  textBorderWidth: number;
  message: string;

  useNonSplittingWords: boolean;
  realSectionPreview: boolean;
  previewFontInSections: boolean;
  nonSplittingWordList: string[];
  hideChordsInReadonlyEditor: boolean;
  sectionHighlightInEditor: boolean;
  sectionSelByEditorLineSel: boolean;
  sectionSelByEditorDblclk: boolean;
  keepAwake: boolean;
  showTooltips: boolean;
  pictureFolder: string;
  selectedBackgroundImageId: string | null;
  backgroundImageFit: "touchInner" | "touchOuter" | "stretch" | "touchInnerMargins" | "touchOuterMargins" | "stretchMargins";
  importImageUseCompression: boolean;
  importImageUseResize: boolean;
  importImageResolutionWidth: number;
  importImageResolutionHeight: number;
  importImageResolutionPreset: string;
  importImageFit: "touchInner" | "touchOuter" | "stretch";
  importImageJpegQuality: number;
  // Search settings
  useTextSimilarities: boolean;

  // Search settings
  searchMaxResults: number; // Maximum number of results (0 = unlimited)
  traditionalSearchCaseSensitive: boolean;
  traditionalSearchWholeWords: boolean;

  // Search method: "traditional" = word-index + Damerau-Levenshtein, "typesense" = Typesense server
  searchMethod: "traditional" | "typesense";
  // Typesense settings
  typesenseUrl: string; // Typesense server URL (default "http://127.0.0.1:8108")
  typesenseApiKey: string; // Typesense search-only API key

  useFontAwesomeIcons: boolean;
  baseFontSize: number; // Base font size in pixels for UI scaling
  fontSizeMode: "manual" | "auto-resolution" | "auto-resolution-dpi";

  iWebEnabled: boolean;
  webServerPort: number;
  webServerPath: string;
  webServerDomainName: string;
  webServerAcceptLanClientsOnly: boolean;
  externalWebDisplayEnabled: boolean;
  registerLocalServer: boolean;
  longPollTimeout: number;
  netDisplayResolution: string; // "640x480" | "854x480" | "1280x720" | "1920x1080" | "3840x2160"
  netDisplayTransitionType: string; // "linear" | "ease" | "ease-in" | "ease-out" | "ease-in-out"
  netDisplayUseJpegCompression: boolean;
  netDisplayJpegQuality: number;
  netDisplayImageScale: number;
  netDisplayTransient: number;

  useSectionColoring: boolean;
  verseSectionColor: string;
  chorusSectionColor: string;
  bridgeSectionColor: string;
  checkSectionsProjectable: boolean;
  contentBasedSections: boolean; // Use content-based section splitting
  projectInstructions: boolean; // Use instructions from playlist items for section generation
  displayFaultThreshold: number; // Tolerance for text overflow in pixels
  displayCroppedTextBgColor: string;
  displayAllowFontSizeReduction: boolean;
  displayMinimumFontSize: number;
  displayMinimumFontSizePercent: number;
  displayShowFontSizeReduction: "NONE" | "SECTIONS" | "PLAYLIST" | "BOTH";
  displayShrinkedTextBgColor: string;
  displayPlaylistUpdateInterval: number;

  printingBB: boolean;
  printingMetaData: boolean;
  printingSuperScript: boolean;
  printingTitle: boolean;
  printingMollMode: string;
  printingSectionLabels: "None" | "Abbreviated" | "Full";

  allClientsCanUseLeaderMode: boolean;
  selectedLeader?: string;
  leaderModeClients: string[];
  minWebRenderSize: { width: number; height: number };

  // Chord system for new songs (G = German/Hungarian, S = Standard/English)
  defaultChordSystem: "G" | "S";

  // Projector/Display settings
  displayMonitorId: string; // ID of selected monitor for projection

  // Last sync date for "old sync" warning when entering edit mode
  lastSyncDate?: string; // ISO date string, null if never synced

  // Cooldown after declining the old-sync prompt before asking again
  syncDeclineTimeoutMinutes: number;

  // Interval of automatic /peek calls (minutes)
  serverPeekIntervalMinutes: number;

  // Log level for console output (0=Debug, 1=Info, 2=Warn, 3=Error, 4=None)
  logLevel: number;

  // Auto-expand object parameters when expanding a log entry in the log viewer
  logAutoExpandParams: boolean;

  // Theme setting: 'light', 'dark', or 'auto' (follows system preference)
  theme: "light" | "dark" | "auto";

  // Language setting: 'en', 'hu', or 'auto' (follows system preference)
  language: "en" | "hu" | "auto";

  // Leader profile update mode: controls when leader preferences are updated
  leaderProfileUpdateMode: "leaderPageOnly" | "uiChangesAlso" | "allSources";

  // Preference filter mode for the song list
  preferenceFilter: "all" | "preferred-only" | "show-ignored";

  // QR Code settings
  qrCodeInPreview: boolean;
  qrCodeX: number; // X position as percentage of image width (0–100), left edge of QR
  qrCodeY: number; // Y position as percentage of image height (0–100), top edge of QR
  qrCodeSizePercent: number; // Size as percentage of image height (5–50)
  showTextInPreview: boolean;
  showImageInPreview: boolean;

  // Update channel: "stable" uses latest.yml, "testing" uses the testing subfolder
  updateChannel: "stable" | "testing";

  // Customizable ChordPro editor styles for light and dark themes
  chordProStyles: ChordProStylesSettings;
}
