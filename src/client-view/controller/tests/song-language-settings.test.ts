import assert from "node:assert/strict";
import { test } from "node:test";
import { installFakeWindow } from "../../../../tests/support/browserEnv";
import { createFakeClientApi } from "../../../../tests/support/fakeClientApi";
import { ClientViewStore } from "../ClientViewStore";

for (const storageScope of ["local", "remote"] as const) {
  test(`language preferences refresh only the local catalogue (${storageScope})`, async (context) => {
    const env = installFakeWindow({ storage: { "pp-settings": JSON.stringify({ clientViewAutoScanSessions: "off", songLanguageFilter: ["hu"] }) } });
    const fake = createFakeClientApi();
    Object.assign(fake.api, { storageScope });
    const load = context.mock.method(fake.api.song, "listAllSongs", async () => []);
    const store = new ClientViewStore(fake.api);
    context.after(() => {
      store.dispose();
      env.restore();
    });
    await store.init({ entryMode: "embedded" });
    const initialCalls = load.mock.callCount();
    env.window.localStorage.setItem("pp-settings", JSON.stringify({ songLanguageFilter: ["en"] }));
    env.window.dispatchEvent(new CustomEvent("pp-settings-changed"));
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(load.mock.callCount() - initialCalls, storageScope === "local" ? 1 : 0);
  });
}
