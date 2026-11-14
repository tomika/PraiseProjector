import { isAccountKey } from "./partitionedFormat";

/**
 * Further stored copies of an account database (a differing localStorage copy,
 * a legacy text beside partitioned records, unusable records). The site
 * migration carries them as `database-copy` entries of a `.ppmigrate` pack; a
 * destination keeps them verbatim in the migration inbox, never in the app's
 * storage, and every later pack of that origin carries them again. Shared by
 * the root site migration runtime and the app's pack import, so it stays free
 * of app imports.
 */

/** The localforage instance that holds the site migration inbox. */
export const COPY_INBOX = { name: "PraiseProjectorSiteMigration", storeName: "incoming" } as const;
export const KEPT_COPY_PREFIX = "copy:";
export const DATABASE_COPY_SOURCES = ["localStorage", "indexeddb-legacy", "indexeddb-records"] as const;
export type DatabaseCopySource = (typeof DATABASE_COPY_SOURCES)[number];

const DIGEST = /^[0-9a-f]{64}$/;

/**
 * Parses a `database-copy` entry key: `<account>#<source>` for a copy read from
 * storage, `<account>#<source>#<sha256>` for one kept from an earlier import.
 * The account key itself may contain "#", so it is parsed from the end.
 */
export function parseDatabaseCopyKey(key: string): { account: string; source: DatabaseCopySource; digest: string | null } | null {
  const parts = key.split("#");
  const digest = parts.length >= 3 && DIGEST.test(parts[parts.length - 1]) ? parts.pop()! : null;
  const source = parts.pop() as DatabaseCopySource;
  const account = parts.join("#");
  if (!isAccountKey(account) || !DATABASE_COPY_SOURCES.includes(source)) return null;
  return { account, source, digest };
}

/**
 * Inbox key of a kept copy, content-addressed by the payload's SHA-256 (hex):
 * keeping the same copy again changes nothing, different copies never
 * overwrite each other. Null for an invalid entry key or digest.
 */
export function keptCopyInboxKey(entryKey: string, sha256: string): string | null {
  const parsed = parseDatabaseCopyKey(entryKey);
  if (!parsed || !DIGEST.test(sha256)) return null;
  return `${KEPT_COPY_PREFIX}${parsed.account}#${parsed.source}#${sha256}`;
}

/** The `database-copy` entry key under which a kept copy is exported again, or null. */
export function keptCopyEntryKey(inboxKey: string): string | null {
  if (!inboxKey.startsWith(KEPT_COPY_PREFIX)) return null;
  const key = inboxKey.slice(KEPT_COPY_PREFIX.length);
  return parseDatabaseCopyKey(key)?.digest ? key : null;
}
