#!/usr/bin/env node

// Archive / restore / inspect EVERY download cache the builds use, as one bundle folder:
//
//   container.tar    the container build cache volume (see container-runtime.mjs)
//   electron.tar     Electron zips                    (ELECTRON_CACHE)
//   electron-builder.tar  NSIS / winCodeSign / AppImage tools (ELECTRON_BUILDER_CACHE)
//   npm.tar          npm cache incl. prebuilt natives (`npm config get cache`)
//   electron-gyp.tar Electron node headers            (~/.electron-gyp, @electron/rebuild)
//   node-gyp.tar     Node headers                     (node-gyp devdir)
//   manifest.json    what was exported, when, from where
//
//   node scripts/build-cache.mjs status
//   node scripts/build-cache.mjs export [dir] [--only=a,b]   (default dir: ./pp-build-cache-YYYYMMDD)
//   node scripts/build-cache.mjs import <dir> [--only=a,b]   (merges into the existing caches)
//
// Host components are restored to the locations THIS machine's tools use (env overrides honoured),
// not to the paths they were exported from, so a bundle moves between machines.

import { execFileSync, execSync } from "child_process";
import fs from "fs";
import os from "os";
import path from "path";
import { BUILD_IMAGE, CACHE_MOUNT, CACHE_VOLUME, detectContainerRuntime } from "./container-runtime.mjs";

const CONTAINER = "container";

// Windows ships bsdtar as System32\tar.exe. A bare "tar" from Git Bash would be GNU tar, which reads
// "C:\..." as host:file, so use the system one explicitly.
const TAR = process.platform === "win32" ? path.join(process.env.SystemRoot || "C:\\Windows", "System32", "tar.exe") : "tar";

function npmCacheDir() {
  // Explicit override first (also what `npm run` exports). `npm config get cache` can refuse to answer
  // ("protected option") for unusual paths, so it must not be the only source.
  if (process.env.npm_config_cache) {
    return process.env.npm_config_cache;
  }
  try {
    // Not from the project directory: `npm config` refuses to run inside a workspace (ENOWORKSPACES).
    const out = execSync("npm config get cache", { cwd: os.tmpdir(), encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
    if (out) {
      return out;
    }
  } catch {
    // Fall through to the platform default.
  }
  const fallback =
    process.platform === "win32"
      ? path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), "AppData", "Local"), "npm-cache")
      : path.join(os.homedir(), ".npm");
  console.warn(`warning: could not ask npm for its cache directory, assuming the default: ${fallback}`);
  return fallback;
}

// Where the host's tools keep their caches (same lookup rules as @electron/get, electron-builder, node-gyp).
function hostComponents() {
  const home = os.homedir();
  const win = process.platform === "win32";
  const mac = process.platform === "darwin";
  const localAppData = process.env.LOCALAPPDATA || path.join(home, "AppData", "Local");
  const cacheRoot = win ? localAppData : mac ? path.join(home, "Library", "Caches") : process.env.XDG_CACHE_HOME || path.join(home, ".cache");
  const sub = (name, winSuffix) => (win ? path.join(localAppData, name, winSuffix) : path.join(cacheRoot, name));

  return {
    electron: process.env.ELECTRON_CACHE || sub("electron", "Cache"),
    "electron-builder": process.env.ELECTRON_BUILDER_CACHE || sub("electron-builder", "Cache"),
    npm: npmCacheDir(),
    "electron-gyp": path.join(home, ".electron-gyp"),
    "node-gyp": process.env.npm_config_devdir || sub("node-gyp", "Cache"),
  };
}

function parseArgs(argv) {
  const positional = [];
  let only = null;
  for (const arg of argv) {
    if (arg.startsWith("--only=")) {
      only = arg.slice("--only=".length).split(",").filter(Boolean);
    } else {
      positional.push(arg);
    }
  }
  return { command: positional[0], dirArg: positional[1], only };
}

const { command, dirArg, only } = parseArgs(process.argv.slice(2));
const selected = (name) => !only || only.includes(name);

function formatBytes(bytes) {
  return bytes >= 1024 ** 3 ? `${(bytes / 1024 ** 3).toFixed(1)} GB` : `${Math.round(bytes / 1024 ** 2)} MB`;
}

function dirSize(dir) {
  let total = 0;
  const stack = [dir];
  while (stack.length) {
    const current = stack.pop();
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) {
        stack.push(full);
      } else if (entry.isFile()) {
        total += fs.statSync(full).size;
      }
    }
  }
  return total;
}

function defaultBundleName() {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, "0");
  return `pp-build-cache-${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}`;
}

// ---- container volume -------------------------------------------------------------------------

function containerRuntimeOrNull() {
  try {
    return detectContainerRuntime();
  } catch {
    return null;
  }
}

function volumeExists(runtime) {
  try {
    execFileSync(runtime, ["volume", "inspect", CACHE_VOLUME], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

function requireImage(runtime) {
  try {
    execFileSync(runtime, ["image", "inspect", BUILD_IMAGE], { stdio: "ignore" });
  } catch {
    throw new Error(`image '${BUILD_IMAGE}' is missing (it provides tar) - run one online container build first`);
  }
}

function exportContainer(runtime, bundleDir) {
  if (!runtime) {
    throw new Error("no container runtime (podman/docker) found");
  }
  if (!volumeExists(runtime)) {
    throw new Error(`volume '${CACHE_VOLUME}' does not exist yet (no container build has run)`);
  }
  requireImage(runtime);
  execFileSync(
    runtime,
    [
      "run", "--rm",
      "-v", `${CACHE_VOLUME}:${CACHE_MOUNT}:ro`,
      "-v", `${bundleDir}:/out`,
      BUILD_IMAGE,
      "tar", "-C", CACHE_MOUNT, "-cf", `/out/${CONTAINER}.tar`, ".",
    ],
    { stdio: "inherit" },
  );
  return { source: `volume ${CACHE_VOLUME}` };
}

function importContainer(runtime, bundleDir) {
  if (!runtime) {
    throw new Error("no container runtime (podman/docker) found");
  }
  requireImage(runtime);
  execFileSync(
    runtime,
    [
      "run", "--rm",
      "-v", `${CACHE_VOLUME}:${CACHE_MOUNT}`,
      "-v", `${bundleDir}:/in:ro`,
      BUILD_IMAGE,
      "tar", "-C", CACHE_MOUNT, "-xf", `/in/${CONTAINER}.tar`,
    ],
    { stdio: "inherit" },
  );
}

// ---- host directories -------------------------------------------------------------------------

function exportHost(name, sourceDir, bundleDir) {
  if (!fs.existsSync(sourceDir)) {
    throw new Error(`${sourceDir} does not exist`);
  }
  execFileSync(TAR, ["-cf", path.join(bundleDir, `${name}.tar`), "-C", sourceDir, "."], { stdio: "inherit" });
  return { source: sourceDir };
}

function importHost(name, targetDir, bundleDir) {
  fs.mkdirSync(targetDir, { recursive: true });
  execFileSync(TAR, ["-xf", path.join(bundleDir, `${name}.tar`), "-C", targetDir], { stdio: "inherit" });
}

// ---- commands ---------------------------------------------------------------------------------

function status() {
  console.log("Host caches:");
  for (const [name, dir] of Object.entries(hostComponents())) {
    if (selected(name)) {
      console.log(`  ${name.padEnd(17)} ${fs.existsSync(dir) ? formatBytes(dirSize(dir)).padStart(8) : "  missing"}  ${dir}`);
    }
  }

  if (!selected(CONTAINER)) {
    return;
  }
  console.log("\nContainer build cache:");
  const runtime = containerRuntimeOrNull();
  if (!runtime || !volumeExists(runtime)) {
    console.log(`  volume '${CACHE_VOLUME}' not found`);
    return;
  }
  requireImage(runtime);
  execFileSync(runtime, ["run", "--rm", "-v", `${CACHE_VOLUME}:${CACHE_MOUNT}:ro`, BUILD_IMAGE, "du", "-h", "--max-depth=2", CACHE_MOUNT], { stdio: "inherit" });
}

function exportAll() {
  const bundleDir = path.resolve(dirArg || defaultBundleName());
  fs.mkdirSync(bundleDir, { recursive: true });

  const hosts = hostComponents();
  const exported = {};
  const failed = {};

  const runComponent = (name, fn) => {
    if (!selected(name)) {
      return;
    }
    const file = path.join(bundleDir, `${name}.tar`);
    fs.rmSync(file, { force: true }); // never leave a stale file behind for a component skipped this time
    console.log(`\n== ${name}`);
    try {
      const { source } = fn();
      exported[name] = { source, bytes: fs.statSync(file).size };
      console.log(`   ${formatBytes(exported[name].bytes)} -> ${file}`);
    } catch (error) {
      fs.rmSync(file, { force: true });
      failed[name] = error instanceof Error ? error.message : String(error);
      console.log(`   skipped: ${failed[name]}`);
    }
  };

  const runtime = selected(CONTAINER) ? containerRuntimeOrNull() : null;
  runComponent(CONTAINER, () => exportContainer(runtime, bundleDir));
  for (const [name, dir] of Object.entries(hosts)) {
    runComponent(name, () => exportHost(name, dir, bundleDir));
  }

  if (Object.keys(exported).length === 0) {
    throw new Error("nothing could be exported");
  }
  fs.writeFileSync(path.join(bundleDir, "manifest.json"), JSON.stringify({ created: new Date().toISOString(), platform: process.platform, exported, skipped: failed }, null, 2));
  console.log(`\nBuild cache exported to: ${bundleDir}`);
}

function importAll() {
  if (!dirArg) {
    throw new Error("Usage: node scripts/build-cache.mjs import <dir> [--only=a,b]");
  }
  const bundleDir = path.resolve(dirArg);
  if (!fs.existsSync(bundleDir) || !fs.statSync(bundleDir).isDirectory()) {
    throw new Error(`Bundle folder not found: ${bundleDir}`);
  }

  const hosts = hostComponents();
  const restored = [];
  const failed = {};
  const runtime = containerRuntimeOrNull();

  for (const name of [CONTAINER, ...Object.keys(hosts)]) {
    if (!selected(name) || !fs.existsSync(path.join(bundleDir, `${name}.tar`))) {
      continue;
    }
    console.log(`\n== ${name}`);
    try {
      if (name === CONTAINER) {
        importContainer(runtime, bundleDir);
      } else {
        importHost(name, hosts[name], bundleDir);
        console.log(`   restored to ${hosts[name]}`);
      }
      restored.push(name);
    } catch (error) {
      failed[name] = error instanceof Error ? error.message : String(error);
      console.log(`   FAILED: ${failed[name]}`);
    }
  }

  console.log(`\nRestored: ${restored.join(", ") || "nothing"}`);
  const failedNames = Object.keys(failed);
  if (failedNames.length > 0) {
    throw new Error(`Not restored: ${failedNames.map((n) => `${n} (${failed[n]})`).join("; ")}`);
  }
}

const COMMANDS = { status, export: exportAll, import: importAll };

if (!COMMANDS[command]) {
  console.error("Usage: node scripts/build-cache.mjs <status | export [dir] | import <dir>> [--only=container,electron,electron-builder,npm,electron-gyp,node-gyp]");
  process.exit(1);
}

try {
  COMMANDS[command]();
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
}
