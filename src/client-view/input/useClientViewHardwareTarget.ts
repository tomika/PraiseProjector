import { useEffect, useState } from "react";
import type { ClientCommand, HardwareActionRow } from "../../../common/hardware-input";
import { useHardwareTarget } from "../../hardware-input/useHardwareTarget";
import type { ClientViewStore } from "../controller/ClientViewStore";
import { decideClientRow, executeClientRow } from "./clientViewCommands";

export interface ClientHardwareFeedback {
  command: ClientCommand;
  /** What the command reported (e.g. the shown song's title); otherwise the view reads the state. */
  value?: string | number | boolean;
}

/** Registers the mounted client view as the `client-view` hardware target. */
export function useClientViewHardwareTarget(store: ClientViewStore, navigateSong: (next: boolean) => void): ClientHardwareFeedback | null {
  const [feedback, setFeedback] = useState<ClientHardwareFeedback | null>(null);
  useEffect(() => {
    if (!feedback) return;
    const timer = setTimeout(() => setFeedback(null), 2000);
    return () => clearTimeout(timer);
  }, [feedback]);
  useHardwareTarget("client-view", {
    canHandle: (row, source) => decideClientRow(store.getSnapshot(), row as HardwareActionRow<ClientCommand>, source),
    execute: async (row, context) => {
      const result = await executeClientRow({ store, navigateSong }, row as HardwareActionRow<ClientCommand>, context);
      if (!context.isCurrent()) return;
      if (result === true) setFeedback({ command: row.command as ClientCommand });
      // A preselection command reports its own value (see ClientViewStore.executePreselectionCommand).
      else if (result && typeof result === "object")
        setFeedback({ command: row.command as ClientCommand, ...(result as Pick<ClientHardwareFeedback, "value">) });
    },
  });
  return feedback;
}
