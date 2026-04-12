import {
  Display,
  ErrorResponse,
  PlayList,
  PlaylistEntry,
  PreferenceType,
  SongEntry,
  SongFound,
  SongFoundType,
  SongPreferenceEntry,
} from "./pp-types";
import { log, logError } from "./pp-log";
import { decode, parseAndDecode } from "./io-utils";
import { playlistEntryCodec } from "./pp-codecs";

export const notPhraseFoundAdditionalCost = 1000;

export function isErrorResponse(resp: unknown): resp is ErrorResponse {
  return resp != null && typeof resp === "object" && Object.prototype.hasOwnProperty.call(resp, "error");
}

/** Type guard for the electron-side wider SongFound. */
export function entryIsFound(entry: SongEntry): entry is SongFound {
  return !!(entry as SongFound).found;
}

export function compareFoundEntries(e1: SongEntry, e2: SongEntry): number {
  if (entryIsFound(e1) && entryIsFound(e2)) {
    const typeVal = (type: SongFoundType) => {
      switch (type) {
        case "NONE":
          return -1;
        case "TITLE":
          return 0;
        case "HEAD":
          return 1;
        case "LYRICS":
          return 2;
        case "META":
          return 3;
        case "WORDS":
          return 4;
      }
    };
    if (e1.found.type !== e2.found.type) return typeVal(e1.found.type) - typeVal(e2.found.type);
    const diff = e1.found.cost - e2.found.cost;
    if (diff) return diff;
  }
  return e1.title.localeCompare(e2.title);
}

const _emptyDisplay: Display = {
  song: "",
  system: "S",
  songId: "",
  from: 0,
  to: 0,
  transpose: 0,
};

export function getEmptyDisplay(): Display {
  return { ..._emptyDisplay };
}

/** Shallow-clone a Display, copying the playlist array reference. */
export function cloneDisplay(display: Display): Display {
  return { ...display, playlist: display.playlist ? [...display.playlist] : undefined };
}

/** Structural equality for Display objects (ignores playlist entry contents). */
export function compareDisplays(display1: Display, display2: Display): boolean {
  return (
    (display1.songId ?? "") === (display2.songId ?? "") &&
    (display1.song ?? "") === (display2.song ?? "") &&
    (display1.system ?? "") === (display2.system ?? "") &&
    (display1.from ?? 0) === (display2.from ?? 0) &&
    (display1.to ?? 0) === (display2.to ?? 0) &&
    (display1.transpose ?? 0) === (display2.transpose ?? 0) &&
    (display1.capo ?? -1) === (display2.capo ?? -1) &&
    (display1.instructions ?? "") === (display2.instructions ?? "") &&
    (display1.playlist_id ?? "") === (display2.playlist_id ?? "") &&
    (display1.message ?? "") === (display2.message ?? "") &&
    (display1.section ?? -1) === (display2.section ?? -1)
  );
}

async function getSHA256Hash(data: string): Promise<string> {
  // Use Web Crypto API for browser/cross-platform compatibility
  const encoder = new TextEncoder();
  const dataBuffer = encoder.encode(data);
  const hashBuffer = await crypto.subtle.digest("SHA-256", dataBuffer);
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  return hashArray.map((b) => b.toString(16).padStart(2, "0")).join("");
}

export async function generatePlaylistId(playlist: PlaylistEntry[]): Promise<string> {
  if (playlist.length === 0) return "empty";
  const playlistJson = JSON.stringify(playlist);
  return await getSHA256Hash(playlistJson);
}

// ═══════════════════════════════════════════════════════════════════════════════
//  parsing functions
// ═══════════════════════════════════════════════════════════════════════════════

function twodigit(n: number): string {
  let s = n.toString();
  while (s.length < 2) s = "0" + s;
  return s;
}

export function formatDateForLabel(scheduled: Date): string {
  return scheduled.getFullYear() + "." + twodigit(scheduled.getMonth() + 1) + "." + twodigit(scheduled.getDate());
}

export function parseLeaderProfile(data: string): { preferences: SongPreferenceEntry[]; playlists: PlayList[] } {
  const preferences: SongPreferenceEntry[] = [];
  const playlists: PlayList[] = [];
  let current_list: SongPreferenceEntry[] | PlaylistEntry[] = preferences;
  for (const l of data.split("\n")) {
    const line = l.trim();
    if (line.startsWith("[") && line.endsWith("]")) {
      let label = line.substr(1, line.length - 2).trim();
      const startTime = Date.parse(label.replace(/([0-9]+)\. *([0-9]+)\. *([0-9]+)/, "$1-$2-$3"));
      const scheduled = isNaN(startTime) ? undefined : new Date(startTime);
      if (scheduled) label = formatDateForLabel(scheduled);
      const songs: PlaylistEntry[] = [];
      playlists.push({ label, scheduled, songs });
      current_list = songs;
    } else {
      const setting = parseSongSetting(line);
      if (setting) (current_list as SongPreferenceEntry[]).push(setting);
    }
  }
  return { preferences, playlists };
}

export function parseSongSetting(s: string): SongPreferenceEntry | null {
  s = s.trim();
  if (!s) return null;

  if (s.startsWith("{") && s.endsWith("}")) {
    try {
      const p = JSON.parse(s);
      if (Object.prototype.hasOwnProperty.call(p, "songId")) return p as SongPreferenceEntry;
    } catch (error) {
      logError("JSON like profile string is not JSON", error);
    }
  }

  return parseOldSongSettingFormat(s);
}

function parseOldSongSettingFormat(s: string): SongPreferenceEntry | null {
  const match = /^([-a-fA-F0-9]+)(?:=([^@|:]*))?(?:@([-0-9]+))?(?:\|([0-9]+))?(?::(.*))?$/m.exec(s);
  if (!match) {
    log("Invalid profile entry string: " + s);
    return null;
  }
  const songId = match[1];
  const type = match[2] ? (match[2] as PreferenceType) : undefined;
  const transpose = parseInt(match[3] || "0", 10);
  const capo = match[4] ? parseInt(match[4], 10) : undefined;
  const title = match[5] ? match[5] : undefined;
  return { songId, transpose, capo, title, type };
}

export function verifyPlaylist(playlist: PlayList): void {
  if (playlist.scheduled) playlist.scheduled = new Date(playlist.scheduled as unknown as string);
  if (!playlist.label) playlist.label = playlist.scheduled ? formatDateForLabel(playlist.scheduled) : "";
}

export function deserializePlaylist(playlistRaw: unknown): PlaylistEntry[] | undefined {
  if (playlistRaw == null) return undefined;

  let normalized: unknown = playlistRaw;

  if (typeof playlistRaw === "string") {
    const trimmed = playlistRaw.trim();
    if (!trimmed) return [];
    if (trimmed.startsWith("[")) {
      try {
        normalized = JSON.parse(trimmed);
      } catch (error) {
        throw new Error(`Invalid playlist JSON array: ${error instanceof Error ? error.message : String(error)}`);
      }
    } else if (trimmed.startsWith("{")) {
      try {
        normalized = [JSON.parse(trimmed)];
      } catch (error) {
        // Support legacy newline-delimited JSON object entries.
        normalized = trimmed.split("\n");
      }
    } else {
      // Legacy newline-delimited profile format.
      normalized = trimmed.split("\n");
    }
  }

  if (Array.isArray(normalized)) {
    const parsed: PlaylistEntry[] = [];
    for (const entry of normalized) {
      if (typeof entry === "string") {
        const line = entry.trim();
        if (!line) continue;
        try {
          parsed.push(parseAndDecode(playlistEntryCodec, line));
          continue;
        } catch (error) {
          logError("Failed to decode playlist entry from string: " + line, error);
        }

        const legacy = parseOldSongSettingFormat(line);
        if (!legacy) throw new Error(`Invalid playlist entry string: ${line}`);
        parsed.push(legacy as PlaylistEntry);
        continue;
      }

      try {
        parsed.push(decode(playlistEntryCodec, entry));
      } catch (error) {
        throw new Error(`Invalid playlist entry object: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    return parsed;
  }

  throw new Error(`Unexpected playlist format: ${typeof normalized}`);
}
