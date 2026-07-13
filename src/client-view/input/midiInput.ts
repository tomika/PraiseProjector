import { parseMidiMessage, type ParsedMidiMessage } from "./clientViewInput";

export function midiSupported(): boolean {
  return typeof navigator !== "undefined" && typeof navigator.requestMIDIAccess === "function";
}

export async function requestMidiAccess(): Promise<MIDIAccess> {
  const request = navigator.requestMIDIAccess;
  if (!request) throw new Error("A böngésző nem támogatja a MIDI bemenetet.");
  return request.call(navigator);
}

export function midiInputNames(access: MIDIAccess): string[] {
  return Array.from(access.inputs.values()).map((input) => input.name || input.id);
}

export function subscribeMidiMessages(access: MIDIAccess, onMessage: (message: ParsedMidiMessage) => void): () => void {
  const handlers = new Map<MIDIInput, (event: MIDIMessageEvent) => void>();
  const attach = () => {
    for (const input of access.inputs.values()) {
      if (handlers.has(input)) continue;
      const handler = (event: MIDIMessageEvent) => {
        if (!event.data) return;
        const parsed = parseMidiMessage(event.data);
        if (parsed) onMessage(parsed);
      };
      input.onmidimessage = handler;
      handlers.set(input, handler);
    }
  };
  attach();
  const previousStateHandler = access.onstatechange;
  access.onstatechange = (_event) => {
    previousStateHandler?.call(access, _event);
    attach();
  };
  return () => {
    for (const [input, handler] of handlers) {
      if (input.onmidimessage === handler) input.onmidimessage = null;
    }
    if (access.onstatechange) access.onstatechange = previousStateHandler;
  };
}

/** Wait for one usable input message; used by the Settings learn button. */
export async function learnMidiMessage(): Promise<ParsedMidiMessage> {
  const access = await requestMidiAccess();
  return new Promise((resolve) => {
    const unsubscribe = subscribeMidiMessages(access, (message) => {
      unsubscribe();
      resolve(message);
    });
  });
}
