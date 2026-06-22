#!/usr/bin/env node

/**
 * Conditional build of the NEW client view (src/client-view) into
 * public/app/client-view, which the Electron embedded webserver serves at
 * /client-view/. Parallels build-client-if-needed.js (which builds the LEGACY
 * client into public/app/pp-api.js). Run from the debug preLaunch chain so a VS
 * Code debug session serves the freshly-built client-view instead of a stale
 * bundle, and from `npm run build` for production.
 *
 * Rebuilds only when a watched source is newer than the built entry (or it is
 * missing), so relaunching without code changes stays fast.
 */

const fs = require("fs/promises");
const path = require("path");
const { execSync } = require("child_process");

const projectRoot = path.resolve(__dirname, "..");
// build:client-view (vite.client-view.config.ts) writes the entry + hashed assets here.
const outputFile = path.join(projectRoot, "public", "app", "client-view", "client-view.html");
// Everything the client-view bundle is built from. Broad on purpose: better to
// rebuild on an unrelated change than to ever serve a stale page.
const watchDirs = [
  path.join(projectRoot, "src"),
  path.join(projectRoot, "chordpro"),
  path.join(projectRoot, "common"),
  path.join(projectRoot, "db-common"),
];
const watchFiles = [
  path.join(projectRoot, "client-view.html"),
  path.join(projectRoot, "vite.client-view.config.ts"),
];

const ignoredDirs = new Set(["node_modules", ".git", "dist", "build", "coverage"]);

async function getFileMtimeMs(filePath) {
  try {
    return (await fs.stat(filePath)).mtimeMs;
  } catch {
    return 0;
  }
}

async function getNewestMtimeMs(rootDir) {
  let newest = 0;
  const queue = [rootDir];
  while (queue.length > 0) {
    const current = queue.pop();
    if (!current) continue;
    let entries;
    try {
      entries = await fs.readdir(current, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (entry.name.startsWith(".")) continue;
      const fullPath = path.join(current, entry.name);
      if (entry.isDirectory()) {
        if (!ignoredDirs.has(entry.name)) queue.push(fullPath);
        continue;
      }
      if (!entry.isFile()) continue;
      const mtimeMs = await getFileMtimeMs(fullPath);
      if (mtimeMs > newest) newest = mtimeMs;
    }
  }
  return newest;
}

function fmt(ts) {
  return ts ? new Date(ts).toISOString() : "missing";
}

async function main() {
  const outputMtime = await getFileMtimeMs(outputFile);
  const newestSourceMtime = Math.max(
    ...(await Promise.all([...watchDirs.map((dir) => getNewestMtimeMs(dir)), ...watchFiles.map((file) => getFileMtimeMs(file))]))
  );

  if (outputMtime !== 0 && newestSourceMtime <= outputMtime) {
    console.log("[client-view] Build skipped: output is up to date.");
    console.log(`[client-view] output: ${fmt(outputMtime)}`);
    console.log(`[client-view] source: ${fmt(newestSourceMtime)}`);
    return;
  }

  console.log("[client-view] Build required.");
  console.log(`[client-view] output: ${fmt(outputMtime)}`);
  console.log(`[client-view] source: ${fmt(newestSourceMtime)}`);
  console.log("[client-view] Running: npm run build:client-view");

  execSync("npm run build:client-view", { cwd: projectRoot, stdio: "inherit" });
}

main().catch((error) => {
  console.error("[client-view] Conditional build failed:", error);
  process.exit(1);
});
