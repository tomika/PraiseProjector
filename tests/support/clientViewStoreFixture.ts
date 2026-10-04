/**
 * Builds a real {@link ClientViewStore} over the fake backend port and a fake
 * window, initialized through the production `init` path.
 */
import { ClientViewStore } from "../../src/client-view/controller/ClientViewStore";
import type { ClientConfig } from "../../src/client-view/api/ClientApi";
import { installFakeWindow, type FakeWindowOptions } from "./browserEnv";
import { createFakeClientApi, type FakeClientApiOptions } from "./fakeClientApi";

export interface StoreFixtureOptions extends FakeClientApiOptions {
  window?: FakeWindowOptions;
  config?: ClientConfig;
  /** Extra `pp-settings` keys; session auto-scan is off unless overridden. */
  settings?: Record<string, unknown>;
}

export const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

export async function createStoreFixture(options: StoreFixtureOptions = {}) {
  const settings = { clientViewAutoScanSessions: "off", ...options.settings };
  const env = installFakeWindow({
    ...options.window,
    storage: { "pp-settings": JSON.stringify(settings), ...options.window?.storage },
  });
  const fake = createFakeClientApi(options);
  const store = new ClientViewStore(fake.api);
  await store.init({ entryMode: "standalone", ...options.config });
  await tick();
  return {
    store,
    fake,
    env,
    state: () => store.getSnapshot(),
    dispose: () => {
      store.dispose();
      env.restore();
    },
  };
}
