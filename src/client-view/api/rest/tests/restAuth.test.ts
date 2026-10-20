import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import { cloudApi } from "../../../../../common/cloudApi";
import { installFakeWindow, MemoryStorage } from "../../../../../tests/support/browserEnv";
import { createAuthApi } from "../restPorts";
import type { RestCore } from "../RestCore";

const json = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status });
const session = (login = "alice") => ({ login, token: `token-${login}`, leaderId: "leader" });

function fixture(context: TestContext, stored = "old") {
  const env = installFakeWindow({ storage: stored ? { sessionId: stored, sessionLogin: "alice" } : {} });
  const sessionStorage = new MemoryStorage();
  Object.assign(env.window, { sessionStorage });
  context.after(() => {
    cloudApi.resetSession();
    env.restore();
  });
  cloudApi.resetSession();
  cloudApi.setBaseUrl("");
  cloudApi.setClientId("device");
  cloudApi.setFixedHeader("X-PP-Expected-User", "");
  const core = {
    clientId: "device",
    leader: null,
    authed: false,
    setAuthed(authed: boolean) {
      this.authed = authed;
    },
  };
  const auth = createAuthApi(core as unknown as RestCore);
  return { auth, core, localStorage: env.window.localStorage, sessionStorage };
}

test("standalone restore falls back to cookies and persists the rotated token", async (context) => {
  const env = fixture(context);
  const headers: string[] = [];
  context.mock.method(globalThis, "fetch", async (_input: unknown, init?: RequestInit) => {
    const authorization = new Headers(init?.headers).get("Authorization") || "";
    headers.push(authorization);
    return authorization ? json({}, 401) : json(session());
  });
  await Promise.all([env.auth.restoreSession(), env.auth.restoreSession()]);
  assert.deepEqual(headers, ["Bearer old", ""]);
  assert.equal(env.localStorage.getItem("sessionId"), "token-alice");
  assert.equal(env.core.authed, true);
});

test("standalone offline restore keeps the saved login for a later retry", async (context) => {
  const env = fixture(context);
  context.mock.method(globalThis, "fetch", async () => {
    throw new TypeError("Failed to fetch");
  });
  await env.auth.restoreSession();
  assert.equal(env.localStorage.getItem("sessionId"), "old");
  assert.equal(env.core.authed, false);
});

test("failed standalone login never leaves Basic credentials as the active token", async (context) => {
  const env = fixture(context);
  context.mock.method(globalThis, "fetch", async (_input: unknown, init?: RequestInit) => {
    return JSON.parse(String(init?.body)).logout ? json({ login: "", token: "" }) : json({}, 401);
  });
  await assert.rejects(env.auth.login("alice", "incorrect", true));
  assert.equal(cloudApi.isAuthed(), false);
  assert.equal(env.localStorage.getItem("sessionId"), null);
});

test("standalone login replaces a previous session-only token when Remember Me is selected", async (context) => {
  const env = fixture(context, "");
  env.sessionStorage.setItem("sessionId", "previous-user");
  context.mock.method(globalThis, "fetch", async (_input: unknown, init?: RequestInit) => {
    return json(JSON.parse(String(init?.body)).logout ? { login: "", token: "" } : session());
  });
  await env.auth.login("alice", "password", true);
  assert.equal(env.sessionStorage.getItem("sessionId"), null);
  assert.equal(env.localStorage.getItem("sessionId"), "token-alice");
  assert.equal(env.localStorage.getItem("sessionLogin"), "alice");
});
