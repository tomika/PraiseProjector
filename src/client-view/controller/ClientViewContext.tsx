/**
 * React binding for the Layer-2 {@link ClientViewStore}.
 *
 * The store is created and initialised at the bootstrap entry point (where the
 * ClientApi adapter is chosen), then handed to this provider. UI components read
 * reactive state with {@link useClientViewState} and dispatch actions through the
 * store returned by {@link useClientViewStore}.
 */

import { createContext, useContext, useSyncExternalStore } from "react";
import type { ReactNode } from "react";
import { ClientViewStore, type ClientViewState } from "./ClientViewStore";

const ClientViewContext = createContext<ClientViewStore | null>(null);

export function ClientViewProvider({ store, children }: { store: ClientViewStore; children: ReactNode }) {
  return <ClientViewContext.Provider value={store}>{children}</ClientViewContext.Provider>;
}

export function useClientViewStore(): ClientViewStore {
  const store = useContext(ClientViewContext);
  if (!store) throw new Error("useClientViewStore must be used within a ClientViewProvider");
  return store;
}

export function useClientViewState(): ClientViewState {
  const store = useClientViewStore();
  return useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot);
}
