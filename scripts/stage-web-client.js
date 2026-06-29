#!/usr/bin/env node
/**
 * stage-web-client.js — post-process the web build (dist/web) so the /webapp
 * deploy is fully SELF-CONTAINED (no sibling /app URL tree).
 *
 * Vite's publicDir (public/public) copies the whole legacy `app/` folder into the
 * build; we don't want a /webapp/app/* URL tree, so we drop it and instead lift
 * only the assets the client-view actually references (icons, soundfonts, chordpro
 * CSS) to the /webapp root. The client-view resolves them via __ppAssetBase="/webapp"
 * (see client-view.html / src/client-view/ui/assets.ts).
 *
 * Then we emit /webapp/precache.json — the authoritative list of every file under
 * /webapp — consumed by:
 *   - sw.js (cloud PWA offline precache), and
 *   - the Electron/Android host webservers (webServerBridge → appAssets) so a LAN
 *     follower can load the served client fully offline.
 * The build is the source of truth because bundle file names are content-hashed.
 *
 * Run by: npm run build:web  (after `vite build --mode web`).
 */

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const projectRoot = path.resolve(__dirname, "..");
const distDir = path.join(projectRoot, "dist", "web");
const legacyAppDir = path.join(projectRoot, "public", "app");

function rmrf(target) {
  fs.rmSync(target, { recursive: true, force: true });
}

function copyRecursive(src, dest) {
  const stat = fs.statSync(src);
  if (stat.isDirectory()) {
    fs.mkdirSync(dest, { recursive: true });
    for (const name of fs.readdirSync(src)) {
      copyRecursive(path.join(src, name), path.join(dest, name));
    }
  } else {
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.copyFileSync(src, dest);
  }
}

/** Copy a legacy asset (dir or file) from public/app into the /webapp root. */
function stage(relName) {
  const src = path.join(legacyAppDir, relName);
  if (!fs.existsSync(src)) {
    console.warn(`[stage-web-client] missing legacy asset, skipping: app/${relName}`);
    return;
  }
  copyRecursive(src, path.join(distDir, relName));
}

/** List every file under a directory as forward-slash URL paths rooted at /webapp. */
function listWebappPaths(dir) {
  const out = [];
  const walk = (current) => {
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) walk(full);
      else {
        const rel = path.relative(distDir, full).replace(/\\/g, "/");
        out.push(`/webapp/${rel}`);
      }
    }
  };
  walk(dir);
  return out;
}

function patchServiceWorkerVersion(paths) {
  const swPath = path.join(distDir, "sw.js");
  if (!fs.existsSync(swPath)) return;

  const hash = crypto.createHash("sha256");
  for (const urlPath of paths) {
    if (urlPath === "/webapp/sw.js") continue;
    const rel = urlPath.slice("/webapp/".length);
    hash.update(urlPath);
    hash.update("\0");
    hash.update(fs.readFileSync(path.join(distDir, rel)));
    hash.update("\0");
  }

  const buildId = `${require("../package.json").version}-${hash.digest("hex").slice(0, 8)}`;
  const content = fs.readFileSync(swPath, "utf8");
  const patched = content.replace(/const CACHE_VERSION = '[^']*'/, `const CACHE_VERSION = '${buildId}'`);
  if (patched === content) {
    console.warn("[stage-web-client] CACHE_VERSION pattern not found in dist/web/sw.js");
    return;
  }
  fs.writeFileSync(swPath, patched, "utf8");
  console.log(`[stage-web-client] patched sw.js CACHE_VERSION → ${buildId}`);
}

function main() {
  if (!fs.existsSync(distDir)) {
    console.error(`[stage-web-client] build output not found: ${path.relative(projectRoot, distDir)}`);
    process.exit(1);
  }

  // 1. Drop the publicDir-copied legacy /app tree — its assets are lifted to the root below.
  rmrf(path.join(distDir, "app"));

  // 2. Lift the assets the served client references (via __ppAssetBase="/webapp").
  //    images: dynamically referenced icons (found_*, confirm anims, mode icons, netdisplay).
  //    soundfont: offline MIDI playback. chordpro/chordselector CSS: loaded by client-view.html.
  ["images", "soundfont", "chordpro.css", "chordselector.css"].forEach(stage);

  // 3. Emit the precache manifest (everything under /webapp except maps + the manifest itself).
  const precacheFile = path.join(distDir, "precache.json");
  const all = listWebappPaths(distDir)
    .filter((p) => !p.endsWith(".map") && p !== "/webapp/precache.json")
    .sort();
  fs.writeFileSync(precacheFile, JSON.stringify(all, null, 2), "utf8");
  patchServiceWorkerVersion([...all, "/webapp/precache.json"].sort());
  console.log(`[stage-web-client] staged legacy assets and wrote ${all.length} precache entries → dist/web/precache.json`);
}

main();
