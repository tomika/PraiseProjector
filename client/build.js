#!/usr/bin/env node

const path = require("path");
const fs = require("fs");
const { execSync } = require("child_process");
const esbuild = require("esbuild");

const args = new Set(process.argv.slice(2));
const isDebug = args.has("--debug");

const clientRoot = __dirname;
const publicRoot = path.resolve(clientRoot, "..");
const rootPackageJsonPath = path.join(publicRoot, "package.json");
const outFile = path.join(publicRoot, "dist", "client", "app", "pp-api.js");
const entryFile = path.join(clientRoot, "pp-api.ts");

const rootPackageJson = JSON.parse(fs.readFileSync(rootPackageJsonPath, "utf8"));
const appVersion = rootPackageJson.version || "0.0.0";

const resolveCommit = () => {
  if (process.env.PP_COMMIT_SHA) return process.env.PP_COMMIT_SHA;
  if (process.env.GIT_COMMIT) return process.env.GIT_COMMIT;
  try {
    return execSync("git rev-parse --short HEAD", {
      cwd: publicRoot,
      stdio: ["ignore", "pipe", "ignore"],
    })
      .toString()
      .trim();
  } catch {
    return "";
  }
};

const resolveCommitMessage = () => {
  if (process.env.PP_COMMIT_MESSAGE) return process.env.PP_COMMIT_MESSAGE;
  if (process.env.GIT_COMMIT_MESSAGE) return process.env.GIT_COMMIT_MESSAGE;
  try {
    return execSync("git log -1 --pretty=%s", {
      cwd: publicRoot,
      stdio: ["ignore", "pipe", "ignore"],
    })
      .toString()
      .trim();
  } catch {
    return "";
  }
};

const appCommit = resolveCommit();
const appCommitMessage = resolveCommitMessage();
const showCommitInAbout = Boolean(appCommit) && appCommitMessage !== `v${appVersion}`;

esbuild
  .build({
    entryPoints: [entryFile],
    bundle: true,
    format: "iife",
    globalName: "P",
    platform: "browser",
    target: "es2018",
    sourcemap: isDebug,
    minify: !isDebug,
    outfile: outFile,
    define: {
      "import.meta.env": "{}",
      __APP_VERSION__: JSON.stringify(appVersion),
      __APP_COMMIT__: JSON.stringify(appCommit),
      __APP_SHOW_COMMIT__: JSON.stringify(showCommitInAbout),
    },
  })
  .then(() => {
    const mode = isDebug ? "debug" : "release";
    console.log(`[pp-client] Built ${mode} bundle at ${outFile}`);
    console.log(`[pp-client] __APP_VERSION__: ${appVersion}`);
    if (showCommitInAbout && appCommit) {
      console.log(`[pp-client] __APP_COMMIT__: ${appCommit}`);
    }
  })
  .catch((error) => {
    console.error("[pp-client] Build failed", error);
    process.exit(1);
  });
