/**
 * The one owner of Web MIDI access. It requests access once, attaches exactly
 * one listener per input (addEventListener — never the shared `onmidimessage`
 * property), follows hot-plug, and fans parsed events out to internal
 * consumers. The normal runtime, learning and the test monitor are consumers;
 * none of them can steal another's events.
 *
 * Learning is exclusive: while a learn session is open, runtime consumers get
 * nothing (no command may run); the monitor still sees raw traffic. The broker
 * keeps the physical state (held notes, last CC values) of every input at all
 * times, so a press observed before a learn/profile/view change can be told
 * apart from a new press afterwards.
 */
import { observePhysicalInput, parseMidiEvent, physicalInputKey, type MidiEvent, type PhysicalInputState } from "../../common/hardware-midi";

export interface MidiInputEvent {
  deviceId: string;
  deviceName: string;
  event: MidiEvent;
  /** The broker's knowledge of this input before the event. */
  physicalBefore: PhysicalInputState | undefined;
  raw: number[];
}

export type MidiServiceStatus = "unsupported" | "idle" | "requesting" | "ready" | "denied" | "error";

export interface MidiServiceSnapshot {
  status: MidiServiceStatus;
  inputs: { id: string; name: string }[];
  learning: boolean;
  error?: string;
}

export interface MidiConsumer {
  /** `runtime` consumers are paused during learning; `monitor` consumers are not. */
  kind: "runtime" | "monitor";
  onEvent(event: MidiInputEvent): void;
  onDeviceLost?(deviceId: string): void;
}

type AccessRequest = () => Promise<MIDIAccess>;

const LEARNABLE = new Set(["note-on", "control-change", "program-change"]);

export class MidiInputService {
  private access: MIDIAccess | null = null;
  private accessPromise: Promise<MIDIAccess | null> | null = null;
  private readonly consumers = new Set<MidiConsumer>();
  private readonly inputListeners = new Map<MIDIInput, (event: Event) => void>();
  private stateListener: ((event: Event) => void) | null = null;
  private readonly physical = new Map<string, PhysicalInputState>();
  private readonly statusListeners = new Set<() => void>();
  private learning: { resolve: (event: MidiInputEvent) => void; reject: (error: unknown) => void; cleanup: () => void } | null = null;
  private snapshot: MidiServiceSnapshot;

  constructor(private readonly requestAccess: AccessRequest | null) {
    this.snapshot = { status: requestAccess ? "idle" : "unsupported", inputs: [], learning: false };
  }

  get supported(): boolean {
    return this.requestAccess !== null;
  }

  getSnapshot = (): MidiServiceSnapshot => this.snapshot;

  subscribeStatus = (listener: () => void): (() => void) => {
    this.statusListeners.add(listener);
    return () => this.statusListeners.delete(listener);
  };

  private update(patch: Partial<MidiServiceSnapshot>): void {
    this.snapshot = { ...this.snapshot, ...patch };
    for (const listener of [...this.statusListeners]) listener();
  }

  /** Requests access once; later callers share the same request. Resolves null when unavailable. */
  ensureAccess(): Promise<MIDIAccess | null> {
    if (this.access) return Promise.resolve(this.access);
    if (this.accessPromise) return this.accessPromise;
    if (!this.requestAccess) return Promise.resolve(null);
    this.update({ status: "requesting", error: undefined });
    this.accessPromise = this.requestAccess().then(
      (access) => {
        this.access = access;
        this.update({ status: "ready", inputs: this.listInputs() });
        this.refreshAttachment();
        return access;
      },
      (error: unknown) => {
        this.accessPromise = null;
        const name = (error as { name?: string } | null)?.name;
        const denied = name === "SecurityError" || name === "NotAllowedError";
        this.update({ status: denied ? "denied" : "error", error: error instanceof Error ? error.message : String(error) });
        return null;
      }
    );
    return this.accessPromise;
  }

  subscribe(consumer: MidiConsumer): () => void {
    this.consumers.add(consumer);
    void this.ensureAccess();
    this.refreshAttachment();
    return () => {
      this.consumers.delete(consumer);
      this.refreshAttachment();
    };
  }

  /**
   * Waits for the first usable input (Note On, CC or Program Change). Aborting
   * the signal rejects with an AbortError; a permission answer arriving after
   * the abort does not revive the session. A new session aborts the previous one.
   */
  learn(signal: AbortSignal): Promise<MidiInputEvent> {
    this.learning?.reject(abortError());
    if (signal.aborted) return Promise.reject(abortError());
    return new Promise<MidiInputEvent>((resolve, reject) => {
      const onAbort = () => session.reject(abortError());
      const session = {
        resolve: (event: MidiInputEvent) => {
          session.cleanup();
          resolve(event);
        },
        reject: (error: unknown) => {
          session.cleanup();
          reject(error);
        },
        cleanup: () => {
          signal.removeEventListener("abort", onAbort);
          if (this.learning === session) {
            this.learning = null;
            this.update({ learning: false });
            this.refreshAttachment();
          }
        },
      };
      this.learning = session;
      signal.addEventListener("abort", onAbort, { once: true });
      this.update({ learning: true });
      this.refreshAttachment();
      void this.ensureAccess().then((access) => {
        if (this.learning !== session) return;
        if (!access) session.reject(new Error(this.snapshot.error ?? "MIDI unavailable"));
        else this.refreshAttachment();
      });
    });
  }

  /** Current inputs after (re)requesting access, for the settings check. */
  async inspect(): Promise<MidiServiceSnapshot> {
    await this.ensureAccess();
    if (this.access) this.update({ inputs: this.listInputs() });
    return this.snapshot;
  }

  /** Listener counts, for leak checks. */
  attachedInputCount(): number {
    return this.inputListeners.size;
  }

  dispose(): void {
    this.learning?.reject(abortError());
    this.consumers.clear();
    this.refreshAttachment();
  }

  private needsEvents(): boolean {
    return this.consumers.size > 0 || this.learning !== null;
  }

  private listInputs(): { id: string; name: string }[] {
    return this.access ? Array.from(this.access.inputs.values()).map((input) => ({ id: input.id, name: input.name || input.id })) : [];
  }

  private refreshAttachment(): void {
    const access = this.access;
    if (!access) return;
    if (!this.needsEvents()) {
      for (const [input, listener] of this.inputListeners) input.removeEventListener("midimessage", listener);
      this.inputListeners.clear();
      if (this.stateListener) access.removeEventListener("statechange", this.stateListener);
      this.stateListener = null;
      return;
    }
    if (!this.stateListener) {
      this.stateListener = (event: Event) => this.onStateChange(event);
      access.addEventListener("statechange", this.stateListener);
    }
    for (const input of access.inputs.values()) this.attach(input);
  }

  private attach(input: MIDIInput): void {
    if (this.inputListeners.has(input) || input.state === "disconnected") return;
    const listener = (event: Event) => this.onMessage(input, event as MIDIMessageEvent);
    input.addEventListener("midimessage", listener);
    this.inputListeners.set(input, listener);
  }

  private onStateChange(event: Event): void {
    const port = (event as MIDIConnectionEvent).port;
    this.update({ inputs: this.listInputs() });
    if (!port || port.type !== "input") return;
    const input = port as MIDIInput;
    if (input.state === "disconnected") {
      for (const [attached, listener] of this.inputListeners) {
        if (attached.id !== input.id) continue;
        attached.removeEventListener("midimessage", listener);
        this.inputListeners.delete(attached);
      }
      for (const key of [...this.physical.keys()]) if (key.startsWith(`${input.id}|`)) this.physical.delete(key);
      for (const consumer of [...this.consumers]) consumer.onDeviceLost?.(input.id);
      return;
    }
    if (this.needsEvents()) {
      // A reconnected device may be a new object; never attach twice to one id.
      for (const attached of this.inputListeners.keys()) if (attached.id === input.id && attached !== input) return;
      this.attach(input);
    }
  }

  private onMessage(input: MIDIInput, message: MIDIMessageEvent): void {
    if (!message.data) return;
    const event = parseMidiEvent(message.data);
    if (!event) return;
    const key = physicalInputKey(input.id, event);
    const known = this.physical.get(key);
    const physicalBefore = known ? { ...known } : undefined;
    observePhysicalInput(this.physical, input.id, event);
    const inputEvent: MidiInputEvent = {
      deviceId: input.id,
      deviceName: input.name || input.id,
      event,
      physicalBefore,
      raw: Array.from(message.data),
    };
    const learning = this.learning;
    for (const consumer of [...this.consumers]) {
      if (consumer.kind === "monitor" || !learning) consumer.onEvent(inputEvent);
    }
    if (learning && LEARNABLE.has(event.kind)) learning.resolve(inputEvent);
  }
}

function abortError(): Error {
  const error = new Error("MIDI learning cancelled");
  error.name = "AbortError";
  return error;
}

let shared: MidiInputService | null = null;

/** The application-wide service bound to `navigator.requestMIDIAccess` (capability-detected). */
export function getMidiInputService(): MidiInputService {
  if (!shared) {
    const request =
      typeof navigator !== "undefined" && typeof navigator.requestMIDIAccess === "function" ? () => navigator.requestMIDIAccess() : null;
    shared = new MidiInputService(request);
  }
  return shared;
}
