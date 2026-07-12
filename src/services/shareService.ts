import { cloudApi } from "../../common/cloudApi";
import { openShareDialog } from "./shareDialogBridge";

/**
 * Public web root that serves `public.html` (e.g. `https://praiseprojector.com`).
 * Derived from the runtime cloud API base (set by AuthContext), with the trailing
 * `/praiseprojector` API path suffix and any trailing slashes stripped — matching
 * {@link normalizePublicWebRoot} in `hooks/useSessionUrl`.
 */
function publicWebRoot(): string {
  return cloudApi
    .getBaseUrl()
    .replace(/\/+$/, "")
    .replace(/\/praiseprojector$/i, "");
}

/**
 * Public share link to a single song. A song always has a public link, so this is
 * always available. Format mirrors the server's `allsongpage` handler (`?s=<songId>`).
 */
export function buildSongShareUrl(songId: string): string {
  return `${publicWebRoot()}/public.html?s=${encodeURIComponent(songId)}`;
}

/**
 * Public share link to a playlist stored in a leader's profile. Format mirrors the
 * server's `allsongpage` handler (`?l=<leaderId>/<label>`, the legacy client's list id).
 */
export function buildPlaylistShareUrl(leaderId: string, label: string): string {
  return `${publicWebRoot()}/public.html?l=${encodeURIComponent(`${leaderId}/${label}`)}`;
}

export type ShareOutcome = "shared" | "dialog" | "copied" | "unavailable";

/**
 * Share a link. Prefers a native share sheet — the host bridge (Android) then the Web Share API
 * (mobile browsers / PWA). When neither exists (Electron desktop, or a desktop browser without the
 * Web Share API) it opens the in-app share dialog (QR + copyable link). The clipboard copy is only
 * an absolute last resort if no dialog host is mounted.
 */
export async function sharePublicLink(url: string, title: string, copiedMessage?: string): Promise<ShareOutcome> {
  const hostDevice = typeof window !== "undefined" ? window.hostDevice : undefined;

  if (hostDevice?.share) {
    try {
      await hostDevice.share(url, title, url);
      return "shared";
    } catch (error) {
      console.warn("shareService", "host share failed", error);
    }
  }

  if (typeof navigator !== "undefined" && typeof navigator.share === "function") {
    try {
      await navigator.share({ url, title });
      return "shared";
    } catch (error) {
      // The user dismissing the share sheet is not a failure — don't fall back.
      if (error instanceof DOMException && error.name === "AbortError") return "shared";
      console.warn("shareService", "navigator.share failed", error);
    }
  }

  // No native share sheet available — present our own dialog with a QR code and copyable link.
  if (openShareDialog({ url, title })) return "dialog";

  try {
    await navigator.clipboard.writeText(url);
    const message = copiedMessage || url;
    if (hostDevice?.showToast) hostDevice.showToast(message);
    else if (typeof window !== "undefined") window.alert(message);
    return "copied";
  } catch (error) {
    console.warn("shareService", "clipboard fallback failed", error);
    return "unavailable";
  }
}
