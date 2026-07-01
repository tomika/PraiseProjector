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
  /** Cloud is unreachable or the session needs re-auth. */
  cloudAccessFailed: boolean;
}

export const EMPTY_SYNC_STATUS: SyncStatus = {
  authenticated: false,
  localChangeCount: 0,
  remoteChangeCount: 0,
  pendingSongCount: 0,
  updateAvailable: false,
  cloudAccessFailed: false,
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
    status.cloudAccessFailed === next.cloudAccessFailed
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
  return s.localChangeCount > 0 || s.remoteChangeCount > 0 || s.pendingSongCount > 0 || s.updateAvailable || s.cloudAccessFailed;
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
