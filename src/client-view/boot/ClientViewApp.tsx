/**
 * ClientViewApp — the client view as an embeddable React component, for hosting
 * inside the Electron desktop renderer (the "switch to new client UI" flow).
 *
 * It owns the adapter + store lifecycle (the standalone entry uses
 * mountClientView instead). `onHome` lets the host switch back to the main UI.
 */

import { useEffect, useState } from "react";
import { DirectClientApi } from "../api/direct/DirectClientApi";
import { ClientViewStore } from "../controller/ClientViewStore";
import { ClientViewProvider } from "../controller/ClientViewContext";
import { ClientView } from "../ui/ClientView";
import type { ClientConfig } from "../api/ClientApi";
import "../ui/client-view.css";

export function ClientViewApp({ config, onHome }: { config?: ClientConfig; onHome?: () => void }) {
  // In-process adapter: the embedded view shares the host app's live state
  // (CurrentSongStore + Database) rather than talking to the cloud.
  const [store] = useState(() => new ClientViewStore(new DirectClientApi()));
  const [ready, setReady] = useState(false);

  useEffect(() => {
    let active = true;
    void store.init(config ?? {}).finally(() => {
      if (active) setReady(true);
    });
    return () => {
      active = false;
      store.dispose();
    };
  }, [store, config]);

  if (!ready) {
    return <div className="cv-loading">Loading…</div>;
  }

  return (
    <ClientViewProvider store={store}>
      <ClientView onHome={onHome} />
    </ClientViewProvider>
  );
}
