/**
 * Tells the native host whether leaving the page would discard unsaved work.
 *
 * Android replaces the running document when the user opens a shared song or playlist link
 * from another app. Without a report the host has to assume the worst and confirm every
 * time, even with nothing at stake. The first call doubles as the capability handshake: a
 * bundle that never reports leaves the host's flag unset, so it keeps confirming exactly as
 * it did before — no version negotiation is needed.
 *
 * Page owners report their own state; individual editors register independent sources.
 * Reports are combined with OR, including editors embedded in the full view.
 */
export function createUnsavedChangesRegistry(report: (dirty: boolean) => void) {
  const sources = new Map<symbol, boolean>();
  let lastReported: boolean | undefined;
  const publish = () => {
    const dirty = [...sources.values()].some(Boolean);
    if (dirty === lastReported) return;
    lastReported = dirty;
    report(dirty);
  };
  return {
    set(source: symbol, dirty: boolean) {
      sources.set(source, dirty);
      publish();
    },
    remove(source: symbol) {
      if (sources.delete(source)) publish();
    },
    /** The combined state, for in-page navigation that has to ask first. */
    has(): boolean {
      return [...sources.values()].some(Boolean);
    },
  };
}

export const unsavedChangesRegistry = createUnsavedChangesRegistry((dirty) => {
  if (typeof window === "undefined") return;
  try {
    const result = window.hostDevice?.setUnsavedChanges?.(dirty);
    void Promise.resolve(result).catch(() => undefined);
  } catch {
    // An optional bridge failure must not interrupt editing.
  }
});

const pageSource = Symbol("page");

/** The page's own state is combined with every mounted editor's report. */
export function reportUnsavedChanges(hasUnsavedChanges: boolean): void {
  unsavedChangesRegistry.set(pageSource, hasUnsavedChanges);
}

/** Whether anything on this page would lose a draft if the document went away.
 *  The native host learns this through the report above; in-page code that
 *  navigates the document itself (the client view's home button) asks here. */
export function hasUnsavedChanges(): boolean {
  return unsavedChangesRegistry.has();
}
