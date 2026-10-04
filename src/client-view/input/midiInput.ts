import { parseMidiMessage, type ParsedMidiMessage } from "./clientViewInput";
import { getMidiInputService } from "../../hardware-input/midiInputService";

/**
 * Legacy entry points of the client-view MIDI input, now backed by the shared
 * MIDI service: one access request, one listener per device, and learning that
 * the running client view can no longer interfere with (or be triggered by).
 */

export function midiSupported(): boolean {
  return getMidiInputService().supported;
}

export async function requestMidiAccess(): Promise<MIDIAccess> {
  const access = await getMidiInputService().ensureAccess();
  if (!access) throw new Error(getMidiInputService().getSnapshot().error ?? "A böngésző nem támogatja a MIDI bemenetet.");
  return access;
}

export function midiInputNames(access: MIDIAccess): string[] {
  return Array.from(access.inputs.values()).map((input) => input.name || input.id);
}

/** Legacy-shaped messages for the running client view (Note On / CC / Program Change). */
export function subscribeMidiMessages(_access: MIDIAccess, onMessage: (message: ParsedMidiMessage) => void): () => void {
  return getMidiInputService().subscribe({
    kind: "runtime",
    onEvent: ({ raw }) => {
      const parsed = parseMidiMessage(raw);
      if (parsed) onMessage(parsed);
    },
  });
}

/** Wait for one usable input message; used by the Settings learn button. */
export async function learnMidiMessage(signal: AbortSignal = new AbortController().signal): Promise<ParsedMidiMessage> {
  const { raw } = await getMidiInputService().learn(signal);
  const parsed = parseMidiMessage(raw);
  if (!parsed) throw new Error("Unsupported MIDI message");
  return parsed;
}
