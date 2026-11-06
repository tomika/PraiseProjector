// Live ABC MIDI playbacks of every ChordPro editor instance.
//
// The full view stays mounted (hidden) behind the embedded client view, so its
// editors are never disposed by a view switch and their playback would keep
// sounding. The switch silences them through this registry instead. Kept free of
// abcjs and editor imports so the app shell can use it without pulling either in.

const activePlaybacks = new Set<() => void>();

/** Registers a running playback's stop function; returns its unregister call. */
export function trackAbcPlayback(stop: () => void): () => void {
  activePlaybacks.add(stop);
  return () => {
    activePlaybacks.delete(stop);
  };
}

/** Stops every running ABC playback (e.g. when its view is hidden). */
export function stopAllAbcPlayback() {
  for (const stop of [...activePlaybacks]) stop();
}
