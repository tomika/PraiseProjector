import localforage from "localforage";
import { PartitionedDatabaseStore, type StorageMode } from "./PartitionedDatabaseStore";
import { isAccountKey } from "./partitionedFormat";
export type { StorageMode } from "./PartitionedDatabaseStore";

declare const __APP_VERSION__: string;
function currentAppVersion(): string {
  return typeof __APP_VERSION__ !== "undefined" ? __APP_VERSION__ : "development";
}

// Keep the original database/store and legacy string keys. Array keys used by
// the new format cannot collide with any username supported by old versions.
const dbStorage = localforage.createInstance({
  name: "PraiseProjector",
  storeName: "database",
  description: "PraiseProjector song database storage",
});

export function getStorageKey(username?: string): string {
  return username ? `pp-database-${username}` : "pp-database";
}

const partitioned = new PartitionedDatabaseStore(async () => {
  await dbStorage.ready();
  if (dbStorage.driver() !== localforage.INDEXEDDB) {
    throw new Error("IndexedDB is required for safe database persistence");
  }
  return new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open("PraiseProjector");
    request.onerror = () => reject(request.error);
    request.onsuccess = () => resolve(request.result);
  });
});

function localCopies(): { key: string; value: string }[] {
  const copies: { key: string; value: string }[] = [];
  for (let i = 0; i < localStorage.length; i++) {
    const key = localStorage.key(i);
    if (isAccountKey(key)) {
      const value = localStorage.getItem(key);
      if (value !== null) copies.push({ key, value });
    }
  }
  return copies;
}

/** After the choice every localStorage source has been converted and removed.
 * A copy found later was written by a pre-IndexedDB app version: only that
 * account is refused (never read over or overwritten) until an import replaces it. */
function refuseLocalCopy(key: string): void {
  if (localStorage.getItem(key) !== null) {
    throw new Error("An older app version wrote this account's database to localStorage; import a backup to replace it");
  }
}

export async function getStorageChoice(): Promise<StorageMode | null> {
  await partitioned.finishCleanup(localStorage);
  return partitioned.choice();
}

export async function chooseStorage(mode: StorageMode, appVersion = currentAppVersion()): Promise<void> {
  await partitioned.choose(mode, localCopies(), { upgradeLegacy: true, legacyVersion: mode === "legacy" ? appVersion : undefined });
  await partitioned.finishCleanup(localStorage);
}

let automaticSetup: Promise<StorageMode> | null = null;

/** Native hosts retain the explicit choice. Browser/PWA startup always uses
 * the new format, including upgrading a previously saved legacy preference;
 * with `respectLegacyDecision` (an eligible Android release) not one that
 * was chosen explicitly in this app version. */
export async function prepareStorageForRuntime(
  hasHostDevice: boolean,
  appVersion = currentAppVersion(),
  options: { respectLegacyDecision?: boolean } = {}
): Promise<StorageMode | null> {
  if (hasHostDevice) {
    const choice = await getStorageChoice();
    if (choice === "legacy" && !(await partitioned.hasLegacyDecision(appVersion))) return null;
    return choice;
  }
  // React StrictMode and simultaneous consumers must share one conversion.
  if (!automaticSetup) {
    automaticSetup = (async () => {
      // Already converted: a single key read instead of reading every record.
      const choice = await getStorageChoice();
      if (choice === "partitioned") return "partitioned" as const;
      if (choice === "legacy" && options.respectLegacyDecision && (await partitioned.hasLegacyDecision(appVersion))) return "legacy" as const;
      await partitioned.choose("partitioned", localCopies(), { upgradeLegacy: true });
      await partitioned.finishCleanup(localStorage);
      return "partitioned" as const;
    })();
  }
  const setup: Promise<StorageMode> = automaticSetup;
  try {
    return await setup;
  } finally {
    if (automaticSetup === setup) automaticSetup = null;
  }
}

async function requireChoice(): Promise<void> {
  if (!(await getStorageChoice())) throw new Error("Choose a storage format before opening the application");
}

/** `owner`: the instance the write baseline belongs to (see PartitionedDatabaseStore). */
export async function loadDatabase<T>(username?: string, owner?: object): Promise<T | null> {
  const key = getStorageKey(username);
  await requireChoice();
  refuseLocalCopy(key);
  const raw = await partitioned.load(key, owner);
  return raw === null ? null : (JSON.parse(raw) as T);
}

export async function saveDatabase<T>(data: T, username?: string, owner?: object): Promise<void> {
  // Freeze this request before any I/O lets callers mutate the model.
  const json = JSON.stringify(data);
  const key = getStorageKey(username);
  refuseLocalCopy(key);
  // The format and cleanup state are verified inside the save transaction.
  await partitioned.save(key, json, owner);
}

export async function getRawDatabase(username?: string): Promise<string | null> {
  return getStoredRawDatabase(username);
}

export async function getStoredRawDatabase(username?: string): Promise<string | null> {
  const key = getStorageKey(username);
  await requireChoice();
  refuseLocalCopy(key);
  return partitioned.read(key);
}

export async function setRawDatabase(json: string, username?: string): Promise<void> {
  await setRawDatabases([{ json, username }]);
}

export async function setRawDatabases(entries: { json: string; username?: string }[]): Promise<void> {
  await requireChoice();
  const keys = entries.map(({ username }) => getStorageKey(username));
  await partitioned.replace(entries.map(({ json }, index) => ({ key: keys[index], json })));
  // The import replaces the account as a whole, including a refused copy an
  // older version wrote to localStorage.
  for (const key of keys) localStorage.removeItem(key);
}

export async function removeDatabase(username?: string): Promise<void> {
  const key = getStorageKey(username);
  await partitioned.remove(key);
  // Keep a localStorage-only source intact if the IndexedDB operation fails.
  localStorage.removeItem(key);
}

export async function listDatabaseKeys(): Promise<string[]> {
  return partitioned.keys();
}

/** Everything the databases occupy, unchanged and unvalidated, so the user can
 * keep their data when the app cannot start. Not an import format. */
export async function exportRecoveryData(): Promise<string> {
  return JSON.stringify({
    format: "pp-storage-recovery-v1",
    exportedAt: new Date().toISOString(),
    appVersion: currentAppVersion(),
    indexedDb: await partitioned.dump(),
    localStorage: localCopies(),
  });
}

export async function migrateFromLocalStorage(username?: string): Promise<boolean> {
  // All accounts are migrated by the explicit startup choice, before mounting
  // any database consumer. Retain the old entry point for compatibility.
  void username;
  return false;
}

export const databaseStorage = {
  prepareForRuntime: prepareStorageForRuntime,
  getChoice: getStorageChoice,
  choose: chooseStorage,
  load: loadDatabase,
  save: saveDatabase,
  getRaw: getRawDatabase,
  setRaw: setRawDatabase,
  getStoredRaw: getStoredRawDatabase,
  setRawMany: setRawDatabases,
  remove: removeDatabase,
  listKeys: listDatabaseKeys,
  migrateFromLocalStorage,
  getStorageKey,
  release: (username?: string, owner?: object) => partitioned.release(getStorageKey(username), owner),
  exportRecoveryData,
};

export default databaseStorage;
