import type { Settings } from "../types";
import { getWebServerInterface, toWebServerConfig } from "./webServerBridge";

/**
 * Deliver settings to whatever backend bridges the current runtime exposes.
 *
 * Capability-detected (NOT "is electron"), so the SAME code path serves the full
 * view and the client view across every runtime — Electron, Android webview, and
 * plain-browser PWA — each of which exposes a different subset of bridges:
 *
 *  - `window.electronAPI` (Electron renderer, full OR embedded client view): the
 *    main-process `sync-settings` handler applies the webserver config AND the
 *    host-only effects (PPD session gate, powerSaveBlocker / keepAwake, update
 *    channel, HW-accel-on-startup pref, net-display re-encode). We use it
 *    EXCLUSIVELY here so the webserver config is not applied twice.
 *  - Otherwise the webserver bridge (`window.webServer` / native wire on Android)
 *    carries the web-facing subset, and a native `window.hostDevice` gets the
 *    host subset it understands.
 *
 * This is the single sync entry point for BOTH `SettingsContext` (full view) and
 * the client view's `saveSessionFeatureSetting` (which runs with no context).
 */
export function syncSettingsToBackend(settings: Settings): void {
  if (typeof window === "undefined") return;

  if (window.electronAPI?.syncSettings) {
    window.electronAPI.syncSettings(settings);
    return;
  }

  // Non-Electron: only push webserver config when the essential fields are present
  // (a standalone client view may persist only a toggle subset — don't clobber the
  // server config with undefineds).
  if (settings.webServerPort != null && settings.webServerPath != null && settings.longPollTimeout != null) {
    getWebServerInterface()?.sync({ kind: "config", config: toWebServerConfig(settings) });
  }

  syncHostSettings(settings);
}

/**
 * Push the host-only settings a native (Android) bridge understands. The PPD
 * session gate is not delivered here — on Android, hosting is driven explicitly by
 * start/stop (`advertiseNearby`), and capability gating handles whether it may
 * start; only Electron has a persistent "answer scans" gate (`setPpdSessionEnabled`,
 * applied via `electronAPI.syncSettings` above).
 */
function syncHostSettings(settings: Settings): void {
  const host = window.hostDevice;
  if (!host) return;
  try {
    host.keepScreenOn?.(!!settings.keepAwake);
  } catch {
    /* best-effort: host bridges may not implement every method */
  }
}
