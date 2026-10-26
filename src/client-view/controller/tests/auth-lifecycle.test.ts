import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import { installFakeWindow } from "../../../../tests/support/browserEnv";
import { createFakeClientApi } from "../../../../tests/support/fakeClientApi";
import { ClientViewStore } from "../ClientViewStore";

function fixture(context: TestContext) {
  const env = installFakeWindow({ storage: { "pp-settings": JSON.stringify({ clientViewAutoScanSessions: "off" }) } });
  const fake = createFakeClientApi();
  const store = new ClientViewStore(fake.api);
  context.after(() => {
    store.dispose();
    env.restore();
  });
  return { store, api: fake.api };
}

test("embedded view switches preserve the host session without reauthenticating", async (context) => {
  const { store, api } = fixture(context);
  let authed = true;
  let notifyAuth: (value: boolean) => void = () => {};
  api.auth.isAuthed = () => authed;
  api.auth.subscribeAuth = (callback) => {
    notifyAuth = callback;
    return () => {};
  };
  // A redundant restore used to clear the host's in-memory authentication on
  // network failure, making a simple view switch appear to sign the user out.
  const restore = context.mock.method(api.auth, "restoreSession", async () => {
    authed = false;
    notifyAuth(false);
    throw new TypeError("Failed to fetch");
  });

  for (let entry = 0; entry < 2; entry++) {
    await store.init({ entryMode: "embedded" });
    assert.equal(store.getSnapshot().ready, true);
    assert.equal(store.getSnapshot().authed, true);
    store.dispose();
  }
  assert.equal(restore.mock.callCount(), 0);

  await store.init({ entryMode: "embedded" });
  notifyAuth(false);
  assert.equal(store.getSnapshot().authed, false, "explicit host logout still reaches the client view");
});

test("standalone entry waits for its own session restore before becoming ready", async (context) => {
  const { store, api } = fixture(context);
  let completeRestore!: () => void;
  const pending = new Promise<void>((resolve) => {
    completeRestore = resolve;
  });
  let authed = false;
  api.auth.isAuthed = () => authed;
  const restore = context.mock.method(api.auth, "restoreSession", async () => {
    await pending;
    authed = true;
  });

  const initializing = store.init({ entryMode: "standalone" });
  await Promise.resolve();
  assert.equal(restore.mock.callCount(), 1);
  assert.equal(store.getSnapshot().ready, false);
  completeRestore();
  await initializing;
  assert.equal(store.getSnapshot().ready, true);
  assert.equal(store.getSnapshot().authed, true);
});
