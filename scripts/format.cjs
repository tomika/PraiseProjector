#!/usr/bin/env node
/**
 * format.cjs — run `prettier --write` over the project globs but hide the noisy
 * "(unchanged)" lines, so the output lists only files that were actually
 * reformatted (plus any warnings/errors).
 *
 * Why a wrapper instead of a shell pipe:
 *  - cross-platform (no `grep`, works on Windows too);
 *  - prettier's exit code is preserved (a `| grep` pipe would mask it and would
 *    also exit non-zero when every file is unchanged, i.e. nothing to print);
 *  - prettier is invoked via `node <resolved cli>`, so it does not depend on the
 *    executable bit of node_modules/.bin/prettier.
 *
 * Note: prettier writes its per-file log to STDOUT; warnings/errors go to STDERR
 * (inherited untouched). Keep the globs here in sync with the "format:check"
 * script in package.json.
 */
const { spawn } = require("child_process");
const readline = require("readline");

const GLOBS = [
  "src/**/*.{ts,tsx,css}",
  "electron/**/*.ts",
  "client/**/*.ts",
  "common/**/*.ts",
  "chordpro/**/*.{ts,css}",
  "scripts/run-chordpro-tests.js",
];

const prettierCli = require.resolve("prettier/bin/prettier.cjs");

const child = spawn(process.execPath, [prettierCli, "--write", ...GLOBS], {
  stdio: ["inherit", "pipe", "inherit"],
});

const rl = readline.createInterface({ input: child.stdout });
rl.on("line", (line) => {
  // Drop unchanged-file lines (e.g. "src/foo.ts 12ms (unchanged)"); keep the
  // reformatted ones and anything else prettier prints to stdout.
  if (!line.trimEnd().endsWith("(unchanged)")) {
    process.stdout.write(line + "\n");
  }
});

child.on("error", (error) => {
  console.error(error);
  process.exit(1);
});

child.on("close", (code) => {
  process.exit(code == null ? 1 : code);
});
