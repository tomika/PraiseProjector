import { defineConfig, type Plugin } from "vite";
import path from "node:path";
import fs from "node:fs";
import react from "@vitejs/plugin-react";
import tsconfigPaths from "vite-tsconfig-paths";
import pkg from "./package.json";

/**
 * Emit public/app/client-view/precache.json — the authoritative list of every file the host
 * webserver (Android/Electron) serves for this client, as /app/... source paths. The Android
 * host reads it (via webServerBridge) and prefetches each file so a LAN follower can load the
 * client fully OFFLINE. The build is the source of truth because the bundle file names are
 * content-hashed (incl. lazy chunks) and cannot be predicted by static analysis.
 */
function clientViewPrecacheManifest(): Plugin {
  const appDir = path.resolve(__dirname, "public/app");

  // Recursively list a /app subdirectory as /app/... URL paths (forward slashes).
  const listDir = (rel: string, urlPrefix: string): string[] => {
    const out: string[] = [];
    const walk = (dir: string, prefix: string) => {
      let entries: fs.Dirent[];
      try {
        entries = fs.readdirSync(dir, { withFileTypes: true });
      } catch {
        return; // directory absent — skip
      }
      for (const entry of entries) {
        if (entry.isDirectory()) walk(path.join(dir, entry.name), `${prefix}/${entry.name}`);
        else out.push(`${prefix}/${entry.name}`);
      }
    };
    walk(path.join(appDir, rel), urlPrefix);
    return out;
  };

  return {
    name: "client-view-precache-manifest",
    // writeBundle runs after the hashed assets (incl. client-view.html) are written to disk.
    writeBundle(_options, bundle) {
      // Hashed bundle outputs (entry + chunks + lazy chunks + CSS + the entry HTML asset).
      const bundlePaths = Object.keys(bundle).map((f) => `/app/client-view/${f.replace(/\\/g, "/")}`);

      // Static legacy assets the served client references but that are NOT in the bundle
      // (publicDir:false). Icons are referenced dynamically (found_*, confirm anims, mode
      // icons) so precache the whole images dir; soundfonts power offline MIDI playback.
      const explicit = ["/app/chordpro.css", "/app/chordselector.css", "/app/image.html"].filter((p) =>
        fs.existsSync(path.join(appDir, p.slice("/app/".length)))
      );
      const staticPaths = [...listDir("images", "/app/images"), ...listDir("soundfont", "/app/soundfont"), ...explicit];

      const all = Array.from(new Set([...bundlePaths, ...staticPaths])).sort();
      const outFile = path.join(appDir, "client-view", "precache.json");
      fs.writeFileSync(outFile, JSON.stringify(all, null, 2), "utf8");
      console.log(`[client-view-precache] wrote ${all.length} entries → ${path.relative(__dirname, outFile)}`);
    },
  };
}

/**
 * Dedicated build of the standalone client view into public/app/client-view, so
 * the Electron embedded webserver (staticDir = public/app) serves it at
 * /client-view/ with zero extra static-mount config.
 *
 * - base "./" keeps the hashed bundle self-contained at that mount point,
 * - publicDir false avoids re-copying the legacy assets (already in public/app),
 * - the entry HTML (client-view.html) resolves the legacy asset base and the API
 *   base at runtime (window.__ppAssetBase / window.__ppApiBase).
 *
 * Build with: npm run build:client-view
 */
export default defineConfig({
  plugins: [react(), tsconfigPaths(), clientViewPrecacheManifest()],
  base: "./",
  publicDir: false,
  build: {
    outDir: "public/app/client-view",
    emptyOutDir: true,
    rollupOptions: {
      input: path.resolve(__dirname, "client-view.html"),
    },
  },
  define: {
    // Required so src/config.ts compiles; the served runtime overrides the API
    // base via window.__ppApiBase, so these values are not actually used there.
    "import.meta.env.VITE_API_BASE_URL": JSON.stringify("/praiseprojector"),
    "import.meta.env.VITE_CLOUD_API_HOST": JSON.stringify(""),
    __APP_VERSION__: JSON.stringify(pkg.version),
    __APP_COMMIT__: JSON.stringify(""),
    __APP_SHOW_COMMIT__: JSON.stringify(false),
  },
});
