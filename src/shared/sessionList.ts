import type { OnlineSessionEntry } from "../../common/pp-types";

export function filterOwnSessionEntries<T extends OnlineSessionEntry>(sessions: T[], ownSessionId: string | null | undefined): T[] {
  const selfId = ownSessionId?.trim();
  if (!selfId) return sessions;
  return sessions.filter((session) => session.id !== selfId);
}
