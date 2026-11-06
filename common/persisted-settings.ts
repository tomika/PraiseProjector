/**
 * Raw read access to the persisted `pp-settings` blob.
 *
 * `src/services/settingsStore.ts` owns the typed read/write API; this storage-level
 * half lives in `common/` so that modules which must not depend on `src/` (the
 * `chordpro/` renderer, for example) read the same key the same way.
 */
export const PERSISTED_SETTINGS_KEY = "pp-settings";

/** The raw persisted `pp-settings` text (cache key for derived reads). */
export function readPersistedSettingsText(): string | null {
  try {
    return typeof window !== "undefined" ? (window.localStorage?.getItem(PERSISTED_SETTINGS_KEY) ?? null) : null;
  } catch {
    return null;
  }
}
