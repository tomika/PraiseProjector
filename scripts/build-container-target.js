#!/usr/bin/env node

import { execSync } from "child_process";
import path from "path";
import fs from "fs";
import { fileURLToPath } from "url";

const TARGETS = {
  linux: {
    label: "Linux AppImage",
    outputSubDir: "linux",
    electronBuilderArgs: "--linux AppImage --publish never",
    extraContainerEnv: [],
  },
  mac: {
    label: "macOS ZIP",
    outputSubDir: "mac",
    electronBuilderArgs: "--mac zip --publish never",
    extraContainerEnv: ["-e CSC_IDENTITY_AUTO_DISCOVERY=false"],
  },
};

const requestedTarget = process.argv[2];
const targetConfig = TARGETS[requestedTarget];

if (!targetConfig) {
  console.error("Invalid target. Use one of: linux, mac");
  process.exit(1);
}

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const packageJsonPath = path.join(__dirname, "..", "package.json");
const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, "utf8"));

const baseOutputDir = packageJson.build?.directories?.output || "release";
const targetOutputDir = `${baseOutputDir}/${targetConfig.outputSubDir}`;

console.log(`Building target: ${requestedTarget}`);
console.log(`Using output directory: ${targetOutputDir}`);

function detectContainerRuntime() {
  const runtimes = ["podman", "docker"];

  for (const runtime of runtimes) {
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

const projectPath = path.resolve(__dirname, "..");
const containerRuntime = detectContainerRuntime();

const customImage = "praiseprojector-electron-builder:latest";
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
    return { rebuild: true, reason: "image missing" };
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

const runContainerEnv = [
  "-e ELECTRON_CACHE=/root/.cache/electron",
  "-e ELECTRON_BUILDER_CACHE=/root/.cache/electron-builder",
  ...targetConfig.extraContainerEnv,
].join(" ");

const buildCmd = [
  "mkdir -p /tmp/project",
  "cd /project",
  "tar --exclude=www --exclude=node_modules --exclude=package-lock.json --exclude=dist -cf - . | tar -xf - -C /tmp/project",
  "cd /tmp/project",
  "npm install",
  ...(targetConfig.preBuildCommands || []),
  "npm run build",
  `npx electron-builder ${targetConfig.electronBuilderArgs}`,
  `mkdir -p /project/${targetOutputDir}`,
  `cp -r ${baseOutputDir}/* /project/${targetOutputDir}/`,
].join(" && ");

const containerCmd = [
  containerRuntime,
  "run",
  "--rm",
  "-it",
  runContainerEnv,
  `-v "${projectPath}:/project"`,
  "-w /project",
  customImage,
  "/bin/bash -lc",
  `"${buildCmd}"`,
].join(" ");

console.log(`Building ${targetConfig.label} using container...`);
console.log(`Command: ${containerCmd}\n`);

try {
  execSync(containerCmd, { stdio: "inherit", shell: true });
  console.log(`\nBuild complete! Output in: ${targetOutputDir}`);
} catch {
  console.error("Build failed!");
  process.exit(1);
}
