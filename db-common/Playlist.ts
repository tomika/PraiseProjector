import { PlaylistEntry } from "./PlaylistEntry";
import { Song } from "./Song";
import { v4 as uuidv4 } from "uuid";
import { PlayList } from "../common/pp-types";

export class Playlist {
  id: string;
  name: string;
  items: PlaylistEntry[];
  modified: number; // timestamp

  constructor(name: string, items: PlaylistEntry[] = [], id: string | null = null) {
    this.id = id || uuidv4();
    this.name = name;
    this.items = items;
    this.modified = Date.now();
  }

  clone(): Playlist {
    const p = new Playlist(this.name, [], this.id);
    p.items = this.items.map((item) => item.clone());
    p.modified = this.modified;
    return p;
  }

  equals(l: Playlist): boolean {
    if (this.items.length !== l.items.length) return false;
    for (let i = 0; i < this.items.length; i++) {
      const item1 = this.items[i];
      const item2 = l.items[i];
      if (!item1 || !item2 || !item1.equals(item2)) return false;
    }
    return true;
  }

  // Link songs from the main database to the playlist items
  linkSongs(songs: Map<string, Song>) {
    for (const item of this.items) {
      if (item.songId && songs.has(item.songId)) {
        const song = songs.get(item.songId);
        if (song) {
          item.title = song.Title;
        }
      }
    }
  }

  static fromJSON(data: PlayList): Playlist {
    const items = data.songs.map((itemData) => PlaylistEntry.fromJSON(itemData)).filter((item) => item !== null) as PlaylistEntry[];
    const playlist = new Playlist(data.label, items);
    return playlist;
  }

  toJSON(): PlayList {
    return {
      label: this.name,
      songs: this.items.map((item) => item.toJSON()),
    };
  }

  // Format playlist to string - matching C# Playlist.ToString(Database)
  toString(): string {
    return this.items.map((item) => item.formatLine()).join("\n") + "\n";
  }

  // Parse playlist from string - matching C# Playlist.Parse
  static parse(s: string): Playlist {
    const pl = new Playlist("CurrentPlaylist");
    const lines = s.split("\n");
    for (const line of lines) {
      if (line.trim()) {
        const ple = PlaylistEntry.parseLine(line);
        if (ple) pl.items.push(ple);
      }
    }
    return pl;
  }
}
