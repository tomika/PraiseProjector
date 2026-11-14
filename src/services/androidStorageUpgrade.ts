import type { ElectronHostDevice } from "../types/hostDevice";

function newerThanStorageBoundary(value: unknown): boolean {
  if (typeof value !== "string" || !/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(value)) return false;
  const parts = value.split(".").map(Number);
  if (!parts.every(Number.isSafeInteger)) return false;
  const boundary = [2, 0, 94];
  for (let index = 0; index < parts.length; index++) {
    if (parts[index] !== boundary[index]) return parts[index] > boundary[index];
  }
  return false;
}

/** Android release APKs reject ordinary in-place downgrades. Also verify the
 * native updater's factory floor: an OTA trial can fall back without replacing
 * the APK or clearing IndexedDB. Unknown/debug hosts always retain consent. */
export async function canAutomaticallyUpgradeAndroidStorage(host: ElectronHostDevice, isElectron: boolean): Promise<boolean> {
  if (isElectron || !host.version || !host.isDebugBuild || !host.getWebAppBundleStatus) return false;
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      (async () => {
        const [version, debug, raw] = await Promise.all([host.version!(), host.isDebugBuild!(), host.getWebAppBundleStatus!()]);
        if (debug !== false || !newerThanStorageBoundary(version) || typeof raw !== "string") return false;
        const status: unknown = JSON.parse(raw);
        if (!status || typeof status !== "object" || Array.isArray(status)) return false;
        const bundle = status as Record<string, unknown>;
        if (!newerThanStorageBoundary(bundle.factoryVersion) || !newerThanStorageBoundary(bundle.runningVersion)) return false;
        for (const kind of ["active", "pending"]) {
          if (bundle[`${kind}ReleaseId`] != null && !newerThanStorageBoundary(bundle[`${kind}Version`])) return false;
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
