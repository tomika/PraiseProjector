/**
 * In-process bridge used by client-view controllers and PPD control requests to
 * route display updates through App.tsx. Waiting is bounded: the App listener may
 * be absent during teardown, and a missing listener must never strand a caller.
 */

export const CLIENT_VIEW_DISPLAY_UPDATE_EVENT = "pp-cv-display-update";

const APPLY_TIMEOUT_MS = 2500;

export type ClientViewDisplayUpdateEnvelope = {
  update: Record<string, unknown>;
  complete: () => void;
  /** Set synchronously by the App listener before it queues the update. */
  handled: boolean;
};

export function isClientViewDisplayUpdateEnvelope(value: unknown): value is ClientViewDisplayUpdateEnvelope {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Partial<ClientViewDisplayUpdateEnvelope>;
  return (
    !!candidate.update && typeof candidate.update === "object" && typeof candidate.complete === "function" && typeof candidate.handled === "boolean"
  );
}

export function dispatchClientViewDisplayUpdate(update: Record<string, unknown>, waitForApply = false): Promise<void> {
  if (!waitForApply) {
    window.dispatchEvent(new CustomEvent(CLIENT_VIEW_DISPLAY_UPDATE_EVENT, { detail: update }));
    return Promise.resolve();
  }

  return new Promise((resolve) => {
    let settled = false;
    const complete = () => {
      if (settled) return;
      settled = true;
      window.clearTimeout(timeout);
      resolve();
    };
    const timeout = window.setTimeout(complete, APPLY_TIMEOUT_MS);
    const envelope: ClientViewDisplayUpdateEnvelope = { update, complete, handled: false };
    window.dispatchEvent(
      new CustomEvent<ClientViewDisplayUpdateEnvelope>(CLIENT_VIEW_DISPLAY_UPDATE_EVENT, {
        detail: envelope,
      })
    );
    // dispatchEvent invokes listeners synchronously. A standalone client-view has
    // no App listener, so acknowledge immediately instead of paying the timeout
    // for every PPD control update.
    if (!envelope.handled) complete();
  });
}
