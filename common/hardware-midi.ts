/**
 * MIDI side of the hardware bindings, independent of Web MIDI and of time:
 * the byte parser (with release events), binding matching and the discrete
 * trigger state machine. Clock and physical-input knowledge are parameters.
 */
import { DEFAULT_CC_THRESHOLD, LEGACY_MIDI_REPEAT_GUARD_MS, type HardwareMidiBinding } from "./hardware-input";

/** `note-off` covers Note Off and Note On with velocity 0. It only updates trigger
 *  state; it is never a learnable or bindable event of its own. */
export type MidiEventKind = "note-on" | "note-off" | "control-change" | "program-change";

export interface MidiEvent {
  kind: MidiEventKind;
  /** 1..16 */
  channel: number;
  /** Note, controller or program number 0..127. */
  number: number;
  /** Velocity or controller value; 0 for program change and note-off. */
  value: number;
}

export function parseMidiEvent(data: ArrayLike<number>): MidiEvent | null {
  const status = data[0];
  if (typeof status !== "number" || status < 0x80 || status >= 0xf0) return null;
  const type = status & 0xf0;
  const channel = (status & 0x0f) + 1;
  const number = data[1];
  if (typeof number !== "number" || number < 0 || number > 127) return null;
  if (type === 0xc0) return { kind: "program-change", channel, number, value: 0 };
  const value = data[2];
  if (typeof value !== "number" || value < 0 || value > 127) return null;
  if (type === 0x80) return { kind: "note-off", channel, number, value: 0 };
  if (type === 0x90) return value > 0 ? { kind: "note-on", channel, number, value } : { kind: "note-off", channel, number, value: 0 };
  if (type === 0xb0) return { kind: "control-change", channel, number, value };
  return null;
}

/** Whether an event concerns a binding's physical input (a Note binding also sees its release). */
export function midiEventTargets(binding: HardwareMidiBinding, event: MidiEvent): boolean {
  if (binding.number !== event.number) return false;
  if (binding.channel !== "any" && binding.channel !== event.channel) return false;
  if (binding.message === "note-on") return event.kind === "note-on" || event.kind === "note-off";
  return binding.message === event.kind;
}

/** Is this event (or the last seen value of its input) a press for the binding? */
export function isMidiPress(binding: HardwareMidiBinding, event: MidiEvent): boolean {
  if (event.kind === "note-on" || event.kind === "program-change") return true;
  if (event.kind === "control-change") return event.value >= (binding.threshold ?? DEFAULT_CC_THRESHOLD);
  return false;
}

/** Identity of one physical input on one device. */
export function physicalInputKey(deviceId: string, event: Pick<MidiEvent, "kind" | "channel" | "number">): string {
  const family = event.kind === "note-off" ? "note-on" : event.kind;
  return `${deviceId}|${family}|${event.channel}|${event.number}`;
}

/** What the broker last observed of a physical input, regardless of bindings. */
export interface PhysicalInputState {
  /** Note held / last CC value; undefined when never seen. */
  held?: boolean;
  lastValue?: number;
}

/** Updates the broker's physical knowledge with an event. */
export function observePhysicalInput(state: Map<string, PhysicalInputState>, deviceId: string, event: MidiEvent): void {
  if (event.kind === "program-change") return;
  const key = physicalInputKey(deviceId, event);
  if (event.kind === "control-change") state.set(key, { lastValue: event.value, held: undefined });
  else state.set(key, { held: event.kind === "note-on" });
}

interface TriggerState {
  armed: boolean;
  lastFire: number;
}

/**
 * Discrete trigger state per (generation, binding, device, channel, number).
 * Two physical inputs never share a state, even on an "any channel" binding.
 *
 * - `legacy-level`: every press sample fires, separated by the 80 ms guard
 *   (the behaviour of migrated pre-hardware-tab bindings);
 * - `press-edge`: a Note fires once per press and re-arms on release; a CC fires
 *   when crossing the threshold upwards and re-arms at/below the release
 *   threshold (hysteresis zone in between changes nothing); a Program Change
 *   fires once per message.
 *
 * A new state starts armed, unless the broker has already observed the input
 * held — then it waits for a release first (a press observed before a view /
 * profile / learning change must not turn into a new button press).
 */
export class MidiTriggerTracker {
  private readonly states = new Map<string, TriggerState>();

  constructor(private readonly now: () => number) {}

  /** Feeds an event targeting `binding`; returns whether the binding fires. Release
   *  events always update the state, even when the caller will not execute.
   *  `physicalBefore` is the broker's knowledge of the input BEFORE this event. */
  process(
    generation: number,
    binding: HardwareMidiBinding,
    deviceId: string,
    event: MidiEvent,
    physicalBefore: PhysicalInputState | undefined
  ): boolean {
    // Legacy bindings keep their original guard key (binding + channel + number,
    // shared by all devices); edge triggers are tracked per physical input.
    const key =
      binding.trigger === "legacy-level"
        ? `${generation}|${binding.id}|*|${event.channel}|${event.number}`
        : `${generation}|${binding.id}|${physicalInputKey(deviceId, event)}`;
    const state = this.states.get(key) ?? this.initial(binding, physicalBefore);
    this.states.set(key, state);
    const now = this.now();

    if (binding.trigger === "legacy-level") {
      if (!isMidiPress(binding, event)) return false;
      if (state.lastFire !== Number.NEGATIVE_INFINITY && now - state.lastFire < LEGACY_MIDI_REPEAT_GUARD_MS) return false;
      state.lastFire = now;
      return true;
    }

    if (event.kind === "program-change") {
      state.lastFire = now;
      return true;
    }
    if (event.kind === "note-on" || event.kind === "note-off") {
      if (event.kind === "note-off") {
        state.armed = true;
        return false;
      }
      if (!state.armed) return false;
      state.armed = false;
      state.lastFire = now;
      return true;
    }
    const threshold = binding.threshold ?? DEFAULT_CC_THRESHOLD;
    const release = binding.releaseThreshold ?? threshold - 1;
    if (event.value <= release) {
      state.armed = true;
      return false;
    }
    if (event.value < threshold || !state.armed) return false;
    state.armed = false;
    state.lastFire = now;
    return true;
  }

  private initial(binding: HardwareMidiBinding, physical: PhysicalInputState | undefined): TriggerState {
    const threshold = binding.threshold ?? DEFAULT_CC_THRESHOLD;
    const held = binding.message === "control-change" ? physical?.lastValue !== undefined && physical.lastValue >= threshold : !!physical?.held;
    return { armed: !held, lastFire: Number.NEGATIVE_INFINITY };
  }

  /** Forgets every state of a device (disconnect: no retroactive commands, no stale press). */
  forgetDevice(deviceId: string): void {
    for (const key of [...this.states.keys()]) if (key.split("|")[2] === deviceId) this.states.delete(key);
  }

  /** Forgets everything (view / profile / generation change). */
  clear(): void {
    this.states.clear();
  }

  get size(): number {
    return this.states.size;
  }
}
