import * as t from "io-ts";
import localforage from "localforage";
import { decode, parseAndDecode } from "../../common/io-utils";
import { Database } from "../../db-common/Database";
import { COPY_INBOX, keptCopyInboxKey, parseDatabaseCopyKey } from "../../db-common/databaseCopies";

/**
 * A `.ppmigrate` pack is the backup file written when the web app moved between
 * two addresses. Unlike a `.ppdb` export it holds the databases of every
 * account that was used in that browser (the guest one and one per user), each
 * as a JSON string in the same shape the local storage keeps.
 */
const migrationPackCodec = t.type({
  format: t.literal("pp-site-migration-v1"),
  entries: t.array(t.type({ kind: t.string, key: t.string, payload: t.string, sha256: t.string })),
});

const GUEST_KEY = "pp-database";
const USER_KEY_PREFIX = "pp-database-";

export interface DatabaseSummary {
  songs: number;
  profiles: number;
  /** Songs and profiles not uploaded yet (version 0), as Database.countUpdatedSongs/Profiles. */
  unsynced: number;
  version: number;
}

export interface MigrationPackDatabase {
  /** Owner of the database; empty for the guest database. */
  username: string;
  /** The database exactly as it is written to storage. */
  json: string;
  summary: DatabaseSummary;
}

export function isMigrationPackFile(fileName: string): boolean {
  return fileName.toLowerCase().endsWith(".ppmigrate");
}

/** Summary of a stored database; throws when the JSON is not a valid database. */
export function summarizeDatabaseJson(json: string): DatabaseSummary {
  const database = parseAndDecode(Database.importExportCodec, json);
  const unsynced = (items: { version: number }[]) => items.filter((item) => item.version === 0).length;
  return {
    songs: database.songs.length,
    profiles: database.leaders.length,
    unsynced: unsynced(database.songs) + unsynced(database.leaders),
    version: database.version,
  };
}

async function sha256Hex(text: string): Promise<string | null> {
  // Web Crypto needs a secure context; without one the integrity check is skipped.
  if (!globalThis.crypto?.subtle) return null;
  const digest = await globalThis.crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return Array.from(new Uint8Array(digest), (value) => value.toString(16).padStart(2, "0")).join("");
}

export interface MigrationPackCopy {
  /** Content-addressed key the copy is kept under in the site migration inbox. */
  inboxKey: string;
  payload: string;
}

/**
 * Reads a pack once: its account databases, guest first, then users by name,
 * and its further stored copies of account databases (`database-copy`
 * entries, see db-common/databaseCopies). The copies are never imported into
 * the app's storage; they are kept verbatim in the site migration inbox, from
 * where every later `.ppmigrate` backup of this origin carries them again.
 * Returns null when the text is not a pack. Throws when a database or a copy
 * in it is damaged, so a partly readable pack is never offered as complete.
 */
export async function readMigrationPackContents(text: string): Promise<{ databases: MigrationPackDatabase[]; copies: MigrationPackCopy[] } | null> {
  let pack: t.TypeOf<typeof migrationPackCodec>;
  try {
    pack = decode(migrationPackCodec, JSON.parse(text) as unknown);
  } catch {
    return null;
  }

  const databases: MigrationPackDatabase[] = [];
  const copies: MigrationPackCopy[] = [];
  for (const entry of pack.entries) {
    const isDatabase = entry.kind === "database" && (entry.key === GUEST_KEY || entry.key.startsWith(USER_KEY_PREFIX));
    const isCopy = entry.kind === "database-copy" && parseDatabaseCopyKey(entry.key) !== null;
    if (!isDatabase && !isCopy) continue;
    const hash = await sha256Hex(entry.payload);
    if (hash !== null && hash !== entry.sha256) throw new Error(`Integrity check failed for ${entry.key}`);
    if (isCopy) {
      const inboxKey = keptCopyInboxKey(entry.key, hash ?? entry.sha256);
      if (!inboxKey) throw new Error(`Invalid database copy: ${entry.key}`);
      copies.push({ inboxKey, payload: entry.payload });
      continue;
    }
    databases.push({
      username: entry.key === GUEST_KEY ? "" : entry.key.slice(USER_KEY_PREFIX.length),
      json: entry.payload,
      summary: summarizeDatabaseJson(entry.payload),
    });
  }
  return { databases: databases.sort((left, right) => left.username.localeCompare(right.username)), copies };
}

/** Keeps a pack's further stored copies (see readMigrationPackContents); keeping one again changes nothing. */
export async function keepDatabaseCopies(copies: MigrationPackCopy[]): Promise<void> {
  if (!copies.length) return;
  const inbox = localforage.createInstance({ name: COPY_INBOX.name, storeName: COPY_INBOX.storeName });
  for (const copy of copies) {
    // Never overwrite a kept copy. Without Web Crypto the file's own digest
    // names the copy unverified, so a differing payload under the same name
    // means wrong checksums: refuse the import rather than lose either copy.
    const existing = await inbox.getItem<string>(copy.inboxKey);
    if (existing === copy.payload) continue;
    if (existing !== null) throw new Error(`A different copy is already kept as ${copy.inboxKey}; the file's checksums are wrong`);
    await inbox.setItem(copy.inboxKey, copy.payload);
  }
}
