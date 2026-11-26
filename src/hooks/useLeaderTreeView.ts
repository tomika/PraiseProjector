import { useCallback, useEffect, useState } from "react";
import { readPersistedSettings, watchPersistedBoolean, writePersistedSettings } from "../services/settingsStore";

/**
 * The leader pickers' group-tree switch (`leaderTreeView` in pp-settings). Both
 * frontends use it — the full view's load dialog and the client view, which may
 * run without a SettingsContext — so it reads and writes the settings store
 * directly; SettingsContext re-reads the key, and every picker follows a change
 * made in another one. Restored from the settings on start.
 */
export function useLeaderTreeView(): [boolean, (next: boolean) => void] {
  const [enabled, setEnabled] = useState(() => readPersistedSettings().leaderTreeView === true);
  useEffect(() => watchPersistedBoolean("leaderTreeView", setEnabled), []);
  const update = useCallback((next: boolean) => {
    setEnabled(next);
    writePersistedSettings({ leaderTreeView: next });
  }, []);
  return [enabled, update];
}
