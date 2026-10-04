/**
 * T05 — MIDI byte parsing with release events, binding targeting, and the
 * discrete trigger state machine (legacy level + 80 ms guard vs press edge with
 * hysteresis), driven by a controlled clock.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  MidiTriggerTracker,
  isMidiPress,
  midiEventTargets,
  observePhysicalInput,
  parseMidiEvent,
  physicalInputKey,
  type MidiEvent,
  type PhysicalInputState,
} from "../hardware-midi";
import type { HardwareMidiBinding } from "../hardware-input";

test("parser: Note On/Off, velocity 0 release, CC and Program extremes, channels 1 and 16", () => {
  assert.deepEqual(parseMidiEvent([0x90, 36, 100]), { kind: "note-on", channel: 1, number: 36, value: 100 });
  assert.deepEqual(parseMidiEvent([0x9f, 127, 1]), { kind: "note-on", channel: 16, number: 127, value: 1 });
  assert.deepEqual(parseMidiEvent([0x90, 36, 0]), { kind: "note-off", channel: 1, number: 36, value: 0 });
  assert.deepEqual(parseMidiEvent([0x83, 36, 64]), { kind: "note-off", channel: 4, number: 36, value: 0 });
  assert.deepEqual(parseMidiEvent([0xb0, 0, 0]), { kind: "control-change", channel: 1, number: 0, value: 0 });
  assert.deepEqual(parseMidiEvent([0xbf, 127, 127]), { kind: "control-change", channel: 16, number: 127, value: 127 });
  assert.deepEqual(parseMidiEvent([0xc0, 0]), { kind: "program-change", channel: 1, number: 0, value: 0 });
  assert.deepEqual(parseMidiEvent([0xcf, 127]), { kind: "program-change", channel: 16, number: 127, value: 0 });
});

test("parser rejects malformed bytes and unsupported messages", () => {
  for (const bytes of [
    [],
    [0x40, 1, 2],
    [0xf8],
    [0xf0, 1, 2],
    [0x90],
    [0x90, 36],
    [0x90, 128, 1],
    [0xb0, 1, 128],
    [0xc0],
    [0xe0, 0, 64],
    [0xa0, 1, 2],
    [0xd0, 5],
  ]) {
    assert.equal(parseMidiEvent(bytes), null, JSON.stringify(bytes));
  }
});

const binding = (patch: Partial<HardwareMidiBinding> = {}): HardwareMidiBinding => ({
  id: "b",
  rowId: "r",
  kind: "midi",
  mode: "button",
  trigger: "press-edge",
  message: "control-change",
  channel: 1,
  number: 20,
  ...patch,
});
const cc = (value: number, channel = 1, number = 20): MidiEvent => ({ kind: "control-change", channel, number, value });
const noteOn = (number = 36, channel = 1): MidiEvent => ({ kind: "note-on", channel, number, value: 100 });
const noteOff = (number = 36, channel = 1): MidiEvent => ({ kind: "note-off", channel, number, value: 0 });

test("targeting: a Note binding sees its release; channel any/exact; number and type", () => {
  const note = binding({ message: "note-on", number: 36 });
  assert.equal(midiEventTargets(note, noteOn()), true);
  assert.equal(midiEventTargets(note, noteOff()), true);
  assert.equal(midiEventTargets(note, cc(127, 1, 36)), false);
  assert.equal(midiEventTargets(binding(), cc(1, 2)), false);
  assert.equal(midiEventTargets(binding({ channel: "any" }), cc(1, 16)), true);
  assert.equal(midiEventTargets(binding(), cc(1, 1, 21)), false);
  const program = binding({ message: "program-change", number: 5 });
  assert.equal(midiEventTargets(program, { kind: "program-change", channel: 1, number: 5, value: 0 }), true);
  assert.equal(isMidiPress(binding({ threshold: 100 }), cc(99)), false);
  assert.equal(isMidiPress(binding(), noteOff()), false);
});

function run(
  tracker: MidiTriggerTracker,
  b: HardwareMidiBinding,
  events: MidiEvent[],
  device = "dev",
  generation = 1,
  physical?: Map<string, PhysicalInputState>
) {
  return events.map((event) => {
    const before = physical?.get(physicalInputKey(device, event));
    if (physical) observePhysicalInput(physical, device, event);
    return tracker.process(generation, b, device, event, before ? { ...before } : undefined);
  });
}

test("press-edge CC: a held pedal fires once; release re-arms (0,127,127,127,0,127 → 2 fires)", () => {
  const tracker = new MidiTriggerTracker(() => 0);
  const fires = run(
    tracker,
    binding(),
    [0, 127, 127, 127, 0, 127].map((value) => cc(value))
  );
  assert.deepEqual(fires, [false, true, false, false, false, true]);
});

test("press-edge CC with hysteresis: values inside the release zone do not re-arm", () => {
  const tracker = new MidiTriggerTracker(() => 0);
  const fires = run(
    tracker,
    binding({ threshold: 65, releaseThreshold: 61 }),
    [0, 65, 63, 65, 60, 65].map((value) => cc(value))
  );
  assert.deepEqual(fires, [false, true, false, false, false, true]);
  const narrow = new MidiTriggerTracker(() => 0);
  assert.deepEqual(
    run(
      narrow,
      binding({ threshold: 64 }),
      [0, 65, 63, 65, 60, 65].map((value) => cc(value))
    ),
    [false, true, false, true, false, true],
    "default release = threshold - 1"
  );
});

test("fresh start: the very first press fires without a prior release", () => {
  assert.deepEqual(run(new MidiTriggerTracker(() => 0), binding(), [cc(127)]), [true]);
  assert.deepEqual(run(new MidiTriggerTracker(() => 0), binding({ message: "note-on", number: 36 }), [noteOn()]), [true]);
});

test("press-edge Note: one press fires once, a real release re-arms; Program fires per message", () => {
  const tracker = new MidiTriggerTracker(() => 0);
  const note = binding({ message: "note-on", number: 36 });
  assert.deepEqual(run(tracker, note, [noteOn(), noteOn(), noteOff(), noteOn()]), [true, false, false, true]);
  const program = binding({ message: "program-change", number: 5 });
  const event: MidiEvent = { kind: "program-change", channel: 1, number: 5, value: 0 };
  assert.deepEqual(run(tracker, program, [event, event]), [true, true]);
});

test("legacy-level keeps the old behaviour: every press sample fires after 80 ms", () => {
  let now = 1000;
  const tracker = new MidiTriggerTracker(() => now);
  const legacy = binding({ trigger: "legacy-level" });
  const at = (time: number, value: number) => {
    now = time;
    return run(tracker, legacy, [cc(value)])[0];
  };
  assert.deepEqual([at(1000, 127), at(1050, 127), at(1080, 127), at(1100, 0), at(1170, 70)], [true, false, true, false, true]);
  const noteLegacy = binding({ trigger: "legacy-level", message: "note-on", number: 36 });
  now = 5000;
  assert.equal(run(tracker, noteLegacy, [noteOn()])[0], true);
  assert.equal(run(tracker, noteLegacy, [noteOff()])[0], false, "Note Off is not a legacy press");
  now = 5100;
  assert.equal(run(tracker, noteLegacy, [noteOn()])[0], true);
});

test("legacy guard key is shared across devices like before; edge state is per physical input", () => {
  const tracker = new MidiTriggerTracker(() => 0);
  const legacy = binding({ trigger: "legacy-level", channel: "any" });
  assert.equal(tracker.process(1, legacy, "a", cc(127), undefined), true);
  assert.equal(tracker.process(1, legacy, "b", cc(127), undefined), false);
  const edge = binding({ channel: "any" });
  assert.equal(tracker.process(1, edge, "a", cc(127, 1), undefined), true);
  assert.equal(tracker.process(1, edge, "b", cc(127, 1), undefined), true, "another device has its own state");
  assert.equal(tracker.process(1, edge, "a", cc(127, 2), undefined), true, "another channel has its own state");
});

test("after a generation change an input observed held waits for a release; a new press is armed", () => {
  const physical = new Map<string, PhysicalInputState>();
  const tracker = new MidiTriggerTracker(() => 0);
  const note = binding({ message: "note-on", number: 36 });
  assert.deepEqual(run(tracker, note, [noteOn()], "dev", 1, physical), [true]);
  // Profile / view switch while the pedal is still held:
  assert.deepEqual(run(tracker, note, [noteOn()], "dev", 2, physical), [false], "the held press is not a new press");
  assert.deepEqual(run(tracker, note, [noteOff(), noteOn()], "dev", 2, physical), [false, true]);
  const ccBinding = binding();
  run(tracker, ccBinding, [cc(127)], "dev", 3, physical);
  assert.deepEqual(run(tracker, ccBinding, [cc(127), cc(0), cc(127)], "dev", 4, physical), [false, false, true]);
  assert.deepEqual(run(tracker, ccBinding, [cc(127)], "fresh-device", 4, physical), [true], "an input never seen held is armed");
});

test("disconnect forgets a device's states; clear forgets everything", () => {
  const tracker = new MidiTriggerTracker(() => 0);
  const note = binding({ message: "note-on", number: 36 });
  tracker.process(1, note, "a", noteOn(), undefined);
  tracker.process(1, note, "b", noteOn(), undefined);
  assert.equal(tracker.size, 2);
  tracker.forgetDevice("a");
  assert.equal(tracker.size, 1);
  assert.equal(tracker.process(1, note, "a", noteOn(), undefined), true, "re-plugged device starts fresh");
  tracker.clear();
  assert.equal(tracker.size, 0);
});

test("physical observation ignores Program Change and tracks notes and CC values", () => {
  const physical = new Map<string, PhysicalInputState>();
  observePhysicalInput(physical, "d", { kind: "program-change", channel: 1, number: 1, value: 0 });
  assert.equal(physical.size, 0);
  observePhysicalInput(physical, "d", noteOn());
  assert.deepEqual(physical.get(physicalInputKey("d", noteOff())), { held: true });
  observePhysicalInput(physical, "d", cc(90));
  assert.deepEqual(physical.get(physicalInputKey("d", cc(0))), { lastValue: 90, held: undefined });
});
