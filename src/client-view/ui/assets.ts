/**
 * Toolbar/button icons, reused from the legacy client asset folder.
 *
 * Those images live in Vite's publicDir (public/app/images) and are served as
 * static files, so we reference them by URL rather than bundling them (importing
 * publicDir files into the graph is unsupported and yields broken paths).
 *
 * The base differs per mount point: the Vite dev server and the standalone web
 * build expose publicDir under "/app", while the Electron webserver serves
 * public/app at the root. The host page may override the base by assigning
 * `window.__ppAssetBase` before this bundle loads (e.g. "" for the webserver).
 */

declare global {
  interface Window {
    /** Base path for legacy static assets (icons, chordpro.css). Set by the entry HTML. */
    __ppAssetBase?: string;
    /** Base URL for the REST API. Set by the entry HTML when served by the webserver. */
    __ppApiBase?: string;
    /** Host-granted access level for a served client. Injected by the Electron
     *  webserver's /client-view route (GUEST view-only; LEADER/LOCAL may control). */
    __ppAccess?: "GUEST" | "LEADER" | "LOCAL";
    /** Where the "open full editor" affordance navigates. Set by the entry HTML. */
    __ppEditorUrl?: string;
  }
}

const override = typeof window !== "undefined" ? window.__ppAssetBase : undefined;
const assetBase = override ?? "/app";

/** Resolve a legacy icon by file name, e.g. icon("left.svg"). */
export function icon(name: string): string {
  return `${assetBase}/images/${name}`;
}
