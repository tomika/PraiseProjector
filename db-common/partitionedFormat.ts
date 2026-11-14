/**
 * IndexedDB layout of the local song databases, shared by the application
 * (PartitionedDatabaseStore) and the site migration runtime, which reads and
 * writes accounts while the application is stopped. Dependency-free on
 * purpose: no app models, codecs or localforage.
 *
 * Every row lives in the "database" object store of the "PraiseProjector"
 * IndexedDB database. Legacy accounts are one JSON string at `pp-database` /
 * `pp-database-<username>`; partitioned accounts are array-keyed records under
 * [PREFIX, account, part] plus a manifest. Array keys never collide with the
 * string keys older versions use.
 */

export const STORE_NAME = "database";
export const PREFIX = "pp-partitioned-v1";
/** Rows of the unreleased 2026-11-12 prototype. Left untouched; removed with their account. */
export const ARCHIVE = `${PREFIX}-archive`;
export const MODE_KEY = ["pp-storage-v1", "mode"];
export const CLEANUP_KEY = ["pp-storage-v1", "cleanup"];
export const LEGACY_VERSION_KEY = ["pp-storage-v1", "legacy-version"];
/**
 * Further stored copies kept inert inside the app's own store:
 * [...KEPT_KEY, account, source, id] = the copy's text. The conversion keeps a
 * localStorage copy that differs from the account's IndexedDB copy here (the
 * account itself opens with the IndexedDB copy, as every earlier version read
 * it), in the same transaction. Never loaded by the app; exports carry them.
 */
export const KEPT_KEY = ["pp-storage-v1", "kept"];
export const keptKey = (account: string, source: string, id: string): IDBValidKey => [...KEPT_KEY, account, source, id];
export const keptRange = (account: string): IDBKeyRange => IDBKeyRange.bound([...KEPT_KEY, account], [...KEPT_KEY, account, []]);
const MANIFEST = "$manifest";

export type StorageMode = "legacy" | "partitioned";
export interface ProfileParts {
  data: string;
  preferences?: string;
  playlists?: string;
}
export type Fields = Record<string, { keys: string[]; profiles?: ProfileParts[]; array: boolean }>;
export interface Manifest {
  format: 1;
  revision: string;
  fields: Fields;
}
export interface Partitioned {
  fields: Fields;
  parts: Map<string, string>;
}

export const isAccountKey = (key: unknown): key is string => typeof key === "string" && (key === "pp-database" || key.startsWith("pp-database-"));
export const sameKey = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
export const recordKey = (account: string, part: string): IDBValidKey => [PREFIX, account, part];
export function accountRange(account: string, prefix = PREFIX): IDBKeyRange {
  return IDBKeyRange.bound([prefix, account], [prefix, account, []]);
}

export function storageMode(value: unknown): StorageMode | null {
  if (value === undefined) return null;
  if (value !== "legacy" && value !== "partitioned") throw new Error("Unsupported storage choice");
  return value;
}

export function newRevision(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (value) => value.toString(16).padStart(2, "0")).join("");
}

/** JSON objects are unordered; array order and every property value matter. */
export function sameJson(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (!a || !b || typeof a !== "object" || typeof b !== "object") return false;
  if (Array.isArray(a) || Array.isArray(b)) {
    return Array.isArray(a) && Array.isArray(b) && a.length === b.length && a.every((value, index) => sameJson(value, b[index]));
  }
  const left = a as Record<string, unknown>,
    right = b as Record<string, unknown>;
  const keys = Object.keys(left);
  return keys.length === Object.keys(right).length && keys.every((key) => hasOwn(right, key) && sameJson(left[key], right[key]));
}

// Object.hasOwn is ES2022; the site migration runtime targets older browsers too.
const hasOwn = (value: object, key: string) => Object.prototype.hasOwnProperty.call(value, key);
const isObject = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);
function object(value: unknown): Record<string, unknown> {
  if (!isObject(value)) throw new Error("Invalid database object");
  return value;
}

const PROFILE_FIELDS = new Set(["leaders", "publicLeaders"]);
const SECTIONS = ["preferences", "playlists"] as const;
/** Record identity of one collection entry; undefined when it has none. */
const IDENTITIES: Record<string, (entry: unknown) => unknown> = {
  // Song.fromJSON also supports the original _id song format.
  songs: (entry) => (isObject(entry) ? (entry.songId ?? entry._id) : undefined),
  songBackup: (entry) => (Array.isArray(entry) ? entry[0] : undefined),
  profileBackup: (entry) => (Array.isArray(entry) ? entry[0] : undefined),
};
function distinctIds(ids: unknown[]): ids is string[] {
  return ids.every((id) => typeof id === "string") && new Set(ids).size === ids.length;
}

/**
 * Splits a parsed database into records. Lossless for every JSON object: unknown
 * fields, array order and property order are kept, nothing is normalized or
 * dropped. A collection whose entries have no unique identity (duplicates,
 * missing ids) is kept as one record until the application normalizes it.
 */
export function partition(data: unknown): Partitioned {
  const fields: Fields = Object.create(null);
  const parts = new Map<string, string>();
  const put = (path: unknown[], value: unknown) => {
    const key = JSON.stringify(path);
    if (parts.has(key)) throw new Error("Duplicate database record");
    parts.set(key, JSON.stringify(value));
    return key;
  };
  for (const [field, value] of Object.entries(object(data))) {
    const identity = IDENTITIES[field];
    if (PROFILE_FIELDS.has(field) && Array.isArray(value)) {
      const ids = value.map((entry) => (isObject(entry) ? entry.leaderId : undefined));
      if (distinctIds(ids)) {
        const profiles = value.map((entry, index) => {
          // Sections are replaced by null placeholders, so assembling restores
          // the original property order.
          const profile = { ...object(entry) };
          const sections: ProfileParts = { data: "" };
          for (const section of SECTIONS) {
            if (hasOwn(profile, section)) {
              sections[section] = put([field, ids[index], section], profile[section]);
              profile[section] = null;
            }
          }
          sections.data = put([field, ids[index], "data"], profile);
          return sections;
        });
        fields[field] = {
          keys: profiles.flatMap((p) => [p.data, ...[p.preferences, p.playlists].filter((k): k is string => k !== undefined)]),
          profiles,
          array: true,
        };
        continue;
      }
    } else if (identity && Array.isArray(value)) {
      const ids = value.map(identity);
      if (distinctIds(ids)) {
        fields[field] = { keys: value.map((entry, index) => put([field, ids[index]], entry)), array: true };
        continue;
      }
    }
    fields[field] = { keys: [put([field], value)], array: false };
  }
  return { fields, parts };
}

export function parseManifest(value: unknown): Manifest | null {
  if (value === undefined) return null;
  if (typeof value !== "string") throw new Error("Unreadable database manifest");
  const manifest = JSON.parse(value) as Manifest;
  if (manifest.format !== 1 || typeof manifest.revision !== "string" || !isObject(manifest.fields)) {
    throw new Error("Unsupported database storage format");
  }
  // Validate descriptors before issuing any writes or deletions.
  for (const field of Object.values(manifest.fields)) {
    if (!Array.isArray(field.keys) || field.keys.some((key) => typeof key !== "string") || typeof field.array !== "boolean") {
      throw new Error("Invalid database manifest");
    }
    if (!field.array && field.keys.length !== 1) throw new Error("Invalid database manifest");
    if (
      field.profiles &&
      (!Array.isArray(field.profiles) ||
        field.profiles.some(
          (p) => !p || typeof p.data !== "string" || [p.data, p.preferences, p.playlists].some((k) => k !== undefined && !field.keys.includes(k))
        ))
    ) {
      throw new Error("Invalid profile manifest");
    }
  }
  return manifest;
}

/** The exact JSON text a partitioned account represents (JSON.stringify of its parsed source). */
export function assemble(manifest: Manifest, parts: ReadonlyMap<string, string>): string {
  const get = (key: string): unknown => {
    const value = parts.get(key);
    if (value === undefined) throw new Error(`Missing database record: ${key}`);
    return JSON.parse(value);
  };
  const result: Record<string, unknown> = Object.create(null);
  for (const [name, field] of Object.entries(manifest.fields)) {
    result[name] = field.profiles
      ? field.profiles.map((p) => {
          const profile = object(get(p.data));
          for (const section of SECTIONS) {
            const key = p[section];
            if (key !== undefined) profile[section] = get(key);
          }
          return profile;
        })
      : field.array
        ? field.keys.map(get)
        : get(field.keys[0]);
  }
  return JSON.stringify(result);
}

/** Writes `next` as the account's partitioned records, deleting records `previous` had that `next` lacks. */
export function writeParts(
  store: IDBObjectStore,
  account: string,
  next: Partitioned,
  revision: string,
  previous: ReadonlyMap<string, string>
): Manifest {
  const manifest: Manifest = { format: 1, revision, fields: next.fields };
  for (const [key, value] of next.parts) if (previous.get(key) !== value) store.put(value, recordKey(account, key));
  for (const key of previous.keys()) if (!next.parts.has(key)) store.delete(recordKey(account, key));
  store.put(JSON.stringify(manifest), recordKey(account, MANIFEST));
  return manifest;
}

export interface StoredAccount {
  mode: StorageMode | null;
  /** The account's JSON as the application would read it, or null when it has none. */
  value: string | null;
  /** The application refuses this account until it is recovered (e.g. by an
   * import in the app); an external writer must not replace it either. */
  blocked: boolean;
  /**
   * Every other stored IndexedDB representation of the account that `value`
   * does not contain: a legacy text beside assembled records, or records that
   * cannot be assembled or have no manifest (raw rows, `[[part, value], …]`).
   * A complete export (e.g. a backup) must carry these too.
   */
  extra: { source: "localStorage" | "indexeddb-legacy" | "indexeddb-records"; payload: string }[];
  /** `value` was assembled from partitioned records (not a legacy text). */
  fromRecords: boolean;
  /** The app's startup has not finished its cleanup yet (blocked until it has run once). */
  gated: boolean;
  /** Copies kept inert in the store for this account (KEPT_KEY rows); exports carry them too. */
  kept: { source: string; payload: string }[];
}

/** What a reader outside the transaction knows about the account. */
export interface StoredAccountOptions {
  /** The account's localStorage copy (`localStorage.getItem(account)`), when the caller can read it. */
  localCopy?: string | null;
}

/** Equal database texts: the same JSON value, in any property order, as the app compares them. */
export function sameDatabaseText(a: string, b: string): boolean {
  if (a === b) return true;
  try {
    return sameJson(JSON.parse(a), JSON.parse(b));
  } catch {
    return false;
  }
}

/** True for text the application can open as a stored database: a JSON object. */
function isObjectText(text: string): boolean {
  try {
    return isObject(JSON.parse(text));
  } catch {
    return false;
  }
}

/**
 * Reads one account inside the caller's transaction, in whichever format the
 * store uses. For external tools; the application has its own stricter reader.
 *
 * `blocked` mirrors every storage-level reason the application refuses to open
 * the account: an unfinished startup cleanup (the app is still gated), records
 * it cannot assemble or that have no manifest, any legacy text once the format
 * is partitioned (an older version's write, or a text that could not be
 * converted), a legacy text that is not a JSON object, and, given
 * `options.localCopy`, a localStorage copy once a format is chosen (the app
 * moved every copy into IndexedDB then, so a later one is an older version's
 * write). Content validity beyond that is the application loader's decision.
 * A given localStorage copy that differs from an IndexedDB value is reported
 * in `extra`.
 */
export function readStoredAccount(
  store: IDBObjectStore,
  account: string,
  done: (account: StoredAccount) => void,
  fail: (error: unknown) => void,
  options: StoredAccountOptions = {}
): void {
  const mode = store.get(MODE_KEY);
  const cleanup = store.get(CLEANUP_KEY);
  const legacy = store.get(account);
  const range = accountRange(account);
  const keys = store.getAllKeys(range);
  const values = store.getAll(range);
  const keptKeys = store.getAllKeys(keptRange(account));
  const keptValues = store.getAll(keptRange(account));
  const report = (result: Omit<StoredAccount, "kept" | "fromRecords" | "gated">, fromRecords = false) => {
    const localCopy = options.localCopy ?? null;
    if (result.value !== null && localCopy !== null && !sameDatabaseText(localCopy, result.value)) {
      result.extra.push({ source: "localStorage", payload: localCopy });
    }
    const kept: StoredAccount["kept"] = [];
    keptKeys.result.forEach((key, index) => {
      const payload: unknown = keptValues.result[index];
      if (typeof payload === "string") kept.push({ source: String((key as unknown[])[3]), payload });
    });
    done({ ...result, kept, fromRecords, gated: cleanup.result !== undefined });
  };
  keptValues.onsuccess = () => {
    try {
      const selected = storageMode(mode.result);
      const raw: unknown = legacy.result;
      const legacyValue = raw == null ? null : typeof raw === "string" ? raw : JSON.stringify(raw);
      const rows = new Map(keys.result.map((key, index) => [String((key as unknown[])[2]), values.result[index]]));
      const refusedLegacy = legacyValue !== null && (selected === "partitioned" || !isObjectText(legacyValue));
      const localCopy = options.localCopy ?? null;
      // The app is gated by an unfinished cleanup and refuses a later localStorage copy.
      const refusedState = cleanup.result !== undefined || (selected !== null && localCopy !== null);
      const unusedRecords = () => [{ source: "indexeddb-records" as const, payload: JSON.stringify([...rows]) }];
      if (selected !== "partitioned" || !rows.has(MANIFEST)) {
        report({
          mode: selected,
          value: legacyValue,
          blocked: refusedState || refusedLegacy || rows.size > 0,
          extra: rows.size ? unusedRecords() : [],
        });
        return;
      }
      let value: string;
      try {
        const manifest = parseManifest(rows.get(MANIFEST))!;
        const parts = new Map<string, string>();
        for (const key of new Set(Object.values(manifest.fields).flatMap((field) => field.keys))) {
          const part = rows.get(key);
          if (typeof part !== "string") throw new Error(`Missing database record: ${key}`);
          parts.set(key, part);
        }
        value = assemble(manifest, parts);
      } catch {
        report({ mode: selected, value: legacyValue, blocked: true, extra: unusedRecords() });
        return;
      }
      report(
        {
          mode: selected,
          value,
          blocked: refusedState || refusedLegacy,
          extra: legacyValue === null ? [] : [{ source: "indexeddb-legacy", payload: legacyValue }],
        },
        true
      );
    } catch (error) {
      fail(error);
    }
  };
}

/** Every account with any stored representation, usable or not (unordered):
 * legacy texts and partitioned records, also records without a manifest, and
 * copies kept inert in the store (also of an account with nothing else left). */
export function listStoredAccounts(store: IDBObjectStore, done: (accounts: string[]) => void): void {
  const keys = store.getAllKeys();
  keys.onsuccess = () => {
    const accounts = new Set<string>();
    for (const key of keys.result) {
      if (isAccountKey(key)) accounts.add(key);
      else if (Array.isArray(key) && key[0] === PREFIX && isAccountKey(key[1])) accounts.add(key[1]);
      else if (Array.isArray(key) && key[0] === KEPT_KEY[0] && key[1] === KEPT_KEY[1] && isAccountKey(key[2])) accounts.add(key[2]);
    }
    done([...accounts]);
  };
}

/**
 * Writes (or with `next === undefined` deletes) an account unconditionally in
 * the format `mode` names, inside the caller's readwrite transaction: what the
 * app's own save of that account leaves stored. Kept copies stay untouched.
 */
export function writeStoredAccount(store: IDBObjectStore, account: string, mode: StorageMode | null, next: string | undefined): void {
  if (mode === "partitioned") {
    store.delete(account);
    store.delete(accountRange(account));
    if (next !== undefined) writeParts(store, account, partition(JSON.parse(next)), newRevision(), new Map());
  } else if (next === undefined) store.delete(account);
  else store.put(next, account);
}

/**
 * Compare-and-set of one account for external writers: inside the caller's
 * readwrite transaction, replaces (or with `next === undefined` deletes) the
 * account only while it still reads as `expected` and is not blocked. Writes
 * the format the store uses. Calls done(false) without writing otherwise.
 */
export function compareAndSetStoredAccount(
  store: IDBObjectStore,
  account: string,
  expected: string | null,
  next: string | undefined,
  done: (wrote: boolean) => void,
  fail: (error: unknown) => void,
  options: StoredAccountOptions = {}
): void {
  readStoredAccount(
    store,
    account,
    (current) => {
      try {
        if (current.blocked || current.value !== expected) {
          done(false);
          return;
        }
        writeStoredAccount(store, account, current.mode, next);
        done(true);
      } catch (error) {
        fail(error);
      }
    },
    fail,
    options
  );
}
