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

/** SVGator animations are embedded as their OWN document (via <object>) so their
 *  scripts can run. For an SVG document the root <svg> background propagates to the
 *  viewport canvas, which lets us colour that canvas to match the panel behind it.
 *
 *  A plain browser leaves the embedded canvas transparent, but Electron's renderer
 *  paints embedded <object> documents on an opaque WHITE base — and an SVG root set
 *  to `transparent` merely reveals that white. So instead of relying on
 *  transparency we paint the canvas an OPAQUE colour that matches the surrounding
 *  panel (read from the `--cv-anim-canvas` custom property on the <object>); an
 *  opaque fill covers the white base in every runtime. Falls back to transparent
 *  if no colour is supplied.
 *
 *  NB: do NOT set `color-scheme: dark` on the <object> — in Chromium that makes the
 *  embedded canvas paint an opaque (white) base instead of staying transparent. */
export function makeEmbeddedSvgTransparent(object: HTMLObjectElement): void {
  const bg = getComputedStyle(object).getPropertyValue("--cv-anim-canvas").trim() || "transparent";
  object.style.background = bg;
  try {
    const root = object.contentDocument?.documentElement;
    if (!root) return;
    root.style.setProperty("background-color", bg, "important");
    object.contentDocument?.body?.style.setProperty("background-color", bg, "important");
  } catch {
    /* Cross-origin or not-yet-ready object documents are non-fatal; the
       element-level background set above still applies. */
  }
}
