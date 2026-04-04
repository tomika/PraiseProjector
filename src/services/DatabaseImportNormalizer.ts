import { unzipSync, zipSync, strFromU8, strToU8 } from "fflate";
import type { SongStoreRecord } from "../../db-common/Song";
import * as t from "io-ts";
import { decode } from "../../common/io-utils";
import { Database } from "../../db-common/Database";
import { LeadersResponse, PlayList, PlaylistEntry, SongPreferenceEntry } from "../../common/pp-types";

const DB_VERSION_PREFIX = "# db_version:";
const GROUP_ID_PREFIX = "# group_id:";

function parseNumber(value: string | null | undefined, fallback = 0): number {
  if (!value) return fallback;
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

/**
 * Resolve the DOMParser constructor that should be used for parsing the imported
 * XML.  In a browser / Electron renderer process the global DOMParser is always
 * available.  In a Node.js test environment it must be provided externally via
 * `globalThis.DOMParser` (use \@xmldom/xmldom to polyfill it before calling
 * normalizeImportedDatabase).
 */
function getDOMParser(): DOMParser {
  if (typeof DOMParser !== "undefined") {
    return new DOMParser();
  }
  throw new Error(
    "DOMParser is not available.  In a Node.js test environment polyfill it via " +
      "globalThis.DOMParser before calling normalizeImportedDatabase.\n" +
      "Example: import { DOMParser } from '@xmldom/xmldom'; " +
      "(globalThis as unknown as Record<string,unknown>).DOMParser = DOMParser;"
  );
}

function mapLegacyMode(modeValue: string): "Ignore" | "Preferred" | undefined {
  switch (modeValue.trim().toLowerCase()) {
    case "ignore":
      return "Ignore";
    case "preferred":
    case "exclusive":
      return "Preferred";
    default:
      return undefined;
  }
}

function parseLegacyPlaylistLine(line: string): PlaylistEntry | null {
  const trimmed = line.trim();
  if (!trimmed) return null;

  if (trimmed.startsWith("{")) {
    try {
      const raw = JSON.parse(trimmed) as Partial<PlaylistEntry>;
      if (!raw.songId || typeof raw.songId !== "string") return null;
      return {
        songId: raw.songId,
        title: typeof raw.title === "string" ? raw.title : "",
        transpose: typeof raw.transpose === "number" ? raw.transpose : 0,
        capo: typeof raw.capo === "number" ? raw.capo : -1,
        instructions: typeof raw.instructions === "string" ? raw.instructions : "",
      };
    } catch {
      // Fall through to legacy line format.
    }
  }

  const legacyMatch = /([0-9a-f-]+)(?:@(-?[0-9]+))?(?:\|([0-9]+))?(?::(.*))?/i.exec(trimmed);
  if (!legacyMatch) return null;

  return {
    songId: legacyMatch[1],
    transpose: legacyMatch[2] ? Number.parseInt(legacyMatch[2], 10) : 0,
    capo: legacyMatch[3] ? Number.parseInt(legacyMatch[3], 10) : -1,
    title: legacyMatch[4] ? legacyMatch[4].trim() : "",
    instructions: "",
  };
}

function parseLegacyPlaylist(text: string): PlaylistEntry[] {
  return text
    .split(/\r?\n/)
    .map(parseLegacyPlaylistLine)
    .filter((entry): entry is PlaylistEntry => !!entry);
}

function parseSongTextAndHeaders(songText: string): { text: string; version: number; groupId: string } {
  const lines = songText.split(/\r?\n/);
  let i = 0;
  let version = 0;
  let groupId = "";

  while (i < lines.length) {
    const line = lines[i]?.trimStart() ?? "";
    if (line.startsWith(DB_VERSION_PREFIX)) {
      version = parseNumber(line.substring(DB_VERSION_PREFIX.length).trim(), 0);
      i += 1;
      continue;
    }
    if (line.startsWith(GROUP_ID_PREFIX)) {
      groupId = line.substring(GROUP_ID_PREFIX.length).trim();
      i += 1;
      continue;
    }
    break;
  }

  const text = lines.slice(i).join("\n");
  return { text, version, groupId };
}

function formatLegacyScheduleLabel(dateText: string): string {
  if (!dateText) return "";
  const datePart = dateText.includes("T") ? (dateText.split("T")[0] ?? dateText) : dateText;
  return datePart.replace(/-/g, ".");
}

function parseHexOrDec(value: string): number | null {
  if (value.startsWith("x") || value.startsWith("X")) {
    const hexPart = value.substring(1);
    const hexValue = parseInt(hexPart, 16);
    if (!isNaN(hexValue)) {
      return hexValue;
    }
  } else {
    const decValue = parseInt(value, 10);
    if (!isNaN(decValue)) {
      return decValue;
    }
  }
  return null;
}

function parseLegacyXmlDatabase(xmlText: string): { database: t.TypeOf<typeof Database.importExportCodec>; username: string; exported: string } {
  const parser = getDOMParser();
  // Filter invalid XML 1.0 character references that would cause the parser to
  // fail; these may be present in older PP XML exports and are not meaningful.
  // Valid XML 1.0 chars: #x9 | #xA | #xD | [#x20-#xD7FF] | [#xE000-#xFFFD] | [#x10000-#x10FFFF]
  const xmlFiltered = xmlText.replace(/&#(x[0-9a-fA-F]+|[0-9]+);/g, (match, value) => {
    const v = parseHexOrDec(value);
    if (v == null) return match;
    if (v === 0x9 || v === 0xa || v === 0xd) return match;
    if (v >= 0x20 && v <= 0xd7ff) return match;
    if (v >= 0xe000 && v <= 0xfffd) return match;
    if (v >= 0x10000 && v <= 0x10ffff) return match;
    return "";
  });
  const doc = parser.parseFromString(xmlFiltered, "application/xml");
  // querySelector is not available in xmldom (test polyfill); getElementsByTagName works everywhere.
  const errors = doc.getElementsByTagName("parsererror");
  if (errors.length > 0) {
    console.error(
      "Error parsing XML database:",
      Array.from(errors)
        .map((element) => element.textContent)
        .join("\n")
    );
    throw new Error("Invalid XML format.");
  }

  const root = doc.documentElement;
  if (!root || root.tagName !== "PraiseProjectorDatabase") {
    throw new Error("Unsupported XML database format.");
  }

  const songs: SongStoreRecord[] = [];
  const songNodes = root.getElementsByTagName("song");
  for (let i = 0; i < songNodes.length; i += 1) {
    const songNode = songNodes.item(i);
    if (!songNode) continue;

    const { text, version, groupId } = parseSongTextAndHeaders(songNode.textContent ?? "");
    const id = (songNode.getAttribute("id") || "").trim() || crypto.randomUUID();

    songs.push({
      songId: id,
      songdata: {
        text,
        system: "G",
      },
      version,
      ...(groupId ? { groupId } : {}),
    });
  }

  const leaders: LeadersResponse = [];
  const leaderNodes = root.getElementsByTagName("leader");
  for (let i = 0; i < leaderNodes.length; i += 1) {
    const leaderNode = leaderNodes.item(i);
    if (!leaderNode) continue;

    const leaderId = (leaderNode.getAttribute("id") || "").trim();
    const leaderName = (leaderNode.getAttribute("name") || leaderId).trim();
    if (!leaderId || !leaderName) continue;

    const version = parseNumber(leaderNode.getAttribute("version"), 0);
    const preferences: SongPreferenceEntry[] = [];
    const prefNodes = leaderNode.getElementsByTagName("preference");
    for (let p = 0; p < prefNodes.length; p += 1) {
      const prefNode = prefNodes.item(p);
      if (!prefNode) continue;

      const songId = (prefNode.getAttribute("song") || "").trim();
      if (!songId) continue;

      const title = prefNode.getAttribute("title") ?? undefined;
      const instructions = prefNode.getAttribute("instructions") ?? undefined;
      const transposeRaw = prefNode.getAttribute("transpose");
      const capoRaw = prefNode.getAttribute("capo");
      const modeRaw = prefNode.getAttribute("mode") || "";
      const mappedType = mapLegacyMode(modeRaw);

      preferences.push({
        songId,
        title: title && title.trim() ? title : undefined,
        transpose: transposeRaw != null && transposeRaw !== "" ? parseNumber(transposeRaw, 0) : undefined,
        capo: capoRaw != null && capoRaw !== "" ? parseNumber(capoRaw, -1) : undefined,
        instructions: instructions && instructions.trim() ? instructions : undefined,
        type: mappedType,
      });
    }

    const playlists: PlayList[] = [];
    const scheduleNodes = leaderNode.getElementsByTagName("schedule");
    for (let s = 0; s < scheduleNodes.length; s += 1) {
      const scheduleNode = scheduleNodes.item(s);
      if (!scheduleNode) continue;

      const dateRaw = (scheduleNode.getAttribute("date") || "").trim();
      const songsInPlaylist = parseLegacyPlaylist(scheduleNode.textContent ?? "");
      playlists.push({
        label: formatLegacyScheduleLabel(dateRaw) || "Imported",
        songs: songsInPlaylist,
        ...(dateRaw ? { scheduled: new Date(dateRaw) } : {}),
      });
    }

    leaders.push({
      leaderId,
      leaderName,
      version,
      preferences,
      playlists,
    });
  }

  if (songs.length === 0 && leaders.length === 0) {
    throw new Error("XML database does not contain songs or leaders.");
  }

  return {
    database: {
      version: parseNumber(root.getAttribute("version"), 0),
      songs,
      leaders,
    },
    username: root.getAttribute("username") || "",
    exported: root.getAttribute("exported") || "",
  };
}

export const databaseExportEnvelopeCodec = t.type({
  format: t.union([t.literal("ppdb-export-v1"), t.literal("ppdb-export-v2"), t.literal("ppdb-export-v2.1")]),
  username: t.string,
  exportedAt: t.string,
  database: Database.importExportCodec,
});

export type DatabaseExportEnvelope = t.TypeOf<typeof databaseExportEnvelopeCodec>;

export function compressDatabaseToZip(jsonContent: string): Blob {
  const compressed = zipSync({ "database.json": strToU8(jsonContent) });
  return new Blob([compressed.buffer as ArrayBuffer], { type: "application/zip" });
}

export async function normalizeImportedDatabase(input: File): Promise<DatabaseExportEnvelope | null> {
  const buffer = await input.arrayBuffer();
  const text = prepareImportBuffer(buffer);

  let parsed: unknown;
  let envelope: DatabaseExportEnvelope | null = null;

  try {
    try {
      parsed = JSON.parse(text) as unknown;
    } catch (error) {
      console.error("App", "Failed to parse JSON, attempting XML fallback", error);
      const fromXML = parseLegacyXmlDatabase(text);
      envelope = {
        format: "ppdb-export-v1",
        username: fromXML.username,
        exportedAt: fromXML.exported,
        database: fromXML.database,
      };
    }

    if (!envelope) {
      try {
        // For JSON imports, the envelope is expected to be part of the imported data.
        envelope = decode(databaseExportEnvelopeCodec, parsed);
      } catch {
        // If parsing as an envelope fails, treat the entire JSON as the database payload for legacy support.
        envelope = {
          format: "ppdb-export-v2",
          username: "",
          exportedAt: "",
          database: decode(Database.importExportCodec, parsed),
        };
      }
    }
  } catch (error) {
    console.error("App", "Failed to parse database export", error);
    return null;
  }

  return envelope;
}

/**
 * Accepts an ArrayBuffer that is either a plain-text database (JSON or XML) or
 * a ZIP-compressed .ppdb file.  Returns the inner content as a UTF-8 string
 * ready to pass to normalizeImportedDatabase().
 */
export function prepareImportBuffer(buffer: ArrayBuffer): string {
  if (buffer.byteLength >= 2) {
    const uint8View = new Uint8Array(buffer);
    const sig1 = uint8View[0];
    const sig2 = uint8View[1];
    if (sig1 === "P".charCodeAt(0) && sig2 === "K".charCodeAt(0)) {
      const files = unzipSync(uint8View);
      const firstEntry = Object.values(files)[0];
      if (!firstEntry) throw new Error("ZIP archive is empty.");
      return strFromU8(firstEntry);
    }
  }
  return new TextDecoder().decode(buffer);
}
