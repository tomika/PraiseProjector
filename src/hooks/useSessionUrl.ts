import { useMemo } from "react";
import { useSettings } from "./useSettings";
import { useAuth } from "../contexts/AuthContext";
import { useOnlineSession } from "../contexts/OnlineSessionContext";
import { cloudApiHost } from "../config";
import { cloudApi } from "../../common/cloudApi";
import { Settings } from "../types";
import { qrCodeCacheService } from "../services/QRCodeCacheService";
import { isWebServerRuntimeAvailable } from "../services/webServerBridge";

export type SessionUrlMode =
  /** Local webserver URL when webserver runtime + iWebEnabled, otherwise cloud leader URL */
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
export function buildLocalUrl(settings: Partial<Settings> | null | undefined, forcedLocalHost?: boolean): string | null {
  if (!settings?.iWebEnabled) return null;
  const localhost = "127.0.0.1";
  const host = forcedLocalHost ? localhost : (settings.webServerDomainName || localhost).trim() || localhost;
  const port = settings.webServerPort && settings.webServerPort > 0 ? settings.webServerPort : 19740;
  const path = settings.webServerPath || "/";
  const normalizedPath = path.startsWith("/") ? path : `/${path}`;
  return `http://${host}:${port}${normalizedPath}`;
}

/**
 * Pure helper — normalize an API base or host to the public web root.
 */
export function normalizePublicWebRoot(baseUrl: string): string {
  return baseUrl.replace(/\/+$/, "").replace(/\/praiseprojector$/i, "");
}

/**
 * The web root the session URLs must point at: the SAME host the app actually talks
 * to, resolved at runtime (`cloudApi.getBaseUrl()` — set from Electron's
 * proxy-config.json, RestCore's config, or `cloudApiBaseUrl` in web mode). The
 * build-time `cloudApiHost` (VITE_CLOUD_API_HOST) is only a fallback for the window
 * before AuthContext has run. Using the build-time constant here would emit
 * production URLs while every request went to a local test server.
 */
function runtimeCloudBaseUrl(): string {
  return cloudApi.getBaseUrl() || cloudApiHost;
}

/**
 * Pure helper — build the cloud leader session URL.
 * Pass `baseUrl` to pin a specific host; omit it to follow the runtime cloud base.
 */
export function buildCloudUrl(sessionOwnerId: string, baseUrl?: string): string {
  const webRoot = normalizePublicWebRoot(baseUrl || runtimeCloudBaseUrl());
  return `${webRoot}/webapp/client-view.html?follow=${encodeURIComponent(sessionOwnerId)}`;
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
 *   - `"auto"` (default) — local webserver URL when running in a webserver-capable runtime with
 *     iWebEnabled, otherwise the cloud leader session URL.
 *   - `"local"` — local webserver URL only; returns null when iWebEnabled is false.
 *   - `"cloud"` — cloud leader session URL only.
 */
export function useSessionUrl(mode: SessionUrlMode = "auto"): string | null {
  const { settings } = useSettings();
  const { authStatus, user } = useAuth();
  const { guestSessionId, state } = useOnlineSession();
  const sessionOwnerId = authStatus === "authenticated" ? user?.leaderId : authStatus === "guest" ? guestSessionId : null;
  const cloudUrl = state.phase === "active" && sessionOwnerId ? buildCloudUrl(sessionOwnerId) : null;

  // INTENTIONAL: depend only on the specific settings fields used to build the URL,
  // not the whole `settings` object. Broadening would recompute (and re-render
  // dependents) on unrelated settings changes. The React Compiler advisory and
  // exhaustive-deps suggestion are both acceptable here.
  /* eslint-disable react-hooks/preserve-manual-memoization, react-hooks/exhaustive-deps */
  return useMemo(() => {
    const hasWebServerRuntime = isWebServerRuntimeAvailable();

    if (mode === "local") {
      return buildLocalUrl(settings);
    }

    if (mode === "cloud") {
      return cloudUrl;
    }

    // "auto": prefer local when available
    if (hasWebServerRuntime && settings?.iWebEnabled) {
      return buildLocalUrl(settings);
    }
    return cloudUrl;
  }, [mode, settings?.iWebEnabled, settings?.webServerDomainName, settings?.webServerPort, settings?.webServerPath, cloudUrl]);
  /* eslint-enable react-hooks/preserve-manual-memoization, react-hooks/exhaustive-deps */
}
