import type { Settings } from "../types";

/**
 * Single low-level owner of the persisted `pp-settings` blob.
 *
 * The app has TWO frontends — the full view (wrapped in `SettingsContext`) and the
 * new client view (which, when booted standalone via `client-view.tsx`, has NO
 * `SettingsContext` at all). Both, plus assorted non-React code (`DirectClientApi`,
 * `RestCore`), read and write the same `pp-settings` key, so the source of truth has
 * to be a plain module — not React state. `SettingsContext` is a *consumer* of this
 * store (it re-reads on the change event), not its authority.
 */

const SETTINGS_KEY = "pp-settings";

/** Settings keys that can be written from outside `SettingsContext` (the session
 *  hub's feature toggles). `SettingsContext` re-reads exactly these on the change
 *  event so a client-view toggle is not clobbered by a later full-view save. */
export const SESSION_TOGGLE_KEYS = ["externalWebDisplayEnabled", "iWebEnabled", "ppdSessionEnabled"] as const;

/** Read the persisted settings object (raw, NOT merged with defaults). Returns an
 *  empty object when nothing is stored or storage is unavailable (embedded webviews). */
export function readPersistedSettings(): Partial<Settings> {
  try {
    const raw = typeof window !== "undefined" ? window.localStorage?.getItem(SETTINGS_KEY) : null;
    return raw ? (JSON.parse(raw) as Partial<Settings>) : {};
  } catch {
    return {};
  }
}

/**
 * The single low-level writer for `pp-settings`: merge `patch` into the persisted
 * object, persist it, and notify listeners via the `pp-settings-changed` event.
 * Returns the merged object. Safe to call without React / `SettingsContext`, so the
 * standalone client view and the full view share one source of truth.
 */
export function writePersistedSettings(patch: Partial<Settings>): Partial<Settings> {
  const next = { ...readPersistedSettings(), ...patch };
  try {
    window.localStorage?.setItem(SETTINGS_KEY, JSON.stringify(next));
  } catch {
    /* storage is optional in embedded webviews */
  }
  if (typeof window !== "undefined") window.dispatchEvent(new CustomEvent("pp-settings-changed"));
  return next;
}

/** The light/dark theme preference, stored under `theme` in the `pp-settings`
 *  blob. It is shared by BOTH frontends — the full view (`ThemeContext`) and the
 *  client view — so the choice never diverges between them. */
export type ThemeSetting = Settings["theme"];

/** Read the shared theme preference, defaulting to "auto" when unset or invalid. */
export function readThemeSetting(): ThemeSetting {
  const { theme } = readPersistedSettings();
  return theme === "light" || theme === "dark" || theme === "auto" ? theme : "auto";
}

/** Write the shared theme preference (notifies listeners via `pp-settings-changed`). */
export function writeThemeSetting(theme: ThemeSetting): void {
  writePersistedSettings({ theme });
}
