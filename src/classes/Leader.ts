import { Playlist } from "./Playlist";
import { SongPreference } from "./SongPreference";
import { SongPreferenceEntry } from "../../common/pp-types";

// Forward declaration to avoid circular dependency
interface Database {
  getSongs(): Song[];
  ensureProfileBackup(leaderId: string): void;
}

import { Song } from "./Song";
import { leaderDBProfileCodec } from "../../common/pp-codecs";
import { LeaderDBProfile, PlayList, PreferenceType } from "../../common/pp-types";
import { decode } from "../../common/io-utils";
import { parseScheduleDate } from "../../common/date-only";

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
    return l;
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

    return pref;
  }

  getPlaylist(dt: Date, timeSpan: number = 0): Playlist | null {
    let pl = this.schedule.get(dt);
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
    const leader = new Leader(data.leaderId, data.leaderName, data.version || 0);

    for (const prefData of data.preferences ?? []) {
      const pref = SongPreference.fromJSON(prefData);
      leader.preferences.set(pref.songId, pref);
    }

    for (const playlistData of data.playlists ?? []) {
      const date = playlistData.scheduled ?? parseScheduleDate(playlistData.label);
      if (!date) {
        console.warn("Leader", "Skipping playlist with invalid date.", playlistData.label, playlistData.scheduled);
        continue;
      }
      const playlist = Playlist.fromJSON(playlistData);
      leader.setScheduleEntry(date, playlist);
    }

    return leader;
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
