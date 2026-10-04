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
  /** The sender's condition, checked again when the queued update finally runs:
   *  false drops an update superseded while the host's queue was busy. */
  isCurrent?: () => boolean;
};

export function isClientViewDisplayUpdateEnvelope(value: unknown): value is ClientViewDisplayUpdateEnvelope {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Partial<ClientViewDisplayUpdateEnvelope>;
  return (
    !!candidate.update && typeof candidate.update === "object" && typeof candidate.complete === "function" && typeof candidate.handled === "boolean"
  );
}

export function dispatchClientViewDisplayUpdate(update: Record<string, unknown>, waitForApply = false, isCurrent?: () => boolean): Promise<void> {
  if (!waitForApply) {
    // An envelope only to carry the sender's condition to the queue.
    const detail: Record<string, unknown> | ClientViewDisplayUpdateEnvelope = isCurrent
      ? { update, complete: () => undefined, handled: false, isCurrent }
      : update;
    window.dispatchEvent(new CustomEvent(CLIENT_VIEW_DISPLAY_UPDATE_EVENT, { detail }));
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
    const envelope: ClientViewDisplayUpdateEnvelope = { update, complete, handled: false, ...(isCurrent ? { isCurrent } : {}) };
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

/**
 * The App side of the bridge: queues each update behind the host's other display
 * work, and drops it there when its sender stopped wanting it in the meantime.
 */
export function createClientViewDisplayUpdateListener(
  enqueue: (job: () => Promise<void>) => Promise<void>,
  apply: (update: Record<string, unknown>) => Promise<void>
): (event: Event) => void {
  return (event) => {
    const eventDetail = (event as CustomEvent<unknown>).detail;
    const envelope = isClientViewDisplayUpdateEnvelope(eventDetail) ? eventDetail : null;
    if (envelope) envelope.handled = true;
    const update = envelope?.update ?? (eventDetail as Record<string, unknown> | null);
    if (!update) {
      envelope?.complete();
      return;
    }
    const queued = enqueue(async () => {
      if (envelope?.isCurrent?.() === false) return;
      await apply(update);
    });
    if (envelope) void queued.then(envelope.complete, envelope.complete);
  };
}
