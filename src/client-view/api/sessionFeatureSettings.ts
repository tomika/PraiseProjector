import type { ClientViewAutoScanMode, Settings } from "../../types";
import { readPersistedSettings, writePersistedSettings } from "../../services/settingsStore";
import { syncSettingsToBackend } from "../../services/settingsSync";
import type { ExternalSearchMode, SessionFeatureKey } from "./ClientApi";
import type { SessionKind } from "../../shared/SessionsForm";

export type SessionToggleSettings = Pick<Settings, SessionFeatureKey>;

export const DEFAULT_SESSION_TOGGLE_SETTINGS: SessionToggleSettings = {
  externalWebDisplayEnabled: false,
  iWebEnabled: true,
  ppdSessionEnabled: true,
};

export const DEFAULT_CLIENT_VIEW_AUTO_SCAN_SESSIONS: ClientViewAutoScanMode = "both";

const AUTO_SCAN_MODES: readonly ClientViewAutoScanMode[] = ["off", "web", "local", "both"];

/**
 * Coerce a persisted value into a {@link ClientViewAutoScanMode}. Tolerates the
 * legacy boolean shape (`true` → `"both"`, `false` → `"off"`) so settings saved
 * before this became an enum keep working, and falls back to the default for
 * anything unrecognised.
 */
function normalizeAutoScanMode(raw: unknown, fallback: ClientViewAutoScanMode = DEFAULT_CLIENT_VIEW_AUTO_SCAN_SESSIONS): ClientViewAutoScanMode {
  if (raw === true) return "both";
  if (raw === false) return "off";
  if (typeof raw === "string" && (AUTO_SCAN_MODES as readonly string[]).includes(raw)) {
    return raw as ClientViewAutoScanMode;
  }
  return fallback;
}

export function readSessionToggleSettings(): SessionToggleSettings {
  const parsed = readPersistedSettings();
  return {
    externalWebDisplayEnabled: parsed.externalWebDisplayEnabled ?? DEFAULT_SESSION_TOGGLE_SETTINGS.externalWebDisplayEnabled,
    iWebEnabled: parsed.iWebEnabled ?? DEFAULT_SESSION_TOGGLE_SETTINGS.iWebEnabled,
    ppdSessionEnabled: parsed.ppdSessionEnabled ?? DEFAULT_SESSION_TOGGLE_SETTINGS.ppdSessionEnabled,
  };
}

export function readClientViewAutoScanSessions(): ClientViewAutoScanMode {
  return normalizeAutoScanMode(readPersistedSettings().clientViewAutoScanSessions);
}

export const DEFAULT_CLIENT_VIEW_SESSIONS_FOUND_POPUP: ClientViewAutoScanMode = "local";

/**
 * Read the "auto-open the sessions dialog for these found source types" preference
 * (default `"local"`). Session types found outside this mask badge the sessions
 * button instead of popping the dialog — see {@link sessionKindMatchesMode}.
 */
export function readClientViewSessionsFoundPopup(): ClientViewAutoScanMode {
  return normalizeAutoScanMode(readPersistedSettings().clientViewSessionsFoundPopup, DEFAULT_CLIENT_VIEW_SESSIONS_FOUND_POPUP);
}

/**
 * Map the auto-scan preference to the {@link ExternalSearchMode} used by
 * `refreshSessions`, or `null` when startup scanning is disabled (`"off"`).
 */
export function autoScanExternalMode(mode: ClientViewAutoScanMode): ExternalSearchMode | null {
  switch (mode) {
    case "web":
      return "WEB";
    case "local":
      return "NEARBY";
    case "both":
      return "BOTH";
    case "off":
      return null;
  }
}

/**
 * Whether a discovered session's {@link SessionKind} falls within a
 * {@link ClientViewAutoScanMode} mask: `web` covers cloud (`online`) sessions,
 * `local` covers nearby PPD peers and LAN web clients, `both` covers all, and
 * `off` covers none. Used to decide whether a found session auto-opens the
 * Sessions dialog or merely badges the button.
 */
export function sessionKindMatchesMode(kind: SessionKind, mode: ClientViewAutoScanMode): boolean {
  switch (mode) {
    case "both":
      return true;
    case "web":
      return kind === "online";
    case "local":
      return kind === "ppd" || kind === "webclient";
    case "off":
      return false;
  }
}

/**
 * Persist one session feature toggle and push it to the backend. Goes through the
 * shared settings store (single writer of `pp-settings`, so the full view's
 * `SettingsContext` won't clobber it) and the shared, capability-detected sync
 * (so the toggle reaches the Electron udp host / webserver, not just localStorage).
 */
export function saveSessionFeatureSetting(key: SessionFeatureKey, value: boolean): SessionToggleSettings {
  const next = writePersistedSettings({ [key]: value });
  syncSettingsToBackend(next as Settings);
  return readSessionToggleSettings();
}
