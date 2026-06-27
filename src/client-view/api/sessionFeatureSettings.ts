import type { Settings } from "../../types";
import { getWebServerInterface, toWebServerConfig } from "../../services/webServerBridge";
import type { SessionFeatureKey } from "./ClientApi";

export type SessionToggleSettings = Pick<Settings, SessionFeatureKey>;

export const DEFAULT_SESSION_TOGGLE_SETTINGS: SessionToggleSettings = {
  externalWebDisplayEnabled: false,
  iWebEnabled: true,
  ppdSessionEnabled: true,
};

export function readSessionToggleSettings(): SessionToggleSettings {
  try {
    const raw = window.localStorage?.getItem("pp-settings");
    const parsed = raw ? (JSON.parse(raw) as Partial<SessionToggleSettings>) : {};
    return {
      externalWebDisplayEnabled: parsed.externalWebDisplayEnabled ?? DEFAULT_SESSION_TOGGLE_SETTINGS.externalWebDisplayEnabled,
      iWebEnabled: parsed.iWebEnabled ?? DEFAULT_SESSION_TOGGLE_SETTINGS.iWebEnabled,
      ppdSessionEnabled: parsed.ppdSessionEnabled ?? DEFAULT_SESSION_TOGGLE_SETTINGS.ppdSessionEnabled,
    };
  } catch {
    return DEFAULT_SESSION_TOGGLE_SETTINGS;
  }
}

export function saveSessionFeatureSetting(key: SessionFeatureKey, value: boolean): SessionToggleSettings {
  let nextSettings: Partial<Settings> = {};
  try {
    const raw = window.localStorage?.getItem("pp-settings");
    nextSettings = raw ? (JSON.parse(raw) as Partial<Settings>) : {};
  } catch {
    nextSettings = {};
  }
  nextSettings = { ...nextSettings, [key]: value };
  try {
    window.localStorage?.setItem("pp-settings", JSON.stringify(nextSettings));
  } catch {
    /* storage is optional in embedded webviews */
  }
  window.dispatchEvent(new CustomEvent("pp-settings-changed"));
  if (nextSettings.webServerPort != null && nextSettings.webServerPath != null && nextSettings.longPollTimeout != null) {
    void getWebServerInterface()?.sync({ kind: "config", config: toWebServerConfig(nextSettings as Settings) });
  }
  return readSessionToggleSettings();
}
