import { PlaylistEntry as PlaylistEntryJSON } from "../common/pp-types";

export class PlaylistEntry {
  title = "";
  transpose = 0;
  capo = -1;
  instructions = "";

  constructor(readonly songId: string) {}

  clone(): PlaylistEntry {
    const e = new PlaylistEntry(this.songId);
    e.title = this.title;
    e.transpose = this.transpose;
    e.capo = this.capo;
    e.instructions = this.instructions;
    return e;
  }

  equals(entry: PlaylistEntry): boolean {
    return (
      this.songId === entry.songId &&
      (this.instructions || "") === (entry.instructions || "") &&
      (this.title || "") === (entry.title || "") &&
      this.transpose === entry.transpose &&
      this.capo === entry.capo
    );
  }

  static fromJSON(data: PlaylistEntryJSON): PlaylistEntry {
    const entry = new PlaylistEntry(data.songId);
    entry.title = data.title ?? "";
    entry.transpose = data.transpose ?? 0;
    entry.capo = data.capo ?? -1;
    entry.instructions = data.instructions ?? "";
    return entry;
  }

  toJSON(): PlaylistEntryJSON {
    return {
      songId: this.songId,
      title: this.title,
      transpose: this.transpose,
      capo: this.capo,
      instructions: this.instructions,
    };
  }

  // Format line for .ppl file - matching C# PlaylistEntry.FormatLine
  formatLine(): string {
    return JSON.stringify(this.toJSON());
  }

  // Parse line from .ppl file - matching C# PlaylistEntry.ParseLine
  static parseLine(line: string): PlaylistEntry | null {
    const trimmed = line.trim();
    if (!trimmed) return null;

    // Try JSON format first
    if (trimmed.startsWith("{")) {
      try {
        const data = JSON.parse(trimmed) as PlaylistEntryJSON;
        return PlaylistEntry.fromJSON(data);
      } catch {
        console.error("Playlist", "Failed to parse JSON playlist entry", trimmed);
      }
    }

    // Try legacy format: songId@transpose|capo:title
    const rxLine = /([0-9a-f-]+)(?:@(-?[0-9]+))?(?:\|([0-9]+))?(?::(.*))?/i;
    const match = rxLine.exec(trimmed);
    if (!match) {
      console.error("Playlist", "PlaylistEntry.parseLine failed", line);
      return null;
    }

    const entry = new PlaylistEntry(match[1]);
    if (match[2]) entry.transpose = parseInt(match[2]);
    if (match[3]) entry.capo = parseInt(match[3]);
    if (match[4]) entry.title = match[4].trim();
    return entry;
  }

  // Create from sync API response - matching C# PlaylistEntry.FromSynced
  // Uses PlaylistEntryJSON from display.ts for API communication types
  static fromSynced(ple: PlaylistEntryJSON): PlaylistEntry {
    const entry = new PlaylistEntry(ple.songId);
    entry.title = ple.title || "";
    entry.transpose = ple.transpose || 0;
    entry.capo = ple.capo ?? -1;
    entry.instructions = ple.instructions || "";
    return entry;
  }
}
