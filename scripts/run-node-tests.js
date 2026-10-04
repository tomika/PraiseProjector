#!/usr/bin/env node
// Discover, bundle and run a node:test suite of TypeScript test files.
//
//   node scripts/run-node-tests.js --suite src|hardware [--root <dir>]
//
// Every test file is bundled on its own with esbuild (CommonJS, node_modules left
// external) so production modules can keep extensionless imports and parameter
// properties, which Node's strip-only TypeScript mode cannot run. `import.meta.url`
// is rewritten to the ORIGINAL file URL so tests that read sibling sources keep
// working after bundling. A suite that discovers no test file is a failure.

const fs = require("fs");
const path = require("path");
const { pathToFileURL } = require("url");
const { spawnSync } = require("child_process");

const publicRoot = path.resolve(__dirname, "..");

/** A test file belongs to the hardware suite when its name or folder says so. */
function isHardwareTest(file) {
  const rel = path.relative(publicRoot, file).split(path.sep).join("/");
  return /(^|\/)hardware-[^/]*\.test\.ts$/.test(rel) || rel.startsWith("src/hardware-input/");
}

const SUITES = {
  src: { roots: ["src", "common/tests", "tests/support"], filter: (file) => !isHardwareTest(file) },
  hardware: { roots: ["src", "common/tests", "tests/support"], filter: isHardwareTest },
};

function parseArgs(argv) {
  const args = { suite: null, root: null };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--suite") args.suite = argv[++i];
    else if (arg === "--root") args.root = argv[++i];
    else fail(`unknown argument: ${arg}`);
  }
  if (!args.suite || !SUITES[args.suite]) fail(`--suite must be one of: ${Object.keys(SUITES).join(", ")}`);
  return args;
}

function fail(message) {
  console.error(`[test] ${message}`);
  process.exit(1);
}

function discover(dir) {
  if (!fs.existsSync(dir)) return [];
  if (fs.statSync(dir).isFile()) return dir.endsWith(".test.ts") ? [dir] : [];
  const results = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === "node_modules") continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) results.push(...discover(full));
    else if (entry.isFile() && entry.name.endsWith(".test.ts")) results.push(full);
  }
  return results;
}

function resolveEsbuild() {
  try {
    return require(require.resolve("esbuild", { paths: [__dirname, publicRoot] }));
  } catch (err) {
    fail(`could not resolve 'esbuild' (run npm install at the repository root): ${(err && err.message) || err}`);
  }
}

/** Replace `import.meta.url` with the source file's own URL before bundling. */
const importMetaUrlPlugin = {
  name: "original-import-meta-url",
  setup(build) {
    build.onLoad({ filter: /\.tsx?$/ }, async (args) => {
      if (args.path.includes(`${path.sep}node_modules${path.sep}`)) return undefined;
      const source = await fs.promises.readFile(args.path, "utf8");
      if (!source.includes("import.meta.url")) return undefined;
      const contents = source.split("import.meta.url").join(JSON.stringify(pathToFileURL(args.path).href));
      return { contents, loader: args.path.endsWith(".tsx") ? "tsx" : "ts" };
    });
  },
};

/** One CommonJS bundle per test file, each run in its own process. */
async function bundle(suiteName, files) {
  const suiteDir = path.join(publicRoot, "dist", "tests", suiteName);
  fs.mkdirSync(suiteDir, { recursive: true });
  // A targeted check must not delete bundles a running full suite still needs.
  const outDir = fs.mkdtempSync(path.join(suiteDir, "run-"));
  const esbuild = resolveEsbuild();
  try {
    const result = await esbuild.build({
      entryPoints: files,
      absWorkingDir: publicRoot,
      outdir: outDir,
      outbase: publicRoot,
      outExtension: { ".js": ".cjs" },
      bundle: true,
      format: "cjs",
      packages: "external",
      platform: "node",
      target: "node22",
      jsx: "automatic",
      define: { "import.meta.env": "{}" },
      sourcemap: "inline",
      sourcesContent: true,
      logLevel: "silent",
      metafile: true,
      plugins: [importMetaUrlPlugin],
      loader: { ".css": "empty", ".svg": "text", ".png": "empty" },
    });
    const entries = Object.entries(result.metafile.outputs)
      .filter(([, output]) => !!output.entryPoint)
      .map(([p]) => path.resolve(publicRoot, p));
    return { entries, outDir };
  } catch (err) {
    fs.rmSync(outDir, { recursive: true, force: true });
    const details = (err && err.errors ? err.errors : [])
      .map((e) => `${e.location ? `${e.location.file}:${e.location.line}: ` : ""}${e.text}`)
      .join("\n");
    fail(`esbuild failed to bundle the ${suiteName} suite:\n${details || (err && err.message) || err}`);
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const suite = SUITES[args.suite];
  const roots = args.root ? [args.root] : suite.roots;
  const files = roots
    .flatMap((root) => discover(path.resolve(publicRoot, root)))
    .filter(args.root ? () => true : suite.filter)
    .sort();
  if (files.length === 0) fail(`suite '${args.suite}' discovered no *.test.ts file under ${roots.join(", ")}`);
  console.log(`[test:${args.suite}] ${files.length} test file(s)`);

  const { entries: bundled, outDir } = await bundle(args.suite, files);
  const nodeArgs = ["--enable-source-maps", "--test"];
  const env = { ...process.env };
  // A runner invoked from a node:test fixture owns a new test run, not a worker
  // of its parent's run. Inheriting this internal marker suppresses child tests.
  delete env.NODE_TEST_CONTEXT;
  let status = 1;
  try {
    const run = spawnSync(process.execPath, [...nodeArgs, ...bundled], { cwd: publicRoot, stdio: "inherit", env });
    if (run.error) console.error(`[test] failed to launch node --test: ${run.error.message}`);
    else status = run.status === null ? 1 : run.status;
  } finally {
    // The bundles belong to this run alone.
    fs.rmSync(outDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
  process.exit(status);
}

main().catch((err) => fail((err && err.stack) || String(err)));
