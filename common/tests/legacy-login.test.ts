import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test, type TestContext } from "node:test";
import { runInNewContext } from "node:vm";
import ts from "typescript";
import { CloudApiService, isCloudApiErrorKind } from "../cloudApi";
import { isErrorResponse } from "../pp-utils";
import { installFakeWindow, MemoryStorage } from "../../tests/support/browserEnv";

// Exercise the real legacy login and restore methods with only the UI stubbed.
const code = ts.transpileModule(readFileSync(new URL("../../client/praiseprojector.ts", import.meta.url), "utf8"), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true },
}).outputText;

interface LegacyApp {
  doLogin(dialog: HTMLElement): Promise<void>;
  login?: string;
  token?: string;
}

function fixture(context: TestContext, keepLoggedIn = false) {
  const browser = installFakeWindow({ storage: { clientId: "legacy-device" } });
  context.after(browser.restore);
  const sessionStorage = new MemoryStorage();
  const api = new CloudApiService();
  api.setToken("Bearer previous-session");
  api.setFixedHeader("X-PP-Expected-User", "previous-user");
  const fields = {
    login: { value: "alice" },
    password: { value: "password" },
    keepLoggedIn: { checked: keepLoggedIn },
  };
  const logs: string[] = [];
  const confirmations: string[] = [];
  const exports = {} as { App: { prototype: LegacyApp } };
  runInNewContext(code, {
    exports,
    require: (name: string) => {
      if (name === "../common/cloudApi") return { cloudApi: api, isCloudApiErrorKind };
      if (name === "../common/pp-utils") return { isErrorResponse };
      if (name === "../common/utils") return { endModal() {} };
      if (name === "../chordpro/midi") return { setMidiSoundfontUrl() {} };
      if (name === "./host-device") return { HostDevice: { hostDevice: null } };
      return {};
    },
    btoa,
    window: { sessionStorage },
    localStorage: browser.window.localStorage,
    document: { getElementById: (id: keyof typeof fields) => fields[id] },
  });
  const app = Object.assign(Object.create(exports.App.prototype), {
    verifyNotifications() {},
    updateDatabase() {},
    updateFieldsForUser() {},
    confirm: async (message: string) => confirmations.push(message),
    log: (message: string) => logs.push(message),
  }) as LegacyApp;
  return { api, app, fields, logs, confirmations, sessionStorage, localStorage: browser.window.localStorage };
}

const session = { login: "alice", token: "alice-session", leaderId: "leader" };
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });

for (const scenario of ["login", "remembered login", "login after failed logout cleanup"] as const) {
  test(`legacy ${scenario} sends explicit Basic auth after signing out the previous user`, async (context) => {
    const remember = scenario === "remembered login";
    const env = fixture(context, remember);
    const authorizations: (string | null)[] = [];
    context.mock.method(globalThis, "fetch", async (input: string | URL | Request, init?: RequestInit) => {
      assert.equal(String(input), "/session");
      const headers = new Headers(init?.headers);
      const authorization = headers.get("Authorization");
      authorizations.push(authorization);
      assert.equal(headers.get("X-PP-Expected-User") || "", "");
      const body = JSON.parse(String(init?.body)) as { clientId: string; logout?: boolean };
      assert.equal(body.clientId, "legacy-device");
      if (body.logout) {
        if (scenario === "login after failed logout cleanup") throw new TypeError("Failed to fetch");
        return json({ login: "", token: "", leaderId: "" });
      }
      if (authorization?.startsWith("Basic ")) {
        assert.equal(env.api.getAuthorizationHeader(), "", "Basic credentials must be scoped to the login request");
        assert.equal(env.api.isSessionEnabled(), false, "logout must have disabled automatic session restore");
      }
      return json(session);
    });

    await env.app.doLogin({} as HTMLElement);

    assert.deepEqual(authorizations, ["", `Basic ${btoa("alice:password")}`, ...(remember ? ["Bearer alice-session"] : [])]);
    assert.deepEqual(env.logs, []);
    assert.deepEqual(env.confirmations, ["access-granted"]);
    assert.equal(env.app.login, "alice");
    assert.equal(env.app.token, "alice-session");
    assert.equal(env.api.getAuthorizationHeader(), "Bearer alice-session");
    assert.equal(env.api.isAuthed(), true);
    assert.equal(env.localStorage.getItem(env.api.getSessionStateKey()), null);
    assert.equal(env.sessionStorage.getItem("sessionId"), "alice-session");
    assert.equal(env.fields.password.value, "");
  });
}

test("legacy failed login stays signed out and clears the previous user's stored token", async (context) => {
  const env = fixture(context, true);
  env.sessionStorage.setItem("sessionId", "previous-session");
  env.localStorage.setItem("sessionId", "previous-session");
  const authorizations: (string | null)[] = [];
  context.mock.method(globalThis, "fetch", async (_input: unknown, init?: RequestInit) => {
    authorizations.push(new Headers(init?.headers).get("Authorization"));
    const body = JSON.parse(String(init?.body)) as { logout?: boolean };
    return body.logout ? json({ login: "", token: "", leaderId: "" }) : json({ error: "Unauthorized" }, 401);
  });

  await env.app.doLogin({} as HTMLElement);

  assert.deepEqual(authorizations, ["", `Basic ${btoa("alice:password")}`]);
  assert.equal(env.api.isSessionEnabled(), false);
  assert.equal(env.api.getAuthorizationHeader(), "");
  assert.equal(env.app.login, undefined);
  assert.equal(env.app.token, undefined);
  assert.equal(env.fields.keepLoggedIn.checked, false);
  assert.equal(env.sessionStorage.getItem("sessionId"), null);
  assert.equal(env.localStorage.getItem("sessionId"), null);
});
