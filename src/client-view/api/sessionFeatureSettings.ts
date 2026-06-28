import type { Settings } from "../../types";
import { readPersistedSettings, writePersistedSettings } from "../../services/settingsStore";
import { syncSettingsToBackend } from "../../services/settingsSync";
import type { SessionFeatureKey } from "./ClientApi";

export type SessionToggleSettings = Pick<Settings, SessionFeatureKey>;

export const DEFAULT_SESSION_TOGGLE_SETTINGS: SessionToggleSettings = {
  externalWebDisplayEnabled: false,
  iWebEnabled: true,
  ppdSessionEnabled: true,
};

export function readSessionToggleSettings(): SessionToggleSettings {
  const parsed = readPersistedSettings();
  return {
    externalWebDisplayEnabled: parsed.externalWebDisplayEnabled ?? DEFAULT_SESSION_TOGGLE_SETTINGS.externalWebDisplayEnabled,
    iWebEnabled: parsed.iWebEnabled ?? DEFAULT_SESSION_TOGGLE_SETTINGS.iWebEnabled,
    ppdSessionEnabled: parsed.ppdSessionEnabled ?? DEFAULT_SESSION_TOGGLE_SETTINGS.ppdSessionEnabled,
  };
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
