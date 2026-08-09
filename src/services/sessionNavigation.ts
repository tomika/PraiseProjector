/**
 * Opening a discovered LAN session's web URL (the "webclient" row of the sessions hub).
 *
 * In a browser or on the Electron desktop a session is a SECOND surface: it opens in
 * its own window/tab and the app it was launched from stays where it is.
 *
 * The Android shell has no tabs. Its WebView used to answer `window.open` itself —
 * multiple windows were unsupported, so the request simply became a navigation and the
 * session loaded in place. Since the frontend became a native-managed bundle the host
 * WebView supports auxiliary windows (`setSupportMultipleWindows(true)`), and
 * `MainActivity.routeAuxiliaryWindow` hands every popup that is not a local `/webapp/`
 * URL to the system browser. A LAN session is not an unrelated web link — it is this
 * app following another host — so on that shell we navigate the WebView itself, which
 * is what the legacy client's session selector did (`client/praiseprojector.ts`).
 */

import { translate } from "../localization/LocalizationContext";

/** Legacy `hostConnectTimeoutSeconds` default (common/settings.ts) for the host's
 *  navigation watchdog. The new Settings model has no such key. */
const HOST_CONNECT_TIMEOUT_MS = 15_000;

/**
 * True in a native WebView shell (Android). `hostDevice` alone is not enough: the
 * Electron renderer exposes the same bridge, but it has real windows and its own
 * `window.open` handler, so it must keep the popup behaviour.
 */
function isNativeWebViewShell(): boolean {
  return typeof window !== "undefined" && !!window.hostDevice && !window.electronAPI;
}

/** Host part of a session URL — the short label the legacy client put in its toast. */
function sessionLabel(url: string): string {
  return url.replace(/^(?:https?|nrb|udp):\/\/([^:/]+)(?::[0-9]+)?(?:\/.*)?$/, (_full, host: string) => host);
}

/**
 * Open the web client of a discovered LAN session: in place on a native shell,
 * in a new window/tab everywhere else.
 */
export function openLanSessionUrl(url: string): void {
  if (typeof window === "undefined") return;

  if (!isNativeWebViewShell()) {
    window.open(url, "_blank");
    return;
  }

  // Arm the host's navigation watchdog BEFORE leaving the local bundle: an offer for a
  // host that has since gone away would otherwise strand the shell on a native error
  // page. The session page disarms it by reporting its boot (services/webAppLaunchReport),
  // and a timeout toasts and returns to the bundled home page.
  void window.hostDevice?.startNavigationTimeout?.(HOST_CONNECT_TIMEOUT_MS, translate("SessionConnectFailed").replace("{0}", sessionLabel(url)));
  window.location.assign(url);
}
