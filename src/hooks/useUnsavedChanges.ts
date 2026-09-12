import { useLayoutEffect, useState } from "react";
import { unsavedChangesRegistry } from "../services/unsavedChangesReport";

/** Protect a draft until it is saved/discarded or its owning editor unmounts. */
export function useUnsavedChanges(dirty: boolean): void {
  const [source] = useState(() => Symbol("editor"));
  useLayoutEffect(() => {
    unsavedChangesRegistry.set(source, dirty);
  }, [source, dirty]);
  // Cleanup is only for unmount, not for each change to the dirty flag.
  useLayoutEffect(() => () => unsavedChangesRegistry.remove(source), [source]);
}
