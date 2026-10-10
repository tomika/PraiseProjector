/**
 * Canonical public website of the PraiseProjector project (no trailing slash).
 * Used for "visit the website" links and for absolute URLs the server publishes
 * (e.g. Open Graph previews). Not the cloud API host: that one is configurable
 * per build (VITE_CLOUD_API_HOST / proxy-config.json) and resolved at runtime.
 */
export const PRAISEPROJECTOR_WEBSITE_URL = "https://praiseprojector.hu";

/**
 * Retired aliases of the website. They still serve the same site during the
 * domain migration (and stay the Android WebView origin), but links handed to
 * other people must not point at them: such links outlive the alias.
 */
const RETIRED_WEBSITE_HOSTS = new Set(["praiseprojector.com", "www.praiseprojector.com"]);

/**
 * Public web root (serving `public.html`, `/webapp/…`) for links shared with others,
 * derived from the cloud API base or page origin the app actually talks to: trailing
 * slashes and the `/praiseprojector` API suffix are stripped, and a retired alias is
 * replaced by {@link PRAISEPROJECTOR_WEBSITE_URL}. Any other host (local test server,
 * LAN host) is kept, so links keep matching the server the data came from.
 */
export function publicWebRootFromBase(baseUrl: string): string {
  const root = baseUrl.replace(/\/+$/, "").replace(/\/praiseprojector$/i, "");
  try {
    const url = new URL(root);
    if (RETIRED_WEBSITE_HOSTS.has(url.hostname)) {
      return PRAISEPROJECTOR_WEBSITE_URL + url.pathname.replace(/\/+$/, "");
    }
  } catch {
    // Relative or malformed base: nothing to canonicalize.
  }
  return root;
}
