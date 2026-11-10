/**
 * heldSongsStore — which of the user's HELD song versions (own versions held
 * back on their way to the public list) the user has acknowledged.
 *
 * Kept on this device only (localStorage): acknowledging writes nothing to the
 * server, so it cannot touch the song state machine or any other client. A
 * version is identified by song id + `created`: renumbering a song's versions
 * (moderation of another row) keeps it, a new upload gets a new one and is
 * shown again.
 */

const STORAGE_KEY = "pp-held-songs-acknowledged";

/** Dispatched on window when an acknowledgement changes the visible held list. */
export const HELD_SONGS_CHANGED_EVENT = "pp-held-songs-changed";

export interface HeldSongRef {
  songId: string;
  created: string;
}

const keyOf = (song: HeldSongRef) => `${song.songId}@${song.created}`;

function load(): Set<string> {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    const parsed: unknown = raw ? JSON.parse(raw) : [];
    return new Set(Array.isArray(parsed) ? parsed.filter((key): key is string => typeof key === "string") : []);
  } catch {
    return new Set();
  }
}

// Read once; without storage the acknowledgements last for this session.
let acknowledged: Set<string> | null = null;
const keys = () => (acknowledged ??= load());

function save() {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify([...keys()]));
  } catch {
    // Storage unavailable: kept in memory only.
  }
}

/** The held versions the user has not acknowledged yet. */
export function unacknowledgedHeldSongs<T extends HeldSongRef>(songs: readonly T[]): T[] {
  return songs.filter((song) => !keys().has(keyOf(song)));
}

export function acknowledgeHeldSong(song: HeldSongRef): void {
  keys().add(keyOf(song));
  save();
  window.dispatchEvent(new Event(HELD_SONGS_CHANGED_EVENT));
}

/** Forget acknowledgements of versions no longer held (moved on, archived),
 *  so the stored list does not grow. `current` must be the complete list. */
export function pruneHeldSongAcknowledgements(current: readonly HeldSongRef[]): void {
  const stillHeld = new Set(current.map(keyOf));
  let changed = false;
  for (const key of keys())
    if (!stillHeld.has(key)) {
      keys().delete(key);
      changed = true;
    }
  if (changed) save();
}
