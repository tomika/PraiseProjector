import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { runInNewContext } from "node:vm";
import ts from "typescript";
import type { WebServerEvent, WebServerInterface } from "../webserver-interface";

const code = ts.transpileModule(readFileSync(new URL("../../electron/preload.ts", import.meta.url), "utf8"), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText;

test("Electron HTTP highlight events preserve and clear ABC ranges through the exposed webServer bridge", () => {
  const ipc = new Map<string, (event: unknown, data: unknown) => void>();
  const exposed = new Map<string, unknown>();
  runInNewContext(code, {
    exports: {},
    console,
    require: (name: string) => {
      assert.equal(name, "electron");
      return {
        ipcRenderer: { on: (name: string, callback: (event: unknown, data: unknown) => void) => ipc.set(name, callback) },
        contextBridge: { exposeInMainWorld: (name: string, value: unknown) => exposed.set(name, value) },
      };
    },
  });
  const events: WebServerEvent[] = [];
  const bridge = exposed.get("webServer") as WebServerInterface;
  const unsubscribe = bridge.onEvent((event) => events.push(event));
  const range = { source: 10, from: 2, to: 4 };
  ipc.get("highlight-changed")!(null, { line: 10, section: 0, abcRange: range });
  ipc.get("highlight-changed")!(null, { line: -1 });
  assert.deepEqual(JSON.parse(JSON.stringify(events)), [
    { kind: "highlightChanged", line: 10, section: 0, abcRange: range },
    { kind: "highlightChanged", line: -1 },
  ]);
  unsubscribe();
  ipc.get("highlight-changed")!(null, { line: 10, abcRange: range });
  assert.equal(events.length, 2);
});
