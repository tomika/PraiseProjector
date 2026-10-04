/**
 * T08 — the hardware runtime: exclusive active view, hidden App never executing,
 * registration replacement, single execution per event, protected / unavailable
 * outcomes, section-list scope, live profile reads, MIDI subscription policy,
 * trigger generations, learning pause and error handling (R05, R08, R13, R17).
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  HardwareInputRuntime,
  isHardwareConsumed,
  isHardwareHandled,
  type ExecutionContext,
  type HardwareTarget,
  type TargetDecision,
} from "../hardwareInputRuntime";
import { MidiInputService } from "../midiInputService";
import {
  baseRowId,
  createProfile,
  defaultHardwareInputSettings,
  upsertProfile,
  type HardwareActionRow,
  type HardwareBinding,
  type HardwareInputSettings,
  type HardwareView,
} from "../../../common/hardware-input";
import { keyEvent, type KeyEventOptions } from "../../../tests/support/keyEvents";
import { controllableAccess } from "../../../tests/support/fakeMidiAccess";

const flush = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

function key(code: string, id: string, rowId: string, extra: Partial<HardwareBinding> = {}): HardwareBinding {
  return { id, rowId, kind: "keyboard", match: "code", key: code, ctrl: false, alt: false, shift: false, meta: false, ...extra } as HardwareBinding;
}

function note(number: number, id: string, rowId: string, extra: Partial<HardwareBinding> = {}): HardwareBinding {
  return { id, rowId, kind: "midi", mode: "button", trigger: "press-edge", message: "note-on", channel: 1, number, ...extra } as HardwareBinding;
}

function settingsWith(view: HardwareView, bindings: HardwareBinding[], base = defaultHardwareInputSettings()): HardwareInputSettings {
  let id = 0;
  const profile = { ...createProfile<typeof view>(`P-${view}`, () => `${view}-profile-${++id}`), bindings };
  return upsertProfile(base, view, profile, true);
}

/** Browser-faithful listener registry (Node's EventTarget does not honour the
 *  capture flag on removal). */
class ListenerTarget {
  private readonly listeners = new Map<string, Set<(event: Event) => void>>();
  addEventListener(type: string, listener: (event: Event) => void, capture?: boolean): void {
    const key = `${type}|${!!capture}`;
    const set = this.listeners.get(key) ?? new Set();
    set.add(listener);
    this.listeners.set(key, set);
  }
  removeEventListener(type: string, listener: (event: Event) => void, capture?: boolean): void {
    this.listeners.get(`${type}|${!!capture}`)?.delete(listener);
  }
  dispatch(type: string, event: object): void {
    for (const key of [`${type}|true`, `${type}|false`]) for (const listener of [...(this.listeners.get(key) ?? [])]) listener(event as Event);
  }
  count(type: string): number {
    return (this.listeners.get(`${type}|true`)?.size ?? 0) + (this.listeners.get(`${type}|false`)?.size ?? 0);
  }
}

class FakeTarget implements HardwareTarget {
  executed: string[] = [];
  contexts: ExecutionContext[] = [];
  decision: (row: HardwareActionRow<unknown>) => TargetDecision = () => "yes";
  sectionList = false;
  constructor(readonly view: HardwareView) {}
  canHandle(row: HardwareActionRow<unknown>): TargetDecision {
    return this.decision(row);
  }
  execute(row: HardwareActionRow<unknown>, context: ExecutionContext): void {
    this.executed.push((row.command as { action: string }).action);
    this.contexts.push(context);
  }
  inSectionList(): boolean {
    return this.sectionList;
  }
}

function setup(initial: HardwareInputSettings = defaultHardwareInputSettings()) {
  let settings = initial;
  const documentTarget = new ListenerTarget();
  const windowTarget = new ListenerTarget();
  const midiAccess = controllableAccess();
  const midi = new MidiInputService(midiAccess.request);
  const errors: unknown[] = [];
  let now = 0;
  const runtime = new HardwareInputRuntime({
    readSettings: () => settings,
    midi,
    now: () => now,
    keyboardTarget: documentTarget as unknown as Document,
    eventTarget: windowTarget as unknown as Window,
    onError: (error) => errors.push(error),
  });
  const client = new FakeTarget("client-view");
  const full = new FakeTarget("full-view");
  const press = (code: string, options: KeyEventOptions = {}) => {
    const event = keyEvent(code, options);
    return { event, result: runtime.handleKeyDown(event) };
  };
  return {
    runtime,
    client,
    full,
    midi,
    midiAccess,
    errors,
    documentTarget,
    windowTarget,
    press,
    setSettings(next: HardwareInputSettings) {
      settings = next;
      windowTarget.dispatch("pp-settings-changed", new Event("pp-settings-changed"));
    },
    tick(ms: number) {
      now += ms;
    },
  };
}

const TOGGLE = baseRowId("client-view", "toggle-options");
const NEXT_DOWN = baseRowId("full-view", "next-down");

test("nothing executes without an active view or target", () => {
  const f = setup(settingsWith("client-view", [key("F6", "k", TOGGLE)]));
  assert.equal(f.press("F6").result, "inactive");
  f.runtime.setActiveView("client-view");
  assert.equal(f.press("F6").result, "inactive", "no registered target");
  f.runtime.register(f.client);
  assert.equal(f.press("F6").result, "handled");
  assert.deepEqual(f.client.executed, ["toggle-options"]);
});

test("the same key runs only in the active view, even with both views mounted (hidden App)", () => {
  let settings = settingsWith("client-view", [key("F6", "k1", TOGGLE)]);
  settings = settingsWith("full-view", [key("F6", "k2", NEXT_DOWN, { scope: "full-view" })], settings);
  const f = setup(settings);
  f.runtime.register(f.full);
  f.runtime.register(f.client);
  f.runtime.setActiveView("client-view");
  f.press("F6");
  f.press("F6");
  assert.deepEqual(f.client.executed, ["toggle-options", "toggle-options"]);
  assert.deepEqual(f.full.executed, [], "the hidden full view never executes");
  f.runtime.setActiveView("full-view");
  f.press("F6");
  assert.deepEqual(f.full.executed, ["next-down"]);
  assert.equal(f.client.executed.length, 2);
});

test("an event is executed at most once, also with a doubled router or a re-dispatch", () => {
  const f = setup(settingsWith("client-view", [key("F6", "k", TOGGLE)]));
  f.runtime.register(f.client);
  f.runtime.setActiveView("client-view");
  const { event } = f.press("F6");
  assert.equal(isHardwareHandled(event), true);
  assert.equal(event.defaultPrevented, true);
  assert.equal(f.runtime.handleKeyDown(event), "handled", "a second router pass sees it as handled");
  assert.deepEqual(f.client.executed, ["toggle-options"]);
});

test("start() is reference counted: one document listener however often it is called", () => {
  const f = setup(settingsWith("client-view", [key("F6", "k", TOGGLE)]));
  f.runtime.register(f.client);
  f.runtime.setActiveView("client-view");
  const stopA = f.runtime.start();
  const stopB = f.runtime.start();
  assert.equal(f.documentTarget.count("keydown"), 1);
  f.documentTarget.dispatch("keydown", keyEvent("F6"));
  assert.deepEqual(f.client.executed, ["toggle-options"]);
  stopA();
  assert.equal(f.documentTarget.count("keydown"), 1, "still started by the other owner");
  stopB();
  stopB();
  assert.equal(f.documentTarget.count("keydown"), 0, "removed after the last stop");
  assert.equal(f.windowTarget.count("pp-settings-changed"), 0);
  f.documentTarget.dispatch("keydown", keyEvent("F6"));
  assert.equal(f.client.executed.length, 1);
});

test("registration replacement (StrictMode remount): only the latest target executes", () => {
  const f = setup(settingsWith("client-view", [key("F6", "k", TOGGLE)]));
  f.runtime.setActiveView("client-view");
  const stale = new FakeTarget("client-view");
  const unregisterStale = f.runtime.register(stale);
  const unregisterCurrent = f.runtime.register(f.client);
  f.press("F6");
  assert.deepEqual(stale.executed, []);
  assert.deepEqual(f.client.executed, ["toggle-options"]);
  unregisterCurrent();
  f.press("F6");
  assert.deepEqual(stale.executed, ["toggle-options"], "the still-mounted instance takes over");
  unregisterStale();
  unregisterStale();
  assert.equal(f.press("F6").result, "inactive");
});

test("text entry, IME and modal UI keep their keys; nothing is prevented", () => {
  const f = setup(settingsWith("client-view", [key("F6", "k", TOGGLE)]));
  f.runtime.register(f.client);
  f.runtime.setActiveView("client-view");
  const input = { closest: () => ({}) };
  const editable = f.press("F6", { target: input });
  assert.equal(editable.result, "protected");
  assert.equal(editable.event.defaultPrevented, false);
  assert.equal(f.press("F6", { isComposing: true }).result, "protected");
  f.client.decision = () => "protected";
  const modal = f.press("F6");
  assert.equal(modal.result, "protected");
  assert.equal(modal.event.defaultPrevented, false);
  assert.equal(isHardwareConsumed(modal.event), false);
  assert.deepEqual(f.client.executed, []);
});

test("an unavailable row is consumed without preventDefault; the next matching binding may run", () => {
  const other = baseRowId("client-view", "clear-control");
  const f = setup(settingsWith("client-view", [key("F6", "k1", TOGGLE), key("F6", "k2", other)]));
  f.runtime.register(f.client);
  f.runtime.setActiveView("client-view");
  f.client.decision = (row) => (row.id === TOGGLE ? "no" : "yes");
  f.press("F6");
  assert.deepEqual(f.client.executed, ["clear-control"], "context-dependent legacy rows behave like the old first-available match");
  f.client.decision = () => "no";
  const { event, result } = f.press("F6");
  assert.equal(result, "unavailable");
  assert.equal(isHardwareConsumed(event), true);
  assert.equal(event.defaultPrevented, false);
});

test("full view: section-list keys need list focus, full-view-scope keys work anywhere", () => {
  const f = setup(settingsWith("full-view", [key("KeyX", "x", NEXT_DOWN, { scope: "full-view" })]));
  f.runtime.register(f.full);
  f.runtime.setActiveView("full-view");
  f.setSettings(defaultHardwareInputSettings());
  assert.equal(f.press("Home").result, "unmatched", "factory keys are section-list scoped");
  f.full.sectionList = true;
  f.press("Home");
  f.press("ArrowRight");
  f.press("ArrowDown", { ctrl: true, repeat: true });
  assert.deepEqual(f.full.executed, ["next-first", "next-down", "next-down"]);
  f.setSettings(settingsWith("full-view", [key("KeyX", "x", NEXT_DOWN, { scope: "full-view" })]));
  f.full.sectionList = false;
  f.press("KeyX");
  assert.deepEqual(f.full.executed.at(-1), "next-down");
  assert.equal(f.press("Home").result, "unmatched", "the custom profile has no Home: the old hardcoded key cannot come back");
});

test("profiles are read at dispatch time; an empty custom profile really has no keys", () => {
  const f = setup(defaultHardwareInputSettings());
  f.runtime.register(f.client);
  f.runtime.setActiveView("client-view");
  f.press("Home");
  assert.deepEqual(f.client.executed, ["toggle-options"]);
  f.setSettings(settingsWith("client-view", []));
  assert.equal(f.press("Home").result, "unmatched");
  f.setSettings(settingsWith("client-view", [key("F7", "k", TOGGLE)]));
  f.press("F7");
  assert.equal(f.client.executed.length, 2);
});

test("keyboard learning pauses execution", () => {
  const f = setup(settingsWith("client-view", [key("F6", "k", TOGGLE)]));
  f.runtime.register(f.client);
  f.runtime.setActiveView("client-view");
  const end = f.runtime.beginLearning();
  assert.equal(f.press("F6").result, "inactive");
  end();
  end();
  f.press("F6");
  assert.deepEqual(f.client.executed, ["toggle-options"]);
});

test("execution contexts expire on a view switch or when the target leaves", () => {
  const f = setup(settingsWith("client-view", [key("F6", "k", TOGGLE)]));
  const unregister = f.runtime.register(f.client);
  f.runtime.setActiveView("client-view");
  f.press("F6");
  const [context] = f.client.contexts;
  assert.equal(context.isCurrent(), true);
  assert.equal(context.source, "keyboard");
  f.runtime.setActiveView("full-view");
  assert.equal(context.isCurrent(), false);
  f.runtime.setActiveView("client-view");
  f.press("F6");
  unregister();
  assert.equal(f.client.contexts[1].isCurrent(), false);
});

test("command failures are reported, sync or async, without breaking the router", async () => {
  const f = setup(settingsWith("client-view", [key("F6", "k", TOGGLE)]));
  f.runtime.setActiveView("client-view");
  f.runtime.register({ view: "client-view", canHandle: () => "yes", execute: () => Promise.reject(new Error("async boom")) });
  f.press("F6");
  await flush();
  f.runtime.register({
    view: "client-view",
    canHandle: () => "yes",
    execute: () => {
      throw new Error("sync boom");
    },
  });
  f.press("F6");
  assert.deepEqual(
    f.errors.map((error) => (error as Error).message),
    ["async boom", "sync boom"]
  );
});

test("MIDI access is requested only while the active profile has MIDI bindings", async () => {
  const f = setup(settingsWith("client-view", [note(36, "n", TOGGLE)]));
  f.runtime.register(f.client);
  f.runtime.register(f.full);
  f.runtime.start();
  assert.equal(f.runtime.midiSubscribed, false, "no view yet");
  f.runtime.setActiveView("client-view");
  assert.equal(f.runtime.midiSubscribed, true);
  assert.equal(f.midiAccess.calls, 1);
  f.runtime.setActiveView("full-view");
  assert.equal(f.runtime.midiSubscribed, false, "the full-view factory profile has no MIDI");
  f.setSettings(settingsWith("full-view", [note(36, "fn", NEXT_DOWN)], settingsWith("client-view", [note(36, "n", TOGGLE)])));
  assert.equal(f.runtime.midiSubscribed, true);
});

async function midiSetup(bindings: HardwareBinding[], view: HardwareView = "client-view") {
  const f = setup(settingsWith(view, bindings));
  f.runtime.register(view === "client-view" ? f.client : f.full);
  f.runtime.start();
  f.runtime.setActiveView(view);
  f.midiAccess.grant();
  await flush();
  const pedal = f.midiAccess.access.connect("pedal");
  return { ...f, pedal, target: view === "client-view" ? f.client : f.full };
}

test("a fallback row runs only when no other binding of the key may run; protection still wins", () => {
  const next = baseRowId("client-view", "show-next-song");
  const preselect = baseRowId("client-view", "select-next-visible-song");
  const f = setup(settingsWith("client-view", [key("PageDown", "k1", next), key("PageDown", "k2", preselect), key("ArrowRight", "k3", next)]));
  f.runtime.register(f.client);
  f.runtime.setActiveView("client-view");
  f.client.decision = (row) => (row.id === next ? "fallback" : "yes");
  f.press("PageDown");
  assert.deepEqual(f.client.executed, ["select-next-visible-song"], "a regular row of the same key wins over an earlier fallback");
  const { event, result } = f.press("ArrowRight");
  assert.equal(result, "handled");
  assert.equal(event.defaultPrevented, true);
  assert.equal(isHardwareHandled(event), true);
  assert.deepEqual(f.client.executed, ["select-next-visible-song", "show-next-song"], "alone, the fallback runs");
  f.client.decision = (row) => (row.id === next ? "fallback" : "protected");
  assert.equal(f.press("PageDown").result, "protected", "a protected match keeps the input for the UI");
  assert.equal(f.client.executed.length, 2);
});

test("MIDI: a fallback row fires only when no regular row takes the press", async () => {
  const next = baseRowId("client-view", "show-next-song");
  const f = await midiSetup([note(36, "n1", next), note(36, "n2", TOGGLE), note(37, "n3", next)]);
  f.client.decision = (row) => (row.id === next ? "fallback" : "yes");
  f.pedal.send([0x90, 36, 100]);
  f.pedal.send([0x90, 37, 100]);
  assert.deepEqual(f.client.executed, ["toggle-options", "show-next-song"]);
  f.client.decision = (row) => (row.id === next ? "fallback" : "protected");
  f.pedal.send([0x80, 36, 0]);
  f.pedal.send([0x90, 36, 100]);
  assert.deepEqual(f.client.executed, ["toggle-options", "show-next-song"], "protection wins over a fallback");
});

test("MIDI: a press-edge Note runs once per press; the same note drives only the active view", async () => {
  const f = await midiSetup([note(36, "n", TOGGLE)]);
  f.pedal.send([0x90, 36, 100]);
  f.pedal.send([0x90, 36, 100]);
  f.pedal.send([0x80, 36, 0]);
  f.pedal.send([0x90, 36, 100]);
  assert.deepEqual(f.client.executed, ["toggle-options", "toggle-options"]);
  assert.deepEqual(f.full.executed, []);
});

test("MIDI: a press during a modal is consumed — no retroactive command when it closes", async () => {
  const f = await midiSetup([note(36, "n", TOGGLE)]);
  f.client.decision = () => "protected";
  f.pedal.send([0x90, 36, 100]);
  f.client.decision = () => "yes";
  f.pedal.send([0x90, 36, 100]);
  assert.deepEqual(f.client.executed, [], "the held press does not fire after the modal");
  f.pedal.send([0x80, 36, 0]);
  f.pedal.send([0x90, 36, 100]);
  assert.deepEqual(f.client.executed, ["toggle-options"]);
});

test("MIDI: a view switch while a pedal is held does not produce a press in the new view", async () => {
  let settings = settingsWith("client-view", [note(36, "n", TOGGLE)]);
  settings = settingsWith("full-view", [note(36, "fn", NEXT_DOWN)], settings);
  const f = setup(settings);
  f.runtime.register(f.client);
  f.runtime.register(f.full);
  f.runtime.start();
  f.runtime.setActiveView("client-view");
  f.midiAccess.grant();
  await flush();
  const pedal = f.midiAccess.access.connect("pedal");
  pedal.send([0x90, 36, 100]);
  f.runtime.setActiveView("full-view");
  pedal.send([0x90, 36, 100]);
  assert.deepEqual(f.full.executed, []);
  pedal.send([0x80, 36, 0]);
  pedal.send([0x90, 36, 100]);
  assert.deepEqual(f.client.executed, ["toggle-options"]);
  assert.deepEqual(f.full.executed, ["next-down"]);
});

test("MIDI: learning (settings) and runtime pauses block execution; legacy level bindings keep the 80 ms guard", async () => {
  const f = await midiSetup([note(40, "legacy", TOGGLE, { trigger: "legacy-level" })]);
  f.pedal.send([0x90, 40, 100]);
  f.tick(50);
  f.pedal.send([0x90, 40, 100]);
  f.tick(50);
  f.pedal.send([0x90, 40, 100]);
  assert.equal(f.client.executed.length, 2);
  const end = f.runtime.beginLearning();
  f.tick(200);
  f.pedal.send([0x90, 40, 100]);
  end();
  assert.equal(f.client.executed.length, 2);
  const learned = f.midi.learn(new AbortController().signal);
  f.tick(200);
  f.pedal.send([0x90, 40, 100]);
  await learned;
  assert.equal(f.client.executed.length, 2, "nothing runs while the settings learn a binding");
});

test("MIDI: a disconnected device leaves no trigger state behind", async () => {
  const f = await midiSetup([note(36, "n", TOGGLE)]);
  f.pedal.send([0x90, 36, 100]);
  f.midiAccess.access.disconnect("pedal");
  const again = f.midiAccess.access.connect("pedal");
  again.send([0x90, 36, 100]);
  assert.deepEqual(f.client.executed, ["toggle-options", "toggle-options"], "the re-plugged pedal starts armed");
});

test("the factory client profile drives the legacy rows when nothing custom is selected", () => {
  const f = setup(defaultHardwareInputSettings());
  f.runtime.register(f.client);
  f.runtime.setActiveView("client-view");
  f.client.decision = (row) => (row.id === baseRowId("client-view", "show-next-song") ? "yes" : "no");
  f.press("PageDown");
  assert.deepEqual(f.client.executed, ["show-next-song"]);
});
