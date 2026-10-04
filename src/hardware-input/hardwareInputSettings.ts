/**
 * Storage side of the hardware-control configuration: the single migration
 * entry point (full application and standalone client alike) and the cached read
 * used by the runtime. The settings store stays the low-level owner of
 * `pp-settings`; this module never keeps a second editable copy.
 */
import { migrateHardwareInput, type HardwareMigrationResult } from "../../common/hardware-input-migration";
import type { HardwareInputSettings } from "../../common/hardware-input";
import { readPersistedSettings, readPersistedSettingsText, writeHardwareLegacyBackup, writePersistedSettingsResult } from "../services/settingsStore";

export interface HardwareBootstrapResult extends HardwareMigrationResult {
  /** `true` durable, `false` in memory only (storage failed), `null` nothing had to be written. */
  persisted: boolean | null;
}

/**
 * Migrates the persisted legacy configuration once. A legacy migration first
 * stores the restore point, then writes the new configuration as ONE settings
 * patch. If either write fails the migrated data is still used in memory, but
 * the result says so and the legacy fields stay the stored truth.
 */
export function ensureHardwareInputMigrated(): HardwareBootstrapResult {
  const result = migrateHardwareInput(readPersistedSettings() as Record<string, unknown>);
  if (!result.patch) return { ...result, persisted: null };
  if (!result.backup || !writeHardwareLegacyBackup(result.backup)) return { ...result, persisted: false };
  const write = writePersistedSettingsResult(result.patch);
  return { ...result, persisted: write.persisted };
}

let cache: { text: string | null; result: HardwareMigrationResult } | null = null;

/** The configuration and its diagnostics as currently persisted (pure read, never writes). */
export function readHardwareInputState(): HardwareMigrationResult {
  const text = readPersistedSettingsText();
  if (cache && cache.text === text) return cache.result;
  const result = migrateHardwareInput(readPersistedSettings() as Record<string, unknown>);
  cache = { text, result };
  return result;
}

export function readHardwareInputSettings(): HardwareInputSettings {
  return readHardwareInputState().settings;
}

/**
 * The `hardwareInput` value a freshly loaded settings draft should carry, computed
 * from the RAW persisted object (before defaults are merged in). Data this build
 * cannot interpret (newer schema, unreadable value) is carried through untouched,
 * so saving the draft never destroys it.
 */
export function hardwareInputForLoadedSettings(loaded: Record<string, unknown>): HardwareInputSettings {
  const result = migrateHardwareInput(loaded);
  if (result.source === "future-schema" || result.source === "invalid") return loaded.hardwareInput as HardwareInputSettings;
  return result.settings;
}
