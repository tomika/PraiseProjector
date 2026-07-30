import { Leader } from "../../db-common/Leader";
import { Playlist } from "../../db-common/Playlist";

export interface PlaylistOrigin {
  leaderId: string;
  scheduledAt: number;
  label: string;
}

export interface ScheduledPlaylist {
  date: Date;
  playlist: Playlist;
}

type PlaylistScheduleSource = Pick<Leader, "id" | "getSchedule" | "getPlaylist">;

export interface ResolvedPlaylistOrigin extends ScheduledPlaylist {
  origin: PlaylistOrigin;
  leader: PlaylistScheduleSource;
}

export function findScheduledPlaylist(leader: PlaylistScheduleSource, requestedDate: Date, timeSpan = 0): ScheduledPlaylist | null {
  const requestedTimestamp = requestedDate.getTime();
  const endTimestamp = requestedTimestamp + Math.max(0, timeSpan);
  const dates = leader.getSchedule();
  const date =
    dates.find((candidate) => candidate.getTime() === requestedTimestamp) ??
    (timeSpan > 0
      ? dates.find((candidate) => {
          const timestamp = candidate.getTime();
          return timestamp >= requestedTimestamp && timestamp <= endTimestamp;
        })
      : undefined);

  if (!date) return null;
  const playlist = leader.getPlaylist(date);
  return playlist ? { date, playlist } : null;
}

export function createPlaylistOrigin(leaderId: string, scheduledDate: Date, playlist: Playlist): PlaylistOrigin {
  return {
    leaderId,
    scheduledAt: scheduledDate.getTime(),
    label: playlist.name,
  };
}

export function parsePlaylistOrigin(value: string | null): PlaylistOrigin | null {
  if (!value) return null;
  try {
    const parsed = JSON.parse(value) as Partial<PlaylistOrigin>;
    if (
      typeof parsed.leaderId !== "string" ||
      parsed.leaderId.length === 0 ||
      typeof parsed.scheduledAt !== "number" ||
      !Number.isFinite(parsed.scheduledAt) ||
      !Number.isFinite(new Date(parsed.scheduledAt).getTime()) ||
      typeof parsed.label !== "string" ||
      parsed.label.length === 0
    ) {
      return null;
    }
    return {
      leaderId: parsed.leaderId,
      scheduledAt: parsed.scheduledAt,
      label: parsed.label,
    };
  } catch {
    return null;
  }
}

export function resolvePlaylistOrigin(
  origin: PlaylistOrigin | null,
  currentPlaylist: Playlist,
  findLeader: (leaderId: string) => PlaylistScheduleSource | undefined
): ResolvedPlaylistOrigin | null {
  if (!origin || currentPlaylist.items.length === 0) return null;
  const leader = findLeader(origin.leaderId);
  if (!leader) return null;

  const scheduled = findScheduledPlaylist(leader, new Date(origin.scheduledAt));
  if (!scheduled || scheduled.playlist.name !== origin.label || !scheduled.playlist.equals(currentPlaylist)) return null;

  return {
    origin,
    leader,
    ...scheduled,
  };
}
