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
  const authRef = useRef(auth);
  authRef.current = auth;
  const [api] = useState(() => {
    const bridge: DirectAuthBridge = {
      isAuthed: () => authRef.current.isAuthenticated,
      login: async (user, password, keepLoggedIn) => {
        const success = await authRef.current.login(user, password);
        if (!success) throw new Error("Sign in failed");
        if (keepLoggedIn) {
          authRef.current.commitSession();
          await window.electronAPI?.persistCookies?.();
        } else {
          await window.electronAPI?.clearPersistedCookies?.();
        }
      },
      logout: async () => {
        await authRef.current.logout();
      },
      restoreSession: async () => {
        await authRef.current.restoreStoredSession();
      },
    };
    return new DirectClientApi(bridge);
  });
  // In-process adapter: the embedded view shares the host app's live state
  // (CurrentSongStore + Database) rather than talking to the cloud.
  const [store] = useState(() => new ClientViewStore(api));
  const [ready, setReady] = useState(false);

  useEffect(() => {
    api.refreshAuthState();
  }, [api, auth.isAuthenticated, auth.user?.login, auth.username]);

  useEffect(() => {
    let active = true;
    void store.init({ entryMode: "embedded", ...config }).finally(() => {
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
