import type * as MIDINS from "midi.js";

// Phase C bundle diet: midi.js (~31 KB) is only needed when the user actually plays
// a chord/song, so it is dynamically imported and cached. Rollup splits it into its
// own chunk, keeping it out of the initial client-view payload.
type MidiModule = typeof MIDINS;
let MIDI: MidiModule | null = null;
let midiLoad: Promise<MidiModule> | null = null;

function loadMidi(): Promise<MidiModule> {
  if (MIDI) return Promise.resolve(MIDI);
  if (!midiLoad) midiLoad = import("midi.js").then((mod) => (MIDI = mod as MidiModule));
  return midiLoad;
}

// `import * as` only captures init-time properties. Methods like noteOn/chordOn/programChange
// are added dynamically by setDefaultPlugin after plugin loads, so they're invisible in the
// namespace proxy. Use (MIDI as any).default to get the live mutable root object.
function getMidiRoot(): MidiModule {
  const mod = MIDI;
  if (!mod) throw new Error("midi.js accessed before load");
  return ((mod as Record<string, unknown>)["default"] as MidiModule) ?? mod;
}

export type Instrument = "" | "PIANO" | "GUITAR";
let initalized = false;
let initializationInProgress = false;
const pendingInitCallbacks: Array<{ ready: () => void; failed?: () => void }> = [];
let midiSoundfontUrl = "./soundfont/";

export function setMidiSoundfontUrl(url: string) {
  if (!url) return;
  midiSoundfontUrl = url.endsWith("/") ? url : `${url}/`;
}

function resumeMidiAudioContext() {
  if (!MIDI) return;
  const midiWithWebAudio = MIDI as MidiModule & {
    WebAudio?: {
      getContext?: () => AudioContext | undefined;
    };
  };

  const audioContext = midiWithWebAudio.WebAudio?.getContext?.();
  if (audioContext?.state === "suspended") {
    void audioContext.resume().catch(() => {});
  }
}

function initialize(onsuccess: () => void, onerror?: () => void) {
  if (initalized) {
    onsuccess();
    return;
  }

  pendingInitCallbacks.push({ ready: onsuccess, failed: onerror });

  if (initializationInProgress) return;

  initializationInProgress = true;
  const pluginApi =
    typeof window !== "undefined" &&
    (window.AudioContext || (window as typeof window & { webkitAudioContext?: typeof AudioContext }).webkitAudioContext)
      ? "webaudio"
      : "audiotag";

  void loadMidi()
    .then((mod) => {
      mod.loadPlugin({
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
          callbacks.forEach((cb) => cb.ready());
        },
        onerror: (error?: unknown) => {
          initializationInProgress = false;
          initalized = false;
          console.error("Load MIDI Plugin error", error);
          pendingInitCallbacks.splice(0).forEach((cb) => cb.failed?.());
        },
      });
    })
    .catch((error: unknown) => {
      initializationInProgress = false;
      initalized = false;
      console.error("Load MIDI module error", error);
      pendingInitCallbacks.splice(0).forEach((cb) => cb.failed?.());
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

/** Preview a progression on its own piano channel. A stop also cancels a
 * preview waiting for the soundfont to finish loading. */
export function playPianoChordSequence(chords: number[][], onFinish: (played: boolean) => void): () => void {
  const channel = 2;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let release: (() => void) | undefined;
  let stopped = false;
  const stop = () => {
    stopped = true;
    clearTimeout(timer);
    release?.();
    release = undefined;
  };
  const play = () => {
    if (stopped) return;
    resumeMidiAudioContext();
    const root = getMidiRoot();
    if (typeof root.chordOn !== "function" || typeof root.chordOff !== "function") {
      onFinish(false);
      return;
    }
    const next = (index: number) => {
      release?.();
      const notes = chords[index]?.map((note) => note + 45);
      if (!notes) {
        release = undefined;
        onFinish(true);
        return;
      }
      root.chordOn(channel, notes, 48, 0);
      release = () => root.chordOff(channel, notes, 0);
      timer = setTimeout(() => next(index + 1), index === chords.length - 1 ? 1000 : 620);
    };
    next(0);
  };
  initialize(play, () => {
    if (!stopped) onFinish(false);
  });
  return stop;
}

// midi.js is loaded lazily (Phase C), so the Player object cannot be returned
// synchronously on the first call; it is resolved inside `play` after init.
export function playMidiFile(data: string, bpm: number, onError?: (error?: unknown) => void): void {
  const play = () => {
    resumeMidiAudioContext();
    const player = getMidiRoot().Player;
    if (!isNaN(bpm)) player.BPM = bpm;
    player.loadFile(data, () => player.start(), null, onError);
  };
  if (!initalized) initialize(play);
  else play();
}
