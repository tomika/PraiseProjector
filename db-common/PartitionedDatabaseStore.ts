import { validateChangedRecords, validateDatabaseObject } from "./validateDatabaseState";
import {
  ARCHIVE,
  CLEANUP_KEY,
  LEGACY_VERSION_KEY,
  MODE_KEY,
  PREFIX,
  STORE_NAME,
  accountRange,
  assemble,
  isAccountKey,
  keptKey,
  keptRange,
  newRevision,
  parseManifest,
  partition,
  recordKey,
  sameJson,
  sameKey,
  storageMode,
  writeParts,
  type Manifest,
  type Partitioned,
  type StorageMode,
} from "./partitionedFormat";

export type { StorageMode } from "./partitionedFormat";

interface Snapshot {
  manifest: Manifest | null;
  legacy: string | null;
  raw: string | null;
  /** Records of `raw`; for a legacy account computed on load, so saves can validate only changes. */
  parts: Map<string, string>;
  mode: StorageMode | null;
}
type Row = [IDBValidKey, unknown];
type LocalCopy = { key: string; value: string };

/** Equal JSON values; text that is not JSON only equals itself. */
function equivalent(a: string, b: string): boolean {
  try {
    return sameJson(JSON.parse(a), JSON.parse(b));
  } catch {
    return a === b;
  }
}

/** Exactly one selected format is authoritative. Conversion, source deletion and
 * the durable choice share the same transaction. No legacy merge or shadow DB. */
export class PartitionedDatabaseStore {
  // Write baselines, one per owner (an open Database instance), so several
  // instances of one account each save against their own load, revision-checked
  // like separate windows. Callers without an owner share one per account.
  private snapshots = new WeakMap<object, Snapshot>();
  private defaultOwners = new Map<string, object>();
  private owner(account: string, owner?: object): object {
    if (owner) return owner;
    let shared = this.defaultOwners.get(account);
    if (!shared) {
      shared = {};
      this.defaultOwners.set(account, shared);
    }
    return shared;
  }
  constructor(private readonly open: () => Promise<IDBDatabase>) {}
  private async transaction<T>(
    mode: IDBTransactionMode,
    action: (store: IDBObjectStore, done: (value: T) => void, fail: (error: unknown) => void) => void
  ): Promise<T> {
    const db = await this.open();
    try {
      return await new Promise<T>((resolve, reject) => {
        const tx = db.transaction(STORE_NAME, mode, mode === "readwrite" ? { durability: "strict" } : undefined);
        let result: T;
        let failure: unknown;
        let failed = false;
        const fail = (error: unknown) => {
          if (failed) return;
          failed = true;
          failure = error;
          try {
            tx.abort();
          } catch {
            /* already aborted */
          }
        };
        tx.oncomplete = () => resolve(result);
        tx.onabort = () => reject(failure ?? tx.error ?? new Error("Database transaction aborted"));
        try {
          action(
            tx.objectStore(STORE_NAME),
            (value) => {
              result = value;
            },
            fail
          );
        } catch (error) {
          fail(error);
        }
      });
    } finally {
      db.close();
    }
  }
  private inventory(store: IDBObjectStore, done: (rows: Row[]) => void, range?: IDBKeyRange): void {
    const keys = store.getAllKeys(range);
    const values = store.getAll(range);
    values.onsuccess = () => done(keys.result.map((key, i) => [key, values.result[i]]));
  }
  private rows(): Promise<Row[]> {
    return this.transaction("readonly", (store, done) => this.inventory(store, done));
  }
  private value(key: IDBValidKey): Promise<unknown> {
    return this.transaction("readonly", (store, done) => {
      const request = store.get(key);
      request.onsuccess = () => done(request.result);
    });
  }
  private mode(rows: Row[]): StorageMode | null {
    return storageMode(rows.find(([key]) => sameKey(key, MODE_KEY))?.[1]);
  }
  async choice(): Promise<StorageMode | null> {
    return storageMode(await this.value(MODE_KEY));
  }
  /** Stores `mode` only when the store holds nothing at all (a fresh installation);
   * atomic, so a database another window writes meanwhile is never decided
   * without the user. Returns the format stored afterwards: `mode`, one another
   * window or startup consumer stored meanwhile, or null (data but no format). */
  async chooseIfEmpty(mode: StorageMode): Promise<StorageMode | null> {
    if (mode !== "legacy" && mode !== "partitioned") throw new Error("Invalid storage choice");
    return this.transaction<StorageMode | null>("readwrite", (store, done, fail) => {
      const existing = store.get(MODE_KEY);
      const count = store.count();
      count.onsuccess = () => {
        try {
          const stored = storageMode(existing.result);
          if (stored || count.result !== 0) {
            done(stored);
            return;
          }
          store.put(mode, MODE_KEY);
          done(mode);
        } catch (error) {
          fail(error);
        }
      };
    });
  }
  async hasLegacyDecision(appVersion: string): Promise<boolean> {
    const value = await this.value([...LEGACY_VERSION_KEY, appVersion]);
    if (value === undefined) return false;
    if (value !== true) throw new Error("Invalid legacy storage decision");
    return true;
  }
  private decode(rows: Row[], account: string, mode: StorageMode | null): Snapshot {
    const values = new Map(rows.map(([key, value]) => [JSON.stringify(key), value]));
    const get = (key: IDBValidKey) => values.get(JSON.stringify(key));
    const rawLegacy = get(account) ?? null;
    if (rawLegacy !== null && typeof rawLegacy !== "string") throw new Error("Invalid legacy database");
    const legacy = rawLegacy as string | null;
    const manifest = parseManifest(get(recordKey(account, "$manifest")));
    if (mode === "legacy" && manifest) throw new Error("Unexpected second database format");
    if (mode === "partitioned" && legacy !== null) {
      throw new Error("This account's stored database was written by an older app version or could not be converted; import a backup to replace it");
    }
    if (!manifest) {
      if (rows.some(([key]) => Array.isArray(key) && key[0] === PREFIX && key[1] === account)) {
        throw new Error("Database records exist without a manifest; recovery is required");
      }
      return { manifest: null, legacy, raw: legacy, parts: new Map(), mode };
    }
    if (mode === null) {
      // Compatibility with the unreleased prototype only. Never merge divergent data.
      const source = get(recordKey(account, "$source"));
      if (source !== legacy) throw new Error("Conflicting legacy and partitioned databases; recovery is required before choosing a format");
    }
    const parts = new Map<string, string>();
    for (const key of new Set(Object.values(manifest.fields).flatMap((field) => field.keys))) {
      const value = get(recordKey(account, key));
      if (typeof value !== "string") throw new Error(`Missing database record: ${key}`);
      parts.set(key, value);
    }
    return { manifest, legacy, raw: assemble(manifest, parts), parts, mode };
  }
  /**
   * Must run before mounting any app/database consumer. Converts every account
   * losslessly; judging content is left to the application's loader, so one
   * damaged account never blocks the others. Text that is not a JSON object
   * stays verbatim at its legacy key (the account then stays closed until an
   * import replaces it).
   */
  async choose(mode: StorageMode, localCopies: LocalCopy[] = [], options: { upgradeLegacy?: boolean; legacyVersion?: string } = {}): Promise<void> {
    if (mode !== "legacy" && mode !== "partitioned") throw new Error("Invalid storage choice");
    const legacyVersion = options.legacyVersion;
    if (legacyVersion !== undefined && !legacyVersion.trim()) throw new Error("Invalid application version");
    // The format key alone decides a repeated choice; only a conversion reads every record.
    const existing = await this.choice();
    if (existing) {
      if (existing === mode) {
        if (mode === "legacy" && legacyVersion !== undefined) {
          await this.transaction<void>("readwrite", (store, done, fail) => {
            const request = store.get(MODE_KEY);
            request.onsuccess = () => {
              try {
                if (request.result !== "legacy") throw new Error("Storage format changed in another window");
                store.put(true, [...LEGACY_VERSION_KEY, legacyVersion]);
                done();
              } catch (error) {
                fail(error);
              }
            };
          });
        }
        return;
      }
      if (!(options.upgradeLegacy && existing === "legacy" && mode === "partitioned")) {
        throw new Error("Another window already chose a different format");
      }
    }
    const before = await this.rows();
    if (this.mode(before) !== existing) throw new Error("Storage format changed in another window; retry");
    // Prototype archive rows (ARCHIVE prefix) are neither accounts nor inputs:
    // they stay untouched and are removed together with their account.
    const accounts = new Set(
      before.flatMap(([key]) => (isAccountKey(key) ? [key] : Array.isArray(key) && key[0] === PREFIX && typeof key[1] === "string" ? [key[1]] : []))
    );
    for (const copy of localCopies) {
      if (!isAccountKey(copy.key)) throw new Error("Invalid local database key");
      accounts.add(copy.key);
    }
    if (new Set(localCopies.map((copy) => copy.key)).size !== localCopies.length) throw new Error("Duplicate local database source");
    const prepared = [...accounts].map((account) => {
      const snapshot = this.decode(before, account, existing);
      const local = localCopies.find((copy) => copy.key === account)?.value;
      // A differing localStorage copy beside the IndexedDB one (e.g. a stale
      // copy an older pre-IndexedDB window wrote later) never blocks anything:
      // the account keeps the IndexedDB copy, which every earlier version read,
      // and the other copy is kept inert in the store (KEPT_KEY), not lost.
      let keepLocal: string | undefined;
      if (local !== undefined && snapshot.raw !== null && !equivalent(local, snapshot.raw)) {
        const source = before.find(([key]) => sameKey(key, recordKey(account, "$source")))?.[1];
        const base = before.find(([key]) => sameKey(key, recordKey(account, "$base")))?.[1];
        if (![source, base].some((value) => typeof value === "string" && equivalent(value, local))) {
          console.warn("DatabaseStorage", `${account}: a differing localStorage copy is kept apart; the IndexedDB copy is used`);
          keepLocal = local;
        }
      }
      const json = snapshot.raw ?? local;
      if (json === undefined || json === null) throw new Error("Orphaned database records");
      let data: unknown;
      let next: Partitioned | null;
      try {
        data = JSON.parse(json);
        next = partition(data);
      } catch (error) {
        // Assembled partitioned data is always a JSON object; only a legacy text can get here.
        if (snapshot.manifest) throw error;
        console.warn("DatabaseStorage", `${account} is not a database object; kept verbatim, the account stays closed until an import`, error);
        next = null;
      }
      if (next && !sameJson(data, JSON.parse(assemble({ format: 1, revision: "", fields: next.fields }, next.parts)))) {
        throw new Error("Database conversion verification failed");
      }
      return { account, json, next, keepLocal };
    });
    await this.transaction<void>("readwrite", (store, done, fail) => {
      this.inventory(store, (rows) => {
        try {
          // Includes accounts created by older windows while validation ran.
          if (!sameKey(rows, before)) throw new Error("Stored data changed during conversion; retry");
          for (const entry of prepared) {
            store.delete(entry.account);
            store.delete(accountRange(entry.account));
            if (mode === "legacy" || !entry.next) store.put(entry.json, entry.account);
            else writeParts(store, entry.account, entry.next, newRevision(), new Map());
            if (entry.keepLocal !== undefined) store.put(entry.keepLocal, keptKey(entry.account, "localStorage", newRevision()));
          }
          if (localCopies.length) store.put(JSON.stringify(localCopies), CLEANUP_KEY);
          store.put(mode, MODE_KEY);
          if (mode === "legacy" && legacyVersion !== undefined) store.put(true, [...LEGACY_VERSION_KEY, legacyVersion]);
          else store.delete(IDBKeyRange.bound(LEGACY_VERSION_KEY, [...LEGACY_VERSION_KEY, []]));
          done();
        } catch (error) {
          fail(error);
        }
      });
    });
    // Every baseline predates the conversion; none may be saved against.
    this.snapshots = new WeakMap();
    this.defaultOwners.clear();
  }
  /** localStorage cannot participate in an IDB transaction. A committed journal
   * makes its source cleanup resumable; the application stays gated until done. */
  async finishCleanup(storage: Pick<Storage, "getItem" | "removeItem">): Promise<void> {
    const journal = await this.value(CLEANUP_KEY);
    if (journal === undefined) return;
    if (typeof journal !== "string") throw new Error("Invalid migration cleanup journal");
    const copies: unknown = JSON.parse(journal);
    if (!Array.isArray(copies)) throw new Error("Invalid migration cleanup journal");
    for (const copy of copies as LocalCopy[]) {
      if (!isAccountKey(copy.key) || typeof copy.value !== "string") throw new Error("Invalid migration cleanup source");
    }
    const changed: string[] = [];
    for (const copy of copies as LocalCopy[]) {
      // Earlier removals can take time or throw; recheck each account at its
      // deletion point, not only before starting the batch. localStorage has
      // no compare-and-delete primitive, so old writing windows must be closed.
      // A source an older window changed since the conversion is never removed:
      // it stays as a later localStorage copy, which closes only that account
      // until an import replaces it (DatabaseStorage refuses such a copy),
      // instead of keeping the whole application from starting.
      const value = storage.getItem(copy.key);
      if (value === null) continue;
      if (value !== copy.value) {
        changed.push(copy.key);
        continue;
      }
      storage.removeItem(copy.key);
    }
    if (changed.length) console.warn("DatabaseStorage", `Legacy localStorage changed after the conversion; kept: ${changed.join(", ")}`);
    for (const copy of copies as LocalCopy[]) if (storage.getItem(copy.key) === copy.value) throw new Error("Legacy cleanup failed");
    await this.transaction<void>("readwrite", (store, done, fail) => {
      const request = store.get(CLEANUP_KEY);
      request.onsuccess = () => {
        try {
          if (request.result === undefined) {
            done();
            return;
          }
          if (request.result !== journal) throw new Error("Migration cleanup changed");
          store.delete(CLEANUP_KEY);
          done();
        } catch (error) {
          fail(error);
        }
      };
    });
  }
  private async snapshot(account: string): Promise<Snapshot> {
    return this.transaction("readonly", (store, done, fail) => {
      const mode = store.get(MODE_KEY);
      const cleanup = store.get(CLEANUP_KEY);
      const legacy = store.get(account);
      this.inventory(
        store,
        (parts) => {
          try {
            const rows: Row[] = [...parts, [MODE_KEY, mode.result], [account, legacy.result]];
            const selected = this.mode(rows);
            if (!selected) throw new Error("A storage format must be chosen before opening a database");
            if (cleanup.result !== undefined) throw new Error("Migration cleanup is incomplete");
            done(this.decode(rows, account, selected));
          } catch (error) {
            fail(error);
          }
        },
        accountRange(account)
      );
    });
  }
  async read(account: string): Promise<string | null> {
    return (await this.snapshot(account)).raw;
  }
  /** Content is judged by the application's loader; a legacy text that is not a
   * database object fails here, since it can neither be opened nor saved over. */
  async load(account: string, owner?: object): Promise<string | null> {
    const key = this.owner(account, owner);
    this.snapshots.delete(key);
    const snapshot = await this.snapshot(account);
    if (snapshot.mode === "legacy" && snapshot.raw !== null) snapshot.parts = partition(JSON.parse(snapshot.raw)).parts;
    this.snapshots.set(key, snapshot);
    return snapshot.raw;
  }
  release(account: string, owner?: object): void {
    this.snapshots.delete(this.owner(account, owner));
  }
  async save(account: string, json: string, owner?: object): Promise<void> {
    const key = this.owner(account, owner);
    const baseline = this.snapshots.get(key);
    if (!baseline) throw new Error("Database must be successfully loaded before saving");
    const data: unknown = JSON.parse(json);
    const next = partition(data);
    // Only what changed: the rest was loaded from storage and saved before.
    validateChangedRecords(data, next, baseline.parts);
    const unchanged =
      baseline.mode === "legacy"
        ? baseline.legacy === json
        : baseline.manifest !== null &&
          sameKey(baseline.manifest.fields, next.fields) &&
          baseline.parts.size === next.parts.size &&
          [...next.parts].every(([key, value]) => baseline.parts.get(key) === value);
    let manifest = baseline.manifest;
    await this.transaction<void>("readwrite", (store, done, fail) => {
      const mode = store.get(MODE_KEY);
      const cleanup = store.get(CLEANUP_KEY);
      const legacy = store.get(account);
      const request = store.get(recordKey(account, "$manifest"));
      request.onsuccess = () => {
        try {
          const current = parseManifest(request.result);
          if (cleanup.result !== undefined) throw new Error("Migration cleanup is incomplete");
          if (
            mode.result !== baseline.mode ||
            (legacy.result ?? null) !== baseline.legacy ||
            (current?.revision ?? null) !== (baseline.manifest?.revision ?? null)
          )
            throw new Error("Database changed in another window; reload before saving");
          if (!unchanged) {
            if (baseline.mode === "legacy") store.put(json, account);
            else manifest = writeParts(store, account, next, newRevision(), baseline.parts);
          }
          done();
        } catch (error) {
          fail(error);
        }
      };
    });
    this.snapshots.set(key, {
      manifest: baseline.mode === "partitioned" ? manifest : null,
      legacy: baseline.mode === "legacy" ? json : null,
      raw: json,
      parts: next.parts,
      mode: baseline.mode,
    });
  }
  /** Import: validates every incoming database completely, then replaces the
   * accounts in one transaction (also an unreadable or unconverted account). */
  async replace(entries: { key: string; json: string }[]): Promise<void> {
    const prepared = entries.map((entry) => {
      const data: unknown = JSON.parse(entry.json);
      validateDatabaseObject(data);
      return { ...entry, next: partition(data) };
    });
    if (new Set(entries.map((entry) => entry.key)).size !== entries.length) throw new Error("Duplicate import account");
    await this.transaction<void>("readwrite", (store, done, fail) => {
      const choice = store.get(MODE_KEY);
      const cleanup = store.get(CLEANUP_KEY);
      cleanup.onsuccess = () => {
        try {
          if ((choice.result !== "legacy" && choice.result !== "partitioned") || cleanup.result !== undefined)
            throw new Error("Storage choice is incomplete");
          for (const entry of prepared) {
            store.delete(entry.key);
            store.delete(accountRange(entry.key));
            if (choice.result === "legacy") store.put(entry.json, entry.key);
            else writeParts(store, entry.key, entry.next, newRevision(), new Map());
          }
          done();
        } catch (error) {
          fail(error);
        }
      };
    });
    // Every other baseline of these accounts now fails its revision check.
    for (const entry of entries) this.defaultOwners.delete(entry.key);
  }
  async remove(account: string): Promise<void> {
    await this.transaction<void>("readwrite", (store, done) => {
      store.delete(account);
      store.delete(accountRange(account));
      store.delete(accountRange(account, ARCHIVE));
      store.delete(keptRange(account));
      done();
    });
    this.defaultOwners.delete(account);
  }
  async keys(): Promise<string[]> {
    const rows = await this.rows();
    return [
      ...new Set(
        rows.flatMap(([key]) =>
          isAccountKey(key) ? [key] : Array.isArray(key) && key[0] === PREFIX && typeof key[1] === "string" && key[2] === "$manifest" ? [key[1]] : []
        )
      ),
    ];
  }
  /** Every stored row, unchanged, for a recovery file when the app cannot start. */
  async dump(): Promise<{ key: IDBValidKey; value: unknown }[]> {
    return (await this.rows()).map(([key, value]) => ({ key, value }));
  }
}
