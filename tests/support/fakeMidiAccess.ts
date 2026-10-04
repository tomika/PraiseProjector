/**
 * Node-side Web MIDI stand-in for service tests. Inputs are EventTargets that count listeners and
 * deliver raw bytes; access requests can succeed, fail or resolve late.
 */
export class FakeMidiInput extends EventTarget {
  readonly type = "input";
  state: "connected" | "disconnected" = "connected";
  listeners = 0;
  onmidimessage: ((event: Event) => void) | null = null;
  constructor(
    readonly id: string,
    readonly name: string
  ) {
    super();
  }
  addEventListener(type: string, listener: EventListenerOrEventListenerObject | null, options?: AddEventListenerOptions | boolean): void {
    if (type === "midimessage") this.listeners++;
    super.addEventListener(type, listener, options);
  }
  removeEventListener(type: string, listener: EventListenerOrEventListenerObject | null, options?: EventListenerOptions | boolean): void {
    if (type === "midimessage") this.listeners = Math.max(0, this.listeners - 1);
    super.removeEventListener(type, listener, options);
  }
  send(bytes: number[]): void {
    const event = new Event("midimessage");
    Object.defineProperty(event, "data", { value: new Uint8Array(bytes) });
    this.dispatchEvent(event);
  }
}

export class FakeMidiAccess extends EventTarget {
  readonly inputs = new Map<string, FakeMidiInput>();
  readonly outputs = new Map();
  stateListeners = 0;
  addEventListener(type: string, listener: EventListenerOrEventListenerObject | null, options?: AddEventListenerOptions | boolean): void {
    if (type === "statechange") this.stateListeners++;
    super.addEventListener(type, listener, options);
  }
  removeEventListener(type: string, listener: EventListenerOrEventListenerObject | null, options?: EventListenerOptions | boolean): void {
    if (type === "statechange") this.stateListeners = Math.max(0, this.stateListeners - 1);
    super.removeEventListener(type, listener, options);
  }
  connect(id: string, name = id): FakeMidiInput {
    const input = new FakeMidiInput(id, name);
    this.inputs.set(id, input);
    this.fire(input);
    return input;
  }
  disconnect(id: string): void {
    const input = this.inputs.get(id);
    if (!input) return;
    this.inputs.delete(id);
    input.state = "disconnected";
    this.fire(input);
  }
  private fire(port: FakeMidiInput): void {
    const event = new Event("statechange");
    Object.defineProperty(event, "port", { value: port });
    this.dispatchEvent(event);
  }
}

/** A controllable access request: resolve/reject on demand and count calls. */
export function controllableAccess() {
  const access = new FakeMidiAccess();
  let calls = 0;
  let settle: { resolve: (value: MIDIAccess) => void; reject: (error: unknown) => void } | null = null;
  const request = () => {
    calls++;
    return new Promise<MIDIAccess>((resolve, reject) => {
      settle = { resolve, reject };
    });
  };
  return {
    access,
    request,
    get calls() {
      return calls;
    },
    grant: () => settle?.resolve(access as unknown as MIDIAccess),
    deny: (name = "NotAllowedError") => {
      const error = new Error("denied");
      error.name = name;
      settle?.reject(error);
    },
  };
}
