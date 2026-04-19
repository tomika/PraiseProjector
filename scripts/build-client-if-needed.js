#!/usr/bin/env node

const fs = require("fs/promises");
const path = require("path");
const { execSync } = require("child_process");

const projectRoot = path.resolve(__dirname, "..");
const outputFile = path.join(projectRoot, "public", "app", "pp-api.js");
const buildModeStampFile = path.join(
  projectRoot,
  "public",
  "app",
  "pp-api.build-mode"
);
const watchDirs = [
  path.join(projectRoot, "client"),
  path.join(projectRoot, "chordpro"),
  path.join(projectRoot, "common"),
  path.join(projectRoot, "db-common"),
];

const ignoredDirs = new Set([
  "node_modules",
  ".git",
  "dist",
  "build",
  "coverage",
]);

async function getFileMtimeMs(filePath) {
  try {
    const stats = await fs.stat(filePath);
    return stats.mtimeMs;
  } catch {
    return 0;
  }
}

async function getNewestMtimeMs(rootDir) {
  let newest = 0;
  const queue = [rootDir];

  while (queue.length > 0) {
    const current = queue.pop();
    if (!current) {
      continue;
    }

    let entries;
    try {
      entries = await fs.readdir(current, { withFileTypes: true });
    } catch {
      continue;
    }

    for (const entry of entries) {
      if (entry.name.startsWith(".")) {
        continue;
      }

      const fullPath = path.join(current, entry.name);
      if (entry.isDirectory()) {
        if (!ignoredDirs.has(entry.name)) {
          queue.push(fullPath);
        }
        continue;
      }

      if (!entry.isFile()) {
        continue;
      }

      const mtimeMs = await getFileMtimeMs(fullPath);
      if (mtimeMs > newest) {
        newest = mtimeMs;
      }
    }
  }

  return newest;
}

function fmt(ts) {
  return ts ? new Date(ts).toISOString() : "missing";
}

async function readLastBuildMode() {
  try {
    return (await fs.readFile(buildModeStampFile, "utf8")).trim().toLowerCase();
  } catch (error) {
    if (error && error.code === "ENOENT") {
      // No stamp file means the output is considered a release build.
      return "release";
    }
    return "";
  }
}

async function writeLastBuildMode(buildMode) {
  if (buildMode === "release") {
    // Keep release output clean: no stamp file means release.
    try {
      await fs.unlink(buildModeStampFile);
    } catch (error) {
      if (!error || error.code !== "ENOENT") {
        throw error;
      }
    }
    return;
  }
  await fs.writeFile(buildModeStampFile, `${buildMode}\n`, "utf8");
}

async function main() {
  const requestedMode = (process.env.PP_BUILD_MODE || "release").toLowerCase();
  const buildMode = requestedMode === "debug" ? "debug" : "release";
  const buildScript = buildMode === "debug" ? "build:debug" : "build:release";
  const lastBuildMode = await readLastBuildMode();

  if (requestedMode !== "debug" && requestedMode !== "release") {
    console.warn(
      `[pp-api] Unknown PP_BUILD_MODE=\"${requestedMode}\", using release.`
    );
  }

  const outputMtime = await getFileMtimeMs(outputFile);
  const newestSourceMtime = Math.max(
    ...(await Promise.all(watchDirs.map((dir) => getNewestMtimeMs(dir))))
  );

  const shouldBuild =
    outputMtime === 0 ||
    newestSourceMtime > outputMtime ||
    lastBuildMode !== buildMode;

  if (!shouldBuild) {
    console.log("[pp-api] Build skipped: output is up to date.");
    console.log(`[pp-api] mode: ${buildMode}`);
    console.log(`[pp-api] output: ${fmt(outputMtime)}`);
    console.log(`[pp-api] source: ${fmt(newestSourceMtime)}`);
    return;
  }

  console.log("[pp-api] Build required.");
  console.log(`[pp-api] mode: ${buildMode}`);
  console.log(`[pp-api] output: ${fmt(outputMtime)}`);
  console.log(`[pp-api] source: ${fmt(newestSourceMtime)}`);
  console.log(`[pp-api] Running: npm run ${buildScript} --workspace=client`);

  execSync(`npm run ${buildScript} --workspace=client`, {
    cwd: projectRoot,
    stdio: "inherit",
  });

  await writeLastBuildMode(buildMode);
}

main().catch((error) => {
  console.error("[pp-api] Conditional build failed:", error);
  process.exit(1);
});
