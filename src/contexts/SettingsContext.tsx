import React, { createContext, useContext, useState, useEffect, useCallback } from "react";
import { Settings } from "../types";

const storeApi = {
  loadSettings: async (): Promise<Settings> => {
    const settings = localStorage.getItem("pp-settings");
    return settings ? JSON.parse(settings) : Promise.reject("No settings found");
  },
  saveSettings: async (settings: Settings): Promise<void> => {
    // Preserve theme and language settings that are managed by other contexts
    const existingSettings = localStorage.getItem("pp-settings");
    const mergedSettings = { ...settings };
    if (existingSettings) {
      try {
        const parsed = JSON.parse(existingSettings);
        if (parsed.theme !== undefined) {
          mergedSettings.theme = parsed.theme;
        }
        if (parsed.language !== undefined) {
          mergedSettings.language = parsed.language;
        }
      } catch {
        // Ignore parse errors
      }
    }
    localStorage.setItem("pp-settings", JSON.stringify(mergedSettings));
  },
};

interface SettingsContextType {
  settings: Settings | null;
  initialSettings: Settings | null;
  updateSetting: <K extends keyof Settings>(key: K, value: Settings[K]) => void;
  updateSettingWithAutoSave: <K extends keyof Settings>(key: K, value: Settings[K]) => void;
  resetSettingsToDefaults: () => void;
  saveSettings: () => Promise<void>;
  revertSettings: () => Promise<void>;
  syncToBackend: () => void;
}

const SettingsContext = createContext<SettingsContextType | undefined>(undefined);

export const SettingsProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const [settings, setSettings] = useState<Settings | null>(null);
  const [initialSettings, setInitialSettings] = useState<Settings | null>(null);

  const createDefaultSettings = useCallback((): Settings => {
    return {
      displayBorderRect: { left: 0, top: 0, width: 0, height: 0 },
      // Display/Preview settings (matching C# Settings.settings defaults)
      displayFontName: "Time New Roman",
      displayFontSize: 16,
      displayFontAlign: "center",
      displayFontBold: false,
      displayFontItalic: false,
      displayFontUnderline: false,
      displayTextShadowEnabled: true,
      displayTextShadowOffset: 2,
      displayTextShadowBlur: 4,
      displayTextShadowColor: "#000000",
      displayTextShadowOpacity: 0.8,
      backgroundColor: "#000000", // Black
      textColor: "#ffffff", // White
      textBorderColor: "#000000", // Empty in C# = black
      textBorderWidth: 0,
      message: "",

      useNonSplittingWords: true, // C# default: True
      realSectionPreview: false,
      previewFontInSections: false,
      nonSplittingWordList: ["Isten", "Jézus", "Krisztus", "Úr", "Ur", "Fiú", "Bárány"], // C# defaults
      hideChordsInReadonlyEditor: false,
      sectionHighlightInEditor: false,
      sectionSelByEditorLineSel: false,
      sectionSelByEditorDblclk: false,
      keepAwake: false,
      showTooltips: true,
      pictureFolder: "",
      selectedBackgroundImageId: null,
      backgroundImageFit: "touchInner",
      importImageUseCompression: false,
      importImageUseResize: false,
      importImageResolutionWidth: 1920,
      importImageResolutionHeight: 1080,
      importImageResolutionPreset: "1920x1080",
      importImageFit: "touchInner",
      importImageJpegQuality: 85,
      baseFontSize: 16, // Base font size for UI scaling
      webServerPath: "/",
      webServerPort: 19740,
      webServerDomainName: "",
      webServerAcceptLanClientsOnly: true,
      iWebEnabled: true,
      externalWebDisplayEnabled: false,
      registerLocalServer: true, // C# default: True
      longPollTimeout: 120, // C# default: 120, not 30
      netDisplayResolution: "1920x1080",
      netDisplayTransitionType: "linear",
      netDisplayUseJpegCompression: true,
      netDisplayJpegQuality: 70,
      netDisplayImageScale: 1,
      netDisplayTransient: 0,
      useTextSimilarities: true, // C# default: True

      // Search settings
      searchMaxResults: 0, // 0 = unlimited results
      traditionalSearchCaseSensitive: false,
      traditionalSearchWholeWords: false,

      // Search method and Typesense settings
      searchMethod: "traditional",
      typesenseUrl: "http://127.0.0.1:8108",
      typesenseApiKey: "",

      useFontAwesomeIcons: false,
      fontSizeMode: "auto-resolution-dpi", // Default to auto-resolution-dpi for better scaling on high-DPI displays
      allClientsCanUseLeaderMode: true, // C# default: True
      leaderModeClients: [],
      printingBB: false,
      printingMetaData: true, // C# default: True
      printingSuperScript: false,
      printingTitle: true, // C# default: True
      printingMollMode: "Am", // C# default: 'Am', not 'Normal'
      printingSectionLabels: "Full",
      minWebRenderSize: { width: 768, height: 576 }, // C# default: 768, 576
      useSectionColoring: true,
      verseSectionColor: "#b4feb6", // RGB(180, 254, 182)
      chorusSectionColor: "#fcafaf", // RGB(252, 175, 175)
      bridgeSectionColor: "#ffffbc", // RGB(255, 255, 188)
      checkSectionsProjectable: true,
      contentBasedSections: true, // C# default: true
      projectInstructions: false, // Default to false (don't use instructions by default)
      displayFaultThreshold: 10, // C# default: 10 pixels tolerance
      displayAllowFontSizeReduction: true,
      displayCroppedTextBgColor: "#de9191", // RGB(222, 145, 145)
      displayShrinkedTextBgColor: "#fffa9e", // RGB(255, 250, 158)
      displayMinimumFontSize: 0, // C# default: 0, not 12
      displayMinimumFontSizePercent: 50, // C# default: 70, but 50 for better testing
      displayPlaylistUpdateInterval: 100,
      displayShowFontSizeReduction: "BOTH",
      selectedLeader: undefined,
      defaultChordSystem: "G", // German chord system by default
      displayMonitorId: "",
      syncDeclineTimeoutMinutes: 15,
      serverPeekIntervalMinutes: 60,
      logLevel: 3, // Error level by default (0=Debug, 1=Info, 2=Warn, 3=Error, 4=None)
      logAutoExpandParams: true, // Auto-expand object params when expanding a log entry
      theme: "auto", // Auto-detect from system
      language: "auto", // Auto-detect from system
      leaderProfileUpdateMode: "allSources", // Allow profile updates from all sources by default
      preferenceFilter: "all" as const, // Show all songs (excluding ignored) by default
      // QR Code settings
      qrCodeInPreview: false, // Show QR code in preview by default
      qrCodeX: 85, // QR code X position (% of image width)
      qrCodeY: 82, // QR code Y position (% of image height)
      qrCodeSizePercent: 15, // QR code size (% of image height)
      showTextInPreview: true,
      showImageInPreview: true,
      updateChannel: "stable",
    };
  }, []);

  useEffect(() => {
    const defaultSettings = createDefaultSettings();

    storeApi
      .loadSettings()
      .then((loadedSettings) => {
        // Merge defaults with loaded settings so new settings get their default values
        const loaded = loadedSettings as Partial<Settings>;
        const merged = { ...defaultSettings, ...loaded };
        if (merged.searchMethod !== "typesense") merged.searchMethod = "traditional";
        // Migrate old showPreferredOnly boolean to preferenceFilter string
        const raw = loadedSettings as unknown as Record<string, unknown>;
        if (!raw.preferenceFilter && raw.showPreferredOnly === true) {
          merged.preferenceFilter = "preferred-only";
        }
        setSettings(merged);
        setInitialSettings(merged);
      })
      .catch(() => {
        setSettings(defaultSettings);
        setInitialSettings(defaultSettings);
      });
  }, [createDefaultSettings]);

  // Listen for theme and language changes from other contexts and update our settings
  useEffect(() => {
    const handleThemeChange = (event: CustomEvent) => {
      const { themeSetting } = event.detail;
      setSettings((prev) => (prev ? { ...prev, theme: themeSetting } : null));
    };

    const handleLanguageChange = (event: CustomEvent) => {
      const { languageSetting } = event.detail;
      setSettings((prev) => (prev ? { ...prev, language: languageSetting } : null));
    };

    window.addEventListener("pp-theme-changed", handleThemeChange as EventListener);
    window.addEventListener("pp-language-changed", handleLanguageChange as EventListener);

    return () => {
      window.removeEventListener("pp-theme-changed", handleThemeChange as EventListener);
      window.removeEventListener("pp-language-changed", handleLanguageChange as EventListener);
    };
  }, []);

  const saveSettings = async () => {
    if (settings) {
      await storeApi.saveSettings(settings);
      setInitialSettings(settings);
      // Dispatch custom event to notify components
      window.dispatchEvent(new CustomEvent("pp-settings-changed"));
      // Sync to backend after saving
      syncToBackend();
    }
  };

  const revertSettings = async () => {
    if (initialSettings) {
      const selectedLeader = settings?.selectedLeader;
      const nextSettings = {
        ...initialSettings,
        selectedLeader,
      };
      setSettings(nextSettings);
      // Also save the reverted settings to localStorage
      await storeApi.saveSettings(nextSettings);
    }
  };

  const resetSettingsToDefaults = useCallback(() => {
    setSettings(createDefaultSettings());
  }, [createDefaultSettings]);

  // Sync current settings to backend via IPC
  const syncToBackend = () => {
    if (settings && window.electronAPI?.syncSettings) {
      window.electronAPI.syncSettings(settings);
    }
  };

  // Update setting without auto-save (for SettingsForm - save only on Save button click)
  const updateSetting = useCallback(<K extends keyof Settings>(key: K, value: Settings[K]) => {
    setSettings((prev) => (prev ? { ...prev, [key]: value } : null));
  }, []);

  // Update setting with immediate auto-save (for Format panel and similar UI controls)
  const updateSettingWithAutoSave = useCallback(<K extends keyof Settings>(key: K, value: Settings[K]) => {
    setSettings((prev) => {
      if (!prev) return null;
      const newSettings = { ...prev, [key]: value };
      // Sync immediately so main process reacts to channel changes without waiting for disk persistence.
      if (window.electronAPI?.syncSettings) {
        window.electronAPI.syncSettings(newSettings);
      }
      // Auto-save settings immediately (matching C# behavior for format panel)
      storeApi
        .saveSettings(newSettings)
        .then(() => {
          // Keep cancel baseline aligned with the latest persisted settings.
          setInitialSettings(newSettings);
          // Dispatch custom event to notify components
          window.dispatchEvent(new CustomEvent("pp-settings-changed"));
        })
        .catch((error) => {
          console.error("General", `Failed to auto-save setting '${key}'`, error);
        });
      return newSettings;
    });
  }, []);

  return (
    <SettingsContext.Provider
      value={{
        settings,
        initialSettings,
        updateSetting,
        updateSettingWithAutoSave,
        resetSettingsToDefaults,
        saveSettings,
        revertSettings,
        syncToBackend,
      }}
    >
      {children}
    </SettingsContext.Provider>
  );
};

export const useSettings = () => {
  const context = useContext(SettingsContext);
  if (context === undefined) {
    throw new Error("useSettings must be used within a SettingsProvider");
  }
  return context;
};
