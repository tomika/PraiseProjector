#!/usr/bin/env node
// Bundle all db-common/tests/**/*.test.ts files and run Node's test runner.

const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");

const publicRoot = path.resolve(__dirname, "..");
const searchRoot = path.join(publicRoot, "db-common", "tests");
const outDir = path.join(publicRoot, "dist", "tests", "search");

function resolveEsbuild() {
  let esbuildPath;
  try {
    esbuildPath = require.resolve("esbuild", { paths: [__dirname, publicRoot] });
  } catch (err) {
    console.error(
      "[test:search] Could not resolve the 'esbuild' package from the public/ " +
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
  if (!fs.existsSync(searchRoot)) {
    console.error(`[test:search] db-common/tests/ directory not found at ${searchRoot}`);
    process.exit(1);
  }

  const testFiles = discoverTestFiles(searchRoot);
  if (testFiles.length === 0) {
    console.log("[test:search] No db-common/tests/**/*.test.ts files found; nothing to run.");
    return;
  }

  // Tests are selected from this build's metafile, never from stale output files.

  fs.mkdirSync(outDir, { recursive: true });

  const esbuild = resolveEsbuild();

  let bundledFiles;
  try {
    const result = esbuild.buildSync({
      entryPoints: testFiles,
      absWorkingDir: publicRoot,
      define: { "import.meta.env": "{}" },
      outdir: outDir,
      outbase: searchRoot,
      bundle: true,
      platform: "node",
      format: "cjs",
      target: "esnext",
      sourcemap: "inline",
      sourcesContent: true,
      logLevel: "silent",
      metafile: true,
    });
    // Ignore any non-JavaScript assets emitted by transitive imports.
    bundledFiles = Object.keys(result.metafile.outputs)
      .filter((p) => p.endsWith(".js"))
      .map((p) => path.resolve(publicRoot, p));
  } catch (err) {
    console.error("[test:search] esbuild failed to bundle search test files:");
    console.error((err && err.message) || err);
    process.exit(1);
  }

  const runResult = spawnSync(process.execPath, ["--enable-source-maps", "--test", ...bundledFiles], { cwd: publicRoot, stdio: "inherit" });

  if (runResult.error) {
    console.error("[test:search] Failed to launch `node --test`:");
    console.error(runResult.error);
    process.exit(1);
  }

  process.exit(runResult.status === null ? 1 : runResult.status);
}

main();
