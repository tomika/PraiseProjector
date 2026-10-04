/**
 * T06 — the shared MIDI service: one access request, one listener per input,
 * several consumers without interference, exclusive and abortable learning
 * (late permission answers do not revive it), hot-plug and cleanup (R17).
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { MidiInputService, type MidiInputEvent } from "../midiInputService";
import { controllableAccess } from "../../../tests/support/fakeMidiAccess";

const flush = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

async function ready() {
  const fake = controllableAccess();
  const service = new MidiInputService(fake.request);
  const access = service.ensureAccess();
  fake.grant();
  await access;
  return { fake, service };
}

test("unsupported environments report it and never request access", async () => {
  const service = new MidiInputService(null);
  assert.equal(service.supported, false);
  assert.equal(service.getSnapshot().status, "unsupported");
  assert.equal(await service.ensureAccess(), null);
  const unsubscribe = service.subscribe({ kind: "runtime", onEvent: () => assert.fail() });
  unsubscribe();
  await assert.rejects(service.learn(new AbortController().signal), /MIDI unavailable/);
});

test("access is requested once and shared; denial is a visible state", async () => {
  const fake = controllableAccess();
  const service = new MidiInputService(fake.request);
  const statuses: string[] = [];
  service.subscribeStatus(() => statuses.push(service.getSnapshot().status));
  const first = service.ensureAccess();
  const second = service.ensureAccess();
  assert.equal(fake.calls, 1);
  fake.deny();
  assert.equal(await first, null);
  assert.equal(await second, null);
  assert.deepEqual(statuses, ["requesting", "denied"]);
  void service.ensureAccess();
  assert.equal(fake.calls, 2, "a denied request may be retried later");
  fake.deny("Other");
  await flush();
  assert.equal(service.getSnapshot().status, "error");
});

test("one listener per input for any number of consumers; every consumer gets every event", async () => {
  const { fake, service } = await ready();
  const pedal = fake.access.connect("pedal", "Pedal");
  const a: MidiInputEvent[] = [];
  const b: MidiInputEvent[] = [];
  const offA = service.subscribe({ kind: "runtime", onEvent: (event) => a.push(event) });
  const offB = service.subscribe({ kind: "runtime", onEvent: (event) => b.push(event) });
  assert.equal(pedal.listeners, 1);
  assert.equal(pedal.onmidimessage, null, "the shared property is never written");
  pedal.send([0x90, 36, 100]);
  assert.equal(a.length, 1);
  assert.equal(b.length, 1);
  assert.deepEqual(a[0].event, { kind: "note-on", channel: 1, number: 36, value: 100 });
  assert.equal(a[0].deviceName, "Pedal");
  offA();
  pedal.send([0x80, 36, 0]);
  assert.equal(a.length, 1);
  assert.equal(b.length, 2);
  assert.equal(b[1].event.kind, "note-off");
  offB();
  assert.equal(pedal.listeners, 0, "no listener leak after the last consumer leaves");
  assert.equal(fake.access.stateListeners, 0);
});

test("physicalBefore reports the input state before each event", async () => {
  const { fake, service } = await ready();
  const pedal = fake.access.connect("pedal");
  const events: MidiInputEvent[] = [];
  service.subscribe({ kind: "runtime", onEvent: (event) => events.push(event) });
  pedal.send([0x90, 36, 100]);
  pedal.send([0x90, 36, 0]);
  pedal.send([0xb0, 7, 90]);
  pedal.send([0xb0, 7, 10]);
  assert.deepEqual(
    events.map((event) => event.physicalBefore),
    [undefined, { held: true }, undefined, { lastValue: 90, held: undefined }]
  );
});

test("learning is exclusive: runtime consumers get nothing, the monitor still sees traffic", async () => {
  const { fake, service } = await ready();
  const pedal = fake.access.connect("pedal");
  const runtime: MidiInputEvent[] = [];
  const monitor: MidiInputEvent[] = [];
  service.subscribe({ kind: "runtime", onEvent: (event) => runtime.push(event) });
  service.subscribe({ kind: "monitor", onEvent: (event) => monitor.push(event) });
  const learned = service.learn(new AbortController().signal);
  assert.equal(service.getSnapshot().learning, true);
  pedal.send([0x80, 36, 0]);
  pedal.send([0xb0, 20, 127]);
  const result = await learned;
  assert.deepEqual(result.event, { kind: "control-change", channel: 1, number: 20, value: 127 });
  assert.equal(runtime.length, 0, "nothing reached the runtime while learning");
  assert.equal(monitor.length, 2);
  assert.equal(service.getSnapshot().learning, false);
  pedal.send([0x90, 36, 100]);
  assert.equal(runtime.length, 1, "runtime resumes after learning");
});

test("learning ignores releases and waits for a usable input", async () => {
  const { fake, service } = await ready();
  const pedal = fake.access.connect("pedal");
  const learned = service.learn(new AbortController().signal);
  pedal.send([0x90, 36, 0]);
  pedal.send([0xf8]);
  pedal.send([0xc2, 5]);
  assert.deepEqual((await learned).event, { kind: "program-change", channel: 3, number: 5, value: 0 });
});

test("aborting learning rejects and detaches; a late permission answer does not revive it", async () => {
  const fake = controllableAccess();
  const service = new MidiInputService(fake.request);
  const controller = new AbortController();
  const learned = service.learn(controller.signal);
  controller.abort();
  await assert.rejects(learned, { name: "AbortError" });
  assert.equal(service.getSnapshot().learning, false);
  const pedal = fake.access.connect("pedal");
  fake.grant();
  await flush();
  assert.equal(pedal.listeners, 0, "no listener is attached for a cancelled session");
  await assert.rejects(service.learn(controller.signal), { name: "AbortError" }, "an already-aborted signal rejects at once");
});

test("a new learn session cancels the previous one", async () => {
  const { fake, service } = await ready();
  const pedal = fake.access.connect("pedal");
  const first = service.learn(new AbortController().signal);
  const second = service.learn(new AbortController().signal);
  await assert.rejects(first, { name: "AbortError" });
  pedal.send([0x90, 40, 1]);
  assert.equal((await second).event.number, 40);
  assert.equal(pedal.listeners, 0);
});

test("hot-plug: new devices are attached once, disconnects drop listeners and notify consumers", async () => {
  const { fake, service } = await ready();
  const lost: string[] = [];
  const events: string[] = [];
  service.subscribe({ kind: "runtime", onEvent: (event) => events.push(event.deviceId), onDeviceLost: (id) => lost.push(id) });
  const first = fake.access.connect("one");
  assert.equal(first.listeners, 1);
  assert.deepEqual(service.getSnapshot().inputs, [{ id: "one", name: "one" }]);
  first.send([0x90, 36, 100]);
  fake.access.disconnect("one");
  assert.equal(first.listeners, 0);
  assert.deepEqual(lost, ["one"]);
  assert.deepEqual(service.getSnapshot().inputs, []);
  const again = fake.access.connect("one");
  assert.equal(again.listeners, 1, "reconnect attaches exactly one listener");
  again.send([0x90, 36, 100]);
  assert.deepEqual(events, ["one", "one"]);
  const secondEvents: MidiInputEvent[] = [];
  service.subscribe({ kind: "runtime", onEvent: (event) => secondEvents.push(event) });
  assert.equal(secondEvents.length, 0, "no retroactive events for a late subscriber");
  assert.equal(again.listeners, 1);
});

test("a reconnect reports the held state as unknown (fresh physical knowledge)", async () => {
  const { fake, service } = await ready();
  const events: MidiInputEvent[] = [];
  service.subscribe({ kind: "runtime", onEvent: (event) => events.push(event) });
  fake.access.connect("pedal").send([0x90, 36, 100]);
  fake.access.disconnect("pedal");
  fake.access.connect("pedal").send([0x90, 36, 100]);
  assert.equal(events[1].physicalBefore, undefined);
});

test("inspect lists inputs; dispose cancels learning and detaches everything", async () => {
  const { fake, service } = await ready();
  fake.access.connect("a", "Alpha");
  const snapshot = await service.inspect();
  assert.deepEqual(snapshot.inputs, [{ id: "a", name: "Alpha" }]);
  service.subscribe({ kind: "runtime", onEvent: () => undefined });
  const learned = service.learn(new AbortController().signal);
  assert.equal(service.attachedInputCount(), 1);
  service.dispose();
  await assert.rejects(learned, { name: "AbortError" });
  assert.equal(service.attachedInputCount(), 0);
});
