import { Song } from "./Song";

export enum PlaylistItemType {
  Song,
  Image,
  Text,
}

export class PlaylistItem {
  type: PlaylistItemType = PlaylistItemType.Song;
  song: Song | null = null;
  songId: string | null = null; // To hold the ID for later lookup
  imagePath: string = "";
  text: string = "";
  title: string = "";
  instructions: string = "";

  constructor(data?: Partial<PlaylistItem>) {
    if (data) {
      Object.assign(this, data);
      if (data.song) {
        this.songId = data.song.Id;
        this.title = data.song.Title;
      }
    }
  }

  public toString(): string {
    return this.title || "Playlist Item";
  }

  static fromJSON(data: any): PlaylistItem {
    if (typeof data === "string") {
      // Handle old format where playlist item was just a song ID string
      return new PlaylistItem({ songId: data, title: "Unknown Title" });
    }
    if (data && data.songId) {
      return new PlaylistItem({
        songId: data.songId,
        title: data.songTitle || data.title || "Unknown Title",
        instructions: data.instructions || "",
      });
    }
    if (data && data.song) {
      return new PlaylistItem({
        song: data.song,
        title: data.song.title,
        instructions: data.instructions || "",
      });
    }
    // Handle cases where data is malformed or incomplete
    return new PlaylistItem({ songId: "unknown", title: "Invalid Item" });
  }
}
