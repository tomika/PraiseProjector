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
  return {
    ...display,
    playlist: display.playlist ? [...display.playlist] : undefined,
    sectionRepeatCounts: display.sectionRepeatCounts ? display.sectionRepeatCounts.map((x) => ({ ...x })) : undefined,
  };
}

function sameSectionRepeatCounts(display1: Display, display2: Display) {
  const a = display1.sectionRepeatCounts ?? [];
  const b = display2.sectionRepeatCounts ?? [];
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; ++i) {
    if (a[i].section !== b[i].section) return false;
    if (a[i].from !== b[i].from) return false;
    if (a[i].to !== b[i].to) return false;
    if (a[i].multiplier !== b[i].multiplier) return false;
  }
  return true;
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
    sameSectionRepeatCounts(display1, display2) &&
    (display1.sectionRepeatNonce ?? 0) === (display2.sectionRepeatNonce ?? 0) &&
    (display1.playlist_id ?? "") === (display2.playlist_id ?? "") &&
    (display1.message ?? "") === (display2.message ?? "") &&
    (display1.section ?? -1) === (display2.section ?? -1)
  );
}

async function getSHA256Hash(data: string): Promise<string> {
  const getUtf8Bytes = (value: string): Uint8Array => {
    if (typeof TextEncoder !== "undefined") {
      return new TextEncoder().encode(value);
    }

    // Legacy fallback when TextEncoder is unavailable.
    const encoded = encodeURIComponent(value);
    const bytes: number[] = [];
    for (let i = 0; i < encoded.length; i++) {
      const char = encoded[i];
      if (char === "%" && i + 2 < encoded.length) {
        const hex = encoded.slice(i + 1, i + 3);
        bytes.push(parseInt(hex, 16));
        i += 2;
      } else {
        bytes.push(char.charCodeAt(0));
      }
    }
    return Uint8Array.from(bytes);
  };

  const rightRotate = (value: number, amount: number): number => {
    return (value >>> amount) | (value << (32 - amount));
  };

  const SHA256_K = [
    0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
    0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
    0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
    0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
    0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
    0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
    0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
    0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
  ];

  const sha256FallbackHex = (value: string): string => {
    const bytes = getUtf8Bytes(value);
    const bitLenLo = (bytes.length * 8) >>> 0;
    const bitLenHi = Math.floor((bytes.length * 8) / 0x100000000) >>> 0;
    const totalLength = (((bytes.length + 9 + 63) >> 6) << 6) >>> 0;

    const padded = new Uint8Array(totalLength);
    padded.set(bytes);
    padded[bytes.length] = 0x80;

    const view = new DataView(padded.buffer);
    view.setUint32(totalLength - 8, bitLenHi, false);
    view.setUint32(totalLength - 4, bitLenLo, false);

    let h0 = 0x6a09e667;
    let h1 = 0xbb67ae85;
    let h2 = 0x3c6ef372;
    let h3 = 0xa54ff53a;
    let h4 = 0x510e527f;
    let h5 = 0x9b05688c;
    let h6 = 0x1f83d9ab;
    let h7 = 0x5be0cd19;

    const w = new Uint32Array(64);

    for (let offset = 0; offset < totalLength; offset += 64) {
      for (let i = 0; i < 16; i++) {
        w[i] = view.getUint32(offset + i * 4, false);
      }

      for (let i = 16; i < 64; i++) {
        const s0 = rightRotate(w[i - 15], 7) ^ rightRotate(w[i - 15], 18) ^ (w[i - 15] >>> 3);
        const s1 = rightRotate(w[i - 2], 17) ^ rightRotate(w[i - 2], 19) ^ (w[i - 2] >>> 10);
        w[i] = (w[i - 16] + s0 + w[i - 7] + s1) >>> 0;
      }

      let a = h0;
      let b = h1;
      let c = h2;
      let d = h3;
      let e = h4;
      let f = h5;
      let g = h6;
      let h = h7;

      for (let i = 0; i < 64; i++) {
        const S1 = rightRotate(e, 6) ^ rightRotate(e, 11) ^ rightRotate(e, 25);
        const ch = (e & f) ^ (~e & g);
        const temp1 = (h + S1 + ch + SHA256_K[i] + w[i]) >>> 0;
        const S0 = rightRotate(a, 2) ^ rightRotate(a, 13) ^ rightRotate(a, 22);
        const maj = (a & b) ^ (a & c) ^ (b & c);
        const temp2 = (S0 + maj) >>> 0;

        h = g;
        g = f;
        f = e;
        e = (d + temp1) >>> 0;
        d = c;
        c = b;
        b = a;
        a = (temp1 + temp2) >>> 0;
      }

      h0 = (h0 + a) >>> 0;
      h1 = (h1 + b) >>> 0;
      h2 = (h2 + c) >>> 0;
      h3 = (h3 + d) >>> 0;
      h4 = (h4 + e) >>> 0;
      h5 = (h5 + f) >>> 0;
      h6 = (h6 + g) >>> 0;
      h7 = (h7 + h) >>> 0;
    }

    return [h0, h1, h2, h3, h4, h5, h6, h7].map((part) => part.toString(16).padStart(8, "0")).join("");
  };

  // Prefer Web Crypto when available, but fallback for runtimes (e.g. Android WebView over HTTP)
  // where crypto.subtle is unavailable.
  try {
    if (typeof globalThis.crypto !== "undefined" && globalThis.crypto.subtle) {
      const dataBuffer = getUtf8Bytes(data);
      const digestInput = Uint8Array.from(dataBuffer).buffer;
      const hashBuffer = await globalThis.crypto.subtle.digest("SHA-256", digestInput);
      const hashArray = Array.from(new Uint8Array(hashBuffer));
      return hashArray.map((b) => b.toString(16).padStart(2, "0")).join("");
    }
  } catch {
    // Fall through to software SHA-256 fallback below.
  }

  return sha256FallbackHex(data);
}

export async function generatePlaylistId(playlist: PlaylistEntry[]): Promise<string> {
  if (playlist.length === 0) return "empty";
  const playlistJson = JSON.stringify(playlist);
  try {
    return await getSHA256Hash(playlistJson);
  } catch (error) {
    console.error("Playlist", "Failed to generate SHA-256 hash for playlist; using fallback", error);
    return playlistJson;
  }
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
      } catch {
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
