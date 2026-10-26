import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test, type TestContext } from "node:test";
import { runInNewContext } from "node:vm";
import ts from "typescript";
import { CloudApiService, isAccessToken, isCloudApiErrorKind } from "../../../common/cloudApi";
import { installFakeWindow } from "../../../tests/support/browserEnv";
import type { useAuth } from "../AuthContext";

type Auth = ReturnType<typeof useAuth>;
const code = ts.transpileModule(readFileSync(new URL("../AuthContext.tsx", import.meta.url), "utf8").replaceAll("import.meta.hot", "false"), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.React, esModuleInterop: true },
}).outputText;

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((yes) => {
    resolve = yes;
  });
  return { promise, resolve };
}
const json = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status });
const session = (login = "alice") => ({ login, token: `token-${login}`, leaderId: "leader" });
const tick = () => new Promise<void>((resolve) => setImmediate(resolve));

// Run the production provider with a deterministic hook scheduler. Only React's
// scheduling and the local DB/native environment are replaced; all auth and HTTP
// code runs unchanged, with network responses controlled by each scenario.
function fixture(context: TestContext, { electron = false, stored = true } = {}) {
  const env = installFakeWindow({ storage: { "pp-client-id": "device", ...(stored ? { auth_username: "alice", pp_session_token: "saved" } : {}) } });
  context.after(env.restore);
  const api = new CloudApiService();
  const database = {
    current: "",
    switchUser: async (name: string) => {
      database.current = name;
    },
    getCurrentUsername: () => database.current,
  };
  const native = { disableNotification: async () => {}, cancelAllNotifications: () => {} };
  Object.assign(env.window, { hostDevice: native, electronAPI: electron ? { clearSessionCookies: async () => {} } : undefined });
  const slots: unknown[] = [];
  const cleanups: (() => void)[] = [];
  let cursor = 0;
  const effects: (() => void)[] = [];
  const memo = <T>(value: T, deps: unknown[]) => {
    const index = cursor++;
    const old = slots[index] as { value: T; deps: unknown[] } | undefined;
    const changed = !old || deps.some((d, i) => !Object.is(d, old.deps[i]));
    if (changed) slots[index] = { value, deps };
    return { value: (slots[index] as { value: T }).value, changed, index };
  };
  const react = {
    createContext: () => ({ Provider: "provider" }),
    createElement: (_type: unknown, props: { value: Auth }) => props.value,
    useState: <T>(initial: T) => {
      const index = cursor++;
      if (!(index in slots)) slots[index] = initial;
      return [
        slots[index],
        (value: T | ((previous: T) => T)) => {
          slots[index] = typeof value === "function" ? (value as (previous: T) => T)(slots[index] as T) : value;
        },
      ];
    },
    useRef: <T>(initial: T) => {
      const index = cursor++;
      if (!(index in slots)) slots[index] = { current: initial };
      return slots[index];
    },
    useCallback: <T>(callback: T, deps: unknown[]) => memo(callback, deps).value,
    useEffect: (effect: () => void | (() => void), deps: unknown[]) => {
      const { changed, index } = memo(effect, deps);
      if (changed)
        effects.push(() => {
          cleanups[index]?.();
          cleanups[index] = effect() || (() => {});
        });
    },
  };
  context.after(() => cleanups.forEach((cleanup) => cleanup()));
  const exports = {} as { AuthProvider: (props: { children: null }) => Auth };
  const modules: Record<string, unknown> = {
    react,
    "../../common/cloudApi": { cloudApi: api, isAccessToken, isCloudApiErrorKind },
    "../config": { cloudApiBaseUrl: "" },
    "../../db-common/Database": { Database: database },
  };
  runInNewContext(code, {
    exports,
    require: (id: string) => {
      assert.ok(id in modules, id);
      return modules[id];
    },
    window: env.window,
    localStorage: env.window.localStorage,
    navigator: { onLine: false, userAgent: "test" },
    AbortController,
    btoa,
    console: { debug() {}, error() {}, warn() {} },
  });
  const render = () => {
    cursor = 0;
    const auth = exports.AuthProvider({ children: null });
    effects.splice(0).forEach((effect) => effect());
    return auth;
  };
  return { render, api, database, native, storage: env.window.localStorage, window: env.window };
}

test("overlapping startup/restore callers await one cookie-authenticated session", async (context) => {
  const env = fixture(context);
  const pending = deferred<Response>();
  let calls = 0;
  context.mock.method(globalThis, "fetch", () => {
    calls++;
    return pending.promise;
  });
  const auth = env.render();
  const startup = auth.loadInitialCredentials();
  const restore = auth.restoreStoredSession();
  await tick();
  assert.equal(calls, 1);
  assert.equal(env.render().isLoading, false, "local DB must be usable while verification waits");
  pending.resolve(json(session()));
  await startup;
  assert.equal(await restore, true);
  assert.equal(env.api.isAuthed(), false, "cookie mode intentionally has no bearer");
  assert.equal(env.render().isAuthenticated, true);
});

test("an HTTP server failure preserves stored credentials", async (context) => {
  const env = fixture(context);
  context.mock.method(globalThis, "fetch", async () => json({}, 500));
  assert.equal(await env.render().restoreStoredSession(), false);
  assert.equal(env.storage.getItem("pp_session_token"), "saved");
  assert.equal(env.render().authStatus, "offline");
});

test("Electron startup restores a remembered expired access token with one cookie renewal", async (context) => {
  const env = fixture(context, { electron: true });
  const expiredToken = `atk.${Buffer.from(JSON.stringify({ sub: "alice", exp: 1 })).toString("base64url")}.expired`;
  env.storage.setItem("pp_session_token", expiredToken);
  const authorizations: string[] = [];
  env.api.setProxy({
    proxyGet: async () => assert.fail("Restore must use POST /session"),
    proxyPost: async (_base, _path, _data, headers) => {
      const authorization = headers?.Authorization || "";
      authorizations.push(authorization);
      return authorization ? { error: { status: 401, message: "Refresh cookie required" } } : { data: session(), ppHeaders: {} };
    },
  });
  assert.equal(await env.render().restoreStoredSession(), true);
  assert.deepEqual(authorizations, [""]);
  assert.equal(env.render().isAuthenticated, true);
  assert.equal(env.storage.getItem("pp_session_token"), "token-alice");
});

test("a rejected cookie renewal of a stored access token is not repeated", async (context) => {
  const env = fixture(context, { electron: true });
  const exp = Math.floor(Date.now() / 1000) + 900;
  env.storage.setItem("pp_session_token", `atk.${Buffer.from(JSON.stringify({ sub: "alice", exp })).toString("base64url")}.valid`);
  const authorizations: string[] = [];
  env.api.setProxy({
    proxyGet: async () => assert.fail("Restore must use POST /session"),
    proxyPost: async (_base, _path, _data, headers) => {
      authorizations.push(headers?.Authorization || "");
      return { error: { status: 401, message: "Invalid refresh token" } };
    },
  });
  assert.equal(await env.render().restoreStoredSession(), false);
  assert.deepEqual(authorizations, [""], "the access token and cookie-only attempts are the same request");
  assert.equal(env.storage.getItem("pp_session_token"), null);
});

test("a definitive 401 clears rejected credentials", async (context) => {
  const env = fixture(context);
  context.mock.method(globalThis, "fetch", async () => json({}, 401));
  assert.equal(await env.render().restoreStoredSession(), false);
  assert.equal(env.storage.getItem("pp_session_token"), null);
  assert.equal(env.storage.getItem("auth_username"), "alice", "offline database remains selected");
});

test("startup cannot overwrite a login that completed while its response was delayed", async (context) => {
  const env = fixture(context);
  const pending = deferred<Response>();
  let calls = 0;
  context.mock.method(globalThis, "fetch", async (_input: unknown, init?: RequestInit) => {
    if (++calls === 1) return pending.promise;
    const body = JSON.parse(String(init?.body));
    return json(body.logout ? { login: "", token: "" } : session("bob"));
  });
  const startup = env.render().loadInitialCredentials();
  await tick();
  assert.equal(await env.render().login("bob", "password"), true);
  pending.resolve(json(session()));
  await startup;
  assert.equal(env.render().username, "bob");
  assert.equal(env.render().token, "token-bob");
  assert.equal(env.storage.getItem("auth_username"), "bob");
  assert.equal(env.database.current, "bob");
});

test("a logout delayed by the native bridge cannot erase a newer login", async (context) => {
  const env = fixture(context);
  const pending = deferred<void>();
  env.native.disableNotification = () => pending.promise;
  context.mock.method(globalThis, "fetch", async (_input: unknown, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body));
    return json(body.logout ? { login: "", token: "" } : session("bob"));
  });
  const logout = env.render().logout();
  assert.equal(await env.render().login("bob", "password"), true);
  pending.resolve();
  await logout;
  assert.equal(env.render().token, "token-bob");
  assert.equal(env.storage.getItem("auth_username"), "bob");
  assert.equal(env.database.current, "bob");
});

test("Electron refresh respects Remember Me and ignores refresh events after logout", async (context) => {
  const env = fixture(context, { electron: true, stored: false });
  context.mock.method(globalThis, "fetch", async (_input: unknown, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body));
    return json(body.logout ? { login: "", token: "" } : session());
  });
  assert.equal(await env.render().login("alice", "password"), true);
  const refresh = (accessToken: string) =>
    env.window.dispatchEvent(new CustomEvent("pp-tokens-refreshed", { detail: { accessToken, login: "alice" } }));
  refresh("temporary");
  assert.equal(env.render().token, "temporary");
  assert.equal(env.storage.getItem("pp_session_token"), null);
  env.render().commitSession();
  refresh("remembered");
  assert.equal(env.storage.getItem("pp_session_token"), "remembered");
  await env.render().logout();
  await tick();
  refresh("stale");
  assert.equal(env.render().token, null);
  assert.equal(env.storage.getItem("pp_session_token"), null);
});

test("a logout in another tab clears the visible identity without another logout request", async (context) => {
  const env = fixture(context);
  let calls = 0;
  context.mock.method(globalThis, "fetch", async () => {
    calls++;
    return json(session());
  });
  await env.render().loadInitialCredentials();
  assert.equal(env.render().isAuthenticated, true);
  env.storage.setItem("pp-session-state:", "signed-out");
  env.window.dispatchEvent(Object.assign(new Event("storage"), { key: "pp-session-state:", newValue: "signed-out" }));
  await tick();
  assert.equal(env.render().isAuthenticated, false);
  assert.equal(env.render().username, null);
  assert.equal(env.database.current, "");
  assert.equal(calls, 1);
});
