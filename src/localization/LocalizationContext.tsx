import React, { createContext, useContext, useState, useEffect, useRef } from "react";

// Import language files
import enStrings from "./strings.en.json";
import huStrings from "./strings.hu.json";

// Type for available languages
export type Language = "en" | "hu";
export type LanguageSetting = Language | "auto";

// Type for string keys
export type StringKey = keyof typeof enStrings;

// Available translations
const translations: Record<Language, typeof enStrings> = {
  en: enStrings,
  hu: huStrings,
};

// Settings key - language is stored inside pp-settings
const SETTINGS_KEY = "pp-settings";

// Helper to get language from pp-settings
function getLanguageFromSettings(): LanguageSetting {
  try {
    const settings = localStorage.getItem(SETTINGS_KEY);
    if (settings) {
      const parsed = JSON.parse(settings);
      if (parsed.language === "hu" || parsed.language === "en" || parsed.language === "auto") {
        return parsed.language;
      }
    }
  } catch {
    // Ignore parse errors
  }
  return "auto";
}

// Helper to save language to pp-settings
function saveLanguageToSettings(language: LanguageSetting): void {
  try {
    const settings = localStorage.getItem(SETTINGS_KEY);
    const parsed = settings ? JSON.parse(settings) : {};
    parsed.language = language;
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(parsed));
  } catch {
    // Ignore errors
  }
}

// Detect system language
function detectSystemLanguage(): Language {
  const systemLang = navigator.language?.toLowerCase() || "en";
  // Check if system language starts with 'hu' (Hungarian)
  if (systemLang.startsWith("hu")) {
    return "hu";
  }
  return "en";
}

interface LocalizationContextType {
  language: Language;
  languageSetting: LanguageSetting;
  setLanguageSetting: (lang: LanguageSetting) => void;
  getString: (key: StringKey) => string;
  t: (key: StringKey) => string; // Shorter alias
}

const LocalizationContext = createContext<LocalizationContextType | undefined>(undefined);

export const LocalizationProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  // Load language setting from pp-settings or default to 'auto'
  const [languageSetting, setLanguageSettingState] = useState<LanguageSetting>(() => {
    return getLanguageFromSettings();
  });

  // Track whether string tables have already been sent to main process.
  const locStringsSent = useRef(false);

  // Derive the actual language from user setting.
  const language: Language = languageSetting === "auto" ? detectSystemLanguage() : languageSetting;

  // Listen for settings changes from other sources (e.g., SettingsForm, other windows)
  useEffect(() => {
    const handleSettingsChange = () => {
      const newSetting = getLanguageFromSettings();
      if (newSetting !== languageSetting) {
        setLanguageSettingState(newSetting);
      }
    };

    // Listen for pp-settings-changed event
    window.addEventListener("pp-settings-changed", handleSettingsChange);

    // Listen for storage changes from other windows
    const handleStorageChange = (event: StorageEvent) => {
      if (event.key === SETTINGS_KEY) {
        handleSettingsChange();
      }
    };
    window.addEventListener("storage", handleStorageChange);

    return () => {
      window.removeEventListener("pp-settings-changed", handleSettingsChange);
      window.removeEventListener("storage", handleStorageChange);
    };
  }, [languageSetting]);

  // Save language preference when it changes
  useEffect(() => {
    saveLanguageToSettings(languageSetting);
    // Dispatch event for components that need to react to language changes
    window.dispatchEvent(new CustomEvent("pp-language-changed", { detail: { language, languageSetting } }));

    // Keep Electron main process in sync. Strings are sent only on the first call;
    // subsequent calls (language change) send language only.
    if (window.electronAPI?.updateLocalization) {
      const payload: { language: "en" | "hu"; strings?: typeof translations } = { language };
      if (!locStringsSent.current) {
        payload.strings = translations;
        locStringsSent.current = true;
      }
      window.electronAPI.updateLocalization(payload);
    }
  }, [language, languageSetting]);

  const setLanguageSetting = (lang: LanguageSetting) => {
    setLanguageSettingState(lang);
  };

  const getString = (key: StringKey): string => {
    return translations[language][key] || translations.en[key] || key;
  };

  // Short alias for getString
  const t = getString;

  return (
    <LocalizationContext.Provider value={{ language, languageSetting, setLanguageSetting, getString, t }}>{children}</LocalizationContext.Provider>
  );
};

// Hook to use localization
export const useLocalization = () => {
  const context = useContext(LocalizationContext);
  if (!context) {
    throw new Error("useLocalization must be used within a LocalizationProvider");
  }
  return context;
};
