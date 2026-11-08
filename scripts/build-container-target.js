#!/usr/bin/env node

import { execSync } from "child_process";
import path from "path";
import fs from "fs";
import { fileURLToPath } from "url";
import { BUILD_IMAGE, CACHE_MOUNT, CACHE_VOLUME, detectContainerRuntime } from "./container-runtime.mjs";

const TARGETS = {
  linux: {
    label: "Linux AppImage",
    outputSubDir: "linux",
    electronBuilderArgs: "--linux AppImage --publish never",
    extraContainerEnv: [],
    copyCommands: (_baseOutputDir, targetOutputDir) => [
      `find dist/executables -maxdepth 1 -type f \\( -name 'latest-linux.yml' -o -name '*.AppImage' \\) -exec cp {} /project/${targetOutputDir}/ \\;`,
    ],
  },
  mac: {
    label: "macOS ZIP",
    outputSubDir: "mac",
    electronBuilderArgs: "--mac zip --publish never",
    extraContainerEnv: ["-e CSC_IDENTITY_AUTO_DISCOVERY=false"],
    copyCommands: (_baseOutputDir, targetOutputDir) => [
      `find dist/executables -maxdepth 1 -type f \\( -name 'latest-mac.yml' -o -name '*-mac.zip' -o -name '*-mac.zip.blockmap' \\) -exec cp {} /project/${targetOutputDir}/ \\;`,
    ],
  },
};

const requestedTarget = process.argv[2];
const targetConfig = TARGETS[requestedTarget];

if (!targetConfig) {
  console.error("Invalid target. Use one of: linux, mac [--offline]");
  process.exit(1);
}

// Offline mode: build only from the persistent download cache (the CACHE_VOLUME volume, which survives
// `--rm`). `npm run dist:linux` does not forward arguments, so PP_BUILD_OFFLINE=1 is accepted as well.
// The first successful ONLINE build seeds the cache; `npm run cache:export` / `cache:import` archive it.
const offline = process.argv.includes("--offline") || process.env.PP_BUILD_OFFLINE === "1";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const packageJsonPath = path.join(__dirname, "..", "package.json");
const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, "utf8"));

const baseOutputDir = packageJson.build?.directories?.output || "release";
const targetOutputDir = `${baseOutputDir}/${targetConfig.outputSubDir}`;

console.log(`Building target: ${requestedTarget}`);
console.log(`Using output directory: ${targetOutputDir}`);

const projectPath = path.resolve(__dirname, "..");
const containerRuntime = detectContainerRuntime();

const customImage = BUILD_IMAGE;
const dockerfilePath = path.join(__dirname, "..", "docker", "Dockerfile.electron-builder");

function imageExists(runtime, imageName) {
  try {
    execSync(`${runtime} image inspect ${imageName}`, { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

function getImageCreatedAt(runtime, imageName) {
  try {
    const created = execSync(`${runtime} image inspect --format "{{.Created}}" ${imageName}`, {
      stdio: ["ignore", "pipe", "pipe"],
      encoding: "utf8",
    }).trim();

    const createdMs = Date.parse(created);
    if (Number.isNaN(createdMs)) {
      return null;
    }

    return createdMs;
  } catch {
    return null;
  }
}

function buildImage(runtime, imageName) {
  execSync(`${runtime} build -t ${imageName} -f "${dockerfilePath}" "${path.dirname(dockerfilePath)}"`, {
    stdio: "inherit",
  });
}

function shouldRebuildImage(runtime, imageName) {
  if (!imageExists(runtime, imageName)) {
    if (offline) {
      throw new Error(`Offline build needs the existing image '${imageName}' (apt/base image cannot be fetched). Run one online build first.`);
    }
    return { rebuild: true, reason: "image missing" };
  }

  if (offline) {
    // A Dockerfile mtime bump (e.g. after a checkout) must not trigger an apt-get run without network.
    return { rebuild: false, reason: "offline mode, keeping the existing image" };
  }

  const imageCreatedAt = getImageCreatedAt(runtime, imageName);
  const dockerfileMtime = fs.statSync(dockerfilePath).mtimeMs;

  if (imageCreatedAt === null) {
    return { rebuild: true, reason: "unable to read image creation timestamp" };
  }

  if (dockerfileMtime > imageCreatedAt) {
    return { rebuild: true, reason: "Dockerfile changed after image build" };
  }

  return { rebuild: false, reason: "image is up to date" };
}

const rebuildDecision = shouldRebuildImage(containerRuntime, customImage);

if (rebuildDecision.rebuild) {
  console.log(`Rebuilding custom image '${customImage}' (${rebuildDecision.reason})...`);
  buildImage(containerRuntime, customImage);
  console.log(`Custom image '${customImage}' built.`);
} else {
  console.log(`Using existing image: ${customImage} (${rebuildDecision.reason})`);
}

// Everything cache-like lives under CACHE_MOUNT. HOME is redirected there too because some tools
// hard-code "~/<dir>" (@electron/rebuild: ~/.electron-gyp, node-gyp: ~/.cache/node-gyp).
const runContainerEnv = [
  `-e HOME=${CACHE_MOUNT}/home`,
  `-e npm_config_cache=${CACHE_MOUNT}/npm`,
  `-e ELECTRON_CACHE=${CACHE_MOUNT}/electron`,
  `-e ELECTRON_BUILDER_CACHE=${CACHE_MOUNT}/electron-builder`,
  // Cache hits first in every mode; in offline mode npm must never touch the network.
  "-e npm_config_prefer_offline=true",
  ...(offline ? ["-e npm_config_offline=true"] : []),
  ...targetConfig.extraContainerEnv,
].join(" ");

const cacheVolumeArg = `-v ${CACHE_VOLUME}:${CACHE_MOUNT}`;

const buildCmd = [
  `mkdir -p ${CACHE_MOUNT}/home`,
  "mkdir -p /tmp/project",
  "cd /project",
  "tar --exclude=www --exclude=node_modules --exclude=dist --exclude='pp-build-cache-*' -cf - . | tar -xf - -C /tmp/project",
  "cd /tmp/project",
  "npm install",
  // `npm audit fix` needs the registry and may bump versions that are not in the cache; the
  // lockfile versions installed above are what the cache holds, so skip it when offline.
  ...(offline
    ? []
    : ["npm audit fix || echo 'npm audit fix left unresolved vulnerabilities (see report above); continuing build'"]),
  ...(targetConfig.preBuildCommands || []),
  "npm run generate-icons",
  "npm run build:web",
  "npm run build",
  `npx electron-builder ${targetConfig.electronBuilderArgs}`,
  `mkdir -p /project/${targetOutputDir}`,
  ...targetConfig.copyCommands(baseOutputDir, targetOutputDir),
].join(" && ");

const containerCmd = [
  containerRuntime,
  "run",
  "--rm",
  "-it",
  runContainerEnv,
  cacheVolumeArg,
  `-v "${projectPath}:/project"`,
  "-w /project",
  customImage,
  "/bin/bash -lc",
  `"${buildCmd}"`,
].join(" ");

console.log(`Building ${targetConfig.label} using container${offline ? " (OFFLINE, caches only)" : ""}...`);
console.log(`Command: ${containerCmd}\n`);

try {
  execSync(containerCmd, { stdio: "inherit", shell: true });
  console.log(`\nBuild complete! Output in: ${targetOutputDir}`);
} catch {
  console.error("Build failed!");
  process.exit(1);
}
