#!/usr/bin/env node
/**
 * stage-web-client.js — post-process the web build (dist/web) so the /webapp
 * deploy is fully SELF-CONTAINED (no sibling /app URL tree).
 *
 * The webapp owns its assets outright: public/public/{images,soundfont,
 * chordselector.css} are ITS copies, and Vite's publicDir drops them at the
 * /webapp root with no help from us. The client-view resolves them via
 * __ppAssetBase="/webapp" (see client-view.html / src/client-view/ui/assets.ts).
 *
 * Vite's publicDir also copies the FROZEN legacy `app/` folder into the build.
 * That tree is retired — nothing here may depend on it — so we simply drop it.
 * Do NOT reintroduce "lifting" assets out of app/: that was the coupling that
 * made new-app icons get added to the legacy client's folder.
 *
 * Then we emit two manifests:
 *   - /webapp/precache.json — the URL list consumed by the browser service worker.
 *   - /webapp/release-manifest.json — the size/hash manifest consumed by the
 *     Android native A/B bundle updater.
 *
 * They describe the same build and are consumed by:
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
const releaseManifestName = "release-manifest.json";

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

/** Fail loudly if a webapp-owned asset didn't make it into the build. */
function requireAsset(relName) {
  if (fs.existsSync(path.join(distDir, relName))) return;
  throw new Error(
    `[stage-web-client] missing webapp asset in the build: ${relName}\n` +
      `  Expected Vite's publicDir to copy public/public/${relName} into dist/web.\n` +
      `  These are the webapp's OWN assets — do not source them from public/app.`
  );
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

function sha256File(filePath) {
  return crypto.createHash("sha256").update(fs.readFileSync(filePath)).digest("hex");
}

function emitReleaseManifest() {
  const files = listWebappPaths(distDir)
    .filter((urlPath) => !urlPath.endsWith(".map") && urlPath !== `/webapp/${releaseManifestName}`)
    .sort()
    .map((urlPath) => {
      const relativePath = urlPath.slice("/webapp/".length);
      const filePath = path.join(distDir, relativePath);
      return {
        path: relativePath,
        size: fs.statSync(filePath).size,
        sha256: sha256File(filePath),
      };
    });

  const releaseHash = crypto.createHash("sha256");
  for (const file of files) {
    releaseHash.update(file.path);
    releaseHash.update("\0");
    releaseHash.update(String(file.size));
    releaseHash.update("\0");
    releaseHash.update(file.sha256);
    releaseHash.update("\0");
  }

  const minAndroidVersionCode = Number.parseInt(process.env.PP_MIN_ANDROID_VERSION_CODE || "1", 10);
  if (!Number.isSafeInteger(minAndroidVersionCode) || minAndroidVersionCode < 1) {
    throw new Error("PP_MIN_ANDROID_VERSION_CODE must be a positive integer");
  }

  const packageVersion = require("../package.json").version;
  const manifest = {
    schemaVersion: 1,
    releaseId: `${packageVersion}-${releaseHash.digest("hex").slice(0, 32)}`,
    packageVersion,
    minAndroidVersionCode,
    entryPoint: "index.html",
    files,
  };

  fs.writeFileSync(path.join(distDir, releaseManifestName), JSON.stringify(manifest, null, 2) + "\n", "utf8");
  console.log(
    `[stage-web-client] wrote ${files.length} hashed release entries → dist/web/${releaseManifestName} (${manifest.releaseId})`
  );
}

function main() {
  if (!fs.existsSync(distDir)) {
    console.error(`[stage-web-client] build output not found: ${path.relative(projectRoot, distDir)}`);
    process.exit(1);
  }

  // 1. Drop the publicDir-copied FROZEN legacy /app tree. The webapp must never
  //    serve or depend on it.
  rmrf(path.join(distDir, "app"));
  // A stale manifest from an interrupted/manual build must never describe this build.
  rmrf(path.join(distDir, releaseManifestName));

  // 2. Assert the webapp's own assets are present (publicDir put them there):
  //    images: dynamically referenced icons (found_*, confirm anims, mode icons, netdisplay).
  //    soundfont: offline MIDI playback. chord-selector CSS: loaded by client-view.html.
  //    Canonical ChordPro CSS is already copied from public/stylesheets by Vite.
  ["images", "soundfont", "chordselector.css"].forEach(requireAsset);

  // 3. Emit the precache manifest (everything under /webapp except maps + the manifest itself).
  const precacheFile = path.join(distDir, "precache.json");
  const all = listWebappPaths(distDir)
    .filter((p) => !p.endsWith(".map") && p !== "/webapp/precache.json")
    .sort();
  fs.writeFileSync(precacheFile, JSON.stringify(all, null, 2), "utf8");
  patchServiceWorkerVersion([...all, "/webapp/precache.json"].sort());
  // Generate hashes after sw.js has received its final build-specific version.
  emitReleaseManifest();
  console.log(`[stage-web-client] staged legacy assets and wrote ${all.length} precache entries → dist/web/precache.json`);
}

main();
