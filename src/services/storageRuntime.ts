import { databaseStorage, type StorageMode } from "../../db-common/DatabaseStorage";
import type { ElectronHostDevice } from "../types/hostDevice";
import { canAutomaticallyUpgradeAndroidStorage } from "./androidStorageUpgrade";

/**
 * The one storage decision every entry point that opens the local song
 * database makes (the full app's StorageChoiceGate, the legacy browser client).
 */
function hostDevice(): ElectronHostDevice | undefined {
  return (window as unknown as { hostDevice?: ElectronHostDevice }).hostDevice;
}

/** A browser/PWA always converts without asking; a native host only as an
 * eligible Android release (see androidStorageUpgrade). */
export async function isAutomaticStorageRuntime(): Promise<boolean> {
  const host = hostDevice();
  return !host || (await canAutomaticallyUpgradeAndroidStorage(host, !!(window as unknown as { electronAPI?: unknown }).electronAPI));
}

/**
 * Prepares storage as decided by isAutomaticStorageRuntime. Null: the explicit
 * choice is still needed. An eligible Android release respects a "keep the old
 * storage" choice made in this very app version (the dialog can appear when the
 * bridge answers too slowly); a later version upgrades it.
 */
export function prepareStorageForThisRuntime(automatic: boolean): Promise<StorageMode | null> {
  return databaseStorage.prepareForRuntime(!automatic, undefined, { respectLegacyDecision: automatic && !!hostDevice() });
}
