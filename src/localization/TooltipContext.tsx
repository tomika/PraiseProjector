import React, { useContext } from "react";
import { hotStableContext } from "../utils/hotStableContext";
import { useLocalization, Language } from "./LocalizationContext";
import { useSettings } from "../hooks/useSettings";

// Import tooltip files
import enTooltips from "./tooltips.en.json";
import huTooltips from "./tooltips.hu.json";

// Type for tooltip keys
export type TooltipKey = keyof typeof enTooltips;

// Available tooltip translations
const tooltips: Record<Language, typeof enTooltips> = {
  en: enTooltips,
  hu: huTooltips,
};

interface TooltipContextType {
  getTooltip: (key: TooltipKey) => string | undefined;
  tt: (key: TooltipKey) => string | undefined; // Shorter alias
}

const TooltipContext = hotStableContext<TooltipContextType | undefined>(import.meta.hot, "tooltipContext", undefined);

export const TooltipProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const { language } = useLocalization();
  const { settings } = useSettings();

  const getTooltip = (key: TooltipKey): string | undefined => {
    // Respect the showTooltips setting
    if (settings && !settings.showTooltips) return undefined;
    const tooltip = tooltips[language][key] || tooltips.en[key] || key;
    // Remove _comment entries
    return tooltip;
  };

  // Short alias for getTooltip
  const tt = getTooltip;

  return <TooltipContext.Provider value={{ getTooltip, tt }}>{children}</TooltipContext.Provider>;
};

// Hook to use tooltips
export const useTooltips = () => {
  const context = useContext(TooltipContext);
  if (!context) {
    throw new Error("useTooltips must be used within a TooltipProvider");
  }
  return context;
};
