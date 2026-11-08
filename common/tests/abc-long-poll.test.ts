import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { runInNewContext } from "node:vm";
import ts from "typescript";
import * as abcRange from "../abc-range";
import * as displayUtils from "../pp-utils";

const nodeRequire = createRequire(import.meta.url);
function loadScript(url: URL, mocks: Record<string, unknown>) {
  const code = ts.transpileModule(readFileSync(url, "utf8"), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true },
  }).outputText;
  const exports = {} as { WebServer: new () => object; RequestHandler: { prototype: object } };
  runInNewContext(code, {
    exports,
    __dirname: dirname(fileURLToPath(url)),
    Buffer,
    URL,
    process,
    console: {
      debug() {},
      info() {},
      warn() {},
      error(...args: unknown[]) {
        throw new Error(JSON.stringify(args));
      },
    },
    require: (name: string) => {
      if (name in mocks) return mocks[name];
      // Backend routes are exercised with the DB/auth boundary replaced below.
      if (name.startsWith(".") || name.startsWith("@praiseprojector/common/")) return {};
      return nodeRequire(name);
    },
  });
  return exports;
}

const range = { source: 10, from: 2, to: 4 };
const current = { ...displayUtils.getEmptyDisplay(), songId: "score", from: 10, to: 11, section: 0, abcRange: range };
const cases = [
  { name: "legacy client without the field", query: {}, waits: 1 },
  { name: "unchanged ABC selection", query: { abcRange: JSON.stringify(range) }, waits: 1 },
  { name: "explicitly cleared ABC selection", query: { abcRange: "null" }, waits: 0 },
  { name: "another ABC page", query: { abcRange: JSON.stringify({ ...range, from: 4, to: 6 }) }, waits: 0 },
];

for (const scenario of cases) {
  test(`Electron display long-poll: ${scenario.name}`, async () => {
    let waits = 0;
    const routes: { route: { path: unknown; stack: { handle: unknown }[] } }[] = [];
    const app = {
      use() {},
      get: (path: unknown, handle: unknown) => routes.push({ route: { path, stack: [{ handle }] } }),
      post() {},
      router: { stack: routes },
    };
    // Express is the registration port here; compiling VM-created RegExp paths
    // in the host realm would exercise Node's realm boundary instead of HTTP.
    const express = Object.assign(() => app, { json: () => () => undefined, urlencoded: () => () => undefined, static: () => () => undefined });
    const { WebServer } = loadScript(new URL("../../electron/webserver.ts", import.meta.url), {
      express,
      electron: { app: { isPackaged: false } },
      "./utils": { getMachineIpAddress: () => "127.0.0.1" },
      "../common/abc-range": abcRange,
      "../common/pp-utils": displayUtils,
      "./display": {
        getCurrentDisplay: () => ({ ...current }),
        waitForDisplayChange: async () => {
          waits++;
          return { ...current };
        },
      },
    });
    const server = Object.assign(new WebServer(), {
      registerAndidentifyClient: async () => ({ id: "client" }),
      getClientType: () => "LOCAL",
      setCommonHeaders: () => undefined,
    }) as unknown as {
      app: { router: { stack: { route?: { path: string; stack: { handle: (req: unknown, res: unknown) => Promise<void> }[] } }[] } };
    };
    const route = server.app.router.stack.find((layer) => layer.route?.path === "/display_query")!.route!;
    let response: unknown;
    await route.stack[0].handle(
      { query: { id: "score", from: "10", to: "11", section: "0", ...scenario.query }, socket: {} },
      {
        json: (value: unknown) => {
          response = value;
        },
      }
    );
    assert.equal(waits, scenario.waits);
    assert.ok(response);
  });

  test(`cloud display long-poll: ${scenario.name}`, async () => {
    let waits = 0;
    const request = { query: { id: "score", from: "10", to: "11", section: "0", ...scenario.query }, aborted: false };
    const { RequestHandler } = loadScript(new URL("../../../server/pp-request-handler.ts", import.meta.url), {
      "@praiseprojector/common/abc-range": abcRange,
      "./db-tools": {
        wait_for_notif: async () => {
          waits++;
          request.aborted = true;
        },
      },
    });
    const handler = Object.assign(Object.create(RequestHandler.prototype), {
      req: request,
      res: { type() {}, write() {}, end() {} },
      get_current_display: async () => ({ ...current }),
    }) as { display_query(): Promise<void> };
    await handler.display_query();
    assert.equal(waits, scenario.waits);
  });
}
