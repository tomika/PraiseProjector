import { useSyncExternalStore } from "react";
import { Song } from "../../db-common/Song";
import { Display } from "../../common/pp-types";
import { cloneDisplay, compareDisplays, getEmptyDisplay } from "../../common/pp-utils";

type Listener = () => void;

// Projected Song - the song currently being displayed/projected
let projectedSong: Song | null = null;
const projectedListeners = new Set<Listener>();

// Edited Song - the song currently being edited
let editedSong: Song | null = null;
const editedListeners = new Set<Listener>();

//Current Display
let currentDisplay: Display = getEmptyDisplay();
const displayListeners = new Map<Listener, Display | undefined>();

function emitProjected() {
  for (const listener of projectedListeners) {
    listener();
  }
}

function emitEdited() {
  for (const listener of editedListeners) {
    listener();
  }
  if (editedSong?.Id === projectedSong?.Id) {
    emitProjected();
  }
}

function emitDisplayChange() {
  for (const [listener, reference] of displayListeners.entries()) {
    if (!reference || !compareDisplays(reference, currentDisplay)) {
      displayListeners.set(listener, cloneDisplay(currentDisplay));
      listener();
    }
  }
}

function subscribeProjected(onStoreChange: Listener): () => void {
  projectedListeners.add(onStoreChange);
  return () => projectedListeners.delete(onStoreChange);
}

function subscribeEdited(onStoreChange: Listener): () => void {
  editedListeners.add(onStoreChange);
  return () => editedListeners.delete(onStoreChange);
}

// Projected Song API
export function getProjectedSong(): Song | null {
  return projectedSong;
}

export function setProjectedSong(song: Song | null): void {
  projectedSong = song;
  emitProjected();
}

export function updateProjectedSong(mutator: (song: Song) => void): void {
  if (!projectedSong) {
    return;
  }
  mutator(projectedSong);
  emitProjected();
}

export function subscribeProjectedSong(listener: (song: Song | null) => void): () => void {
  const handler: Listener = () => listener(projectedSong);
  projectedListeners.add(handler);
  return () => projectedListeners.delete(handler);
}

export function useProjectedSong(): Song | null {
  return useSyncExternalStore(
    subscribeProjected,
    () => projectedSong,
    () => projectedSong
  );
}

// Edited Song API
export function getEditedSong(): Song | null {
  return editedSong;
}

export function setEditedSong(song: Song | null): void {
  editedSong = song;
  emitEdited();
}

export function updateEditedSong(mutator: (song: Song) => void): void {
  if (!editedSong) {
    return;
  }
  mutator(editedSong);
  emitEdited();
}

export function subscribeEditedSong(listener: (song: Song | null) => void): () => void {
  const handler: Listener = () => listener(editedSong);
  editedListeners.add(handler);
  return () => editedListeners.delete(handler);
}

export function useEditedSong(): Song | null {
  return useSyncExternalStore(
    subscribeEdited,
    () => editedSong,
    () => editedSong
  );
}

// Legacy API for backward compatibility (maps to editedSong)
export function getCurrentSong(): Song | null {
  return editedSong;
}

export function setCurrentSong(song: Song | null): void {
  setEditedSong(song);
}

export function updateCurrentSong(mutator: (song: Song) => void): void {
  updateEditedSong(mutator);
}

export function subscribeCurrentSong(listener: (song: Song | null) => void): () => void {
  return subscribeEditedSong(listener);
}

export function useCurrentSong(): Song | null {
  return useEditedSong();
}

export function getCurrentDisplay() {
  return currentDisplay;
}

export function updateCurrentDisplay(display: Partial<Display>) {
  currentDisplay = { ...currentDisplay, ...display };
  emitDisplayChange();
}

export function subscribeCurrentDisplayChange(listener: (display: Display) => void, referenceDisplay?: Display): () => void {
  const handler: Listener = () => listener(currentDisplay);
  displayListeners.set(handler, referenceDisplay ? cloneDisplay(referenceDisplay) : undefined);
  return () => displayListeners.delete(handler);
}

// Projector render dimensions — the actual pixel size of the canvas being rendered
// (real monitor size when projector is open, netDisplayResolution size when not)
let projectorRenderDims: { width: number; height: number } = { width: 1920, height: 1080 };
const projectorRenderListeners = new Set<Listener>();

function emitProjectorRenderDims() {
  for (const listener of projectorRenderListeners) {
    listener();
  }
}

export function setProjectorRenderDims(width: number, height: number): void {
  if (projectorRenderDims.width !== width || projectorRenderDims.height !== height) {
    projectorRenderDims = { width, height };
    emitProjectorRenderDims();
  }
}

export function getProjectorRenderDims(): { width: number; height: number } {
  return projectorRenderDims;
}

export function useProjectorRenderDims(): { width: number; height: number } {
  return useSyncExternalStore(
    (onStoreChange) => {
      projectorRenderListeners.add(onStoreChange);
      return () => projectorRenderListeners.delete(onStoreChange);
    },
    () => projectorRenderDims,
    () => projectorRenderDims
  );
}
