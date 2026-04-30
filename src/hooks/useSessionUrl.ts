import { useMemo } from "react";
import { useSettings } from "./useSettings";
import { useLeader } from "../contexts/LeaderContext";
import { cloudApiHost } from "../config";
import { Settings } from "../types";
import { qrCodeCacheService } from "../services/QRCodeCacheService";

export type SessionUrlMode =
  /** Local webserver URL when Electron + iWebEnabled, otherwise cloud leader URL */
  | "auto"
  /** Local webserver URL only — null when iWebEnabled is false */
  | "local"
  /** Cloud leader session URL only */
  | "cloud";

/**
 * Pure helper — build the local webserver URL from settings.
 * Returns null when iWebEnabled is false.
 * Exported so components that receive settings as props (e.g. WebServerSettings)
 * can use it without needing the hook.
 */
export function buildLocalUrl(settings: Settings | null | undefined, forcedLocalHost?: boolean): string | null {
  if (!settings?.iWebEnabled) return null;
  const localhost = "127.0.0.1";
  const host = forcedLocalHost ? localhost : (settings.webServerDomainName || localhost).trim() || localhost;
  const port = settings.webServerPort && settings.webServerPort > 0 ? settings.webServerPort : 19740;
  const path = settings.webServerPath || "/";
  const normalizedPath = path.startsWith("/") ? path : `/${path}`;
  return `http://${host}:${port}${normalizedPath}`;
}

/**
 * Pure helper — build the cloud leader session URL.
 */
export function buildCloudUrl(leaderId: string): string {
  return `${cloudApiHost}/view_session?leader=${encodeURIComponent(leaderId)}`;
}

/**
 * Generate a QR code as an SVG string for the given URL.
 * Returns the raw SVG markup that can be used with dangerouslySetInnerHTML
 * or injected into a canvas.
 */
export function generateQRCodeSVG(url: string, size: number = 128, level: "L" | "M" | "Q" | "H" = "M"): string {
  return qrCodeCacheService.getSVGMarkup(url, size, level);
}

/**
 * Returns the session URL for this device.
 *
 * @param mode
 *   - `"auto"` (default) — local webserver URL when running in Electron with
 *     iWebEnabled, otherwise the cloud leader session URL.
 *   - `"local"` — local webserver URL only; returns null when iWebEnabled is false.
 *   - `"cloud"` — cloud leader session URL only.
 */
export function useSessionUrl(mode: SessionUrlMode = "auto"): string | null {
  const { settings } = useSettings();
  const { guestLeaderId } = useLeader();

  // INTENTIONAL: depend only on the specific settings fields used to build the URL,
  // not the whole `settings` object. Broadening would recompute (and re-render
  // dependents) on unrelated settings changes. The React Compiler advisory and
  // exhaustive-deps suggestion are both acceptable here.
  /* eslint-disable react-hooks/preserve-manual-memoization, react-hooks/exhaustive-deps */
  return useMemo(() => {
    const isElectron = typeof window !== "undefined" && !!window.electronAPI;

    if (mode === "local") {
      return buildLocalUrl(settings);
    }

    if (mode === "cloud") {
      return buildCloudUrl(guestLeaderId);
    }

    // "auto": prefer local when available
    if (isElectron && settings?.iWebEnabled) {
      return buildLocalUrl(settings);
    }
    return buildCloudUrl(guestLeaderId);
  }, [mode, settings?.iWebEnabled, settings?.webServerDomainName, settings?.webServerPort, settings?.webServerPath, guestLeaderId]);
  /* eslint-enable react-hooks/preserve-manual-memoization, react-hooks/exhaustive-deps */
}
