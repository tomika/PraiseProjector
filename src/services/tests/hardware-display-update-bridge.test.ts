/**
 * The embedded client view's display bridge into the host App: the host queues
 * every update behind its other display work, and an update whose sender stopped
 * wanting it while the queue was busy is dropped when its turn comes.
 */
import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { AsyncJobQueue } from "../../../common/asyncQueue";
import { installFakeWindow } from "../../../tests/support/browserEnv";
import { CLIENT_VIEW_DISPLAY_UPDATE_EVENT, createClientViewDisplayUpdateListener, dispatchClientViewDisplayUpdate } from "../clientViewDisplayUpdate";

let restore: (() => void) | null = null;
afterEach(() => {
  restore?.();
  restore = null;
});

/** The App wiring over a real job queue, held busy until `release` is called. */
function hostWithBusyQueue() {
  const env = installFakeWindow();
  Object.assign(env.window, { setTimeout, clearTimeout });
  const queue = new AsyncJobQueue();
  const applied: unknown[] = [];
  const listener = createClientViewDisplayUpdateListener(
    (job) => queue.enqueue(job),
    async (update) => {
      applied.push(update.id);
    }
  );
  env.window.addEventListener(CLIENT_VIEW_DISPLAY_UPDATE_EVENT, listener);
  let release!: () => void;
  void queue.enqueue(() => new Promise<void>((resolve) => (release = resolve)));
  restore = () => {
    env.window.removeEventListener(CLIENT_VIEW_DISPLAY_UPDATE_EVENT, listener);
    env.restore();
  };
  return { applied, release: () => release(), drained: () => queue.enqueue(async () => undefined) };
}

test("an update superseded while the host's queue was busy is dropped there; others still run in order", async () => {
  const host = hostWithBusyQueue();
  let current = true;
  await dispatchClientViewDisplayUpdate({ id: "p2" }, false, () => current);
  await dispatchClientViewDisplayUpdate({ id: "bare" });
  await dispatchClientViewDisplayUpdate({ id: "p3" }, false, () => true);
  current = false;
  host.release();
  await host.drained();
  assert.deepEqual(host.applied, ["bare", "p3"]);
});

test("a waiting sender is released even when its update is dropped", async () => {
  const host = hostWithBusyQueue();
  let current = true;
  const waiting = dispatchClientViewDisplayUpdate({ id: "p2" }, true, () => current);
  current = false;
  host.release();
  await waiting;
  assert.deepEqual(host.applied, []);
});

test("an event without an update queues nothing", async () => {
  const host = hostWithBusyQueue();
  window.dispatchEvent(new CustomEvent(CLIENT_VIEW_DISPLAY_UPDATE_EVENT, { detail: null }));
  host.release();
  await host.drained();
  assert.deepEqual(host.applied, []);
});
