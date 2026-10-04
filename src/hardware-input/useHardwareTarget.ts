import { useEffect, useLayoutEffect, useRef } from "react";
import type { HardwareView } from "../../common/hardware-input";
import { getHardwareInputRuntime, type HardwareInputRuntime, type HardwareTarget } from "./hardwareInputRuntime";

export type HardwareTargetImpl = Omit<HardwareTarget, "view">;

/**
 * Registers a component as the hardware target of a view for as long as it is
 * mounted. The runtime always calls the LATEST implementation, so commands read
 * the current state at dispatch time, never a snapshot from registration.
 */
export function useHardwareTarget(view: HardwareView, impl: HardwareTargetImpl, runtime: HardwareInputRuntime = getHardwareInputRuntime()): void {
  const implRef = useRef(impl);
  useLayoutEffect(() => {
    implRef.current = impl;
  });
  useEffect(
    () =>
      runtime.register({
        view,
        canHandle: (row, source) => implRef.current.canHandle(row, source),
        execute: (row, context) => implRef.current.execute(row, context),
        inSectionList: (target) => implRef.current.inSectionList?.(target) ?? false,
      }),
    [runtime, view]
  );
}
