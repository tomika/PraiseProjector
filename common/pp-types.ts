/**
 * pp-types.ts — TypeScript types for all cross-boundary communication in PraiseProjector.
 *
 * This file owns all plain TypeScript type definitions. Types are derived from
 * the io-ts codecs in pp-codecs.ts via `t.TypeOf<>`, or defined directly where
 * no codec exists (hand-written compound types, string literal unions, etc.).
 *
 * io-ts codecs (runtime validators) live in pp-codecs.ts.
 * Utility / parsing functions live in pp-utils.ts.
 *
 * Import from pp-codecs.ts when you need runtime io-ts validation.
 * Import from pp-utils.ts when you need utility functions.
 */

import * as t from "io-ts";
import {
  chordSystemCodec,
  songSettingCodec,
  songPreferenceCodec,
  songPreferenceEntryCodec,
  songDataCodec,
  songEntryCodec,
  songDBEntryCodec,
  songDBEntryWithDataCodec,
  playlistEntryCodec,
  sessionResponseCodec,
  peekResponseCodec,
  editSongResponseCodec,
  ppdMessageInternalCodec,
  ppdMessageCodec,
  displayCodec,
  songHistoryResponseCodec,
  songHistoryEntryCodec,
  leaderProfileCodec,
  profileDataCodec,
  playListCodec,
  errorResponseCodec,
  syncResponseCodec,
  songsResponseCodec,
  leadersResponseCodec,
  preferenceTypeCodec,
  songUpdateCodec,
  syncRequestCodec,
  sessionRequestCodec,
  editSongRequestCodec,
  suggestRequestCodec,
  netDisplayDataCodec,
  displayStylesQueryResponseCodec,
} from "./pp-codecs";

// ═══════════════════════════════════════════════════════════════════════════════
//  Primitive / enumeration types
// ═══════════════════════════════════════════════════════════════════════════════

export type ChordSystemCode = t.TypeOf<typeof chordSystemCodec>;
/** @deprecated Use ChordSystemCode — identical type, kept for backward compat. */
export type ChordSystemType = ChordSystemCode;

export type PreferenceType = t.TypeOf<typeof preferenceTypeCodec>;

// ═══════════════════════════════════════════════════════════════════════════════
//  Song setting & preference
// ═══════════════════════════════════════════════════════════════════════════════

export type SongSetting = t.TypeOf<typeof songSettingCodec>;
export type SongPreference = t.TypeOf<typeof songPreferenceCodec>;
export type SongPreferenceEntry = t.TypeOf<typeof songPreferenceEntryCodec>;

// ═══════════════════════════════════════════════════════════════════════════════
//  Song data & entries
// ═══════════════════════════════════════════════════════════════════════════════

export type SongData = t.TypeOf<typeof songDataCodec>;

export type SongFoundType = "NONE" | "TITLE" | "HEAD" | "LYRICS" | "WORDS" | "META";

export type SongEntry = t.TypeOf<typeof songEntryCodec>;
export type SongDBEntry = t.TypeOf<typeof songDBEntryCodec>;
export type SongDBEntryWithData = t.TypeOf<typeof songDBEntryWithDataCodec>;

export type PendingSongOperation = "APPROVE" | "REJECT" | "KEEP" | "REVOKE";
export type PendingSongState = "PENDING" | "REJECTED" | "KEPT";

export type SongDBPendingEntry = SongDBEntryWithData & {
  current: string;
  state: PendingSongState;
  uploader: string;
  created: string;
};

export type SongInfo = SongEntry & { created: string; uploader: string; owner: string };

export type SongFound = SongEntry & { found: { type: SongFoundType; cost: number; snippet?: string } };
export type SongFoundInfo = SongFound & SongInfo;

export type SongHistoryEntry = t.TypeOf<typeof songHistoryEntryCodec>;
export type SongHistoryResponse = t.TypeOf<typeof songHistoryResponseCodec>;

export type SongsRsponse = t.TypeOf<typeof songsResponseCodec>;

// ═══════════════════════════════════════════════════════════════════════════════
//  Playlist
// ═══════════════════════════════════════════════════════════════════════════════

export type PlaylistEntry = t.TypeOf<typeof playlistEntryCodec>;
export type PlayList = t.TypeOf<typeof playListCodec>;

// ═══════════════════════════════════════════════════════════════════════════════
//  Leader profile
// ═══════════════════════════════════════════════════════════════════════════════

export type ProfileData = t.TypeOf<typeof profileDataCodec>;

export type LeaderProfile = t.TypeOf<typeof leaderProfileCodec>;
export type LeaderDBProfile = LeaderProfile & { version: number };

export type LeadersResponse = t.TypeOf<typeof leadersResponseCodec>;

// ═══════════════════════════════════════════════════════════════════════════════
//  Display
// ═══════════════════════════════════════════════════════════════════════════════

export type Display = t.TypeOf<typeof displayCodec>;
export type DisplayStylesQueryResponse = t.TypeOf<typeof displayStylesQueryResponseCodec>;

// ═══════════════════════════════════════════════════════════════════════════════
//  Netdisplay data
// ═══════════════════════════════════════════════════════════════════════════════

export type NetDisplayData = t.TypeOf<typeof netDisplayDataCodec>;

// ═══════════════════════════════════════════════════════════════════════════════
//  Session / host types
// ═══════════════════════════════════════════════════════════════════════════════

export type AppConfig = {
  leaderModeAvailable?: boolean;
  leaderModeEnabled?: boolean;
  leaderName?: string;
  leaderId?: string;
  online?: boolean;
};

export type LocalHostEntry = { host: string; url: string };

export type OnlineSessionEntry = {
  id: string;
  name: string;
  lastUpdate?: string;
  localUrl?: string;
};

export type OnlineSessionResponse = OnlineSessionEntry[];

export type DeviceDataResponse = {
  version: string;
  url: string;
  error?: string;
};

export type PeekResponse = t.TypeOf<typeof peekResponseCodec>;

// ═══════════════════════════════════════════════════════════════════════════════
//  HTTP response types
// ═══════════════════════════════════════════════════════════════════════════════

export type ErrorResponse = t.TypeOf<typeof errorResponseCodec>;
export type SessionResponse = t.TypeOf<typeof sessionResponseCodec>;
export type EditSongResponse = t.TypeOf<typeof editSongResponseCodec>;
export type SuggestResponse = SongDBEntryWithData;

// ═══════════════════════════════════════════════════════════════════════════════
//  PPD protocol message types
// ═══════════════════════════════════════════════════════════════════════════════

export type PpdMessageInternal = t.TypeOf<typeof ppdMessageInternalCodec>;
export type PpdMessage = t.TypeOf<typeof ppdMessageCodec>;

// ═══════════════════════════════════════════════════════════════════════════════
// dbsync response types
// ═══════════════════════════════════════════════════════════════════════════════

export type SyncResponse = t.TypeOf<typeof syncResponseCodec>;

// ═══════════════════════════════════════════════════════════════════════════════
//  API request types (wire format — uploaded from client to server)
//  Derived from io-ts codecs in pp-codecs.ts for runtime validation.
// ═══════════════════════════════════════════════════════════════════════════════

export type SongUpdate = t.TypeOf<typeof songUpdateCodec>;
export type SyncRequest = t.TypeOf<typeof syncRequestCodec>;
export type SessionRequest = t.TypeOf<typeof sessionRequestCodec>;
export type EditSongRequest = t.TypeOf<typeof editSongRequestCodec>;
export type SuggestRequest = t.TypeOf<typeof suggestRequestCodec>;

// ═══════════════════════════════════════════════════════════════════════════════
//  Notification types
// ═══════════════════════════════════════════════════════════════════════════════

export interface NotificationEntry {
  id: number;
  title: string;
  text: string;
}

export type NotificationsResponse = NotificationEntry[];
