/**
 * One-shot handoff from a standalone client-view document to the app's own
 * document (index.html).
 *
 * A "borrowed" entry — a shared /public.html link opened in the Android app, or a
 * host-served follower page — leaves through the native host's `goHome()`, which
 * simply loads index.html. That bridge method takes no arguments and old app
 * versions keep shipping it unchanged while the web bundle updates over the air,
 * so the intent has to travel in localStorage rather than in the URL.
 *
 * The intent asks for the app's OWN client view, and is deliberately kept apart
 * from the stored view preference: the arriving document may override it (an
 * empty local database is useless in the client view) without rewriting what the
 * user last chose for themselves.
 */

const HANDOFF_KEY = "pp-client-view-handoff";

/** Ask the next document to open the app's own client view. Called right before
 *  the native goHome(). On a host-served entry this writes to the SERVING
 *  device's origin, where nothing ever reads it — harmless, and goHome() behaves
 *  exactly as it did before. */
export function requestOwnClientViewOnHome(): void {
  try {
    window.localStorage?.setItem(HANDOFF_KEY, "1");
  } catch {
    /* storage may be unavailable (private mode) — the plain navigation still works */
  }
}

/** Cached so React's StrictMode double-mount reads one answer, not two. */
let consumed: boolean | null = null;

/** Read and clear the intent. A reload of the arriving document is a fresh start,
 *  so the key must not survive this call. */
export function consumeClientViewHandoff(): boolean {
  if (consumed !== null) return consumed;
  let pending = false;
  try {
    pending = window.localStorage?.getItem(HANDOFF_KEY) === "1";
    if (pending) window.localStorage?.removeItem(HANDOFF_KEY);
  } catch {
    pending = false;
  }
  consumed = pending;
  return pending;
}
