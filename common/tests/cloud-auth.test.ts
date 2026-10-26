import assert from "node:assert/strict";
import { test } from "node:test";
import { CloudApiService, isCloudApiErrorKind } from "../cloudApi";
import { installFakeWindow } from "../../tests/support/browserEnv";
import { getEmptyDisplay } from "../pp-utils";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: Error) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

function token(user: string, seconds = 900) {
  return `atk.${Buffer.from(JSON.stringify({ sub: user, exp: Math.floor(Date.now() / 1000) + seconds })).toString("base64url")}.test`;
}

const json = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status });
const session = (user = "alice") => ({ login: user, token: token(user), leaderId: "leader" });

for (const failure of ["network", "timeout", 500, 429, 503] as const) {
  test(`proactive refresh ${failure} failure allows parallel requests to use their current token`, async (context) => {
    const api = new CloudApiService();
    api.setClientId("device");
    const currentToken = token("alice", 60);
    api.setToken(currentToken);
    const authorizations: (string | null)[] = [];
    context.mock.method(globalThis, "fetch", async (input: string | URL | Request, init?: RequestInit) => {
      if (String(input) === "/session") {
        if (failure === "network") throw new TypeError("Failed to fetch");
        if (failure === "timeout") {
          return new Promise<Response>((_resolve, reject) => {
            init!.signal!.addEventListener("abort", () => reject(new DOMException("The operation was aborted", "AbortError")), { once: true });
          });
        }
        return new Response("{}", { status: failure, headers: { "Retry-After": "0" } });
      }
      authorizations.push(new Headers(init?.headers).get("Authorization"));
      return json([]);
    });
    const results = await Promise.all([api.fetchSongHistory("a"), api.fetchSongHistory("b")]);
    assert.deepEqual(results, [[], []]);
    assert.deepEqual(authorizations, [`Bearer ${currentToken}`, `Bearer ${currentToken}`]);
    assert.equal(api.getAuthorizationHeader(), currentToken);
  });
}

test("parallel expiring requests share refresh without exposing a temporary logout", async (context) => {
  const api = new CloudApiService();
  api.setClientId("device");
  const oldToken = token("alice", 60);
  api.setToken(oldToken);
  const refresh = deferred<Response>();
  const requests: { path: string; authorization: string | null }[] = [];
  context.mock.method(globalThis, "fetch", async (input: string | URL | Request, init?: RequestInit) => {
    const path = String(input);
    requests.push({ path, authorization: new Headers(init?.headers).get("Authorization") });
    return path === "/session" ? refresh.promise : json([]);
  });
  const a = api.fetchSongHistory("a");
  const b = api.fetchSongHistory("b");
  assert.equal(api.getAuthorizationHeader(), oldToken);
  assert.equal(requests.length, 1);
  assert.equal(requests[0].authorization, "");
  refresh.resolve(json(session()));
  await Promise.all([a, b]);
  assert.equal(requests.filter((r) => r.path === "/session").length, 1);
  assert.ok(requests.slice(1).every((r) => r.authorization === `Bearer ${session().token}`));
});

for (const fail of [false, true]) {
  test(`a late refresh ${fail ? "failure" : "success"} cannot overwrite a new login`, async (context) => {
    const env = installFakeWindow();
    context.after(env.restore);
    const api = new CloudApiService();
    api.setClientId("device");
    api.setToken(token("alice", 60));
    const refresh = deferred<Response>();
    context.mock.method(globalThis, "fetch", () => refresh.promise);
    const oldRequest = assert.rejects(api.fetchSongHistory("a"), (error) => isCloudApiErrorKind(error, "aborted"));
    api.resetSession();
    api.setToken(token("bob"));
    if (fail) refresh.reject(new TypeError("Failed to fetch"));
    else refresh.resolve(json(session()));
    await oldRequest;
    assert.equal(api.getAuthorizationHeader(), token("bob"));
    assert.equal(env.window.events.includes("pp-tokens-refreshed"), false);
  });
}

for (const proxy of [false, true]) {
  test(`${proxy ? "proxy" : "browser"}: a late 401 cannot clear or retry as the new user`, async (context) => {
    const api = new CloudApiService();
    api.setClientId("device");
    api.setToken(token("alice"));
    const pending = deferred<void>();
    let calls = 0;
    if (proxy) {
      api.setProxy({
        proxyGet: async () => {
          calls++;
          await pending.promise;
          return { error: { status: 401, message: "Unauthorized" } };
        },
        proxyPost: async () => {
          calls++;
          return { data: session(), ppHeaders: {} };
        },
      });
    } else {
      context.mock.method(globalThis, "fetch", async () => {
        calls++;
        await pending.promise;
        return json({}, 401);
      });
    }
    const oldRequest = assert.rejects(api.fetchSongHistory("a"), (error) => isCloudApiErrorKind(error, "aborted"));
    api.resetSession();
    api.setToken(token("bob"));
    pending.resolve();
    await oldRequest;
    assert.equal(calls, 1);
    assert.equal(api.getAuthorizationHeader(), token("bob"));
  });
}

test("a network failure during refresh remains a network error and preserves the token", async (context) => {
  const api = new CloudApiService();
  api.setClientId("device");
  const original = token("alice");
  api.setToken(original);
  context.mock.method(globalThis, "fetch", async (input: string | URL | Request) => {
    if (String(input) === "/session") throw new TypeError("Failed to fetch");
    return json({}, 401);
  });
  await assert.rejects(api.fetchSongHistory("a"), (error) => isCloudApiErrorKind(error, "network"));
  assert.equal(api.getAuthorizationHeader(), original);
});

test("cookie refresh keeps cookie authentication and publishes the verified identity", async (context) => {
  const env = installFakeWindow();
  context.after(env.restore);
  const api = new CloudApiService();
  api.setClientId("device");
  api.setFixedHeader("X-PP-Expected-User", "alice");
  let refreshed = false;
  const events: unknown[] = [];
  env.window.addEventListener("pp-tokens-refreshed", (e) => events.push((e as CustomEvent).detail));
  context.mock.method(globalThis, "fetch", async (input: string | URL | Request, init?: RequestInit) => {
    assert.ok(!new Headers(init?.headers).get("Authorization"));
    if (String(input) === "/session") {
      refreshed = true;
      return json(session());
    }
    return refreshed ? json([]) : json({}, 401);
  });
  await api.fetchSongHistory("a");
  assert.equal(api.getAuthorizationHeader(), "");
  assert.deepEqual(events, [{ accessToken: session().token, login: "alice" }]);
});

test("logout never refreshes an expiring token", async (context) => {
  const api = new CloudApiService();
  api.setClientId("device");
  api.setToken(token("alice", 60));
  const bodies: unknown[] = [];
  context.mock.method(globalThis, "fetch", async (_input: unknown, init?: RequestInit) => {
    bodies.push(JSON.parse(String(init?.body)));
    return json({ login: "", token: "" });
  });
  await api.logoutSession("device");
  assert.deepEqual(bodies, [{ clientId: "device", logout: true }]);
});

test("explicit login credentials stay scoped to the session request", async (context) => {
  const api = new CloudApiService();
  const pending = deferred<Response>();
  const headers: (string | null)[] = [];
  context.mock.method(globalThis, "fetch", async (input: string | URL | Request, init?: RequestInit) => {
    headers.push(new Headers(init?.headers).get("Authorization"));
    return String(input) === "/session" ? pending.promise : json([]);
  });
  const login = api.fetchSession("device", { skipRefresh: true, authToken: "Basic credentials" });
  await api.fetchSongHistory("a");
  assert.equal(api.getAuthorizationHeader(), "");
  pending.resolve(json(session()));
  await login;
  assert.deepEqual(headers, ["Basic credentials", null]);
});

for (const proxy of [false, true]) {
  for (const seconds of [900, -900]) {
    test(`${proxy ? "Electron" : "browser"}: restoring ${seconds > 0 ? "valid" : "expired"} access tokens renews with cookies`, async (context) => {
      const api = new CloudApiService();
      const storedToken = token("alice", seconds);
      api.setToken(storedToken);
      api.setFixedHeader("X-PP-Expected-User", "alice");
      const authorizations: string[] = [];
      if (proxy) {
        api.setProxy({
          proxyGet: async () => assert.fail("Restore must use POST /session"),
          proxyPost: async (_base, endpoint, _data, headers, options) => {
            assert.equal(endpoint, "/session");
            assert.equal(options?.omitCookies, false);
            authorizations.push(headers?.Authorization || "");
            return { data: session(), ppHeaders: {} };
          },
        });
      } else {
        context.mock.method(globalThis, "fetch", async (_url: unknown, init?: RequestInit) => {
          assert.equal(init?.credentials, "include");
          authorizations.push(new Headers(init?.headers).get("Authorization") || "");
          return json(session());
        });
      }
      for (const authToken of [undefined, storedToken, `Bearer ${storedToken}`]) {
        const result = await api.fetchSession("device", { authToken });
        assert.equal(result.login, "alice");
      }
      assert.deepEqual(authorizations, ["", "", ""], "An access-only Authorization header suppresses Electron's refresh cookie");
    });
  }
}

test("aborting one caller leaves the shared refresh available to another caller", async (context) => {
  const api = new CloudApiService();
  api.setClientId("device");
  api.setToken(token("alice", 60));
  const pending = deferred<Response>();
  context.mock.method(globalThis, "fetch", async (input: string | URL | Request) => (String(input) === "/session" ? pending.promise : json([])));
  const controller = new AbortController();
  const cancelled = assert.rejects(api.fetchDisplayStylesQuery({ signal: controller.signal }), (error) => isCloudApiErrorKind(error, "aborted"));
  const survivor = api.fetchSongHistory("b");
  controller.abort();
  await cancelled;
  pending.resolve(json(session()));
  await survivor;
  assert.equal(api.getAuthorizationHeader(), session().token);
});

test("display long-poll renews expired auth while preserving projection headers", async (context) => {
  const api = new CloudApiService();
  api.setClientId("device");
  api.setToken(token("alice", 60));
  const display = getEmptyDisplay();
  const paths: string[] = [];
  context.mock.method(globalThis, "fetch", async (input: string | URL | Request) => {
    const path = String(input);
    paths.push(path);
    return path === "/session" ? json(session()) : new Response(JSON.stringify(display), { headers: { "X-PP-Access": "GRANTED" } });
  });
  const result = await api.fetchDisplayQuery(display);
  assert.equal(paths[0], "/session");
  assert.ok(paths[1].startsWith("/display_query"));
  assert.deepEqual(result.display, display);
  assert.equal(result.ppHeaders.access, "GRANTED");
});

test("offline logout survives a page restart and prevents cookies, bearer auth and refresh", async (context) => {
  const env = installFakeWindow();
  context.after(env.restore);
  const api = new CloudApiService();
  api.setToken(token("alice"));
  context.mock.method(globalThis, "fetch", async () => {
    throw new TypeError("Failed to fetch");
  });
  await assert.rejects(api.logoutSession("device", { clearCookiesAfterSnapshot: true }));
  const restarted = new CloudApiService();
  restarted.setClientId("device");
  restarted.setToken(token("alice")); // Even another tab's stale in-memory token is suppressed.
  const requests: { url: string; init?: RequestInit }[] = [];
  context.mock.method(globalThis, "fetch", async (url: string | URL | Request, init?: RequestInit) => {
    requests.push({ url: String(url), init });
    return json({}, 401);
  });
  await assert.rejects(restarted.fetchSongHistory("a"), (error) => isCloudApiErrorKind(error, "auth"));
  await assert.rejects(restarted.fetchSession("device"), (error) => isCloudApiErrorKind(error, "auth"));
  assert.equal(restarted.isAuthed(), false);
  assert.equal(requests.length, 1);
  assert.equal(requests[0].init?.credentials, "omit");
  assert.equal(new Headers(requests[0].init?.headers).get("Authorization"), null);
});

test("only a successful explicit login re-enables a signed-out session", async (context) => {
  const env = installFakeWindow();
  context.after(env.restore);
  const api = new CloudApiService();
  api.setSessionEnabled(false);
  let success = false;
  context.mock.method(globalThis, "fetch", async () => (success ? json(session("bob")) : json({}, 401)));
  await assert.rejects(api.fetchSession("device", { authToken: "Basic wrong" }));
  assert.equal(api.isSessionEnabled(), false);
  success = true;
  await api.fetchSession("device", { authToken: "Basic correct" });
  assert.equal(api.isSessionEnabled(), true);
  assert.equal(new CloudApiService().isSessionEnabled(), true);
});

test("logout passes the native cookie-clear extension and still sends the revocation cookie", async (context) => {
  const api = new CloudApiService();
  context.mock.method(globalThis, "fetch", async (_url: unknown, init?: RequestInit & { ppClearSessionCookies?: boolean }) => {
    assert.equal(init?.ppClearSessionCookies, true);
    assert.equal(init?.credentials, "include");
    assert.equal(new Headers(init?.headers).get("Authorization"), "");
    return json({ login: "", token: "" });
  });
  await api.logoutSession("device", { clearCookiesAfterSnapshot: true });
});

test("legacy text POSTs also suppress cookies after logout", async (context) => {
  const api = new CloudApiService();
  api.setSessionEnabled(false);
  context.mock.method(globalThis, "fetch", async (_url: unknown, init?: RequestInit) => {
    assert.equal(init?.credentials, "omit");
    assert.equal(init?.body, JSON.stringify({ id: "song" }));
    return new Response("DONE");
  });
  assert.equal(await api.sendPost("/display_update", { id: "song" }), "DONE");
});

test("blocked storage writes cannot re-enable a locally signed-out session", (context) => {
  const env = installFakeWindow({ failWrites: true });
  context.after(env.restore);
  const api = new CloudApiService();
  api.setSessionEnabled(false);
  assert.equal(api.isSessionEnabled(), false);
});
