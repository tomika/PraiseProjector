import * as t from "io-ts";
import { decode, parseAndDecode } from "../../common/io-utils";
import { Database } from "../../db-common/Database";

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

/**
 * Reads the account databases out of a pack, guest first, then users by name.
 * Returns null when the text is not a pack. Throws when a database in it is
 * damaged, so a partly readable pack is never offered as if it were complete.
 */
export async function readMigrationPack(text: string): Promise<MigrationPackDatabase[] | null> {
  let pack: t.TypeOf<typeof migrationPackCodec>;
  try {
    pack = decode(migrationPackCodec, JSON.parse(text) as unknown);
  } catch {
    return null;
  }

  const databases: MigrationPackDatabase[] = [];
  for (const entry of pack.entries) {
    if (entry.kind !== "database") continue;
    if (entry.key !== GUEST_KEY && !entry.key.startsWith(USER_KEY_PREFIX)) continue;
    const hash = await sha256Hex(entry.payload);
    if (hash !== null && hash !== entry.sha256) throw new Error(`Integrity check failed for ${entry.key}`);
    databases.push({
      username: entry.key === GUEST_KEY ? "" : entry.key.slice(USER_KEY_PREFIX.length),
      json: entry.payload,
      summary: summarizeDatabaseJson(entry.payload),
    });
  }
  return databases.sort((left, right) => left.username.localeCompare(right.username));
}
