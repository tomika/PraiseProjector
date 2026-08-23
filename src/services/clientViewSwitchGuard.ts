type ClientViewSwitchGuard = (signal?: AbortSignal) => boolean | Promise<boolean>;

let activeGuard: ClientViewSwitchGuard | null = null;

export function registerClientViewSwitchGuard(guard: ClientViewSwitchGuard): () => void {
  activeGuard = guard;
  return () => {
    if (activeGuard === guard) activeGuard = null;
  };
}

export function requestClientViewSwitch(signal?: AbortSignal): Promise<boolean> {
  if (!activeGuard) return Promise.resolve(true);

  return Promise.resolve()
    .then(() => activeGuard?.(signal) ?? true)
    .catch((error) => {
      console.error("ClientView", "Client-view switch guard failed", error);
      return true;
    });
}
