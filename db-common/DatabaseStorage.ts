import localforage from "localforage";

/**
 * DatabaseStorage service - wraps localForage for persistent database storage.
 * Uses IndexedDB as the primary storage backend, which has much larger storage limits
 * than localStorage (typically 50% of disk space vs 5-10MB).
 *
 * Storage keys:
 * - "pp-database" for guest mode
 * - "pp-database-<username>" for logged-in users
 */

// Configure localForage to use IndexedDB with a descriptive name
const dbStorage = localforage.createInstance({
  name: "PraiseProjector",
  storeName: "database",
  description: "PraiseProjector song database storage",
});

/**
 * Get the storage key for the current user
 */
export function getStorageKey(username?: string): string {
  return username ? `pp-database-${username}` : "pp-database";
}

/**
 * Load database JSON from storage
 * @param username - The username (empty string or undefined for guest)
 * @returns The parsed database state object, or null if not found
 */
export async function loadDatabase<T>(username?: string): Promise<T | null> {
  const key = getStorageKey(username);
  try {
    // console.debug("DatabaseStorage", `Loading from key: ${key}`);
    const data = await dbStorage.getItem<string>(key);
    if (data) {
      return JSON.parse(data) as T;
    }
    return null;
  } catch (error) {
    console.error("DatabaseStorage", `Failed to load from key: ${key}`, error);
    return null;
  }
}

/**
 * Save database state to storage
 * @param data - The database state object to save
 * @param username - The username (empty string or undefined for guest)
 */
export async function saveDatabase<T>(data: T, username?: string): Promise<void> {
  const key = getStorageKey(username);
  try {
    const json = JSON.stringify(data);
    await dbStorage.setItem(key, json);
    // console.debug("DatabaseStorage", `Saved to key: ${key} (${json.length} bytes)`);
  } catch (error) {
    console.error("DatabaseStorage", `Failed to save to key: ${key}`, error);
    throw error;
  }
}

/**
 * Get raw JSON string from storage (for export)
 * @param username - The username (empty string or undefined for guest)
 * @returns The raw JSON string, or null if not found
 */
export async function getRawDatabase(username?: string): Promise<string | null> {
  const key = getStorageKey(username);
  try {
    return await dbStorage.getItem<string>(key);
  } catch (error) {
    console.error("DatabaseStorage", `Failed to get raw data from key: ${key}`, error);
    return null;
  }
}

/**
 * Set raw JSON string to storage (for import)
 * @param json - The raw JSON string to save
 * @param username - The username (empty string or undefined for guest)
 */
export async function setRawDatabase(json: string, username?: string): Promise<void> {
  const key = getStorageKey(username);
  try {
    // Validate JSON first
    JSON.parse(json);
    await dbStorage.setItem(key, json);
    // console.debug("DatabaseStorage", `Set raw data for key: ${key} (${json.length} bytes)`);
  } catch (error) {
    console.error("DatabaseStorage", `Failed to set raw data for key: ${key}`, error);
    throw error;
  }
}

/**
 * Get the raw JSON string an account's database would be loaded from: the
 * IndexedDB copy, or the legacy localStorage copy that migrateFromLocalStorage
 * has not moved yet (it runs only when that account becomes active). Unlike
 * getRawDatabase a read error is thrown, so a failure is never mistaken for
 * "this account has no database".
 * @param username - The username (empty string or undefined for guest)
 * @returns The raw JSON string, or null if the account has no database at all
 */
export async function getStoredRawDatabase(username?: string): Promise<string | null> {
  const key = getStorageKey(username);
  return (await dbStorage.getItem<string>(key)) ?? localStorage.getItem(key);
}

/**
 * Set several raw JSON databases all-or-nothing (for a multi-account import):
 * either every one of them is stored or none is changed.
 * @param entries - The raw JSON strings with the username each belongs to
 */
export async function setRawDatabases(entries: { json: string; username?: string }[]): Promise<void> {
  const writes = entries.map((entry) => {
    // Validate JSON first
    JSON.parse(entry.json);
    return { key: getStorageKey(entry.username), json: entry.json };
  });
  await dbStorage.ready();

  if (dbStorage.driver() === localforage.INDEXEDDB) {
    // One IndexedDB transaction: a failing put (e.g. quota) aborts all of them.
    const database = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open("PraiseProjector");
      request.onerror = () => reject(request.error);
      request.onsuccess = () => resolve(request.result);
    });
    try {
      await new Promise<void>((resolve, reject) => {
        const transaction = database.transaction("database", "readwrite");
        transaction.oncomplete = () => resolve();
        transaction.onerror = () => reject(transaction.error);
        transaction.onabort = () => reject(transaction.error ?? new Error("IndexedDB transaction aborted"));
        const store = transaction.objectStore("database");
        for (const write of writes) store.put(write.json, write.key);
      });
    } finally {
      database.close();
    }
    return;
  }

  // Other localForage drivers have no multi-key transaction: put back what was there on failure.
  const previous = new Map<string, string | null>();
  try {
    for (const write of writes) {
      previous.set(write.key, await dbStorage.getItem<string>(write.key));
      await dbStorage.setItem(write.key, write.json);
    }
  } catch (error) {
    // Undo in reverse order: each step then returns to a state that fitted
    // before, whereas the original order can run out of quota while a later
    // import still occupies the space an earlier, larger original needs. One
    // failing restore must not keep the remaining ones from being put back.
    for (const [key, value] of [...previous].reverse()) {
      try {
        if (value === null) await dbStorage.removeItem(key);
        else await dbStorage.setItem(key, value);
      } catch (restoreError) {
        console.error("DatabaseStorage", `Failed to restore key after a failed import: ${key}`, restoreError);
      }
    }
    throw error;
  }
}

/**
 * Remove database from storage
 * @param username - The username (empty string or undefined for guest)
 */
export async function removeDatabase(username?: string): Promise<void> {
  const key = getStorageKey(username);
  try {
    await dbStorage.removeItem(key);
    // console.debug("DatabaseStorage", `Removed key: ${key}`);
  } catch (error) {
    console.error("DatabaseStorage", `Failed to remove key: ${key}`, error);
    throw error;
  }
}

/**
 * List all stored database keys
 * @returns Array of storage keys
 */
export async function listDatabaseKeys(): Promise<string[]> {
  try {
    return await dbStorage.keys();
  } catch (error) {
    console.error("DatabaseStorage", "Failed to list keys", error);
    return [];
  }
}

/**
 * Migrate data from localStorage to IndexedDB (one-time migration)
 * This checks if there's data in localStorage that hasn't been migrated yet.
 * @param username - The username (empty string or undefined for guest)
 * @returns true if migration was performed, false otherwise
 */
export async function migrateFromLocalStorage(username?: string): Promise<boolean> {
  const key = getStorageKey(username);

  try {
    // Check if data already exists in IndexedDB
    const existingData = await dbStorage.getItem<string>(key);
    if (existingData) {
      // console.debug("DatabaseStorage", `Data already exists in IndexedDB for key: ${key}, skipping migration`);
      return false;
    }

    // Check if data exists in localStorage
    const localStorageData = localStorage.getItem(key);
    if (!localStorageData) {
      // console.debug("DatabaseStorage", `No localStorage data found for key: ${key}`);
      return false;
    }

    // Migrate data to IndexedDB
    console.info("DatabaseStorage", `Migrating data from localStorage to IndexedDB for key: ${key}`);
    await dbStorage.setItem(key, localStorageData);

    // Remove from localStorage after successful migration to free up the limited quota
    localStorage.removeItem(key);
    console.info("DatabaseStorage", `Removed localStorage data for key: ${key}`);

    console.info("DatabaseStorage", `Migration complete for key: ${key} (${localStorageData.length} bytes)`);
    return true;
  } catch (error) {
    console.error("DatabaseStorage", `Migration failed for key: ${key}`, error);
    return false;
  }
}

export const databaseStorage = {
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
};

export default databaseStorage;
