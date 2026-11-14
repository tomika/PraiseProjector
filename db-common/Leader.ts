import { cloneJson } from "./cloneJson";
import { Playlist } from "./Playlist";
import { SongPreference } from "./SongPreference";
import { SongPreferenceEntry } from "../common/pp-types";

// Forward declaration to avoid circular dependency
interface Database {
  getSongs(): Song[];
  ensureProfileBackup(leaderId: string): void;
  invalidateFilterCache(): void;
}

import { Song } from "./Song";
import { leaderDBProfileCodec } from "../common/pp-codecs";
import { LeaderDBProfile, PlayList, PreferenceType } from "../common/pp-types";
import { decode } from "../common/io-utils";
import { parseScheduleDate } from "../common/date-only";

export interface UpdatePreferenceOptions {
  title?: string;
  transpose?: number;
  capo?: number;
  type?: PreferenceType | "";
  instructions?: string;
}

export class Leader {
  private readonly _id: string;
  private readonly _name: string;
  private readonly preferences: Map<string, SongPreference> = new Map();
  private readonly schedule: Map<Date, Playlist> = new Map();
  private _version: number = 0;
  // Stored entries the model cannot hold: an undated playlist, or a playlist or
  // preference shadowed by a later one of the same date or song. Never live and
  // never uploaded; kept only so that saving the profile locally loses nothing
  // (earlier versions dropped them on the first save).
  private retainedPreferences: unknown[] = [];
  private retainedPlaylists: unknown[] = [];

  constructor(id: string, name: string, version: number = 0) {
    this._id = id;
    this._name = name;
    this._version = version;
  }

  get id(): string {
    return this._id;
  }

  get name(): string {
    return this._name;
  }

  get version(): number {
    return this._version;
  }

  set version(value: number) {
    this._version = value;
  }

  clone(): Leader {
    return this.cloneWithId(this._id);
  }

  cloneWithId(newId: string): Leader {
    const l = new Leader(newId, this._name);
    for (const [key, value] of this.preferences) {
      l.preferences.set(key, value.clone());
    }
    for (const [key, value] of this.schedule) {
      l.setScheduleEntry(new Date(key.getTime()), value.clone());
    }
    l.version = this.version;
    l.retainedPreferences = cloneJson(this.retainedPreferences);
    l.retainedPlaylists = cloneJson(this.retainedPlaylists);
    return l;
  }

  /** Stored entries that are kept but not used; see retainedPreferences. */
  get retainedEntryCount(): number {
    return this.retainedPreferences.length + this.retainedPlaylists.length;
  }

  /**
   * Adds the retained entries of the profile this one replaces (e.g. a newer
   * server version pulled by a sync, which never contains them because they
   * are not uploaded). Entries already retained here are not duplicated.
   */
  retainFrom(previous: Leader): void {
    const merge = (own: unknown[], other: unknown[]) => {
      const seen = new Set(own.map((entry) => JSON.stringify(entry)));
      for (const entry of other) {
        const key = JSON.stringify(entry);
        if (seen.has(key)) continue;
        seen.add(key);
        own.push(cloneJson(entry));
      }
    };
    merge(this.retainedPreferences, previous.retainedPreferences);
    merge(this.retainedPlaylists, previous.retainedPlaylists);
  }

  forAllSongPreference(cb: (songId: string, pref: SongPreference) => boolean): void {
    for (const [songId, pref] of this.preferences) {
      if (!cb(songId, pref)) break;
    }
  }

  getSchedule(): Date[] {
    return Array.from(this.schedule.keys()).sort((a, b) => a.getTime() - b.getTime());
  }

  private getScheduleEntryByTimestamp(timestamp: number): Playlist | null {
    for (const [key, value] of this.schedule) {
      if (key.getTime() === timestamp) return value;
    }
    return null;
  }

  // Helper to set a playlist in the schedule, handling duplicate Date keys
  // (Map uses reference equality for Date keys, so different Date objects
  // with the same timestamp would create duplicate entries)
  private setScheduleEntry(date: Date, playlist: Playlist): void {
    const timestamp = date.getTime();
    for (const existingKey of this.schedule.keys()) {
      if (existingKey.getTime() === timestamp) {
        this.schedule.delete(existingKey);
        break;
      }
    }
    this.schedule.set(date, playlist);
  }

  getPreference(songId: string): SongPreference | null {
    return this.preferences.get(songId) || null;
  }

  getPreferencedSong(pref: SongPreference): string {
    for (const [songId, p] of this.preferences) {
      if (p === pref) return songId;
    }
    return "";
  }

  updatePreference(songId: string, opts: UpdatePreferenceOptions, database: Database): SongPreference {
    const { title, transpose, capo, type, instructions } = opts;
    let pref = this.preferences.get(songId);
    if (!pref) {
      pref = new SongPreference();
      this.preferences.set(songId, pref);
    } else if (
      pref.title === title &&
      pref.transpose === transpose &&
      pref.capo === capo &&
      pref.type === type &&
      pref.instructions === instructions
    ) {
      return pref;
    }

    let song: Song | undefined;
    const getSong = () => {
      if (!song) {
        song = database.getSongs().find((s) => s.Id === songId);
      }
      return song;
    };

    // Backup the profile before first local modification (must happen before version changes)
    if (this.version !== 0) database.ensureProfileBackup(this._id);

    if (title != null && pref.title !== title) {
      const song = getSong();
      if (!song || song.Title !== title) {
        pref.title = title;
        this.version = 0;
      }
    }
    if (transpose != null && pref.transpose !== transpose && transpose > -12 && transpose < 12) {
      pref.transpose = transpose;
      this.version = 0;
    }
    if (capo != null && capo >= -1 && pref.capo !== capo) {
      const song = getSong();
      if (!song || song.Capo !== capo) {
        pref.capo = capo;
        this.version = 0;
      }
    }
    if (type != null && pref.type !== type) {
      pref.type = type === "" ? undefined : type;
      this.version = 0;
    }
    if (instructions != null && pref.instructions !== instructions) {
      pref.instructions = instructions;
      this.version = 0;
    }

    if (!pref.isActive && this.preferences.delete(songId)) {
      this.version = 0;
    }

    // A preference change (esp. Preferred/Ignore type) alters filter results and
    // the preference baked into cached SongFound entries — drop the filter cache.
    database.invalidateFilterCache();

    return pref;
  }

  getPlaylist(dt: Date, timeSpan: number = 0): Playlist | null {
    // Date keys use reference equality in Map; callers usually reconstruct the
    // same timestamp with a different Date instance, so resolve exact timestamps.
    let pl = this.getScheduleEntryByTimestamp(dt.getTime()) ?? undefined;
    if (!pl && timeSpan > 0) {
      const end = new Date(dt.getTime() + timeSpan);
      const sortedKeys = Array.from(this.schedule.keys()).sort((a, b) => a.getTime() - b.getTime());
      for (const key of sortedKeys) {
        if (key >= dt && key <= end) {
          pl = this.schedule.get(key);
          break;
        }
      }
    }
    return pl || null;
  }

  addPlaylist(dt: Date, playlist: Playlist, bUpdatePreference: boolean, database: Database): void {
    if (!playlist) {
      console.error("Playlist", "Null playlist cannot be added to leader.");
      return;
    }
    // Backup the profile before first local modification
    if (this.version !== 0) database.ensureProfileBackup(this._id);

    this.version = 0;
    this.setScheduleEntry(dt, playlist);
    if (bUpdatePreference) {
      for (const ple of playlist.items) {
        this.updatePreference(ple.songId, { title: ple.title, transpose: ple.transpose, capo: ple.capo, instructions: ple.instructions }, database);
      }
    }
  }

  // Store preference from sync API
  storeSyncedPreference(sp: SongPreferenceEntry, database?: Database): SongPreference {
    const pref = new SongPreference(sp.songId);
    pref.title = sp.title || "";
    pref.capo = sp.capo ?? -1;
    pref.transpose = sp.transpose || 0;
    pref.instructions = sp.instructions || "";
    pref.type = sp.type;

    // Only add if song exists in database (or no database provided)
    if (!database || database.getSongs().some((s) => s.Id === sp.songId)) {
      this.preferences.set(sp.songId, pref);
    }
    return pref;
  }

  // Add playlist from sync API data
  addSyncedPlaylist(pl: PlayList): void {
    if (!pl.scheduled) {
      console.error("Leader", "Cannot add synced playlist without scheduled date.");
      return;
    }
    const playlist = Playlist.fromJSON(pl);
    this.setScheduleEntry(pl.scheduled, playlist);
  }

  toString(): string {
    return this._name;
  }

  equals(other: Leader): boolean {
    if (this.schedule.size !== other.schedule.size) return false;

    for (const [key, value] of this.schedule) {
      const o = other.getScheduleEntryByTimestamp(key.getTime());
      if (!o || !value.equals(o)) return false;
    }

    const empty = new SongPreference();
    const verified = new Set<string>();

    for (const [key, value] of this.preferences) {
      const o = other.preferences.get(key) || empty;
      if (!value.equals(o)) return false;
      verified.add(key);
    }

    for (const [key, value] of other.preferences) {
      if (!verified.has(key) && !value.equals(empty)) return false;
    }

    return true;
  }

  static fromJSON(input: unknown): Leader {
    const data = decode(leaderDBProfileCodec, input);
    // The decoded arrays correspond to the input's entry by entry; the retained
    // copies are the input's own entries, never a normalized re-encoding.
    const raw = input as { preferences?: unknown[]; playlists?: unknown[]; retainedPreferences?: unknown; retainedPlaylists?: unknown };
    const leader = new Leader(data.leaderId, data.leaderName, data.version || 0);
    if (Array.isArray(raw.retainedPreferences)) leader.retainedPreferences.push(...cloneJson(raw.retainedPreferences));
    if (Array.isArray(raw.retainedPlaylists)) leader.retainedPlaylists.push(...cloneJson(raw.retainedPlaylists));

    // Like every earlier version the last of duplicate preferences or same-date
    // playlists is used and undated playlists are not; the others are retained.
    const source = (entries: unknown[] | undefined, decoded: unknown[], index: number) => cloneJson(entries?.[index] ?? decoded[index]);
    const preferences = data.preferences ?? [];
    const preferenceIndex = new Map<string, number>();
    preferences.forEach((prefData, index) => {
      const pref = SongPreference.fromJSON(prefData);
      const shadowed = preferenceIndex.get(pref.songId);
      if (shadowed !== undefined) leader.retainedPreferences.push(source(raw.preferences, preferences, shadowed));
      preferenceIndex.set(pref.songId, index);
      leader.preferences.set(pref.songId, pref);
    });

    const playlists = data.playlists ?? [];
    const playlistIndex = new Map<number, number>();
    playlists.forEach((playlistData, index) => {
      const date = playlistData.scheduled ?? parseScheduleDate(playlistData.label);
      if (!date) {
        leader.retainedPlaylists.push(source(raw.playlists, playlists, index));
        return;
      }
      const shadowed = playlistIndex.get(date.getTime());
      if (shadowed !== undefined) leader.retainedPlaylists.push(source(raw.playlists, playlists, shadowed));
      playlistIndex.set(date.getTime(), index);
      leader.setScheduleEntry(date, Playlist.fromJSON(playlistData));
    });

    if (leader.retainedEntryCount) {
      console.warn(
        "Leader",
        `Profile ${data.leaderId}: ${leader.retainedEntryCount} undated or duplicate playlists/preferences are kept but not used`
      );
    }
    return leader;
  }

  /** The profile as stored locally: toJSON plus the retained entries, which are
   * never uploaded (toJSON is also the sync format). */
  toStorageJSON(): LeaderDBProfile & { retainedPreferences?: unknown[]; retainedPlaylists?: unknown[] } {
    return {
      ...this.toJSON(),
      ...(this.retainedPreferences.length ? { retainedPreferences: cloneJson(this.retainedPreferences) } : {}),
      ...(this.retainedPlaylists.length ? { retainedPlaylists: cloneJson(this.retainedPlaylists) } : {}),
    };
  }

  // Convert to sync format for uploading to server - matching C# Leader.ToProfile()
  toJSON(): LeaderDBProfile {
    const preferences = Array.from(this.preferences.entries()).map(([songId, pref]) => ({
      songId,
      title: pref.title,
      transpose: pref.transpose,
      capo: pref.capo,
      type: pref.type,
      instructions: pref.instructions,
    }));

    const playlists = Array.from(this.schedule.entries()).map(([date, playlist]) => ({
      scheduled: date,
      label: playlist.name,
      songs: playlist.items.map((item) => ({
        songId: item.songId,
        title: item.title || "",
        transpose: item.transpose,
        capo: item.capo,
        instructions: item.instructions || "",
      })),
    }));

    return {
      version: this._version,
      leaderId: this._id,
      leaderName: this._name,
      preferences,
      playlists,
    };
  }
}
