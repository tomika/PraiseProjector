import { PartitionedDatabaseStore } from "../db-common/PartitionedDatabaseStore";
import { databaseStorage } from "../db-common/DatabaseStorage";
import { compareAndSetStoredAccount, listStoredAccounts, readStoredAccount, type StoredAccount } from "../db-common/partitionedFormat";
import { Database } from "../db-common/Database";
import { Song } from "../db-common/Song";
import { Leader } from "../db-common/Leader";
import localforage from "localforage";
import React from "react";
import { createRoot, type Root } from "react-dom/client";
import { StorageChoiceGate } from "../src/components/StorageChoiceGate";
import { LocalizationProvider } from "../src/localization/LocalizationContext";
import { canAutomaticallyUpgradeAndroidStorage, includesPartitionedStorage } from "../src/services/androidStorageUpgrade";
import strings from "../src/localization/strings.en.json";
import { keepDatabaseCopies, readMigrationPackContents } from "../src/services/migrationPack";
import { COPY_INBOX, keptCopyEntryKey, parseDatabaseCopyKey } from "../db-common/databaseCopies";
import "bootstrap/dist/css/bootstrap.min.css";

const results: { name: string; error?: string }[] = [];
function assert(condition: unknown, message = "Assertion failed"): asserts condition {
  if (!condition) throw new Error(message);
}
function equal(actual: unknown, expected: unknown, label?: string): void {
  // Compare JSON semantics, independent of object property insertion order.
  const normalize = (value: unknown): unknown =>
    Array.isArray(value)
      ? value.map(normalize)
      : value && typeof value === "object"
        ? Object.fromEntries(
            Object.entries(value)
              .sort(([a], [b]) => a.localeCompare(b))
              .map(([k, v]) => [k, normalize(v)])
          )
        : value;
  assert(
    JSON.stringify(normalize(actual)) === JSON.stringify(normalize(expected)),
    `${label ? `${label}: ` : ""}Mismatch: ${JSON.stringify(actual)} != ${JSON.stringify(expected)}`
  );
}
async function rejects(action: () => Promise<unknown>): Promise<void> {
  let failed = false;
  try {
    await action();
  } catch {
    failed = true;
  }
  assert(failed, "Expected operation to fail");
}
async function test(name: string, action: () => Promise<void>): Promise<void> {
  await fetch("/progress", { method: "POST", body: `RUN ${name}` });
  try {
    await action();
    results.push({ name });
  } catch (error) {
    results.push({ name, error: error instanceof Error ? error.stack : String(error) });
  } finally {
    // A failed assertion must not leave its gate mounted for the next test.
    unmountGate();
  }
}
const dbName = "partitioned-regression-tests";
const account = "pp-database-user";
const prefix = "pp-partitioned-v1";
function open(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(dbName, 1);
    request.onupgradeneeded = () => request.result.createObjectStore("database");
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}
async function rawWrite(key: IDBValidKey, value?: unknown): Promise<void> {
  const db = await open();
  try {
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction("database", "readwrite");
      tx.oncomplete = () => resolve();
      tx.onabort = () => reject(tx.error);
      if (value === undefined) tx.objectStore("database").delete(key);
      else tx.objectStore("database").put(value, key);
    });
  } finally {
    db.close();
  }
}
/** One transaction on the test store, for the external-writer API. */
async function inStore<T>(
  mode: IDBTransactionMode,
  action: (store: IDBObjectStore, done: (value: T) => void, fail: (error: unknown) => void) => void
): Promise<T> {
  const db = await open();
  try {
    return await new Promise<T>((resolve, reject) => {
      const tx = db.transaction("database", mode);
      let result: T;
      let failure: unknown;
      tx.oncomplete = () => resolve(result);
      tx.onabort = () => reject(failure ?? tx.error);
      action(
        tx.objectStore("database"),
        (value) => {
          result = value;
        },
        (error) => {
          failure = error;
          tx.abort();
        }
      );
    });
  } finally {
    db.close();
  }
}
async function dump(opener = open): Promise<[IDBValidKey, unknown][]> {
  const db = await opener();
  try {
    return await new Promise((resolve, reject) => {
      const tx = db.transaction("database");
      const store = tx.objectStore("database");
      const keys = store.getAllKeys();
      const values = store.getAll();
      tx.oncomplete = () => resolve(keys.result.map((key, i) => [key, values.result[i]]));
      tx.onabort = () => reject(tx.error);
    });
  } finally {
    db.close();
  }
}

function state() {
  const s1 = new Song("{title: First song}\nLyrics");
  s1.Id = "s1";
  s1.version = 2;
  const s2 = new Song("{title: Second song}\nLyrics");
  s2.Id = "s2";
  s2.version = 3;
  const leader = {
    leaderId: "l1",
    leaderName: "Leader",
    version: 4,
    preferences: [{ songId: "s1", transpose: 2 }],
    playlists: [{ label: "Set", scheduled: "2026-11-13T17:00:00.000Z", songs: [{ songId: "s2", title: "Second song" }] }],
  };
  return {
    version: 7,
    songs: [s1.toJSON(), s2.toJSON()],
    leaders: [leader],
    publicLeaders: [],
    songBackup: [["s1", { version: 2, song: s1.toJSON() }]],
    profileBackup: [["l1", { version: 4, leader: structuredClone(leader) }]],
    futureField: { keep: true },
  };
}
async function clear(opener = open) {
  const db = await opener();
  try {
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction("database", "readwrite");
      tx.objectStore("database").clear();
      tx.oncomplete = () => resolve();
      tx.onabort = () => reject(tx.error);
    });
  } finally {
    db.close();
  }
}
async function fixture(mode: "legacy" | "partitioned" = "partitioned") {
  await clear();
  const data = state();
  const json = JSON.stringify(data);
  await rawWrite(account, json);
  const store = new PartitionedDatabaseStore(open);
  await store.choose(mode);
  equal(JSON.parse((await store.load(account))!), data);
  return { store, data, json };
}
function injectFailure(after: number, mode: "throw" | "abort") {
  const original = IDBObjectStore.prototype.put;
  let calls = 0;
  IDBObjectStore.prototype.put = function (...args: Parameters<IDBObjectStore["put"]>) {
    calls++;
    if (calls === after && mode === "throw") throw new DOMException("Injected quota error", "QuotaExceededError");
    const request = original.apply(this, args);
    if (calls === after && mode === "abort") this.transaction.abort();
    return request;
  };
  return () => {
    IDBObjectStore.prototype.put = original;
  };
}
async function waitFor(check: () => boolean) {
  for (let i = 0; i < 200; i++) {
    if (check()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("Timed out waiting for DOM");
}
const appLegacy = localforage.createInstance({ name: "PraiseProjector", storeName: "database" });
async function resetApp() {
  await appLegacy.ready();
  await appLegacy.clear();
  localStorage.clear();
}
let root: Root | null = null;
let host: HTMLDivElement | null = null;
/** `true`: Electron (hostDevice and electronAPI); a bridge object: Android
 * (hostDevice only); `false`: browser/PWA. */
function setRuntime(hasHostDevice: boolean | NonNullable<Window["hostDevice"]>) {
  Object.defineProperty(window, "hostDevice", {
    configurable: true,
    writable: true,
    value: hasHostDevice === true ? {} : hasHostDevice || undefined,
  });
  Object.defineProperty(window, "electronAPI", { configurable: true, writable: true, value: hasHostDevice === true ? {} : undefined });
}
function renderGate(hasHostDevice: boolean | NonNullable<Window["hostDevice"]> = true, strictMode = false) {
  setRuntime(hasHostDevice);
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  const gate = React.createElement(
    LocalizationProvider,
    null,
    React.createElement(StorageChoiceGate, null, React.createElement("div", { "data-app-mounted": "true" }, "Application"))
  );
  root.render(strictMode ? React.createElement(React.StrictMode, null, gate) : gate);
}
async function mountGate(expectChoice = true, hasHostDevice: boolean | NonNullable<Window["hostDevice"]> = true, strictMode = false) {
  renderGate(hasHostDevice, strictMode);
  await waitFor(() => !!host?.querySelector(expectChoice ? '[role="dialog"]' : "[data-app-mounted]"));
}
function unmountGate() {
  root?.unmount();
  host?.remove();
  root = null;
  host = null;
  setRuntime(false);
}
function checkBox(index: number) {
  const inputs = host!.querySelectorAll<HTMLInputElement>('input[type="checkbox"]');
  inputs[index].click();
}
async function run() {
  await test("no database consumer can bypass the mandatory storage choice", async () => {
    await clear();
    await rawWrite(account, JSON.stringify(state()));
    const store = new PartitionedDatabaseStore(open);
    const before = await dump();
    equal(await store.choice(), null);
    await rejects(() => store.load(account));
    await rejects(() => store.save(account, JSON.stringify(state())));
    await rejects(() => store.replace([{ key: account, json: JSON.stringify(state()) }]));
    equal(await dump(), before);
  });
  await test("conversion preserves every account, field, playlist and backup and deletes old sources", async () => {
    await clear();
    const data = state(),
      json = JSON.stringify(data);
    await rawWrite(account, json);
    await rawWrite("pp-database", json);
    const store = new PartitionedDatabaseStore(open);
    await store.choose("partitioned");
    equal(await store.choice(), "partitioned");
    equal(JSON.parse((await store.read(account))!), data);
    equal(JSON.parse((await store.read("pp-database"))!), data);
    const rows = await dump();
    assert(!rows.some(([key]) => typeof key === "string"));
    assert(!rows.some(([key]) => Array.isArray(key) && ["$source", "$base"].includes(String(key[2]))));
    equal((await store.keys()).sort(), [account, "pp-database"].sort());
    await rejects(() => store.choose("legacy"));
  });
  await test("legacy choice keeps one compatible JSON and saves the complete database", async () => {
    const { store, data } = await fixture("legacy");
    data.leaders[0].preferences[0].transpose = 6;
    await store.save(account, JSON.stringify(data));
    equal(await store.choice(), "legacy");
    assert(!(await dump()).some(([key]) => Array.isArray(key) && key[0] === prefix));
    equal(JSON.parse((await store.read(account))!), data);
  });
  await test("conversion compares JSON values without requiring object property order", async () => {
    await clear();
    const data = state();
    const profile = data.leaders[0];
    data.leaders[0] = {
      playlists: profile.playlists,
      preferences: profile.preferences,
      leaderName: profile.leaderName,
      version: profile.version,
      leaderId: profile.leaderId,
    };
    const json = JSON.stringify(data);
    await rawWrite(account, json);
    // A second, differently ordered but equivalent localStorage source must
    // not be mistaken for conflicting edits.
    const local = JSON.stringify({ ...data, leaders: [{ ...profile }] });
    assert(local !== json);
    const store = new PartitionedDatabaseStore(open);
    await store.choose("partitioned", [{ key: account, value: local }]);
    await store.finishCleanup({ getItem: () => null, removeItem: () => {} });
    equal(JSON.parse((await store.load(account))!), data);
  });
  await test("orphaned records without a manifest cannot be loaded or overwritten as an empty account", async () => {
    const { store, json } = await fixture();
    await rawWrite([prefix, account, "$manifest"]);
    const before = await dump();
    const restarted = new PartitionedDatabaseStore(open);
    await rejects(() => restarted.read(account));
    await rejects(() => restarted.load(account));
    await rejects(() => restarted.save(account, json));
    await rejects(() => store.save(account, json));
    equal(await dump(), before);
  });
  for (const mode of ["throw", "abort"] as const) {
    await test(`${mode} during multi-account conversion leaves every original and the undecided state intact`, async () => {
      await clear();
      const json = JSON.stringify(state());
      await rawWrite(account, json);
      await rawWrite("pp-database-other", json);
      const before = await dump();
      const store = new PartitionedDatabaseStore(open),
        restore = injectFailure(3, mode);
      try {
        await rejects(() => store.choose("partitioned"));
      } finally {
        restore();
      }
      equal(await dump(), before);
      equal(await store.choice(), null);
      await store.choose("partitioned");
      equal(JSON.parse((await store.read(account))!), state());
    });
  }
  await test("invalid content is converted verbatim, but never saved or imported", async () => {
    await clear();
    const invalid = state();
    (invalid.leaders[0].preferences as unknown[]) = [{ transpose: 9 }];
    const bad = JSON.stringify(invalid);
    await rawWrite(account, bad);
    const store = new PartitionedDatabaseStore(open);
    await store.choose("partitioned");
    // Judging content is the application loader's job; storage loses nothing.
    assert((await store.read(account)) === bad);
    const valid = await fixture();
    const saved = await dump();
    await rejects(() => valid.store.save(account, bad));
    await rejects(() => valid.store.replace([{ key: account, json: bad }]));
    equal(await dump(), saved);
  });
  await test("duplicates and same-date or undated playlists are kept verbatim and never block conversion", async () => {
    for (const kind of ["song", "profile", "preference", "same-date playlist", "undated playlist"]) {
      await clear();
      const data = state();
      if (kind === "song") data.songs.push(data.songs[0]);
      if (kind === "profile") data.leaders.push(structuredClone(data.leaders[0]));
      if (kind === "preference") data.leaders[0].preferences.push({ songId: "s1", transpose: 4 });
      if (kind === "same-date playlist") data.leaders[0].playlists.push(structuredClone(data.leaders[0].playlists[0]));
      if (kind === "undated playlist") data.leaders[0].playlists[0].scheduled = "invalid";
      const json = JSON.stringify(data);
      await rawWrite(account, json);
      await rawWrite("pp-database-other", JSON.stringify(state()));
      const store = new PartitionedDatabaseStore(open);
      await store.choose("partitioned");
      assert((await store.read(account)) === json, kind);
      equal(JSON.parse((await store.read("pp-database-other"))!), state());
    }
    // A collection without unique identities is one record until the app saves it normalized.
    await clear();
    const duplicated = state();
    duplicated.songs.push(duplicated.songs[0]);
    await rawWrite(account, JSON.stringify(duplicated));
    const store = new PartitionedDatabaseStore(open);
    await store.choose("partitioned");
    await store.load(account);
    await store.save(account, JSON.stringify(state()));
    const keys = (await dump()).map(([key]) => JSON.stringify(key));
    assert(keys.includes(JSON.stringify([prefix, account, '["songs","s1"]'])));
    assert(!keys.includes(JSON.stringify([prefix, account, '["songs"]'])));
    equal(JSON.parse((await store.read(account))!), state());
  });
  await test("conversion keeps the exact JSON text, including property order", async () => {
    await clear();
    const data = state();
    const profile = data.leaders[0];
    (data.leaders as unknown[])[0] = {
      leaderId: profile.leaderId,
      preferences: profile.preferences,
      leaderName: profile.leaderName,
      playlists: profile.playlists,
      version: profile.version,
    };
    const json = JSON.stringify(data);
    await rawWrite(account, json);
    const store = new PartitionedDatabaseStore(open);
    await store.choose("partitioned");
    assert((await store.read(account)) === json);
    await store.load(account);
    await store.save(account, json);
    assert((await new PartitionedDatabaseStore(open).read(account)) === json);
  });
  await test("a text that is not a database object closes only its own account until an import replaces it", async () => {
    await clear();
    const json = JSON.stringify(state());
    await rawWrite(account, "{broken");
    await rawWrite("pp-database-other", json);
    const store = new PartitionedDatabaseStore(open);
    await store.choose("partitioned");
    equal(await store.choice(), "partitioned");
    assert((await store.read("pp-database-other")) === json);
    equal((await dump()).find(([key]) => key === account)?.[1], "{broken");
    await rejects(() => store.load(account));
    await rejects(() => store.save(account, json));
    await store.replace([{ key: account, json }]);
    assert((await store.read(account)) === json);
    assert(!(await dump()).some(([key]) => typeof key === "string"));
  });
  await test("prototype archives neither block conversion nor change, and leave with their account", async () => {
    await clear();
    await rawWrite(account, JSON.stringify(state()));
    const archive = ["pp-partitioned-v1-archive", account, "copy"];
    await rawWrite(archive, "archived");
    const store = new PartitionedDatabaseStore(open);
    await store.choose("partitioned");
    equal(JSON.parse((await store.read(account))!), state());
    equal((await dump()).find(([key]) => JSON.stringify(key) === JSON.stringify(archive))?.[1], "archived");
    await store.remove(account);
    equal(await dump(), [[["pp-storage-v1", "mode"], "partitioned"]]);
  });
  await test("saves validate the top-level shape and every changed record", async () => {
    const { store, data, json } = await fixture();
    const broken = structuredClone(data);
    (broken.songs[1] as unknown as Record<string, unknown>).songdata = 5;
    await rejects(() => store.save(account, JSON.stringify(broken)));
    const missing: Record<string, unknown> = structuredClone(data);
    delete missing.songs;
    await rejects(() => store.save(account, JSON.stringify(missing)));
    const badBackup = structuredClone(data);
    (badBackup.profileBackup[0][1] as { leader: unknown }).leader = { leaderId: "l1" };
    await rejects(() => store.save(account, JSON.stringify(badBackup)));
    assert((await store.read(account)) === json);
  });
  await test("external writers read and compare-and-set accounts in the selected format", async () => {
    const { json } = await fixture();
    const read = () => inStore<StoredAccount>("readonly", (store, done, fail) => readStoredAccount(store, account, done, fail));
    const cas = (expected: string | null, next: string | undefined) =>
      inStore<boolean>("readwrite", (store, done, fail) => compareAndSetStoredAccount(store, account, expected, next, done, fail));
    const current = await read();
    assert(current.mode === "partitioned" && current.value === json && !current.blocked);
    equal(await inStore<string[]>("readonly", (store, done) => listStoredAccounts(store, done)), [account]);
    const next = JSON.stringify({ ...state(), version: 50 });
    assert(!(await cas("stale", next)));
    assert(await cas(json, next));
    assert(!(await dump()).some(([key]) => typeof key === "string"));
    assert((await new PartitionedDatabaseStore(open).load(account)) === next);
    assert(await cas(next, undefined));
    equal((await read()).value, null);
    equal(await inStore<string[]>("readonly", (store, done) => listStoredAccounts(store, done)), []);
    assert(await cas(null, json));
    // An account the app refuses (here: an older version's write) is never replaced.
    await rawWrite(account, next);
    const blocked = await read();
    assert(blocked.blocked && blocked.value === json);
    assert(!(await cas(json, next)));
    // Orphaned records are not overwritten either.
    await rawWrite(account);
    await rawWrite([prefix, account, "$manifest"]);
    assert((await read()).blocked);
    assert(!(await cas(null, next)));
    const legacy = await fixture("legacy");
    assert(await cas(legacy.json, next));
    equal((await dump()).find(([key]) => key === account)?.[1], next);
    assert(!(await dump()).some(([key]) => Array.isArray(key) && key[0] === prefix));
  });
  await test("external writers never replace an account the app refuses", async () => {
    const read = () => inStore<StoredAccount>("readonly", (store, done, fail) => readStoredAccount(store, account, done, fail));
    const cas = (expected: string | null, next: string) =>
      inStore<boolean>("readwrite", (store, done, fail) => compareAndSetStoredAccount(store, account, expected, next, done, fail));
    const json = JSON.stringify(state());
    // A text kept unconverted at its legacy key in partitioned mode.
    await clear();
    await rawWrite(account, "{broken");
    await new PartitionedDatabaseStore(open).choose("partitioned");
    const unconverted = await read();
    assert(unconverted.blocked && unconverted.value === "{broken");
    assert(!(await cas("{broken", json)));
    equal((await dump()).find(([key]) => key === account)?.[1], "{broken");
    // A text that is not a database object, in legacy mode.
    await clear();
    await rawWrite(account, "{broken");
    await new PartitionedDatabaseStore(open).choose("legacy");
    assert((await read()).blocked);
    assert(!(await cas("{broken", json)));
    // An unfinished localStorage cleanup keeps the application gated.
    await clear();
    await rawWrite(account, json);
    await new PartitionedDatabaseStore(open).choose("partitioned", [{ key: "pp-database-other", value: json }]);
    const pending = await read();
    assert(pending.blocked && pending.gated && pending.value === json);
    assert(!(await cas(json, JSON.stringify({ ...state(), version: 9 }))));
    assert(pending.value === (await read()).value);
  });
  await test("pack imports keep further stored copies content-addressed and never import them", async () => {
    const digest = async (text: string) =>
      Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text))), (byte) =>
        byte.toString(16).padStart(2, "0")
      ).join("");
    const payload = JSON.stringify({ version: 1, marker: "copy", songs: [], leaders: [] });
    const sha = await digest(payload);
    const entry = (key: string, sha256 = sha) => ({ id: `database-copy:${key}`, kind: "database-copy", key, payload, sha256 });
    const pack = (entries: unknown[]) => JSON.stringify({ format: "pp-site-migration-v1", entries });
    const readCopies = async (text: string) => (await readMigrationPackContents(text))!.copies;
    const copies = await readCopies(
      pack([
        entry("pp-database-user#localStorage"),
        // The same copy exported again after an earlier import keeps its key.
        entry(`pp-database-user#localStorage#${sha}`),
        entry("not-a-database#localStorage"),
      ])
    );
    const inboxKey = `copy:pp-database-user#localStorage#${sha}`;
    equal(
      copies.map((copy) => copy.inboxKey),
      [inboxKey, inboxKey]
    );
    await rejects(() => readCopies(pack([entry("pp-database-user#localStorage", "0".repeat(64))])));
    const inbox = localforage.createInstance({ name: COPY_INBOX.name, storeName: COPY_INBOX.storeName });
    await inbox.clear();
    await keepDatabaseCopies(copies);
    equal(await inbox.keys(), [inboxKey]);
    equal(await inbox.getItem(inboxKey), payload);
    equal(keptCopyEntryKey(inboxKey), `pp-database-user#localStorage#${sha}`);
    equal(parseDatabaseCopyKey("pp-database-a#b#indexeddb-records"), { account: "pp-database-a#b", source: "indexeddb-records", digest: null });
    equal(parseDatabaseCopyKey("pp-database-a#unknown"), null);
    // A kept copy is never overwritten (an unverified digest could name two copies).
    await rejects(() => keepDatabaseCopies([{ inboxKey, payload: "a different copy" }]));
    equal(await inbox.getItem(inboxKey), payload);
    await inbox.clear();
  });
  await test("external readers list every stored account and report every copy the value lacks", async () => {
    const read = (key = account) => inStore<StoredAccount>("readonly", (store, done, fail) => readStoredAccount(store, key, done, fail));
    const list = () => inStore<string[]>("readonly", (store, done) => listStoredAccounts(store, done));
    const { json } = await fixture();
    equal((await read()).extra, []);
    assert((await read()).fromRecords);
    // A given localStorage copy: the same JSON in another property order is no
    // further copy (as the app compares), a different one is, and once a format
    // is chosen any copy makes the app refuse the account.
    const withLocal = (localCopy: string) =>
      inStore<StoredAccount>("readonly", (store, done, fail) => readStoredAccount(store, account, done, fail, { localCopy }));
    const reordered = JSON.stringify(Object.fromEntries(Object.entries(JSON.parse(json)).reverse()));
    assert(reordered !== json);
    const sameLocal = await withLocal(reordered);
    assert(sameLocal.blocked);
    equal(sameLocal.extra, []);
    const differentLocal = JSON.stringify({ ...state(), version: 2 });
    equal((await withLocal(differentLocal)).extra, [{ source: "localStorage", payload: differentLocal }]);
    assert(
      !(await inStore<boolean>("readwrite", (store, done, fail) =>
        compareAndSetStoredAccount(store, account, json, differentLocal, done, fail, { localCopy: differentLocal })
      ))
    );
    // A legacy text beside the records (an older version's write).
    const older = JSON.stringify({ ...state(), version: 3 });
    await rawWrite(account, older);
    const beside = await read();
    assert(beside.value === json && beside.blocked);
    equal(beside.extra, [{ source: "indexeddb-legacy", payload: older }]);
    // Records without a manifest are listed and carried as raw rows.
    await rawWrite(account);
    await rawWrite([prefix, account, "$manifest"]);
    equal(await list(), [account]);
    const orphaned = await read();
    assert(orphaned.value === null && orphaned.blocked && orphaned.extra.length === 1);
    assert(orphaned.extra[0].source === "indexeddb-records");
    const rows = JSON.parse(orphaned.extra[0].payload) as [string, string][];
    assert(rows.length > 0 && rows.every(([part, value]) => part !== "$manifest" && typeof value === "string"));
    assert(!orphaned.fromRecords);
    // An account with nothing but a kept copy left is still listed, so exports carry it.
    await rawWrite(["pp-storage-v1", "kept", "pp-database-ghost", "localStorage", "id"], "ghost copy");
    equal((await list()).sort(), [account, "pp-database-ghost"].sort());
    const ghost = await inStore<StoredAccount>("readonly", (store, done, fail) => readStoredAccount(store, "pp-database-ghost", done, fail));
    assert(ghost.value === null);
    equal(ghost.kept, [{ source: "localStorage", payload: "ghost copy" }]);
  });
  await test("localStorage cleanup resumes after a crash/error and never removes a changed source", async () => {
    await clear();
    const store = new PartitionedDatabaseStore(open),
      json = JSON.stringify(state());
    const values = new Map([[account, json]]);
    const storage = {
      getItem: (key: string) => values.get(key) ?? null,
      removeItem: (key: string) => {
        values.delete(key);
      },
    };
    await store.choose("partitioned", [{ key: account, value: json }]);
    await rejects(() => store.load(account));
    await rejects(() =>
      store.finishCleanup({
        ...storage,
        removeItem: () => {
          throw new Error("Blocked storage");
        },
      })
    );
    equal(values.get(account), json);
    const restarted = new PartitionedDatabaseStore(open);
    await Promise.all([restarted.finishCleanup(storage), store.finishCleanup(storage)]);
    equal(values.size, 0);
    equal(JSON.parse((await restarted.load(account))!), state());
    assert(!(await dump()).some(([key]) => JSON.stringify(key).includes("cleanup")));
    // A source an older window changed after the conversion is never removed,
    // and it does not keep the cleanup (and so the whole app) from finishing:
    // it stays as a later localStorage copy that closes only its own account.
    await clear();
    values.set(account, json);
    const converted = new PartitionedDatabaseStore(open);
    await converted.choose("partitioned", [{ key: account, value: json }]);
    values.set(account, json + " ");
    await converted.finishCleanup(storage);
    equal(values.get(account), json + " ");
    assert(!(await dump()).some(([key]) => JSON.stringify(key).includes("cleanup")));
    equal(JSON.parse((await converted.load(account))!), state());
  });
  await test("a differing localStorage copy is kept apart and never blocks conversion", async () => {
    await clear();
    const json = JSON.stringify(state());
    await rawWrite(account, json);
    await rawWrite("pp-database-other", json);
    const other = JSON.stringify({ ...state(), version: 99 });
    const store = new PartitionedDatabaseStore(open);
    await store.choose("partitioned", [{ key: account, value: other }]);
    const values = new Map([[account, other]]);
    await store.finishCleanup({ getItem: (key) => values.get(key) ?? null, removeItem: (key) => void values.delete(key) });
    equal(values.size, 0);
    // The account keeps its IndexedDB copy (what every earlier version read) …
    assert((await store.load(account)) === json);
    equal(JSON.parse((await store.read("pp-database-other"))!), state());
    // … and the other copy is kept inert in the store, carried by every export.
    const kept = (await dump()).filter(([key]) => Array.isArray(key) && key[0] === "pp-storage-v1" && key[1] === "kept");
    equal(
      kept.map(([key, value]) => [(key as unknown[])[2], (key as unknown[])[3], value]),
      [[account, "localStorage", other]]
    );
    const stored = await inStore<StoredAccount>("readonly", (s, done, fail) => readStoredAccount(s, account, done, fail));
    equal(stored.kept, [{ source: "localStorage", payload: other }]);
    assert(!stored.blocked);
    // Removing the account removes its kept copies too.
    await store.remove(account);
    assert(!(await dump()).some(([key]) => Array.isArray(key) && key[1] === "kept"));
  });
  await test("cleanup rechecks each local source after earlier removals and retains changed data", async () => {
    await clear();
    const store = new PartitionedDatabaseStore(open);
    const json = JSON.stringify(state()),
      changed = JSON.stringify({ ...state(), version: 99 });
    const other = "pp-database-other";
    const values = new Map([
      [account, json],
      [other, json],
    ]);
    await store.choose(
      "partitioned",
      [...values].map(([key, value]) => ({ key, value }))
    );
    const storage = {
      getItem: (key: string) => values.get(key) ?? null,
      removeItem: (key: string) => {
        values.delete(key);
        // Model another old window writing while earlier accounts are removed.
        if (key === account) values.set(other, changed);
      },
    };
    await store.finishCleanup(storage);
    equal(values.get(other), changed);
    equal(values.has(account), false);
    assert(!(await dump()).some(([key]) => JSON.stringify(key).includes("cleanup")));
    equal(JSON.parse((await store.load(account))!), state());
  });
  await test("a concurrent old-version write aborts conversion instead of overwriting it", async () => {
    await clear();
    await rawWrite(account, JSON.stringify(state()));
    let calls = 0;
    const changed = JSON.stringify({ ...state(), version: 99 });
    // Opens: 1 the format key, 2 every record, 3 the commit; the old version
    // writes after everything was read and validated, right before the commit.
    const store = new PartitionedDatabaseStore(async () => {
      if (++calls === 3) await rawWrite(account, changed);
      return open();
    });
    await rejects(() => store.choose("partitioned"));
    equal(calls, 3);
    equal(await store.choice(), null);
    equal((await dump()).find(([key]) => key === account)?.[1], changed);
  });
  await test("preference saves write no songs or playlists; unchanged saves write nothing", async () => {
    const { store, data, json } = await fixture();
    const writes: string[] = [];
    const original = IDBObjectStore.prototype.put;
    IDBObjectStore.prototype.put = function (value, key) {
      writes.push(JSON.stringify(key));
      return original.call(this, value, key);
    };
    try {
      await store.save(account, json);
      equal(writes, []);
      data.leaders[0].preferences[0].transpose = 6;
      await store.save(account, JSON.stringify(data));
      equal(writes.length, 2);
      assert(writes.every((key) => !key.includes("songs") && !key.includes("playlists")));
    } finally {
      IDBObjectStore.prototype.put = original;
    }
    equal(JSON.parse((await store.read(account))!), data);
  });
  await test("one-song edits, addition/deletion and failed incremental writes are atomic", async () => {
    const { store, data } = await fixture();
    data.songs[0].songdata.text = "{title: Edited}\nLyrics";
    await store.save(account, JSON.stringify(data));
    const before = await dump();
    data.songs.shift();
    data.leaders[0].preferences[0].transpose = 9;
    const restore = injectFailure(2, "abort");
    try {
      await rejects(() => store.save(account, JSON.stringify(data)));
    } finally {
      restore();
    }
    equal(await dump(), before);
    await store.save(account, JSON.stringify(data));
    equal(JSON.parse((await new PartitionedDatabaseStore(open).load(account))!), data);
  });
  await test("a large catalogue still writes only the changed preference, then only the changed song", async () => {
    const { store, data } = await fixture();
    const templates = data.songs;
    data.songs = Array.from({ length: 2000 }, (_, index) => {
      const song = structuredClone(templates[index % 2]);
      song.songId = `large-${index}`;
      song.songdata.text = `{title: Song ${index}}\n${"lyrics ".repeat(300)}`;
      return song;
    });
    const json = JSON.stringify(data);
    await store.save(account, json);
    const original = IDBObjectStore.prototype.put;
    const writes: { key: string; bytes: number }[] = [];
    IDBObjectStore.prototype.put = function (value, key) {
      writes.push({ key: JSON.stringify(key), bytes: new TextEncoder().encode(String(value)).length });
      return original.call(this, value, key);
    };
    try {
      data.leaders[0].preferences[0].transpose = 8;
      const started = performance.now();
      await store.save(account, JSON.stringify(data));
      const elapsed = Math.round(performance.now() - started);
      equal(writes.length, 2);
      assert(writes.every((write) => !write.key.includes("songs")));
      const bytes = writes.reduce((total, write) => total + write.bytes, 0);
      assert(bytes < json.length / 10);
      await fetch("/progress", {
        method: "POST",
        body: `Large catalogue: ${json.length} bytes; preference save: ${bytes} bytes, ${writes.length} puts, ${elapsed} ms`,
      });
      writes.length = 0;
      data.songs[17].songdata.text += "changed";
      await store.save(account, JSON.stringify(data));
      equal(
        writes.filter((write) => write.key.includes('\\"songs\\"')).map((write) => JSON.parse(write.key)[2]),
        ['["songs","large-17"]']
      );
    } finally {
      IDBObjectStore.prototype.put = original;
    }
  });
  await test("a stale window cannot overwrite another window's saved edits", async () => {
    const { store, data, json } = await fixture();
    const stale = new PartitionedDatabaseStore(open);
    await stale.load(account);
    data.leaders[0].version = 0;
    data.leaders[0].preferences[0].transpose = 6;
    await store.save(account, JSON.stringify(data));
    await stale.read(account);
    await rejects(() => stale.save(account, json));
    equal(JSON.parse((await store.read(account))!).leaders[0].version, 0);
  });
  await test("old-version writes after opting in are refused, never merged over pending preferences", async () => {
    const { store, data } = await fixture();
    data.leaders[0].version = 0;
    data.leaders[0].preferences[0].transpose = 6;
    await store.save(account, JSON.stringify(data));
    const older = state();
    older.leaders[0].version = 5;
    older.leaders[0].preferences[0].transpose = 9;
    await rawWrite(account, JSON.stringify(older));
    const before = await dump();
    await rejects(() => store.load(account));
    await rejects(() => store.read(account));
    await rejects(() => store.save(account, JSON.stringify(older)));
    equal(await dump(), before);
    const stored = (await dump()).find(([key]) => JSON.stringify(key) === JSON.stringify([prefix, account, '["leaders","l1","preferences"]']));
    equal(JSON.parse(stored?.[1] as string)[0].transpose, 6);
  });
  await test("multi-account imports are atomic and can recover an unreadable account", async () => {
    const { store, json } = await fixture();
    await store.replace([{ key: "pp-database-other", json }]);
    const before = await dump(),
      updated = JSON.stringify({ ...state(), version: 100 });
    const restore = injectFailure(4, "throw");
    try {
      await rejects(() =>
        store.replace([
          { key: account, json: updated },
          { key: "pp-database-other", json: updated },
        ])
      );
    } finally {
      restore();
    }
    equal(await dump(), before);
    await rawWrite([prefix, account, "$manifest"], JSON.stringify({ format: 99 }));
    await rejects(() => store.load(account));
    await store.replace([
      { key: account, json: updated },
      { key: "pp-database-other", json: updated },
    ]);
    equal(JSON.parse((await store.read(account))!).version, 100);
    assert(!(await dump()).some(([key]) => typeof key === "string"));
  });
  await test("prototype copies are consolidated only when their original source still matches", async () => {
    const { json } = await fixture();
    const rows = (await dump()).filter(([key]) => Array.isArray(key) && key[0] === prefix);
    await clear();
    for (const [key, value] of rows) await rawWrite(key, value);
    await rawWrite(account, json);
    await rawWrite([prefix, account, "$source"], json);
    const store = new PartitionedDatabaseStore(open);
    await store.choose("partitioned");
    assert(!(await dump()).some(([key]) => key === account));
    await clear();
    for (const [key, value] of rows) await rawWrite(key, value);
    await rawWrite(account, JSON.stringify({ ...state(), version: 99 }));
    await rawWrite([prefix, account, "$source"], json);
    const before = await dump();
    await rejects(() => store.choose("partitioned"));
    equal(await dump(), before);
  });
  await test("startup dialog cannot be dismissed; new choice needs backup and downgrade acknowledgments", async () => {
    await resetApp();
    await appLegacy.setItem(account, JSON.stringify(state()));
    localStorage.setItem("pp-settings", JSON.stringify({ language: "hu" }));
    await fetch("/viewport?width=320&height=568");
    await mountGate();
    const dialog = host!.querySelector<HTMLElement>('[role="dialog"]')!;
    equal(window.innerWidth, 320);
    await fetch("/capture?name=storage-choice-phone-top");
    const buttons = host!.querySelectorAll<HTMLButtonElement>("button");
    equal(buttons.length, 2);
    assert(buttons[0].disabled && buttons[1].disabled);
    assert(!host!.querySelector("[data-app-mounted]"));
    dialog.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    host!.querySelector<HTMLElement>(".modal-backdrop")!.click();
    assert(host!.querySelector('[role="dialog"]'));
    assert(document.documentElement.scrollWidth <= window.innerWidth);
    const last = buttons[1];
    last.scrollIntoView({ block: "end" });
    assert(last.getBoundingClientRect().bottom <= window.innerHeight + 1);
    await fetch("/capture?name=storage-choice-phone");
    checkBox(0);
    await waitFor(() => !host!.querySelector<HTMLInputElement>("input")?.disabled);
    assert(buttons[0].disabled && buttons[1].disabled);
    checkBox(1);
    await waitFor(() => !buttons[0].disabled);
    assert(buttons[1].disabled);
    buttons[0].click();
    await waitFor(() => !!host?.querySelector("[data-app-mounted]"));
    equal(await databaseStorage.getChoice(), "partitioned");
    unmountGate();
  });
  await test("old choice requires its two separate consents and the shared backup acknowledgment", async () => {
    await resetApp();
    await appLegacy.setItem(account, JSON.stringify(state()));
    localStorage.setItem("pp-settings", JSON.stringify({ language: "hu" }));
    await fetch("/viewport?width=1024&height=900");
    await mountGate();
    const buttons = host!.querySelectorAll<HTMLButtonElement>("button");
    await fetch("/capture?name=storage-choice-desktop");
    checkBox(2);
    checkBox(3);
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert(buttons[1].disabled);
    checkBox(0);
    await waitFor(() => !buttons[1].disabled);
    assert(buttons[0].disabled);
    document.documentElement.setAttribute("data-theme", "dark");
    document.body.setAttribute("data-bs-theme", "dark");
    buttons[1].scrollIntoView({ block: "end" });
    await new Promise((resolve) => setTimeout(resolve, 200));
    await fetch("/capture?name=storage-choice-desktop-dark");
    await fetch("/viewport?width=320&height=568");
    buttons[1].scrollIntoView({ block: "end" });
    await fetch("/capture?name=storage-choice-phone-dark");
    document.documentElement.removeAttribute("data-theme");
    document.body.removeAttribute("data-bs-theme");
    buttons[1].click();
    await waitFor(() => !!host?.querySelector("[data-app-mounted]"));
    equal(await databaseStorage.getChoice(), "legacy");
    unmountGate();
  });
  await test("the durable choice is remembered without prompting again", async () => {
    await mountGate(false);
    assert(!host!.querySelector('[role="dialog"]'));
    equal(await databaseStorage.getChoice(), "legacy");
    unmountGate();
  });
  await test("failed choice stays gated and can be retried without partial conversion", async () => {
    await resetApp();
    await appLegacy.setItem(account, JSON.stringify(state()));
    await mountGate();
    checkBox(0);
    checkBox(1);
    const button = host!.querySelector<HTMLButtonElement>("button")!;
    await waitFor(() => !button.disabled);
    const restore = injectFailure(3, "throw");
    try {
      button.click();
      await waitFor(() => !!host?.querySelector('[role="alert"]'));
      assert(!host!.querySelector("[data-app-mounted]"));
      equal(await databaseStorage.getChoice(), null);
    } finally {
      restore();
    }
    button.click();
    await waitFor(() => !!host?.querySelector("[data-app-mounted]"));
    unmountGate();
  });
  await test("a fresh installation (nothing stored) gets the new format without a question, also on Electron", async () => {
    const openApp = () =>
      new Promise<IDBDatabase>((resolve, reject) => {
        const request = indexedDB.open("PraiseProjector");
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
      });
    for (const runtime of [true, false] as const) {
      await resetApp();
      let displayedChoice = false;
      const observer = new MutationObserver(() => {
        displayedChoice ||= !!document.querySelector('[role="dialog"]');
      });
      observer.observe(document.body, { childList: true, subtree: true });
      try {
        await mountGate(false, runtime, true);
        assert(!displayedChoice, `dialog shown (${runtime ? "Electron" : "PWA"})`);
        equal(await databaseStorage.getChoice(), "partitioned");
        equal((await dump(openApp)).length, 1);
      } finally {
        observer.disconnect();
        unmountGate();
      }
    }
    // Two windows starting at once: the one that finds the store already decided uses that format.
    await resetApp();
    equal(await Promise.all([databaseStorage.prepareForRuntime("choice"), databaseStorage.prepareForRuntime("choice")]), [
      "partitioned",
      "partitioned",
    ]);
    // Any stored database, even only a localStorage copy, still asks on Electron.
    for (const seed of [
      () => appLegacy.setItem(account, JSON.stringify(state())),
      async () => localStorage.setItem(account, JSON.stringify(state())),
    ]) {
      await resetApp();
      await seed();
      await mountGate(true, true);
      equal(await databaseStorage.getChoice(), null);
      unmountGate();
    }
    // Only an empty store is decided, atomically: nothing else is written.
    await resetApp();
    await appLegacy.setItem(account, JSON.stringify(state()));
    const before = await dump(openApp);
    equal(await new PartitionedDatabaseStore(openApp).chooseIfEmpty("partitioned"), null);
    equal(await dump(openApp), before);
  });

  await test("a legacy refusal is remembered per frontend version and every unseen version asks again", async () => {
    await resetApp();
    const json = JSON.stringify(state());
    await appLegacy.setItem(account, json);
    await databaseStorage.choose("legacy", "2.0.94");
    equal(await databaseStorage.prepareForRuntime("choice", "2.0.94"), "legacy");
    equal(await databaseStorage.prepareForRuntime("choice", "2.0.95"), null);
    equal(await appLegacy.getItem(account), json);
    const restore = injectFailure(1, "throw");
    try {
      await rejects(() => databaseStorage.choose("legacy", "2.0.95"));
    } finally {
      restore();
    }
    equal(await databaseStorage.prepareForRuntime("choice", "2.0.95"), null);
    await databaseStorage.choose("legacy", "2.0.95");
    equal(await databaseStorage.prepareForRuntime("choice", "2.0.95"), "legacy");
    equal(await databaseStorage.prepareForRuntime("choice", "2.0.94"), "legacy");
    equal(await databaseStorage.prepareForRuntime("choice", "2.0.96"), null);
    equal(await appLegacy.getItem(account), json);
    await databaseStorage.choose("partitioned", "2.0.96");
    equal(await databaseStorage.prepareForRuntime("choice", "2.0.97"), "partitioned");
    equal(JSON.parse((await databaseStorage.getRaw("user"))!), state());
    equal(await appLegacy.getItem(account), null);
  });
  await test("an unversioned legacy preference asks once and then remembers this version", async () => {
    await resetApp();
    await appLegacy.setItem(account, JSON.stringify(state()));
    const appStore = new PartitionedDatabaseStore(
      async () =>
        new Promise<IDBDatabase>((resolve, reject) => {
          const request = indexedDB.open("PraiseProjector");
          request.onsuccess = () => resolve(request.result);
          request.onerror = () => reject(request.error);
        })
    );
    await appStore.choose("legacy");
    equal(await databaseStorage.prepareForRuntime("choice", "2.0.95"), null);
    await databaseStorage.choose("legacy", "2.0.95");
    equal(await databaseStorage.prepareForRuntime("choice", "2.0.95"), "legacy");
  });
  const androidStatus = () => ({ factoryVersion: "2.0.95", runningVersion: "2.0.95", activeReleaseId: null, pendingReleaseId: null });
  const androidHost = (version = "2.0.95", status: unknown = androidStatus(), debug = false): NonNullable<Window["hostDevice"]> => ({
    version: () => version,
    isDebugBuild: () => debug,
    getWebAppBundleStatus: () => JSON.stringify(status),
  });
  await test("storage versions compare their x.y.z part from 2.0.94 on, also with a build label", async () => {
    for (const version of ["2.0.94", "2.0.94-pp-debug", "2.0.95-pp-debug", "2.0.94+build.7", "2.0.100", "2.1.0", "3.0.0"])
      equal(includesPartitionedStorage(version), true, version);
    for (const version of [
      "2.0.93",
      "2.0.93-pp-debug",
      "2.0.9",
      "1.9.99",
      "2.0.0-pp-debug",
      "2.0.94-",
      "2.0.94pp",
      "02.0.94",
      "2.0",
      "",
      "not-a-version",
      null,
      2094,
    ])
      equal(includesPartitionedStorage(version), false, String(version));
  });
  await test("Android upgrades automatically only when its factory and every other frontend include the new storage", async () => {
    equal(await canAutomaticallyUpgradeAndroidStorage(androidHost()), true);
    equal(
      await canAutomaticallyUpgradeAndroidStorage(androidHost("2.0.94", { ...androidStatus(), factoryVersion: "2.0.94", runningVersion: "2.0.94" })),
      true
    );
    // Debug builds qualify like releases once the debug install sets their version.
    equal(await canAutomaticallyUpgradeAndroidStorage(androidHost("2.0.95-pp-debug", undefined, true)), true);
    equal(await canAutomaticallyUpgradeAndroidStorage({ ...androidHost(), isDebugBuild: undefined }), true);
    for (const version of ["2.0.93", "2.0.0-pp-debug", "", "not-a-version"])
      equal(await canAutomaticallyUpgradeAndroidStorage(androidHost(version)), false, version);
    equal(await canAutomaticallyUpgradeAndroidStorage({ ...androidHost(), version: undefined }), false);
    equal(await canAutomaticallyUpgradeAndroidStorage({ ...androidHost(), getWebAppBundleStatus: undefined }), false);
    equal(
      await canAutomaticallyUpgradeAndroidStorage({
        ...androidHost(),
        version: () => {
          throw new Error("bridge failure");
        },
      }),
      false
    );
    equal(await canAutomaticallyUpgradeAndroidStorage({ ...androidHost(), getWebAppBundleStatus: () => "{" }), false);
    equal(await canAutomaticallyUpgradeAndroidStorage({ ...androidHost(), version: () => new Promise<string>(() => {}) }), false);
    for (const status of [
      { ...androidStatus(), factoryVersion: "2.0.93" },
      { ...androidStatus(), factoryVersion: undefined },
      { ...androidStatus(), runningVersion: "2.0.93" },
      { ...androidStatus(), activeReleaseId: "old", activeVersion: "2.0.93" },
      { ...androidStatus(), pendingReleaseId: "unknown" },
      null,
    ])
      equal(await canAutomaticallyUpgradeAndroidStorage(androidHost("2.0.95", status)), false, JSON.stringify(status));
    equal(
      await canAutomaticallyUpgradeAndroidStorage(androidHost("2.0.95", { ...androidStatus(), activeReleaseId: "new", activeVersion: "2.0.96" })),
      true
    );
  });
  await test("an eligible Android upgrades automatically from every stored legacy format", async () => {
    const legacyFormats: [string, () => Promise<unknown>][] = [
      ["refused in an earlier version", () => databaseStorage.choose("legacy", "2.0.1")],
      ["refused in this version", () => databaseStorage.choose("legacy")],
      ["kept without asking (unversioned)", () => databaseStorage.prepareForRuntime("legacy")],
    ];
    for (const [label, storeLegacy] of legacyFormats) {
      await resetApp();
      await appLegacy.setItem(account, JSON.stringify(state()));
      await storeLegacy();
      equal(await databaseStorage.getChoice(), "legacy", label);
      await mountGate(false, androidHost(), true);
      equal(await databaseStorage.getChoice(), "partitioned");
      equal(await appLegacy.getItem(account), null);
      equal(await databaseStorage.load("user"), state());
      assert(!host!.querySelector('[role="dialog"]'));
      unmountGate();
    }
  });
  await test("Android with data already in the new format starts without asking the bridge", async () => {
    await resetApp();
    await appLegacy.setItem(account, JSON.stringify(state()));
    await databaseStorage.choose("partitioned");
    let bridgeCalls = 0;
    const counted =
      <T>(value: T) =>
      () => {
        bridgeCalls++;
        return value;
      };
    await mountGate(false, {
      version: counted("2.0.95"),
      isDebugBuild: counted(false),
      getWebAppBundleStatus: counted(JSON.stringify(androidStatus())),
    });
    equal(bridgeCalls, 0);
    equal(await databaseStorage.getChoice(), "partitioned");
    equal(await databaseStorage.load("user"), state());
    unmountGate();
  });
  await test("Android that can still fall back to an older frontend keeps the old format without asking", async () => {
    const json = JSON.stringify(state());
    for (const bridge of [
      androidHost("2.0.93"),
      androidHost("2.0.95", { ...androidStatus(), factoryVersion: "2.0.93" }),
      androidHost("2.0.93-pp-debug", { ...androidStatus(), factoryVersion: "2.0.93" }, true),
      // An APK predating the bundle status bridge.
      { version: () => "2.0.90" },
    ]) {
      await resetApp();
      await appLegacy.setItem(account, json);
      localStorage.setItem("pp-database", json);
      let displayedChoice = false;
      const observer = new MutationObserver(() => {
        displayedChoice ||= !!document.querySelector('[role="dialog"]');
      });
      observer.observe(document.body, { childList: true, subtree: true });
      try {
        await mountGate(false, bridge, true);
        assert(!displayedChoice && !host!.querySelector('[role="dialog"]'));
        equal(await databaseStorage.getChoice(), "legacy");
        // The exact keys and texts every earlier frontend reads.
        equal(await appLegacy.getItem(account), json);
        equal(await appLegacy.getItem("pp-database"), json);
        equal(localStorage.getItem("pp-database"), null);
        equal(await databaseStorage.load("user"), state());
      } finally {
        observer.disconnect();
        unmountGate();
      }
      // Not a user decision: no version-scoped refusal is recorded.
      equal(await databaseStorage.prepareForRuntime("choice"), null);
    }
    // The next start whose factory frontend includes the new storage converts it.
    await mountGate(false, androidHost());
    equal(await databaseStorage.getChoice(), "partitioned");
    equal(await databaseStorage.load("user"), state());
    unmountGate();
    // A store already in the new format is never downgraded.
    await mountGate(false, androidHost("2.0.93"));
    equal(await databaseStorage.getChoice(), "partitioned");
    equal(await databaseStorage.load("user"), state());
    unmountGate();
  });
  await test("a failed Android setup without the upgrade offers retry and a recovery file, never the choice", async () => {
    await resetApp();
    const json = JSON.stringify(state());
    await appLegacy.setItem(account, json);
    localStorage.setItem("pp-database", json);
    localStorage.setItem("pp-settings", JSON.stringify({ language: "en" }));
    const restore = injectFailure(1, "abort");
    try {
      renderGate(androidHost("2.0.93"));
      await waitFor(() => !!host?.querySelector('[role="alert"]'));
      assert(!host!.querySelector('[role="dialog"]') && !host!.querySelector("[data-app-mounted]"));
      assert(host!.textContent!.includes(strings.StorageSetupError) && host!.textContent!.includes(strings.StorageRecoveryExport));
      equal(await databaseStorage.getChoice(), null);
      equal(await appLegacy.getItem(account), json);
      equal(localStorage.getItem("pp-database"), json);
    } finally {
      restore();
    }
    host!.querySelector<HTMLButtonElement>("button")!.click();
    await waitFor(() => !!host?.querySelector("[data-app-mounted]"));
    equal(await databaseStorage.getChoice(), "legacy");
    equal(localStorage.getItem("pp-database"), null);
    unmountGate();
  });
  await test("eligible Android migration errors offer retry without silently accepting legacy storage", async () => {
    await resetApp();
    await appLegacy.setItem(account, JSON.stringify(state()));
    const restore = injectFailure(3, "abort");
    try {
      renderGate(androidHost());
      await waitFor(() => !!host?.querySelector('[role="alert"]'));
      assert(!host!.querySelector('[role="dialog"]'));
      equal(await databaseStorage.getChoice(), null);
    } finally {
      restore();
    }
    host!.querySelector<HTMLButtonElement>("button")!.click();
    await waitFor(() => !!host?.querySelector("[data-app-mounted]"));
    equal(await databaseStorage.getChoice(), "partitioned");
    unmountGate();
  });
  await test("PWA converts all legacy sources automatically without displaying a choice, also in StrictMode", async () => {
    await resetApp();
    const json = JSON.stringify(state());
    await appLegacy.setItem(account, json);
    localStorage.setItem("pp-database", json);
    let displayedChoice = false;
    const observer = new MutationObserver(() => {
      displayedChoice ||= !!document.querySelector('[role="dialog"]');
    });
    observer.observe(document.body, { childList: true, subtree: true });
    try {
      await mountGate(false, false, true);
      assert(!displayedChoice && !host!.querySelector('[role="dialog"]'));
      equal(await databaseStorage.getChoice(), "partitioned");
      equal(JSON.parse((await databaseStorage.getRaw("user"))!), state());
      equal(JSON.parse((await databaseStorage.getRaw())!), state());
      equal(await appLegacy.getItem(account), null);
      equal(localStorage.getItem("pp-database"), null);
    } finally {
      observer.disconnect();
      unmountGate();
    }
  });
  await test("PWA upgrades a previously remembered legacy choice and preserves its latest edits", async () => {
    await resetApp();
    await appLegacy.setItem(account, JSON.stringify(state()));
    await databaseStorage.choose("legacy");
    await databaseStorage.load("user");
    const data = state();
    data.leaders[0].version = 0;
    data.leaders[0].preferences[0].transpose = 6;
    await databaseStorage.save(data, "user");
    await mountGate(false, false);
    equal(await databaseStorage.getChoice(), "partitioned");
    equal(JSON.parse((await databaseStorage.getRaw("user"))!), data);
    equal(await appLegacy.getItem(account), null);
    unmountGate();
  });
  await test("PWA using the new format starts without prompting or rewriting records", async () => {
    await resetApp();
    await appLegacy.setItem(account, JSON.stringify(state()));
    await databaseStorage.choose("partitioned");
    const original = IDBObjectStore.prototype.put;
    let writes = 0;
    IDBObjectStore.prototype.put = function (...args: Parameters<IDBObjectStore["put"]>) {
      writes++;
      return original.apply(this, args);
    };
    try {
      await mountGate(false, false, true);
      equal(writes, 0);
    } finally {
      IDBObjectStore.prototype.put = original;
      unmountGate();
    }
  });
  await test("a failed PWA conversion leaves every source untouched; the retry page offers a recovery file instead of a choice dialog", async () => {
    await resetApp();
    const json = JSON.stringify(state());
    const other = JSON.stringify({ ...state(), version: 99 });
    await appLegacy.setItem(account, json);
    localStorage.setItem(account, other);
    const restore = injectFailure(3, "abort");
    let buttons: NodeListOf<HTMLButtonElement>;
    try {
      renderGate(false);
      await waitFor(() => !!host?.querySelector('[role="alert"]'));
      assert(!host!.querySelector('[role="dialog"]') && !host!.querySelector("[data-app-mounted]"));
      equal(await appLegacy.getItem(account), json);
      equal(localStorage.getItem(account), other);
      equal(await databaseStorage.getChoice(), null);
      buttons = host!.querySelectorAll<HTMLButtonElement>("button");
      equal(buttons.length, 2);
      const recovery = JSON.parse(await databaseStorage.exportRecoveryData());
      equal(recovery.format, "pp-storage-recovery-v1");
      assert(recovery.indexedDb.some((row: { key: unknown; value: unknown }) => row.key === account && row.value === json));
      assert(recovery.localStorage.some((copy: { key: string; value: string }) => copy.key === account && copy.value === other));
    } finally {
      restore();
    }
    buttons[0].click();
    await waitFor(() => !!host?.querySelector("[data-app-mounted]"));
    equal(await databaseStorage.getChoice(), "partitioned");
    // The differing localStorage copy did not block anything: kept apart, the account opens.
    equal(localStorage.getItem(account), null);
    equal(await databaseStorage.load("user"), state());
    unmountGate();
  });
  await test("a localStorage copy written after the choice closes only its own account until an import replaces it", async () => {
    await resetApp();
    const json = JSON.stringify(state());
    await appLegacy.setItem(account, json);
    await appLegacy.setItem("pp-database-other", json);
    await databaseStorage.choose("partitioned");
    localStorage.setItem(account, json);
    equal(await databaseStorage.getChoice(), "partitioned");
    equal(await databaseStorage.prepareForRuntime("automatic"), "partitioned");
    equal(await databaseStorage.prepareForRuntime("choice"), "partitioned");
    equal(await databaseStorage.prepareForRuntime("legacy"), "partitioned");
    await rejects(() => databaseStorage.load("user"));
    await rejects(() => databaseStorage.getStoredRaw("user"));
    equal(JSON.parse((await databaseStorage.getRaw("other"))!), state());
    await databaseStorage.setRaw(json, "user");
    equal(localStorage.getItem(account), null);
    equal(await databaseStorage.load("user"), state());
  });
  await test("a failed automatic upgrade keeps the prior legacy choice and data until a successful retry", async () => {
    await resetApp();
    const json = JSON.stringify(state());
    await appLegacy.setItem(account, json);
    await databaseStorage.choose("legacy");
    const restore = injectFailure(3, "abort");
    try {
      renderGate(false);
      await waitFor(() => !!host?.querySelector('[role="alert"]'));
      assert(!host!.querySelector('[role="dialog"]') && !host!.querySelector("[data-app-mounted]"));
      equal(await databaseStorage.getChoice(), "legacy");
      equal(await appLegacy.getItem(account), json);
    } finally {
      restore();
    }
    host!.querySelector<HTMLButtonElement>("button")!.click();
    await waitFor(() => !!host?.querySelector("[data-app-mounted]"));
    equal(await databaseStorage.getChoice(), "partitioned");
    equal(JSON.parse((await databaseStorage.getRaw("user"))!), state());
    unmountGate();
  });
  await test("application queue, account switches, validation and failed-reload dirty protection", async () => {
    await resetApp();
    localStorage.setItem("pp-database-integration", JSON.stringify(state()));
    await databaseStorage.choose("partitioned");
    equal(localStorage.getItem("pp-database-integration"), null);
    await databaseStorage.load("integration");
    const mutable = state();
    const savingSnapshot = databaseStorage.save(mutable, "integration");
    mutable.songs[0].songdata.text = "{title: Changed after save was requested}";
    await savingSnapshot;
    equal(JSON.parse((await databaseStorage.getRaw("integration"))!).songs[0].songdata.text, state().songs[0].songdata.text);
    const db = await Database.initialize("integration");
    db.autoSave = false;
    const added = new Song("{title: Queued song}\nLyrics");
    db.addSong(added);
    const leader = new Leader("queue-leader", "Queue leader", 1);
    db.addLeader(leader);
    const saves = [db.forceSaveAsync()];
    leader.updatePreference(added.Id, { transpose: 3 }, db);
    saves.push(db.forceSaveAsync());
    leader.updatePreference(added.Id, { transpose: 5 }, db);
    saves.push(db.forceSaveAsync());
    await Promise.all(saves);
    await db.reloadAsync();
    equal(db.leaders.find(leader.id)?.getPreference(added.Id)?.transpose, 5);
    await Promise.all([Database.switchUser("one"), Database.switchUser("two"), Database.switchUser("integration")]);
    equal(Database.getCurrentUsername(), "integration");
    // The obsolete instance cannot write over the account's current instance.
    const beforeObsoleteSave = await databaseStorage.getRaw("integration");
    db.addSong(new Song("{title: Obsolete edit}\nLyrics"));
    await db.forceSaveAsync();
    equal(await databaseStorage.getRaw("integration"), beforeObsoleteSave);
    // Stored duplicates open as in earlier versions (the last song, preference
    // and same-date playlist win, undated playlists are unused), and saving
    // loses none of the others: they are retained, never uploaded.
    const dupes = state();
    const unmodified = state();
    dupes.songs.push({ ...dupes.songs[0], songdata: { ...dupes.songs[0].songdata, text: "{title: Later copy}\nLyrics" } });
    dupes.leaders[0].preferences.push({ songId: "s1", transpose: 4 });
    const undated = { label: "No date", songs: [{ songId: "s2", title: "Second song" }] };
    const later = { ...structuredClone(dupes.leaders[0].playlists[0]), label: "Later set" };
    (dupes.leaders[0].playlists as unknown[]).push(undated, later);
    await databaseStorage.setRaw(JSON.stringify(dupes), "dupes");
    const opened = await Database.switchUser("dupes");
    const profile = opened.leaders.find("l1")!;
    equal(opened.getSong("s1")?.Title, "Later copy");
    equal(profile.getPreference("s1")?.transpose, 4);
    equal(profile.getSchedule().length, 1);
    assert(!("retainedPlaylists" in profile.toJSON()) && !("retainedPreferences" in profile.toJSON()));
    opened.autoSave = false;
    profile.updatePreference("s2", { transpose: 1 }, opened);
    await opened.forceSaveAsync();
    const checkStored = async () => {
      const stored = JSON.parse((await databaseStorage.getRaw("dupes"))!);
      equal(stored.leaders[0].retainedPreferences, [unmodified.leaders[0].preferences[0]]);
      equal(stored.leaders[0].retainedPlaylists, [undated, unmodified.leaders[0].playlists[0]]);
      equal(stored.retainedSongs, [unmodified.songs[0]]);
      equal(stored.leaders[0].playlists.length, 1);
      equal(stored.leaders[0].playlists[0].label, "Later set");
    };
    await checkStored();
    // Reloading and saving again neither drops nor duplicates the retained entries.
    await opened.reloadAsync();
    opened.leaders.find("l1")!.updatePreference("s2", { transpose: 2 }, opened);
    await opened.forceSaveAsync();
    await checkStored();
    // A sync replaces the profile with the server's version, which never holds
    // the retained entries (they are not uploaded): they must survive that too.
    const fromServer = Leader.fromJSON(opened.leaders.find("l1")!.toJSON());
    fromServer.version = 9;
    assert(fromServer.retainedEntryCount === 0);
    opened.updateLeader(fromServer);
    await opened.forceSaveAsync();
    await checkStored();
    equal(JSON.parse((await databaseStorage.getRaw("dupes"))!).leaders[0].version, 9);
    await Database.switchUser("integration");
    // Late work still holding the replaced instance (its account is not open
    // any more) saves to its own account, as earlier versions did, without errors.
    let saveErrors = 0;
    const countSaveError = () => saveErrors++;
    window.addEventListener("pp-db-save-error", countSaveError);
    try {
      opened.addSong(new Song("{title: Late refresh}\nLyrics"));
      await opened.forceSaveAsync();
    } finally {
      window.removeEventListener("pp-db-save-error", countSaveError);
    }
    equal(saveErrors, 0);
    assert((await databaseStorage.getRaw("dupes"))!.includes("Late refresh"));
    // A failed switch leaves waitForReady with the account that stays active.
    localStorage.setItem("pp-database-refused", "{}");
    try {
      const failing = Database.switchUser("refused");
      const ready = Database.waitForReady();
      await rejects(() => failing);
      assert((await ready) === Database.getInstance() && Database.getCurrentUsername() === "integration");
    } finally {
      localStorage.removeItem("pp-database-refused");
    }
    const current = Database.getInstance();
    current.autoSave = false;
    const pending = new Song("{title: Unsaved draft}\nPreserve me");
    current.addSong(pending);
    const original = databaseStorage.load;
    databaseStorage.load = async () => {
      throw new Error("Transient read failure");
    };
    try {
      await rejects(() => current.reloadAsync());
    } finally {
      databaseStorage.load = original;
    }
    await rejects(() => Database.switchUser("other"));
    assert(Database.getInstance() === current && current.getSong(pending.Id));
    assert(JSON.parse(current.exportForBackup()).songs.some((song: { songId: string }) => song.songId === pending.Id));
    const invalid = state();
    (invalid.leaders[0].preferences as unknown[]) = [{ transpose: 9 }];
    await rejects(() => databaseStorage.setRaw(JSON.stringify(invalid), "invalid"));
    // After an import replaced the open account, its instance stops saving
    // (the page reloads to open the import) instead of failing every save.
    await databaseStorage.setRaw(JSON.stringify(state()), "integration");
    Database.supersedeByImport(["integration"]);
    let importSaveErrors = 0;
    const countImportSaveError = () => importSaveErrors++;
    window.addEventListener("pp-db-save-error", countImportSaveError);
    try {
      await current.forceSaveAsync();
    } finally {
      window.removeEventListener("pp-db-save-error", countImportSaveError);
    }
    equal(importSaveErrors, 0);
    equal(JSON.parse((await databaseStorage.getRaw("integration"))!), state());
  });
  await fetch("/result", { method: "POST", body: JSON.stringify({ tests: results }) });
}
void run().catch(async (error) => {
  unmountGate();
  results.push({ name: "test harness", error: String(error) });
  await fetch("/result", { method: "POST", body: JSON.stringify({ tests: results }) });
});
