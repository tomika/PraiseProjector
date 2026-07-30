/** Pure startup/update decisions for restoring a client-view page snapshot. */

export type RestorableLocalNavigationMode = "database" | "filter" | "archive";

export interface LocalSongRestoreContext {
  songId?: string;
  navigationMode?: string;
  hasInitialTarget: boolean;
  embedded: boolean;
  canControlDisplay: boolean;
}

/** Only a controller's locally browsed view is reload state. Playlist/follower
 * displays remain owned by the live backend, and explicit entry URLs always win. */
export function canRestoreLocalSong(context: LocalSongRestoreContext): context is LocalSongRestoreContext & {
  songId: string;
  navigationMode: RestorableLocalNavigationMode;
} {
  return (
    !!context.songId &&
    (context.navigationMode === "database" || context.navigationMode === "filter" || context.navigationMode === "archive") &&
    !context.hasInitialTarget &&
    !context.embedded &&
    context.canControlDisplay
  );
}

export interface ClientPlaylistFallbackContext {
  apiMode: string;
  hasInitialTarget: boolean;
  embedded: boolean;
  hasPersistedNavigation: boolean;
}

/** Preserve the established Client startup behavior only for a genuinely fresh
 * entry. A valid saved navigation mode must never be overwritten merely because
 * capabilities or song data are still arriving asynchronously. */
export function shouldUseClientPlaylistFallback(context: ClientPlaylistFallbackContext): boolean {
  return context.apiMode === "Client" && !context.hasInitialTarget && !context.embedded && !context.hasPersistedNavigation;
}

export function hasPersistedViewMode(navigationMode: string | undefined, listMode: string | undefined): boolean {
  const validNavigation =
    navigationMode === "database" || navigationMode === "playlist" || navigationMode === "filter" || navigationMode === "archive";
  const validList = listMode === "database" || listMode === "playlist" || listMode === "leaderlists";
  return validNavigation || validList;
}

export interface DisplayUpdateContext {
  viewingRemoteDisplay: boolean;
  navigationMode: string;
  viewedSongId?: string;
  incomingSongId?: string;
}

/** Followers and playlist navigation consume live display updates. A controller
 * browsing locally accepts only same-song updates, so a follow echo cannot replace
 * the locally viewed song after reload. */
export function shouldAcceptDisplayUpdate(context: DisplayUpdateContext): boolean {
  if (context.viewingRemoteDisplay || context.navigationMode === "playlist") return true;
  return !context.viewedSongId || context.viewedSongId === context.incomingSongId;
}
