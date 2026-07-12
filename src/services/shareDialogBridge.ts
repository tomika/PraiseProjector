// Imperative bridge so non-React modules (e.g. shareService) can open the in-app share dialog.
// The dialog itself is rendered by <ShareDialogHost> (mounted once in App), which registers the
// opener here. Kept free of React imports so shareService can depend on it without pulling in UI.

export interface ShareDialogRequest {
  /** The public URL being shared. */
  url: string;
  /** Human-readable label for what is shared (song title / playlist label) — shown as the heading. */
  title: string;
}

type Opener = (request: ShareDialogRequest) => void;

let opener: Opener | null = null;

/** Registered by <ShareDialogHost>. Returns an unregister function. */
export function registerShareDialogOpener(fn: Opener): () => void {
  opener = fn;
  return () => {
    if (opener === fn) opener = null;
  };
}

/** Open the in-app share dialog. Returns false when no host is mounted (caller should fall back). */
export function openShareDialog(request: ShareDialogRequest): boolean {
  if (!opener) return false;
  opener(request);
  return true;
}
