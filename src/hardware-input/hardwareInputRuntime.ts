/**
 * The hardware input runtime: one document-level keyboard router and one MIDI
 * consumer for the whole renderer. Exactly one application view is active at a
 * time (set by the shell from what is actually visible); only the target
 * registered for that view executes, and every event runs at most once.
 *
 * The runtime knows profiles, bindings and triggers — never the UI's DOM or
 * state. A target answers, at dispatch time, whether a row may run now and
 * executes it through its own semantic command layer.
 */
import {
  resolveActiveProfile,
  findRow,
  type HardwareActionRow,
  type HardwareBinding,
  type HardwareInputSettings,
  type HardwareKeyboardBinding,
  type HardwareView,
} from "../../common/hardware-input";
import { MidiTriggerTracker, midiEventTargets } from "../../common/hardware-midi";
import { isComposingKey, isEditableTarget, matchesHardwareKey } from "./keyboardInput";
import { getMidiInputService, type MidiInputEvent, type MidiInputService } from "./midiInputService";
import { readHardwareInputSettings } from "./hardwareInputSettings";

export type InputSource = "keyboard" | "midi";

/** `yes` run it; `no` not available in this state; `protected` the UI owns the input now;
 *  `fallback` run it only when no other binding of the same event may run. */
export type TargetDecision = "yes" | "no" | "protected" | "fallback";

export interface ExecutionContext {
  /** False once the generation changed (view/profile/learning switch) or the target left. */
  isCurrent(): boolean;
  source: InputSource;
}

export interface HardwareTarget {
  view: HardwareView;
  canHandle(row: HardwareActionRow<unknown>, source: InputSource): TargetDecision;
  execute(row: HardwareActionRow<unknown>, context: ExecutionContext): void | Promise<unknown>;
  /** Full view: is a keyboard event inside the section list this target owns? */
  inSectionList?(target: EventTarget | null): boolean;
}

/** Outcome of a keyboard dispatch, for tests and local fallbacks. */
export type KeyDispatchResult = "unmatched" | "protected" | "handled" | "unavailable" | "inactive";

const handledEvents = new WeakSet<object>();
const consumedEvents = new WeakSet<object>();

/** True when the hardware router executed this event (local handlers must skip it). */
export function isHardwareHandled(event: object): boolean {
  return handledEvents.has(event);
}

/** True when a hardware binding matched this event, executed or not: a legacy local
 *  handler must not start a different action for it. */
export function isHardwareConsumed(event: object): boolean {
  return consumedEvents.has(event);
}

export interface RuntimeDependencies {
  readSettings(): HardwareInputSettings;
  midi: MidiInputService;
  now(): number;
  /** Where the keyboard router listens (the document in the app). */
  keyboardTarget?: Pick<Document, "addEventListener" | "removeEventListener">;
  /** Where settings-change notifications arrive (the window in the app). */
  eventTarget?: Pick<Window, "addEventListener" | "removeEventListener">;
  onError?(error: unknown): void;
}

export class HardwareInputRuntime {
  private activeView: HardwareView | null = null;
  private readonly targets = new Map<HardwareView, HardwareTarget[]>();
  private generation = 0;
  private readonly tracker: MidiTriggerTracker;
  private learningDepth = 0;
  private started = 0;
  private stopListeners: (() => void) | null = null;
  private midiUnsubscribe: (() => void) | null = null;
  private lastLearning = false;

  constructor(private readonly deps: RuntimeDependencies) {
    this.tracker = new MidiTriggerTracker(deps.now);
  }

  get currentGeneration(): number {
    return this.generation;
  }

  get view(): HardwareView | null {
    return this.activeView;
  }

  /** The shell's choice of the visible, usable view; `null` while nothing may execute. */
  setActiveView(view: HardwareView | null): void {
    if (this.activeView === view) return;
    this.activeView = view;
    this.bump();
  }

  /** Registers a target; the latest registration of a view wins until it leaves. */
  register(target: HardwareTarget): () => void {
    const list = this.targets.get(target.view) ?? [];
    list.push(target);
    this.targets.set(target.view, list);
    this.bump();
    return () => {
      const current = this.targets.get(target.view) ?? [];
      const index = current.indexOf(target);
      if (index < 0) return;
      current.splice(index, 1);
      this.bump();
    };
  }

  /** Pauses all hardware execution (keyboard/MIDI learning in the settings UI). */
  beginLearning(): () => void {
    this.learningDepth++;
    this.bump();
    let ended = false;
    return () => {
      if (ended) return;
      ended = true;
      this.learningDepth--;
      this.bump();
    };
  }

  /** Installs the keyboard router and the settings watcher (reference counted). */
  start(): () => void {
    if (this.started++ === 0) {
      const onKey = (event: Event) => this.handleKeyDown(event as KeyboardEvent);
      const onSettings = () => this.settingsChanged();
      this.deps.keyboardTarget?.addEventListener("keydown", onKey, true);
      this.deps.eventTarget?.addEventListener("pp-settings-changed", onSettings);
      this.deps.eventTarget?.addEventListener("storage", onSettings);
      const unsubscribeStatus = this.deps.midi.subscribeStatus(() => {
        const learning = this.deps.midi.getSnapshot().learning;
        if (learning !== this.lastLearning) {
          this.lastLearning = learning;
          this.bump();
        }
      });
      this.stopListeners = () => {
        this.deps.keyboardTarget?.removeEventListener("keydown", onKey, true);
        this.deps.eventTarget?.removeEventListener("pp-settings-changed", onSettings);
        this.deps.eventTarget?.removeEventListener("storage", onSettings);
        unsubscribeStatus();
      };
      this.refreshMidi();
    }
    let stopped = false;
    return () => {
      if (stopped) return;
      stopped = true;
      if (--this.started > 0) return;
      this.stopListeners?.();
      this.stopListeners = null;
      this.midiUnsubscribe?.();
      this.midiUnsubscribe = null;
    };
  }

  /** The keyboard router (installed on the document in the capture phase). */
  handleKeyDown(event: KeyboardEvent): KeyDispatchResult {
    if (handledEvents.has(event) || consumedEvents.has(event)) return "handled";
    const target = this.activeTarget();
    if (!target || this.learningDepth > 0) return "inactive";
    if (isComposingKey(event) || isEditableTarget(event.target)) return "protected";
    const view = target.view;
    const profile = resolveActiveProfile(this.deps.readSettings(), view);
    let matched = false;
    let protectedMatch = false;
    let fallback: HardwareActionRow<unknown> | null = null;
    for (const binding of profile.bindings) {
      if (binding.kind !== "keyboard" || !matchesHardwareKey(binding, event)) continue;
      if (!this.inKeyScope(target, binding, event)) continue;
      const row = findRow(view, profile, binding.rowId);
      if (!row) continue;
      matched = true;
      const decision = target.canHandle(row, "keyboard");
      if (decision === "protected") {
        protectedMatch = true;
        continue;
      }
      if (decision === "fallback") fallback ??= row;
      if (decision !== "yes") continue;
      event.preventDefault();
      handledEvents.add(event);
      this.run(target, row, "keyboard");
      return "handled";
    }
    if (protectedMatch) return "protected";
    if (fallback) {
      event.preventDefault();
      handledEvents.add(event);
      this.run(target, fallback, "keyboard");
      return "handled";
    }
    if (matched) {
      consumedEvents.add(event);
      return "unavailable";
    }
    return "unmatched";
  }

  private inKeyScope(target: HardwareTarget, binding: HardwareKeyboardBinding, event: KeyboardEvent): boolean {
    if (target.view !== "full-view") return true;
    if ((binding.scope ?? "section-list") === "full-view") return true;
    return !!target.inSectionList?.(event.target);
  }

  /** MIDI events from the shared service. */
  handleMidi(input: MidiInputEvent): boolean {
    const target = this.activeTarget();
    if (!target) return false;
    const view = target.view;
    const profile = resolveActiveProfile(this.deps.readSettings(), view);
    let executed = false;
    let protectedMatch = false;
    let fallback: HardwareActionRow<unknown> | null = null;
    for (const binding of profile.bindings) {
      if (binding.kind !== "midi" || !midiEventTargets(binding, input.event)) continue;
      // Every targeted binding sees the event, so releases update the trigger
      // state even while nothing may execute.
      const fires = this.tracker.process(this.generation, binding, input.deviceId, input.event, input.physicalBefore);
      if (!fires || executed || this.learningDepth > 0) continue;
      const row = findRow(view, profile, binding.rowId);
      if (!row) continue;
      const decision = target.canHandle(row, "midi");
      if (decision === "protected") protectedMatch = true;
      if (decision === "fallback") fallback ??= row;
      if (decision !== "yes") continue;
      executed = true;
      this.run(target, row, "midi");
    }
    if (!executed && !protectedMatch && fallback) {
      executed = true;
      this.run(target, fallback, "midi");
    }
    return executed;
  }

  private run(target: HardwareTarget, row: HardwareActionRow<unknown>, source: InputSource): void {
    const generation = this.generation;
    const context: ExecutionContext = {
      source,
      isCurrent: () => this.generation === generation && this.activeTarget() === target,
    };
    try {
      const result = target.execute(row, context);
      if (result && typeof (result as Promise<unknown>).catch === "function") (result as Promise<unknown>).catch((error) => this.reportError(error));
    } catch (error) {
      this.reportError(error);
    }
  }

  private reportError(error: unknown): void {
    if (this.deps.onError) this.deps.onError(error);
    else console.error("HardwareInput", "Command failed", error);
  }

  private activeTarget(): HardwareTarget | null {
    if (!this.activeView) return null;
    const list = this.targets.get(this.activeView);
    return list && list.length ? list[list.length - 1] : null;
  }

  private settingsChanged(): void {
    this.bump();
  }

  /** New generation: pending work and trigger state of the previous one are void. */
  private bump(): void {
    this.generation++;
    this.tracker.clear();
    this.refreshMidi();
  }

  /** MIDI access is requested only when the active profile has a MIDI binding. */
  private refreshMidi(): void {
    if (this.started === 0) return;
    const target = this.activeTarget();
    const wanted =
      !!target && resolveActiveProfile(this.deps.readSettings(), target.view).bindings.some((binding: HardwareBinding) => binding.kind === "midi");
    if (wanted && !this.midiUnsubscribe) {
      this.midiUnsubscribe = this.deps.midi.subscribe({
        kind: "runtime",
        onEvent: (event) => this.handleMidi(event),
        onDeviceLost: (deviceId) => this.tracker.forgetDevice(deviceId),
      });
    } else if (!wanted && this.midiUnsubscribe) {
      this.midiUnsubscribe();
      this.midiUnsubscribe = null;
    }
  }

  /** For tests: whether the runtime currently consumes MIDI. */
  get midiSubscribed(): boolean {
    return this.midiUnsubscribe !== null;
  }
}

let shared: HardwareInputRuntime | null = null;

/** The renderer-wide runtime (one per document). */
export function getHardwareInputRuntime(): HardwareInputRuntime {
  if (!shared) {
    shared = new HardwareInputRuntime({
      readSettings: readHardwareInputSettings,
      midi: getMidiInputService(),
      now: () => (typeof performance !== "undefined" ? performance.now() : Date.now()),
      keyboardTarget: typeof document !== "undefined" ? document : undefined,
      eventTarget: typeof window !== "undefined" ? window : undefined,
    });
  }
  return shared;
}
