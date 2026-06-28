/**
 * Bootstrap for the client view.
 *
 * This is the ONE place that chooses a ClientApi adapter — here, the canonical
 * RestClientApi. A future Direct (in-process) adapter for the Electron desktop
 * window would be selected here too, without touching the UI or controller.
 */

import { createRoot } from "react-dom/client";
import { RestClientApi } from "../api/rest/RestClientApi";
import type { ClientConfig } from "../api/ClientApi";
import { ClientViewStore } from "../controller/ClientViewStore";
import { ClientViewProvider } from "../controller/ClientViewContext";
import { ClientView } from "../ui/ClientView";
import { cloudApiBaseUrl } from "../../config";
import { setMidiSoundfontUrl } from "../../../chordpro/midi";

export async function mountClientView(rootEl: HTMLElement, config: ClientConfig = {}): Promise<ClientViewStore> {
  const api = new RestClientApi();
  const store = new ClientViewStore(api);
  // Resolve MIDI soundfonts through the same legacy asset base as icon() (assets.ts):
  // the soundfont files live at <assetBase>/soundfont/ (upstream /app/soundfont/), NOT under
  // the hashed client-view bundle. When served by a host webserver (__ppAssetBase="") this
  // becomes /soundfont/, which the host maps back to /app/soundfont/ for offline playback.
  const assetBase = (typeof window !== "undefined" ? window.__ppAssetBase : undefined) ?? "/app";
  setMidiSoundfontUrl(`${assetBase}/soundfont/`);
  // When served by the Electron webserver the entry HTML sets __ppApiBase to the
  // serving origin (root). Otherwise use the base resolved in src/config.ts (the
  // Vite proxy target in dev). Callers may still override via config.
  const baseUrl = window.__ppApiBase || cloudApiBaseUrl;
  // A served mount (the entry HTML sets __ppApiBase to the webserver origin) is a
  // follower by default: auto-follow the desktop leader's current projection. It
  // is also host-gated (servedByHost), which drives the capability model — see
  // RestCore.computeCapabilities. Absent __ppApiBase ⇒ cloud-backed client.
  const served = !!window.__ppApiBase;
  // The webserver injects the host-granted access level as window.__ppAccess so
  // a GUEST viewer's UI is correctly view-only (see RestCore.computeCapabilities).
  await store.init({
    baseUrl,
    follow: served,
    servedByHost: served,
    hostAccess: window.__ppAccess,
    fullEditorUrl: window.__ppEditorUrl,
    ...config,
  });

  createRoot(rootEl).render(
    <ClientViewProvider store={store}>
      <ClientView />
    </ClientViewProvider>
  );

  window.hostDevice?.pageLoadedSuccessfully?.();

  return store;
}
