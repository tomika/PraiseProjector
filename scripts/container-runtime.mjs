// Shared by build-container-target.js and build-cache.mjs.

import { execSync } from "child_process";

export const BUILD_IMAGE = "praiseprojector-electron-builder:latest";

// ONE named volume holds every download cache of the container builds (npm tarballs and prebuilt
// native modules, the Electron zips, electron-builder tools, Electron node headers). Inside the
// container HOME points into it, so tools with a hard-coded "~/.something" cache land there too.
// `npm run cache:export` / `cache:import` (scripts/build-cache.mjs) archive it together with the
// Windows/host caches into one bundle folder and restore all of them.
export const CACHE_VOLUME = "pp-build-cache";
export const CACHE_MOUNT = "/cache";

export function detectContainerRuntime() {
  for (const runtime of ["podman", "docker"]) {
    try {
      execSync(`${runtime} --version`, { stdio: "pipe" });
      console.log(`Found container runtime: ${runtime}`);
      return runtime;
    } catch {
      // Runtime not found, try next.
    }
  }

  throw new Error("Neither podman nor docker found. Please install one of them.");
}
