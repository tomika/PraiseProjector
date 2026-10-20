import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { runInNewContext } from "node:vm";
import ts from "typescript";
import { CloudApiService, isCloudApiErrorKind } from "../../../../common/cloudApi";
import { getEmptyDisplay } from "../../../../common/pp-utils";
import type { Display } from "../../../../common/pp-types";
import type { NetworkState } from "../ClientApi";

const adapters = [
  { name: "DirectClientApi", path: "../direct/DirectClientApi.ts" },
  { name: "RestCore", path: "../rest/RestCore.ts" },
].map(({ name, path }) => ({
  name,
  code: ts.transpileModule(readFileSync(new URL(path, import.meta.url), "utf8"), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText,
}));

function fixture({ name, code }: (typeof adapters)[number]) {
  const api = new CloudApiService();
  const states: NetworkState[] = [];
  const displays: Display[] = [];
  const delays: { ms: number; resume: () => void }[] = [];
  const exports: Record<string, { prototype: object }> = {};
  runInNewContext(code, {
    exports,
    require: (id: string) => (id === "../../../../common/cloudApi" ? { cloudApi: api, isCloudApiErrorKind } : {}),
    AbortController,
    Error,
    setTimeout: (resume: () => void, ms: number) => delays.push({ ms, resume }),
  });
  // Keep the production follow loop and stopFollow; omit unrelated host startup.
  const adapter = Object.assign(Object.create(exports[name].prototype), {
    followToken: 0,
    followAbort: null,
    ppdWatching: false,
    ppdAccess: null,
    ppdSongCache: new Map(),
    display: getEmptyDisplay(),
    displaySource: { getCurrent: getEmptyDisplay, stopFollowing() {} },
    snapshotPlaylistBeforeFollow() {},
    resetChordProStyles() {},
    applyLeaderHeaders() {},
    async syncChordProStyles() {},
    setDisplay: (display: Display) => displays.push(display),
    relayFollowedDisplay: (display: Display) => displays.push(display),
    setNetworkState: (state: NetworkState) => states.push(state),
  }) as { startCloudFollow(leaderId: string, forced: boolean): void; stopFollow(): void };
  return { api, adapter, states, displays, delays };
}

const settle = () => new Promise<void>((resolve) => setImmediate(resolve));

for (const adapterType of adapters) {
  test(`${adapterType.name}: an auth reset resumes following without an error or backoff`, async (context) => {
    const { api, adapter, states, displays, delays } = fixture(adapterType);
    const requests: { signal: AbortSignal; respond: (response: Response) => void }[] = [];
    context.mock.method(globalThis, "fetch", (_input: string | URL | Request, init?: RequestInit) => {
      assert.ok(init?.signal);
      const signal = init.signal;
      return new Promise<Response>((respond, reject) => {
        requests.push({ signal, respond });
        signal.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")), { once: true });
      });
    });
    context.after(() => adapter.stopFollow());
    adapter.startCloudFollow("leader", true);
    requests[0].respond(new Response(JSON.stringify(getEmptyDisplay())));
    await settle();
    assert.equal(requests.length, 2);
    assert.equal(states.at(-1)?.status, "watching");

    api.resetSession();
    await settle();
    assert.equal(requests[1].signal.aborted, true);
    assert.equal(requests.length, 3);
    assert.deepEqual(
      states.map((state) => state.status),
      ["startup", "watching"]
    );
    assert.deepEqual(delays, []);

    requests[2].respond(new Response(JSON.stringify(getEmptyDisplay())));
    await settle();
    assert.equal(displays.length, 2);
    assert.equal(requests.length, 4);
    adapter.stopFollow();
    await settle();
    assert.equal(requests[3].signal.aborted, true);
    assert.equal(requests.length, 4);
    assert.equal(
      states.some((state) => state.status === "error"),
      false
    );
  });

  test(`${adapterType.name}: a network failure still reports an error and backs off`, async (context) => {
    const { adapter, states, delays } = fixture(adapterType);
    let requests = 0;
    context.mock.method(globalThis, "fetch", async () => {
      requests++;
      throw new TypeError("Failed to fetch");
    });
    context.after(() => adapter.stopFollow());
    adapter.startCloudFollow("leader", true);
    await settle();
    assert.equal(requests, 1);
    assert.equal(states.at(-1)?.status, "error");
    assert.equal(delays.length, 1);
    assert.equal(delays[0].ms, 2000);
    adapter.stopFollow();
    delays[0].resume();
    await settle();
    assert.equal(requests, 1);
  });
}
