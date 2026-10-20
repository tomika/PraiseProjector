import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { runInNewContext } from "node:vm";
import ts from "typescript";
import { CloudApiService, isCloudApiErrorKind } from "../cloudApi";
import { getEmptyDisplay } from "../pp-utils";

// Run the real legacy polling and request methods without constructing its UI.
const code = ts.transpileModule(readFileSync(new URL("../../client/praiseprojector.ts", import.meta.url), "utf8"), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true },
}).outputText;

function fixture() {
  const api = new CloudApiService();
  const logs: string[] = [];
  const states: string[] = [];
  const retries: number[] = [];
  const exports = {} as { App: { prototype: { watchDisplay(): Promise<void> } } };
  runInNewContext(code, {
    exports,
    require: (name: string) => {
      if (name === "../common/cloudApi") return { cloudApi: api, isCloudApiErrorKind };
      if (name === "../chordpro/midi") return { setMidiSoundfontUrl() {} };
      return {};
    },
    Error,
    AbortController,
    window: { setTimeout: (_callback: () => void, delay: number) => retries.push(delay), clearTimeout() {} },
  });
  const app = Object.assign(Object.create(exports.App.prototype), {
    mode: "Client",
    webRoot: "https://example.test",
    currentDisplay: getEmptyDisplay(),
    log: (message: string) => logs.push(message),
    setNetworkState: (state: string) => states.push(state),
  }) as { watchDisplay(): Promise<void> };
  return { api, app, logs, states, retries };
}

test("legacy display polling does not report offline when abortAll cancels its cloud request", async (context) => {
  const env = fixture();
  context.mock.method(
    globalThis,
    "fetch",
    (_input: unknown, init?: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        init!.signal!.addEventListener("abort", () => reject(new DOMException("The operation was aborted", "AbortError")), { once: true });
      })
  );
  await env.app.watchDisplay();
  env.api.abortAll();
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(env.logs, []);
  assert.deepEqual(env.states, []);
  assert.equal(env.retries.length, 1, "polling must still be scheduled to resume");
});

test("legacy display polling continues to ignore native AbortError", async (context) => {
  const env = fixture();
  context.mock.method(env.api, "fetchDisplayQuery", async () => {
    throw new DOMException("The operation was aborted", "AbortError");
  });
  await env.app.watchDisplay();
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(env.logs, []);
  assert.deepEqual(env.states, []);
  assert.equal(env.retries.length, 1);
});

test("legacy display polling still reports real network failures as offline", async (context) => {
  const env = fixture();
  context.mock.method(globalThis, "fetch", async () => {
    throw new TypeError("Failed to fetch");
  });
  await env.app.watchDisplay();
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(env.states, ["offline"]);
  assert.equal(env.logs.length, 1);
  assert.match(env.logs[0], /Download error: .*Failed to fetch/);
  assert.equal(env.retries.length, 1);
});
