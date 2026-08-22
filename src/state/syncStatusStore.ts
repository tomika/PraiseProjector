/**
 * syncStatusStore — a tiny module-singleton (like SongFilterStore / CurrentSongStore)
 * that mirrors the FULL VIEW's "todo" status so the CLIENT VIEW can show attention
 * badges WITHOUT re-implementing any of the checks.
 *
 * SINGLE WRITER: the full view's UserPanel (the only place that polls /peek and counts
 * local DB changes) publishes here via setSyncStatus(). The embedded client view READS
 * it through DirectClientApi.subscribeSyncStatus(). There is exactly one writer and no
 * duplicated polling.
 *
 * Only meaningful for the in-process desktop embed (App + UserPanel always mounted).
 * The served/cloud Rest client has no local DB/full view, so its adapter does NOT
 * implement the sync-status port methods and the client view simply shows no badges.
 */
import { useSyncExternalStore } from "react";

export interface SyncStatus {
  /** Whether a cloud user is logged in (guests/anon => false). */
  authenticated: boolean;
  /** Local edits waiting to be uploaded (updated songs + profiles). */
  localChangeCount: number;
  /** Server changes waiting to be pulled (cloudDbVersion - localDbVersion). */
  remoteChangeCount: number;
  /** Songs awaiting review/handling (SongCheck). */
  pendingSongCount: number;
  /** A software update is available or downloaded. */
  updateAvailable: boolean;
  /** The device cannot reach the cloud at all (no network / offline session). */
  offline: boolean;
  /** The cloud is reachable but the session needs re-auth. */
  cloudAuthFailed: boolean;
}

/**
 * The ONE colour a todo badge shows. Each kind is a distinct situation rather
 * than a severity level, because "something is pending" alone (the old single red
 * dot) told the user nothing about whether it was worth opening the full view:
 *
 *   upload   (green)     — only local edits waiting to be pushed
 *   download (blue)      — nothing to push, but the server is ahead
 *   sync     (turquoise) — both directions, and nothing else
 *   offline  (orange)    — the device cannot reach the cloud
 *   other    (red)       — pending songs, an app update, or anything else
 */
export type TodoBadgeKind = "upload" | "download" | "sync" | "offline" | "other";

export const EMPTY_SYNC_STATUS: SyncStatus = {
  authenticated: false,
  localChangeCount: 0,
  remoteChangeCount: 0,
  pendingSongCount: 0,
  updateAvailable: false,
  offline: false,
  cloudAuthFailed: false,
};

type Listener = () => void;

let status: SyncStatus = EMPTY_SYNC_STATUS;
const listeners = new Set<Listener>();

export function getSyncStatus(): SyncStatus {
  return status;
}

/** Publish the latest status. No-op (no emit) when nothing changed, so mirror writes
 *  from the full view never cause needless client-view re-renders. */
export function setSyncStatus(next: SyncStatus): void {
  if (
    status.authenticated === next.authenticated &&
    status.localChangeCount === next.localChangeCount &&
    status.remoteChangeCount === next.remoteChangeCount &&
    status.pendingSongCount === next.pendingSongCount &&
    status.updateAvailable === next.updateAvailable &&
    status.offline === next.offline &&
    status.cloudAuthFailed === next.cloudAuthFailed
  ) {
    return;
  }
  status = next;
  for (const l of listeners) l();
}

export function subscribeSyncStatus(listener: (status: SyncStatus) => void): () => void {
  const handler: Listener = () => listener(status);
  listeners.add(handler);
  listener(status);
  return () => listeners.delete(handler);
}

/** True when there is anything the user can only resolve in the FULL VIEW (sync,
 *  song review, or app update). Drives the client-view attention dots. */
export function hasFullViewTodo(s: SyncStatus): boolean {
  return todoBadgeKind(s) !== null;
}

/**
 * Classify the todo status into the single badge colour to show, or null when
 * there is nothing to report. Most specific / most urgent first: anything that is
 * neither plain sync traffic nor a lost link is "other" and shows red ALONE, so
 * red keeps meaning "there is more here than a sync".
 *
 * `ignoreUpdate` drops the app-update trigger, for surfaces where the update is
 * reachable anyway and so should not claim a badge of its own (the full view's
 * tab header — UpdateNotification is mounted above all three tabs).
 */
export function todoBadgeKind(s: SyncStatus, { ignoreUpdate = false }: { ignoreUpdate?: boolean } = {}): TodoBadgeKind | null {
  if (s.pendingSongCount > 0 || s.cloudAuthFailed || (s.updateAvailable && !ignoreUpdate)) return "other";
  if (s.offline) return "offline";
  const up = s.localChangeCount > 0;
  const down = s.remoteChangeCount > 0;
  if (up && down) return "sync";
  if (up) return "upload";
  if (down) return "download";
  return null;
}

export function useSyncStatus(): SyncStatus {
  return useSyncExternalStore(
    (onChange) => {
      listeners.add(onChange);
      return () => listeners.delete(onChange);
    },
    () => status,
    () => status
  );
}
