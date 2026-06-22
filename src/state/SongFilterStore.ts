/**
 * SongFilterStore — the song-list filter text, shared in-process between the
 * desktop App shell (LeftPanel search box) and the embedded client view's filter
 * box, so the two stay in lockstep (see ClientViewStore.setSearchText and
 * DirectClientApi's hostFilter binding).
 *
 * It is a tiny module-singleton like CurrentSongStore: App.tsx mirrors its
 * `songFilter` state here and subscribes back, while the in-process
 * DirectClientApi reads/writes it. The Rest adapter has no host LeftPanel to
 * mirror and never touches this store.
 */

import { useSyncExternalStore } from "react";

type Listener = () => void;

let songFilter = "";
const listeners = new Set<Listener>();

function emit(): void {
  for (const listener of listeners) listener();
}

export function getSharedSongFilter(): string {
  return songFilter;
}

/** Set the shared filter; no-op (and no emit) when the value is unchanged, which
 *  keeps the App ↔ client-view mirror loops from re-entering. */
export function setSharedSongFilter(value: string): void {
  if (songFilter === value) return;
  songFilter = value;
  emit();
}

export function subscribeSharedSongFilter(listener: (value: string) => void): () => void {
  const handler: Listener = () => listener(songFilter);
  listeners.add(handler);
  return () => listeners.delete(handler);
}

export function useSharedSongFilter(): string {
  return useSyncExternalStore(
    (onStoreChange) => {
      listeners.add(onStoreChange);
      return () => listeners.delete(onStoreChange);
    },
    () => songFilter,
    () => songFilter
  );
}
