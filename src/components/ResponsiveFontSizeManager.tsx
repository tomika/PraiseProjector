import { useResponsiveFontSize } from "../hooks/useResponsiveFontSize";

/**
 * Component that manages responsive font sizing globally
 * Must be placed inside SettingsProvider
 */
export const ResponsiveFontSizeManager: React.FC = () => {
  // This hook applies the font size to document.documentElement
  useResponsiveFontSize();

  // This component doesn't render anything
  return null;
};
