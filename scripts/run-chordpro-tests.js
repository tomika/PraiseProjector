#!/usr/bin/env node
/**
 * run-chordpro-tests.js — bundles chordpro/**\/*.test.ts with esbuild and runs
 * the result with Node's built-in test runner.
 *
 * Node's native TypeScript stripping (--experimental-strip-types) does not work
 * for this codebase (constructor parameter properties, the yalps runtime import,
 * extensionless ESM imports), so tests are bundled with esbuild instead of run
 * directly. esbuild itself is resolved explicitly (never via cwd) from the
 * public/ workspace/project root; it is already an installed dependency
 * (via the client workspace) and is never added here.
 */

const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");

const publicRoot = path.resolve(__dirname, "..");
const chordproRoot = path.join(publicRoot, "chordpro", "tests");
const outDir = path.join(publicRoot, "dist", "tests", "chordpro");

function resolveEsbuild() {
  let esbuildPath;
  try {
    esbuildPath = require.resolve("esbuild", { paths: [__dirname, publicRoot] });
  } catch (err) {
    console.error(
      "[test:chordpro] Could not resolve the 'esbuild' package from the public/ " +
        "workspace/project root. Run `npm install` at the repository root so the " +
        "hoisted 'esbuild' dependency (from the client workspace) is installed, " +
        "then retry.\n" +
        String((err && err.message) || err)
    );
    process.exit(1);
  }
  return require(esbuildPath);
}

function discoverTestFiles(dir) {
  const results = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      results.push(...discoverTestFiles(full));
    } else if (entry.isFile() && entry.name.endsWith(".test.ts")) {
      results.push(full);
    }
  }
  return results;
}

function main() {
  if (!fs.existsSync(chordproRoot)) {
    console.error(`[test:chordpro] chordpro/ directory not found at ${chordproRoot}`);
    process.exit(1);
  }

  const testFiles = discoverTestFiles(chordproRoot);
  if (testFiles.length === 0) {
    console.log("[test:chordpro] No chordpro/**/*.test.ts files found; nothing to run.");
    return;
  }

  // Delete and recreate the output dir so removed tests cannot leave stale output.
  fs.rmSync(outDir, { recursive: true, force: true });
  fs.mkdirSync(outDir, { recursive: true });

  const esbuild = resolveEsbuild();

  let bundledFiles;
  try {
    const result = esbuild.buildSync({
      entryPoints: testFiles,
      outdir: outDir,
      outbase: chordproRoot,
      bundle: true,
      platform: "node",
      format: "cjs",
      target: "esnext",
      sourcemap: "inline",
      sourcesContent: true,
      logLevel: "silent",
      metafile: true,
    });
    // Bundling a test file that reaches a CSS side-effect import (e.g. anything
    // touching chordpro_editor.ts's dynamic `import("./abc_editor")`) makes
    // esbuild emit a sibling .css asset in the same metafile. Only .js outputs
    // are ever runnable test entries; a non-.js asset must never be handed to
    // `node --test`.
    bundledFiles = Object.keys(result.metafile.outputs)
      .filter((p) => p.endsWith(".js"))
      .map((p) => path.resolve(publicRoot, p));
  } catch (err) {
    console.error("[test:chordpro] esbuild failed to bundle chordpro test files:");
    console.error((err && err.message) || err);
    process.exit(1);
  }

  const runResult = spawnSync(process.execPath, ["--enable-source-maps", "--test", ...bundledFiles], { cwd: publicRoot, stdio: "inherit" });

  if (runResult.error) {
    console.error("[test:chordpro] Failed to launch `node --test`:");
    console.error(runResult.error);
    process.exit(1);
  }

  process.exit(runResult.status === null ? 1 : runResult.status);
}

main();
