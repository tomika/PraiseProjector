import { databaseStorage, type StorageMode, type StoragePolicy } from "../../db-common/DatabaseStorage";
import type { ElectronHostDevice } from "../types/hostDevice";
import { canAutomaticallyUpgradeAndroidStorage } from "./androidStorageUpgrade";

/**
 * The one storage decision every entry point that opens the local song
 * database makes (the full app's StorageChoiceGate, the legacy browser client).
 */
function hostDevice(): ElectronHostDevice | undefined {
  return (window as unknown as { hostDevice?: ElectronHostDevice }).hostDevice;
}

/** A browser/PWA converts without asking; Electron keeps the explicit startup
 * choice. Android never asks: it converts like the PWA once its factory
 * frontend reads the new format (see androidStorageUpgrade), and until then
 * keeps the old format, which every frontend it can fall back to reads. */
export async function storageRuntimePolicy(): Promise<StoragePolicy> {
  const host = hostDevice();
  if (!host) return "automatic";
  if ((window as unknown as { electronAPI?: unknown }).electronAPI) return "choice";
  // Data already in the new format stays in it under either Android policy, so the
  // bridge (synchronous native file reads that block the page) is not asked.
  if ((await databaseStorage.getChoice()) === "partitioned") return "automatic";
  return (await canAutomaticallyUpgradeAndroidStorage(host)) ? "automatic" : "legacy";
}

/** Prepares storage as decided by storageRuntimePolicy. Null: the explicit
 * choice is still needed. */
export function prepareStorageForThisRuntime(policy: StoragePolicy): Promise<StorageMode | null> {
  return databaseStorage.prepareForRuntime(policy);
}
