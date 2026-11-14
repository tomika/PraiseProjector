import * as t from "io-ts";
import { decode } from "../common/io-utils";
import { leaderDBProfileCodec } from "../common/pp-codecs";
import { legacySongStoreCodec, songStoreCodec } from "./Song";
import type { Partitioned } from "./partitionedFormat";

const stateCodec = t.intersection([
  t.type({ version: t.number, songs: t.array(t.unknown), leaders: t.array(t.unknown) }),
  t.partial({
    publicLeaders: t.array(t.unknown),
    songBackup: t.array(t.tuple([t.string, t.type({ version: t.number, song: t.unknown })])),
    profileBackup: t.array(t.tuple([t.string, t.type({ version: t.number, leader: t.unknown })])),
  }),
]);
// Song.fromJSON reads both formats.
const songCodec = t.union([songStoreCodec, legacySongStoreCodec]);

/**
 * Structural validation: the shapes the application can load. Duplicate
 * preferences, songs or profiles and same-date or undated playlists are not
 * errors: storage keeps them verbatim and the application normalizes them on
 * load, as every earlier version did.
 */
export function validateDatabaseObject(input: unknown): void {
  const data = decode(stateCodec, input);
  for (const song of data.songs) decode(songCodec, song);
  for (const profile of [...data.leaders, ...(data.publicLeaders ?? [])]) decode(leaderDBProfileCodec, profile);
  for (const [, entry] of data.songBackup ?? []) decode(songCodec, entry.song);
  for (const [, entry] of data.profileBackup ?? []) decode(leaderDBProfileCodec, entry.leader);
}

export function validateDatabaseState(json: string): void {
  validateDatabaseObject(JSON.parse(json));
}

const COLLECTIONS = new Set(["songs", "leaders", "publicLeaders", "songBackup", "profileBackup"]);

/**
 * Validates the top-level shape and only the records that differ from
 * `previous`, so a save costs in proportion to the change, not to the catalogue.
 * `next` must be partition(data).
 */
export function validateChangedRecords(data: unknown, next: Partitioned, previous: ReadonlyMap<string, string>): void {
  const source = data as Record<string, unknown>;
  const changed = (key: string | undefined) => key !== undefined && previous.get(key) !== next.parts.get(key);
  const unchangedCollection = (value: unknown) => (Array.isArray(value) ? [] : value);
  // Required collections are always present, so a missing one still fails.
  const delta: Record<string, unknown> = {
    version: source.version,
    songs: unchangedCollection(source.songs),
    leaders: unchangedCollection(source.leaders),
  };
  for (const [field, descriptor] of Object.entries(next.fields)) {
    if (!COLLECTIONS.has(field)) continue;
    const value = source[field];
    if (!descriptor.array) {
      delta[field] = changed(descriptor.keys[0]) ? value : unchangedCollection(value);
      continue;
    }
    const entries = value as unknown[];
    const profiles = descriptor.profiles;
    delta[field] = profiles
      ? entries.filter((_, index) => changed(profiles[index].data) || changed(profiles[index].preferences) || changed(profiles[index].playlists))
      : entries.filter((_, index) => changed(descriptor.keys[index]));
  }
  validateDatabaseObject(delta);
}
