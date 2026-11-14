import type { ElectronHostDevice } from "../types/hostDevice";

/** The first release whose frontend reads and writes the partitioned format. */
const PARTITIONED_STORAGE_VERSION = [2, 0, 94];

/** `x.y.z`, optionally followed by a build label: `2.0.94-pp-debug` (the debug
 * APK's version name) counts as 2.0.94. The label names a build flavour of that
 * release, never an earlier pre-release. */
export function includesPartitionedStorage(value: unknown): boolean {
  if (typeof value !== "string") return false;
  const match = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:[-+][0-9A-Za-z][0-9A-Za-z.+-]*)?$/.exec(value);
  if (!match) return false;
  const parts = match.slice(1).map(Number);
  if (!parts.every(Number.isSafeInteger)) return false;
  for (let index = 0; index < parts.length; index++) {
    if (parts[index] !== PARTITIONED_STORAGE_VERSION[index]) return parts[index] > PARTITIONED_STORAGE_VERSION[index];
  }
  return true;
}

/** True when every frontend this Android host can start reads the partitioned
 * format. Above all the embedded factory bundle: a failed or bad bundle falls
 * back to it without replacing the APK or clearing IndexedDB, and the native
 * updater never installs a bundle older than it. The APK, running, active and
 * pending versions must include the format too. Debug builds qualify the same
 * way (they take the public/package.json version). A missing or invalid bridge
 * answer does not qualify, nor does an asynchronous one slower than 1.5 s;
 * Android's JavaScript interface answers synchronously, so it is waited for. */
export async function canAutomaticallyUpgradeAndroidStorage(host: ElectronHostDevice): Promise<boolean> {
  if (!host.version || !host.getWebAppBundleStatus) return false;
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      (async () => {
        const [version, raw] = await Promise.all([host.version!(), host.getWebAppBundleStatus!()]);
        if (!includesPartitionedStorage(version) || typeof raw !== "string") return false;
        const status: unknown = JSON.parse(raw);
        if (!status || typeof status !== "object" || Array.isArray(status)) return false;
        const bundle = status as Record<string, unknown>;
        if (!includesPartitionedStorage(bundle.factoryVersion) || !includesPartitionedStorage(bundle.runningVersion)) return false;
        for (const kind of ["active", "pending"]) {
          if (bundle[`${kind}ReleaseId`] != null && !includesPartitionedStorage(bundle[`${kind}Version`])) return false;
        }
        return true;
      })(),
      new Promise<boolean>((resolve) => {
        timeout = setTimeout(() => resolve(false), 1500);
      }),
    ]);
  } catch {
    return false;
  } finally {
    clearTimeout(timeout);
  }
}
