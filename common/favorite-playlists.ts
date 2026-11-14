/**
 * Favorite (named, undated) playlists stored in the existing leader-profile
 * format, so that no schema change is needed and older clients keep them.
 *
 * A favorite is an ordinary playlist whose `scheduled` date falls into a
 * reserved range of whole days in the 1980s (one day per favorite) and whose
 * `label` is the user-given name prefixed with "★ ".
 *
 * Why this shape:
 * - Older clients drop or overwrite playlists without a date, but keep every
 *   dated one, so a favorite must have a unique date.
 * - Whole local days survive the midnight normalization some hosts apply.
 * - The timestamps are positive: older code treats 0 or a negative value as
 *   "no date" and falls back to today.
 * - The dates are in the past: the "today's playlist" lookups only look at the
 *   current day and later, so a favorite is never picked up as today's list.
 * - Older clients that list playlists by label sort the "★ " names after the
 *   date labels, so favorites show up at the end of their lists.
 */

export const FAVORITE_PLAYLIST_PREFIX = "★ ";

/** Every playlist dated before this instant is a favorite. */
const FAVORITE_RANGE_END = Date.UTC(1990, 0, 1);

/** The first day handed out to a favorite (local midnight). */
const FIRST_FAVORITE_YEAR = 1980;

/** Number of favorite day slots available per leader. */
const FAVORITE_SLOT_COUNT = 3650;

export const FAVORITE_NAME_MAX_LENGTH = 80;

/** True when a playlist date belongs to the reserved favorite range. */
export function isFavoriteScheduleDate(date: Date | number | null | undefined): boolean {
  if (date == null) return false;
  const time = typeof date === "number" ? date : date.getTime();
  return Number.isFinite(time) && time > 0 && time < FAVORITE_RANGE_END;
}

/** True when a playlist (as stored in a profile) is a favorite. */
export function isFavoritePlaylist(playlist: { scheduled?: Date | number | null; label?: string }): boolean {
  if (playlist.scheduled != null) return isFavoriteScheduleDate(playlist.scheduled);
  return !!playlist.label?.startsWith(FAVORITE_PLAYLIST_PREFIX.trim());
}

/** True when a label carries the favorite prefix. */
export function hasFavoriteLabel(label: string | null | undefined): boolean {
  return !!label && label.startsWith(FAVORITE_PLAYLIST_PREFIX.trim());
}

/** The user-visible name of a favorite label ("★ Easter" → "Easter"). Returns
 *  an empty string when the label has no favorite prefix (e.g. an older client
 *  replaced it with a date label). */
export function favoriteNameFromLabel(label: string | null | undefined): string {
  if (!hasFavoriteLabel(label)) return "";
  return (label as string).slice(FAVORITE_PLAYLIST_PREFIX.trim().length).trim();
}

/** The stored label of a favorite name ("Easter" → "★ Easter"). */
export function favoriteLabel(name: string): string {
  return FAVORITE_PLAYLIST_PREFIX + name.trim();
}

export type FavoriteNameError = "empty" | "slash" | "tooLong";

/** Validates a favorite name typed by the user. A "/" is rejected because the
 *  label is part of the playlist preview id (`leaderId/label`). */
export function validateFavoriteName(name: string): FavoriteNameError | null {
  const trimmed = name.trim();
  if (!trimmed) return "empty";
  if (trimmed.includes("/")) return "slash";
  if (trimmed.length > FAVORITE_NAME_MAX_LENGTH) return "tooLong";
  return null;
}

/** Case- and accent-insensitive equality of two favorite names. */
export function sameFavoriteName(a: string, b: string): boolean {
  return a.trim().localeCompare(b.trim(), undefined, { sensitivity: "base" }) === 0;
}

function localDayKey(date: Date): string {
  return `${date.getFullYear()}-${date.getMonth()}-${date.getDate()}`;
}

/**
 * A free favorite day (local midnight) that none of the given dates occupies.
 * The search starts at a random slot, so that favorites created on two devices
 * before they sync are unlikely to get the same date (the same date would make
 * them one playlist in the merge). Throws when every slot is taken.
 */
export function allocateFavoriteDate(existing: Iterable<Date>, random: () => number = Math.random): Date {
  const used = new Set<string>();
  for (const date of existing) {
    if (isFavoriteScheduleDate(date)) used.add(localDayKey(date));
  }
  const start = Math.min(FAVORITE_SLOT_COUNT - 1, Math.max(0, Math.floor(random() * FAVORITE_SLOT_COUNT)));
  for (let step = 0; step < FAVORITE_SLOT_COUNT; step++) {
    const candidate = new Date(FIRST_FAVORITE_YEAR, 0, 1 + ((start + step) % FAVORITE_SLOT_COUNT));
    if (isFavoriteScheduleDate(candidate) && !used.has(localDayKey(candidate))) return candidate;
  }
  throw new Error("No free favorite playlist slot");
}

/** Half a day: two favorites are a whole day apart, so a stored favorite within
 *  this distance of an incoming one is the same favorite even when an older
 *  client re-sent the date in a different time zone. */
const SAME_FAVORITE_TOLERANCE_MS = 12 * 60 * 60 * 1000;

/** True for a favorite-dated playlist whose label lost its favorite name. */
export function needsFavoriteLabel(playlist: { scheduled?: Date; label: string }): boolean {
  return !!playlist.scheduled && isFavoriteScheduleDate(playlist.scheduled) && !hasFavoriteLabel(playlist.label);
}

/**
 * Restores favorite names that an older client replaced while uploading a
 * profile. Older desktop clients send every playlist with a label generated
 * from its date, which would turn "★ Easter" into "1980.01.03". For each
 * incoming favorite without a favorite label, the label and exact date of the
 * stored favorite on the same day are kept. Returns the number of restored
 * playlists; the incoming playlists are updated in place.
 */
export function restoreFavoriteLabels(
  incoming: { scheduled?: Date; label: string }[],
  stored: readonly { scheduled?: Date; label: string }[]
): number {
  const storedFavorites = stored.filter((pl) => pl.scheduled && isFavoriteScheduleDate(pl.scheduled) && hasFavoriteLabel(pl.label));
  let restored = 0;
  for (const playlist of incoming) {
    if (!needsFavoriteLabel(playlist)) continue;
    const time = (playlist.scheduled as Date).getTime();
    let best: { scheduled?: Date; label: string } | undefined;
    let bestDistance = SAME_FAVORITE_TOLERANCE_MS;
    for (const candidate of storedFavorites) {
      const distance = Math.abs((candidate.scheduled as Date).getTime() - time);
      if (distance < bestDistance) {
        best = candidate;
        bestDistance = distance;
      }
    }
    if (best) {
      playlist.label = best.label;
      playlist.scheduled = new Date((best.scheduled as Date).getTime());
      restored++;
    }
  }
  return restored;
}
