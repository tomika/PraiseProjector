import { createContext, type Context } from "react";

/**
 * `createContext` that keeps the context object across Vite hot reloads of the
 * calling module. Re-running a context module would otherwise create a new
 * context that the still-mounted provider does not feed, so every refreshed
 * consumer would read the default value (or throw "must be used within ...").
 *
 * `hot` is the caller's own `import.meta.hot` (its `data` survives reloads of
 * that module). Production builds have no `import.meta.hot`: there this is
 * exactly `createContext(defaultValue)`.
 */
export function hotStableContext<T>(hot: { readonly data: Record<string, unknown> } | undefined, key: string, defaultValue: T): Context<T> {
  if (!hot) return createContext(defaultValue);
  const context = (hot.data[key] as Context<T> | undefined) ?? createContext(defaultValue);
  hot.data[key] = context;
  return context;
}
