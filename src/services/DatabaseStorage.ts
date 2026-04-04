/**
 * Re-export from classes/DatabaseStorage.ts — the canonical location.
 * This stub exists so that existing imports from "../services/DatabaseStorage" continue to work.
 */
export {
  databaseStorage,
  default,
  getStorageKey,
  getRawDatabase,
  listDatabaseKeys,
  loadDatabase,
  migrateFromLocalStorage,
  removeDatabase,
  saveDatabase,
  setRawDatabase,
} from "../../db-common/DatabaseStorage";
