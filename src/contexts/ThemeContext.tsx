import React, { createContext, useContext, useState, useEffect } from "react";

// Type for theme modes
export type Theme = "light" | "dark";
export type ThemeSetting = Theme | "auto";

interface ThemeContextType {
  theme: Theme; // The actual computed theme
  themeSetting: ThemeSetting; // The user's preference
  setThemeSetting: (theme: ThemeSetting) => void;
}

const ThemeContext = createContext<ThemeContextType | undefined>(undefined);

// Settings key - theme is stored inside pp-settings
const SETTINGS_KEY = "pp-settings";

// Helper to get theme from pp-settings
function getThemeFromSettings(): ThemeSetting {
  try {
    const settings = localStorage.getItem(SETTINGS_KEY);
    if (settings) {
      const parsed = JSON.parse(settings);
      if (parsed.theme === "light" || parsed.theme === "dark" || parsed.theme === "auto") {
        return parsed.theme;
      }
    }
  } catch {
    // Ignore parse errors
  }
  return "auto";
}

// Helper to save theme to pp-settings
function saveThemeToSettings(theme: ThemeSetting): void {
  try {
    const settings = localStorage.getItem(SETTINGS_KEY);
    const parsed = settings ? JSON.parse(settings) : {};
    parsed.theme = theme;
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(parsed));
  } catch {
    // Ignore errors
  }
}

// Detect system preference
function getSystemTheme(): Theme {
  if (typeof window !== "undefined" && window.matchMedia) {
    return window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
  }
  return "light";
}

export const ThemeProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  // Load theme setting from pp-settings or default to 'auto'
  const [themeSetting, setThemeSettingState] = useState<ThemeSetting>(() => {
    return getThemeFromSettings();
  });

  // Compute the actual theme to use
  const [theme, setTheme] = useState<Theme>(() => {
    const setting = getThemeFromSettings();
    if (setting === "light" || setting === "dark") {
      return setting;
    }
    return getSystemTheme();
  });

  // Update actual theme when setting changes or system preference changes
  useEffect(() => {
    const updateTheme = () => {
      if (themeSetting === "auto") {
        setTheme(getSystemTheme());
      } else {
        setTheme(themeSetting);
      }
    };

    updateTheme();

    // Listen for system theme changes
    const mediaQuery = window.matchMedia("(prefers-color-scheme: dark)");
    const handleChange = () => {
      if (themeSetting === "auto") {
        setTheme(getSystemTheme());
      }
    };

    mediaQuery.addEventListener("change", handleChange);
    return () => mediaQuery.removeEventListener("change", handleChange);
  }, [themeSetting]);

  // Listen for settings changes from other sources (e.g., SettingsForm, other windows)
  useEffect(() => {
    const handleSettingsChange = () => {
      const newSetting = getThemeFromSettings();
      if (newSetting !== themeSetting) {
        setThemeSettingState(newSetting);
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
  }, [themeSetting]);

  // Apply theme to document
  useEffect(() => {
    document.documentElement.setAttribute("data-theme", theme);
    document.documentElement.style.colorScheme = theme;
    // Also set on body for Bootstrap compatibility
    document.body.setAttribute("data-bs-theme", theme);
  }, [theme]);

  // Save theme preference when it changes and dispatch event
  useEffect(() => {
    saveThemeToSettings(themeSetting);
    // Dispatch event for components that need to react to theme changes
    window.dispatchEvent(new CustomEvent("pp-theme-changed", { detail: { theme, themeSetting } }));
  }, [theme, themeSetting]);

  const setThemeSetting = (newTheme: ThemeSetting) => {
    setThemeSettingState(newTheme);
  };

  return <ThemeContext.Provider value={{ theme, themeSetting, setThemeSetting }}>{children}</ThemeContext.Provider>;
};

// Hook to use theme
export const useTheme = () => {
  const context = useContext(ThemeContext);
  if (!context) {
    throw new Error("useTheme must be used within a ThemeProvider");
  }
  return context;
};
