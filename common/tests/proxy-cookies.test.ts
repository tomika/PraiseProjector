import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import net from "node:net";
import { test } from "node:test";
import { runInNewContext } from "node:vm";
import ts from "typescript";
import { CloudApiService } from "../cloudApi";

const code = ts.transpileModule(readFileSync(new URL("../../electron/proxy.ts", import.meta.url), "utf8"), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true },
}).outputText;

type HttpResponse = { data: unknown; status: number; headers: Record<string, string[]> };
const response = (cookie?: string): HttpResponse => ({ data: {}, status: 200, headers: cookie ? { "set-cookie": [cookie] } : {} });

function fixture(persistedFiles?: Map<string, string>) {
  const handlers = new Map<string, (...args: unknown[]) => unknown>();
  const files = persistedFiles ?? new Map<string, string>();
  const cookiePath = path.join("test-profile", "pp-cookies.json");
  if (!persistedFiles) files.set(cookiePath, JSON.stringify({ "https://example.test": { pp_refresh: "original" } }));
  const requests: Record<string, string>[] = [];
  const axios = {
    post: async (_url: string, _data: unknown, options: { headers: Record<string, string> }) => {
      requests.push(options.headers);
      return response();
    },
    isAxiosError: () => false,
  };
  const fs = {
    existsSync: (name: string) => files.has(name),
    readFileSync: (name: string) => files.get(name),
    unlinkSync: (name: string) => files.delete(name),
    renameSync: (from: string, to: string) => {
      files.set(to, files.get(from)!);
      files.delete(from);
    },
    promises: {
      writeFile: async (name: string, data: string) => {
        files.set(name, data);
      },
      unlink: async (name: string) => {
        files.delete(name);
      },
    },
  };
  const modules: Record<string, unknown> = {
    electron: {
      app: { getPath: () => "test-profile" },
      ipcMain: {
        handle: (name: string, handler: (...args: unknown[]) => unknown) => handlers.set(name, handler),
        on: (name: string, handler: (...args: unknown[]) => unknown) => handlers.set(name, handler),
      },
    },
    axios,
    "node:fs": fs,
    "node:path": path,
    "node:net": net,
  };
  const exports = {} as { initializeProxy: () => void };
  runInNewContext(code, {
    exports,
    require: (name: string) => {
      assert.ok(name in modules);
      return modules[name];
    },
    URL,
    AbortController,
    process: { env: {}, cwd: () => "test-project", pid: 1 },
    console: { debug() {}, info() {}, warn() {}, error() {} },
  });
  exports.initializeProxy();
  const call = (name: string, ...args: unknown[]) => handlers.get(name)!(null, ...args);
  const post = () => call("proxy-post", "https://example.test", "/session", {}, {}) as Promise<unknown>;
  return { call, post, axios, files, cookiePath, requests };
}

test("remembered sessions renew and persist their rotated cookies across repeated Electron restarts", async () => {
  let env = fixture();
  let refreshCookie = "original";
  let storedToken = `atk.${Buffer.from(JSON.stringify({ sub: "alice", exp: 1 })).toString("base64url")}.expired`;
  type ProxyPost = Parameters<CloudApiService["setProxy"]>[0]["proxyPost"];
  for (let restart = 0; restart < 3; restart++) {
    const api = new CloudApiService();
    api.setBaseUrl("https://example.test");
    api.setFixedHeader("X-PP-Expected-User", "alice");
    api.setProxy({
      proxyGet: async () => assert.fail("Restore must use POST /session"),
      proxyPost: (...args) => env.call("proxy-post", ...args) as ReturnType<ProxyPost>,
    });
    const nextRefresh = `refresh-${restart}`;
    const nextToken = `atk.${Buffer.from(JSON.stringify({ sub: "alice", exp: Math.floor(Date.now() / 1000) + 900 })).toString("base64url")}.renewed`;
    env.axios.post = async (_url, _data, options) => {
      assert.equal(options.headers.Cookie, `pp_refresh=${refreshCookie}`, "Renewal needs the cookie restored from disk");
      assert.equal(options.headers["X-PP-Expected-User"], "alice");
      return { ...response(`pp_refresh=${nextRefresh}; HttpOnly`), data: { login: "alice", token: nextToken, leaderId: "leader" } };
    };
    const result = await api.fetchSession("device", { authToken: `Bearer ${storedToken}` });
    assert.equal(result.login, "alice");
    storedToken = result.token;
    refreshCookie = nextRefresh;
    await new Promise((resolve) => setImmediate(resolve));
    const disk = JSON.parse(env.files.get(env.cookiePath)!);
    assert.equal(disk["https://example.test"].pp_refresh, nextRefresh);
    // A fresh VM discards all main-process memory, retaining only disk files.
    env = fixture(env.files);
  }
});

test("declining Remember Me requires login after the Electron process restarts", async () => {
  const env = fixture();
  env.call("clear-session-cookies", { keepSession: true });
  const restarted = fixture(env.files);
  await restarted.post();
  assert.equal(restarted.requests[0].Cookie, undefined);
});

test("declining Remember Me retains refresh cookies only in memory", async () => {
  const env = fixture();
  env.call("clear-session-cookies", { keepSession: true });
  assert.equal(env.files.has(env.cookiePath), false);
  await env.post();
  assert.equal(env.requests[0].Cookie, "pp_refresh=original");
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(env.files.has(env.cookiePath), false);
});

test("logout clears both memory and disk cookies", async () => {
  const env = fixture();
  env.call("clear-session-cookies");
  await env.post();
  assert.equal(env.requests[0].Cookie, undefined);
  assert.equal(env.files.has(env.cookiePath), false);
});

test("a response that arrives after logout cannot resurrect cookies", async () => {
  const env = fixture();
  let resolve!: (value: HttpResponse) => void;
  env.axios.post = () =>
    new Promise((done) => {
      resolve = done;
    });
  const pending = env.post();
  env.call("clear-session-cookies");
  resolve(response("pp_refresh=stale; HttpOnly"));
  await pending;
  env.axios.post = async (_url, _data, options) => {
    env.requests.push(options.headers);
    return response();
  };
  await env.post();
  assert.equal(env.requests[0].Cookie, undefined);
  assert.equal(env.files.has(env.cookiePath), false);
});

test("an in-flight cookie write cannot undo logout or a Remember Me decline", async () => {
  for (const keepSession of [false, true]) {
    const env = fixture();
    env.call("persist-cookies");
    env.call("clear-session-cookies", { keepSession });
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(env.files.has(env.cookiePath), false);
    assert.equal(env.files.size, 0);
  }
});

test("an aborted Electron response cannot replace the current cookie jar", async () => {
  const env = fixture();
  let resolve!: (value: HttpResponse) => void;
  env.axios.post = () =>
    new Promise((done) => {
      resolve = done;
    });
  const pending = env.call("proxy-post", "https://example.test", "/session", {}, {}, { requestId: "old" }) as Promise<unknown>;
  env.call("proxy-abort", "old");
  resolve(response("pp_refresh=stale; HttpOnly"));
  await pending;
  env.axios.post = async (_url, _data, options) => {
    env.requests.push(options.headers);
    return response();
  };
  await env.post();
  assert.equal(env.requests[0].Cookie, "pp_refresh=original");
});

test("signed-out Electron requests neither send nor accept cookies", async () => {
  const env = fixture();
  env.axios.post = async (_url, _data, options) => {
    env.requests.push(options.headers);
    return response("pp_refresh=unexpected; HttpOnly");
  };
  await env.call("proxy-post", "https://example.test", "/session", {}, {}, { requestId: "guest", omitCookies: true });
  assert.equal(env.requests[0].Cookie, undefined);
  await env.post();
  assert.equal(env.requests[1].Cookie, "pp_refresh=original");
});

test("logout snapshots cookies, clears them locally, and ignores its late response", async () => {
  const env = fixture();
  let resolve!: (value: HttpResponse) => void;
  env.axios.post = async (_url, _data, options) => {
    env.requests.push(options.headers);
    return new Promise((done) => {
      resolve = done;
    });
  };
  const pending = env.call(
    "proxy-post",
    "https://example.test",
    "/session",
    { logout: true },
    {},
    { requestId: "logout", clearCookiesAfterSnapshot: true }
  ) as Promise<unknown>;
  assert.equal(env.requests[0].Cookie, "pp_refresh=original");
  assert.equal(env.files.has(env.cookiePath), false);
  resolve(response("pp_refresh=stale; HttpOnly"));
  await pending;
  env.axios.post = async (_url, _data, options) => {
    env.requests.push(options.headers);
    return response();
  };
  await env.post();
  assert.equal(env.requests[1].Cookie, undefined);
});
