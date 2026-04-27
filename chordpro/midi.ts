import * as MIDI from "midi.js";

// `import * as` only captures init-time properties. Methods like noteOn/chordOn/programChange
// are added dynamically by setDefaultPlugin after plugin loads, so they're invisible in the
// namespace proxy. Use (MIDI as any).default to get the live mutable root object.
function getMidiRoot(): typeof MIDI {
  return ((MIDI as Record<string, unknown>)["default"] as typeof MIDI) ?? MIDI;
}

export type Instrument = "" | "PIANO" | "GUITAR";
let initalized = false;
let initializationInProgress = false;
const pendingInitCallbacks: Array<() => void> = [];
let midiSoundfontUrl = "./soundfont/";

export function setMidiSoundfontUrl(url: string) {
  if (!url) return;
  midiSoundfontUrl = url.endsWith("/") ? url : `${url}/`;
}

function resumeMidiAudioContext() {
  const midiWithWebAudio = MIDI as typeof MIDI & {
    WebAudio?: {
      getContext?: () => AudioContext | undefined;
    };
  };

  const audioContext = midiWithWebAudio.WebAudio?.getContext?.();
  if (audioContext?.state === "suspended") {
    void audioContext.resume().catch(() => {});
  }
}

function initialize(onsuccess: () => void) {
  if (initalized) {
    onsuccess();
    return;
  }

  pendingInitCallbacks.push(onsuccess);

  if (initializationInProgress) return;

  initializationInProgress = true;
  const pluginApi =
    typeof window !== "undefined" &&
    (window.AudioContext || (window as typeof window & { webkitAudioContext?: typeof AudioContext }).webkitAudioContext)
      ? "webaudio"
      : "audiotag";

  MIDI.loadPlugin({
    api: pluginApi,
    instruments: ["acoustic_grand_piano", "acoustic_guitar_nylon"],
    soundfontUrl: midiSoundfontUrl,
    onsuccess: () => {
      initializationInProgress = false;
      initalized = true;
      resumeMidiAudioContext();

      const root = getMidiRoot();
      // Guard for partial/failed plugin states where MIDI methods may be missing.
      if (typeof root.programChange === "function" && root.GM?.byName && root.channels) {
        root.programChange(0, root.GM.byName.acoustic_grand_piano.number);
        root.programChange(1, root.GM.byName.acoustic_guitar_nylon.number);
        for (let i = 2; i < 16; ++i) root.programChange(i, root.GM.byName.acoustic_grand_piano.number);
      }

      const callbacks = pendingInitCallbacks.splice(0, pendingInitCallbacks.length);
      callbacks.forEach((cb) => cb());
    },
    onerror: (error?: unknown) => {
      initializationInProgress = false;
      initalized = false;
      console.error("Load MIDI Plugin error", error);
      pendingInitCallbacks.splice(0, pendingInitCallbacks.length);
    },
  });
}
export function playNote(instrument: Instrument, note: number, length: number = 1) {
  playChord(instrument, [note], length);
}

export function playChord(instrument: Instrument, chord: number[], length: number = 4) {
  const play = () => {
    resumeMidiAudioContext();

    const offset = 21 + 1 * 12;
    const midiChord = chord.map((x) => x + offset);

    const root = getMidiRoot();
    const chordOn = typeof root.chordOn === "function" ? root.chordOn.bind(root) : undefined;
    const chordOff = typeof root.chordOff === "function" ? root.chordOff.bind(root) : undefined;
    const noteOn = typeof root.noteOn === "function" ? root.noteOn.bind(root) : undefined;
    const noteOff = typeof root.noteOff === "function" ? root.noteOff.bind(root) : undefined;

    const playSingle = (channel: number, note: number, velocity: number, startDelay: number, stopDelay: number) => {
      if (noteOn && noteOff) {
        noteOn(channel, note, velocity, startDelay);
        noteOff(channel, note, stopDelay);
        return;
      }
      if (chordOn && chordOff) {
        chordOn(channel, [note], velocity, startDelay);
        chordOff(channel, [note], stopDelay);
      }
    };

    if (instrument === "PIANO") {
      if (chordOn && chordOff) {
        chordOn(0, midiChord, 32, 0);
        chordOff(0, midiChord, length);
      } else {
        for (const note of midiChord) playSingle(0, note, 32, 0, length);
      }
    } else if (instrument === "GUITAR") {
      const delay = 0.02;
      let i = midiChord.length;
      for (const note of midiChord) {
        const d = --i * delay;
        playSingle(1, note, 32, d, d + length);
      }
    } else return;
  };
  if (!initalized) initialize(play);
  else play();
}

export function playMidiFile(
  data: string,
  bpm: number,
  onError?: (error?: unknown) => void
): { stop: () => void; playing: boolean; currentTime: number; endTime: number } {
  const player = MIDI.Player;
  const play = () => {
    resumeMidiAudioContext();
    if (!isNaN(bpm)) player.BPM = bpm;
    player.loadFile(data, () => player.start(), null, onError);
  };
  if (!initalized) initialize(play);
  else play();
  return player;
}
