/**
 * ClientViewApp — the client view as an embeddable React component, for hosting
 * inside the Electron desktop renderer (the "switch to new client UI" flow).
 *
 * It owns the adapter + store lifecycle (the standalone entry uses
 * mountClientView instead). `onHome` lets the host switch back to the main UI.
 */

import { useEffect, useRef, useState } from "react";
import { DirectClientApi, type DirectAuthBridge } from "../api/direct/DirectClientApi";
import { ClientViewStore } from "../controller/ClientViewStore";
import { ClientViewProvider } from "../controller/ClientViewContext";
import { ClientView } from "../ui/ClientView";
import type { ClientConfig } from "../api/ClientApi";
import { useAuth } from "../../contexts/AuthContext";
import "../ui/client-view.css";

export function ClientViewApp({ config, onHome }: { config?: ClientConfig; onHome?: () => void }) {
  const auth = useAuth();
  const { isAuthenticated, login, commitSession, logout, restoreStoredSession } = auth;
  const [api] = useState(() => new DirectClientApi());
  const [store] = useState(() => new ClientViewStore(api));
  const [ready, setReady] = useState(false);
  const readyRef = useRef(false);

  useEffect(() => {
    const bridge: DirectAuthBridge = {
      isAuthed: () => isAuthenticated,
      login: async (user, password, keepLoggedIn) => {
        const success = await login(user, password);
        if (!success) throw new Error("Sign in failed");
        if (keepLoggedIn) {
          commitSession();
          await window.electronAPI?.persistCookies?.();
        } else {
          await window.electronAPI?.clearPersistedCookies?.();
        }
      },
      logout: async () => {
        await logout();
      },
      restoreSession: async () => {
        await restoreStoredSession();
      },
    };
    api.setAuthBridge(bridge);
  }, [api, isAuthenticated, login, commitSession, logout, restoreStoredSession]);

  // In-process adapter: the embedded view shares the host app's live state
  // (CurrentSongStore + Database) rather than talking to the cloud.

  useEffect(() => {
    let active = true;
    void store.init({ entryMode: "embedded", ...config }).finally(() => {
      if (active) {
        readyRef.current = true;
        setReady(true);
      }
    });
    return () => {
      active = false;
      if (readyRef.current) store.syncHostSelectionToFullView();
      readyRef.current = false;
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
