#!/usr/bin/env node

const { execFileSync } = require("child_process");
const path = require("path");

const projectRoot = path.resolve(__dirname, "..");

function normalizeVersion(raw) {
  if (typeof raw !== "string") {
    return "";
  }
  return raw.trim().replace(/^[~^]/, "");
}

function getElectronVersion() {
  try {
    // Prefer installed package version when available.
    return normalizeVersion(require("electron/package.json").version);
  } catch {
    try {
      const pkg = require(path.join(projectRoot, "package.json"));
      return normalizeVersion(pkg?.devDependencies?.electron);
    } catch {
      return "";
    }
  }
}

function getRebuildCliPath() {
  // Resolve the CLI relative to the package's main entry. Invoking it through
  // `node` (rather than the node_modules/.bin shim) avoids depending on the
  // executable bit of cli.js, which some installs strip and which otherwise
  // fails with "electron-rebuild: Permission denied".
  const mainEntry = require.resolve("@electron/rebuild");
  return path.join(path.dirname(mainEntry), "cli.js");
}

function runRebuild(version) {
  execFileSync(process.execPath, [getRebuildCliPath(), "--version", version], {
    cwd: projectRoot,
    stdio: "inherit",
  });
}

function main() {
  const electronVersion = getElectronVersion();

  if (!electronVersion) {
    console.warn("[electron-rebuild] Electron version not found. Skipping rebuild.");
    return;
  }

  console.log(`[electron-rebuild] Rebuilding native modules for Electron ${electronVersion}`);
  runRebuild(electronVersion);
}

main();
