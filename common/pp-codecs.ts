/**
 * pp-codecs.ts — Unified io-ts codecs for all cross-boundary communication
 * in PraiseProjector.
 *
 * This is the single source of truth for runtime validators (io-ts codecs)
 * shared between:
 *   - Electron main process  (electron/)
 *   - React/Vite front-end  (src/)
 *   - Browser client bundle  (client/)
 *   - Cloud backend server   (server/)
 *
 * Rules:
 *   • Every type that travels over the wire (HTTP, UDP, BT, IPC) is validated here.
 *   • io-ts codecs are exported so that callers can do runtime validation.
 *   • Plain TypeScript types live in pp-types.ts (derived from these codecs via t.TypeOf<>).
 *   • Utility / parsing functions live in pp-utils.ts.
 */

import * as t from "io-ts";

// ─── Internal helper ──────────────────────────────────────────────────────────

/** Shorthand for `t.intersection([t.type(req), t.partial(opt)])`. */
export function uniType<RP extends t.Props, OP extends t.Props>(reqProps: RP, optProps: OP) {
  return t.intersection([t.type(reqProps), t.partial(optProps)]);
}

// ═══════════════════════════════════════════════════════════════════════════════
//  Primitive / enumeration codecs
// ═══════════════════════════════════════════════════════════════════════════════
// For backward compatibility, these codecs are lenient: they decode unknown / null / undefined
// input to a default value instead of failing.  This allows the app to handle stale
// DB values without breaking, and avoids the need for careful undefined/null checks
// on every field when decoding.
export const chordSystemCodec = new t.Type<"G" | "S", "G" | "S", unknown>(
  "ChordSystem",
  (u): u is "G" | "S" => u === "G" || u === "S",
  (u, c) => {
    if (u === undefined || u === null || u === "") return t.success<"G" | "S">("G");
    if (u === "G" || u === "S") return t.success(u);
    return t.failure(u, c);
  },
  t.identity
);

export const preferenceTypeValues = ["Ignore", "Preferred"] as const;

/** Internal type used only by preferenceTypeCodec — exported type lives in pp-types.ts. */
type PreferenceType = "Ignore" | "Preferred";

/**
 * Lenient PreferenceType codec — unknown / null / undefined input decodes to
 * `undefined` instead of failing, so stale DB values don't break decoding.
 */
export const preferenceTypeCodec = new t.Type<PreferenceType | undefined, string | undefined, unknown>(
  "PreferenceType",
  (u): u is PreferenceType | undefined => u === undefined || u === "Preferred" || u === "Ignore",
  (u, _c) => {
    if (u === undefined || u === null) return t.success(undefined);
    if (typeof u !== "string") return t.success(undefined);
    switch (u) {
      case "Preferred":
      case "Ignore":
        return t.success(u);
      default:
        return t.success(undefined);
    }
  },
  t.identity
);

/** Transition duration in milliseconds for net display crossfade (0..500). */
export const transitionMsCodec = new t.Type<number, number, unknown>(
  "TransitionMs",
  (u): u is number => typeof u === "number" && Number.isFinite(u) && u >= 0 && u <= 500,
  (u, c) => {
    // Backward compatibility with legacy boolean payloads.
    if (typeof u === "boolean") return t.success(u ? 500 : 0);
    if (typeof u !== "number" || !Number.isFinite(u)) return t.failure(u, c);
    return t.success(Math.max(0, Math.min(500, Math.round(u))));
  },
  t.identity
);

// ═══════════════════════════════════════════════════════════════════════════════
//  Song setting & preference
// ═══════════════════════════════════════════════════════════════════════════════

export const songSettingCodec = t.partial({
  transpose: t.number,
  capo: t.number,
  title: t.string,
  instructions: t.string,
});

export const songPreferenceCodec = t.partial({
  transpose: t.number,
  capo: t.number,
  title: t.string,
  instructions: t.string,
  type: preferenceTypeCodec,
});

export const songPreferenceEntryCodec = t.intersection([t.type({ songId: t.string }), songPreferenceCodec]);

// ═══════════════════════════════════════════════════════════════════════════════
//  Song data & entries
// ═══════════════════════════════════════════════════════════════════════════════

export const songDataCodec = t.type({
  text: t.string,
  system: chordSystemCodec,
});

export const songEntryCodec = uniType(
  { songId: t.string, title: t.string },
  { transpose: t.number, capo: t.number, instructions: t.string, songdata: songDataCodec }
);

export const songDBEntryCodec = t.intersection([songEntryCodec, uniType({ version: t.number }, { groupId: t.string })]);

export const songDBEntryWithDataCodec = t.intersection([songDBEntryCodec, t.type({ songdata: songDataCodec })]);

export const songsResponseCodec = t.array(songDBEntryWithDataCodec);

// ═══════════════════════════════════════════════════════════════════════════════
//  Playlist
// ═══════════════════════════════════════════════════════════════════════════════

/** Decodes a `string | number | Date` into a `Date`; encodes back to ISO string.
 *  Accepts Date objects directly so that data round-tripped through IndexedDB
 *  (structured clone preserves Date as Date, not string) decodes without error.
 */
export const scheduleCodec = new t.Type<Date, string | number, unknown>(
  "Schedule",
  (u): u is Date => u instanceof Date,
  (u, c) => {
    if (u instanceof Date) return isNaN(u.getTime()) ? t.failure(u, c) : t.success(u);
    if (typeof u !== "string" && typeof u !== "number") return t.failure(u, c);
    const d = new Date(u);
    return isNaN(d.getTime()) ? t.failure(u, c) : t.success(d);
  },
  (d) => d.toISOString()
);

export const playlistEntryCodec = uniType({ songId: t.string, title: t.string }, { transpose: t.number, capo: t.number, instructions: t.string });

export const playlistEntryListCodec = t.array(playlistEntryCodec);

/**
 * Wire codec for PlayList.  `scheduled` is a string over the wire; call
 * `verifyPlaylist()` after decoding to convert it to a `Date`.
 */
export const playListCodec = uniType({ label: t.string, songs: t.array(playlistEntryCodec) }, { scheduled: scheduleCodec });

// ═══════════════════════════════════════════════════════════════════════════════
//  Leader profile
// ═══════════════════════════════════════════════════════════════════════════════

export const profileDataCodec = t.type({
  preferences: t.array(songPreferenceEntryCodec),
  playlists: t.array(playListCodec),
});

export const leaderProfileCodec = t.intersection([t.type({ leaderId: t.string, leaderName: t.string }), profileDataCodec]);

export const leaderDBProfileCodec = t.intersection([leaderProfileCodec, t.type({ version: t.number })]);

export const leadersResponseCodec = t.array(leaderDBProfileCodec);

// ═══════════════════════════════════════════════════════════════════════════════
//  Display
// ═══════════════════════════════════════════════════════════════════════════════

export const displayCodec = uniType(
  {
    song: t.string,
    system: chordSystemCodec,
    songId: t.string,
    from: t.number,
    to: t.number,
    transpose: t.number,
  },
  {
    section: t.number,
    capo: t.number,
    playlist: t.array(playlistEntryCodec),
    playlist_id: t.string,
    version: t.number,
    instructions: t.string,
    message: t.string,
    chordProStylesRev: t.string,
    chordProStyles: t.UnknownRecord,
  }
);

export const displayStylesQueryResponseCodec = uniType(
  {
    rev: t.string,
  },
  {
    changed: t.boolean,
    styles: t.UnknownRecord,
  }
);

// ═══════════════════════════════════════════════════════════════════════════════
//  Netdisplay data
// ═══════════════════════════════════════════════════════════════════════════════

export const netDisplayDataCodec = uniType(
  {
    id: t.string,
  },
  {
    transient: transitionMsCodec,
    transitionType: t.string,
    bgColor: t.string,
  }
);

// ═══════════════════════════════════════════════════════════════════════════════
//  Session / host codecs
// ═══════════════════════════════════════════════════════════════════════════════

export const onlineSessionEntryCodec = uniType({ id: t.string, name: t.string }, { lastUpdate: t.string, localUrl: t.string });
export const onlineSessionEntryListCodec = t.array(onlineSessionEntryCodec);

// ═══════════════════════════════════════════════════════════════════════════════
//  HTTP response codecs
// ═══════════════════════════════════════════════════════════════════════════════

export const structuredErrorCodec = t.type({ code: t.string, message: t.string, ref: t.string });
export const errorResponseCodec = t.type({
  error: t.union([t.string, structuredErrorCodec]),
});

/**
 * SessionResponse codec.
 *
 * NOTE: `leaderId` is optional here (matching observed server behaviour) even
 * though the legacy type declared it required.  Callers should guard before use.
 */
export const sessionResponseCodec = uniType({ token: t.string, login: t.string }, { leaderId: t.string });

export const peekResponseCodec = t.type({
  dbVersion: t.number,
  pendingSongCount: t.number,
});

export const editSongResponseCodec = uniType({ version: t.number, song: t.string, system: chordSystemCodec }, {});

// ═══════════════════════════════════════════════════════════════════════════════
//  PPD protocol message codecs
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * The internal (pre-send / post-receive) PPD message shape — no transport fields.
 * `device` is omitted since it's a transport-level field added by the sender.
 */
export const ppdMessageInternalCodec = uniType({ op: t.string }, { id: t.string, url: t.string, name: t.string, display: displayCodec });

/**
 * Full PPD message with required `device` field (always set by the sender).
 * All producers (UDP, Bluetooth, ppd-protocol.ts) always set `device`; it is
 * never absent on the wire.
 */
export const ppdMessageCodec = uniType(
  { op: t.string, device: t.string },
  { id: t.string, url: t.string, name: t.string, display: displayCodec, port: t.number }
);

// ── Song history ──────────────────────────────────────────────────────────────
// /history endpoint returns an array of these entries

export const songHistoryEntryCodec = t.type({
  created: t.string,
  uploader: t.string,
  songdata: songDataCodec,
});

export const songHistoryResponseCodec = t.array(songHistoryEntryCodec);

// ═══════════════════════════════════════════════════════════════════════════════
//  API request body codecs (client → server)
// ═══════════════════════════════════════════════════════════════════════════════

export const songUpdateCodec = uniType({ songId: t.string, songdata: songDataCodec }, { groupId: t.string });

export const syncRequestCodec = t.type({
  version: t.number,
  clientId: t.string,
  songs: t.array(songUpdateCodec),
  profiles: t.array(leaderProfileCodec),
});

export const sessionRequestCodec = uniType({ clientId: t.string }, { logout: t.boolean });

export const editSongRequestCodec = t.type({ id: t.string });

export const suggestRequestCodec = uniType({ id: t.string, version: t.number, song: t.string }, { system: chordSystemCodec, leaderId: t.string });

// ── Sync ──────────────────────────────────────────────────────────────────────
export const syncedLeaderEntryCodec = t.intersection([
  t.type({
    leaderId: t.string,
    leaderName: t.string,
    updateable: t.boolean,
  }),
  t.partial({
    version: t.number,
    preferences: t.array(songPreferenceEntryCodec),
    playlists: t.array(playListCodec),
  }),
]);

export const syncResponseCodec = t.intersection([
  t.type({
    upload_enabled: t.boolean,
    version: t.number,
    songs: t.array(t.union([songDBEntryWithDataCodec, uniType({ songId: t.string }, { version: t.number })])),
    leaders: t.array(t.union([syncedLeaderEntryCodec, t.type({ leaderId: t.string, updateable: t.boolean, version: t.undefined })])),
  }),
  t.partial({
    token: t.string,
  }),
]);
