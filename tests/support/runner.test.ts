import assert from "node:assert/strict";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
const publicRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

test("the real test runner rejects no tests and a discovered failing test", () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "pp-runner-negative-"));
  try {
    const run = (root: string) =>
      spawnSync(process.execPath, [path.join(publicRoot, "scripts/run-node-tests.js"), "--suite", "src", "--root", root], {
        cwd: publicRoot,
        encoding: "utf8",
      });
    const empty = run(temp);
    assert.equal(empty.status, 1);
    assert.match(empty.stderr, /discovered no/i);
    const file = path.join(temp, "failure.test.ts");
    fs.writeFileSync(file, "import {test} from 'node:test'; test('deliberate failure',()=>{throw Error('runner-negative-fixture')});");
    const failed = run(file);
    assert.equal(failed.status, 1);
    assert.match(failed.stdout, /runner-negative-fixture/);
  } finally {
    fs.rmSync(temp, { recursive: true, force: true });
  }
});

test("concurrent checks of the same suite keep both compiled test sets", async () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "pp-concurrent-runner-"));
  try {
    const slowDir = path.join(temp, "first");
    fs.mkdirSync(slowDir);
    const slow = path.join(slowDir, "a-slow.test.ts"),
      fast = path.join(temp, "fast.test.ts"),
      marker = path.join(temp, "started");
    fs.writeFileSync(
      slow,
      `import fs from 'node:fs';import {test} from 'node:test';test('slow existing bundle',async()=>{fs.writeFileSync(${JSON.stringify(marker)},'yes');await new Promise(r=>setTimeout(r,500));});`
    );
    fs.writeFileSync(fast, "import {test} from 'node:test';test('second bundle',()=>{});");
    fs.writeFileSync(path.join(slowDir, "b-later.test.ts"), "import {test} from 'node:test';test('queued first-suite bundle',()=>{});");
    const suiteDir = path.join(publicRoot, "dist", "tests", "src");
    const existing = new Set(fs.existsSync(suiteDir) ? fs.readdirSync(suiteDir) : []);
    const child = spawn(process.execPath, [path.join(publicRoot, "scripts/run-node-tests.js"), "--suite", "src", "--root", slowDir], {
      cwd: publicRoot,
      stdio: "pipe",
    });
    const done = new Promise<number | null>((resolve, reject) => {
      child.once("error", reject);
      child.once("exit", resolve);
    });
    const deadline = Date.now() + 15_000;
    while (!fs.existsSync(marker) && Date.now() < deadline) await new Promise((r) => setTimeout(r, 20));
    assert.ok(fs.existsSync(marker), "first suite started");
    const second = spawnSync(process.execPath, [path.join(publicRoot, "scripts/run-node-tests.js"), "--suite", "src", "--root", fast], {
      cwd: publicRoot,
      encoding: "utf8",
    });
    assert.equal(second.status, 0, second.stderr);
    assert.equal(await done, 0);
    assert.deepEqual(
      fs.readdirSync(suiteDir).filter((name) => !existing.has(name)),
      [],
      "each runner removes its own compiled bundles"
    );
  } finally {
    fs.rmSync(temp, { recursive: true, force: true });
  }
});
