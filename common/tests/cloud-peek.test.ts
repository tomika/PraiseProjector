import assert from "node:assert/strict";
import { test } from "node:test";
import { CloudApiService, isCloudApiErrorKind } from "../cloudApi";

function response(pendingSongCount: number) {
  return new Response(JSON.stringify({ dbVersion: 42, pendingSongCount }), {
    headers: { "Content-Type": "application/json" },
  });
}

function accessToken(login: string, expiresIn: number) {
  const payload = Buffer.from(JSON.stringify({ sub: login, exp: Math.floor(Date.now() / 1000) + expiresIn })).toString("base64url");
  return `atk.${payload}.test`;
}

test("renewing an access token preserves cached counts only for the same user", async (context) => {
  const api = new CloudApiService();
  let calls = 0;
  context.mock.method(globalThis, "fetch", async () => response(++calls));
  api.setToken(accessToken("admin", 900));
  assert.equal((await api.fetchPeek(true)).pendingSongCount, 1);
  api.setToken(accessToken("admin", 1800));
  assert.equal((await api.fetchPeek(true)).pendingSongCount, 1);
  assert.equal(calls, 1);
  api.setToken(accessToken("another-user", 1800));
  assert.equal((await api.fetchPeek(true)).pendingSongCount, 2);
  api.setToken(null);
  assert.equal((await api.fetchPeek(true)).pendingSongCount, 3);
});

test("a peek that renews its token stays deduplicated and caches its result", async (context) => {
  const api = new CloudApiService();
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, "window");
  Object.defineProperty(globalThis, "window", { configurable: true, value: new EventTarget() });
  context.after(() => {
    if (descriptor) Object.defineProperty(globalThis, "window", descriptor);
    else Reflect.deleteProperty(globalThis, "window");
  });
  const paths: string[] = [];
  context.mock.method(globalThis, "fetch", async (input: string | URL | Request) => {
    const path = String(input);
    paths.push(path);
    if (path === "/session") {
      return new Response(JSON.stringify({ login: "admin", token: accessToken("admin", 900), leaderId: "leader" }));
    }
    return response(4);
  });
  api.setClientId("device");
  api.setToken(accessToken("admin", 60));
  const results = await Promise.all([api.fetchPeek(true), api.fetchPeek(true)]);
  assert.equal(results[0].pendingSongCount, 4);
  assert.equal(results[1].pendingSongCount, 4);
  assert.equal((await api.fetchPeek(true)).pendingSongCount, 4);
  assert.deepEqual(paths, ["/session", "/peek?version=2"]);
});

test("a token change discards cached anonymous pending counts", async (context) => {
  const api = new CloudApiService();
  let calls = 0;
  context.mock.method(globalThis, "fetch", async () => response(++calls === 1 ? 0 : 3));

  assert.equal((await api.fetchPeek(true)).pendingSongCount, 0);
  api.setToken("test-token");
  assert.equal((await api.fetchPeek(true)).pendingSongCount, 3);
  assert.equal((await api.fetchPeek(true)).pendingSongCount, 3);
  assert.equal(calls, 2);
});

test("an invalidated in-flight peek cannot repopulate the cache or detach a fresh request", async (context) => {
  const api = new CloudApiService();
  const pending: ((value: Response) => void)[] = [];
  context.mock.method(globalThis, "fetch", () => new Promise<Response>((resolve) => pending.push(resolve)));

  const anonymous = api.fetchPeek(true);
  // Browser sessions use cookies, so force invalidation must also work without
  // changing the in-memory bearer token.
  api.invalidatePeekCache();
  const authenticated = api.fetchPeek(true);
  assert.equal(pending.length, 2);

  pending[0](response(0));
  await anonymous;
  const concurrent = api.fetchPeek(true);
  assert.equal(pending.length, 2);
  pending[1](response(5));
  assert.equal((await authenticated).pendingSongCount, 5);
  assert.equal((await concurrent).pendingSongCount, 5);
  assert.equal((await api.fetchPeek(true)).pendingSongCount, 5);
  assert.equal(pending.length, 2);
});

test("a late anonymous response cannot overwrite an authenticated cache entry", async (context) => {
  const api = new CloudApiService();
  const pending: ((value: Response) => void)[] = [];
  context.mock.method(globalThis, "fetch", () => new Promise<Response>((resolve) => pending.push(resolve)));

  const anonymous = api.fetchPeek(true);
  api.setToken("test-token");
  const authenticated = api.fetchPeek(true);
  pending[1](response(7));
  await authenticated;
  pending[0](response(0));
  await assert.rejects(anonymous, (error) => isCloudApiErrorKind(error, "aborted"));
  assert.equal((await api.fetchPeek(true)).pendingSongCount, 7);
  assert.equal(pending.length, 2);
});
