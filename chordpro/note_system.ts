import { ChordInfo } from "./allchords";
import { decodeRoman, romanUpper } from "../common/utils";

const halfNotes = [false, true, false, false, true, false, true, false, false, true, false, true];
export const isHalfNote = (note: number) => halfNotes[note % 12];

const notesToSteps = ["1", "b9", "2", "b3", "3", "4", "b5", "5", "#5", "6", "b7", "7"];
const notesToStepsOctave = ["", "b9", "9", "#9", "b11", "11", "#11", "", "b13", "13", "#13", ""];

const { sharpOrder, flatOrder } = (() => {
  const s: number[] = [];
  const f: number[] = [];
  for (let i = 0; i < 7; ++i) {
    s.push((12000008 - 5 * i) % 12);
    f.push((2 + 5 * i) % 12);
  }
  return { sharpOrder: s, flatOrder: f };
})();

export type ChordDetails = {
  baseNote: number;
  bassNote: number | null;
  subscript: string;
  chordInfo: ChordInfo;
  label: string;
};

export type NoteSystemCode = "G" | "S";

export class NoteSystem {
  readonly baseNoteList: string[];
  readonly possibleNoteList: string;

  private noteLists = new Map<number, string[]>();
  private keysMap = new Map<number | string, Key>();

  constructor(readonly systemCode: NoteSystemCode) {
    this.baseNoteList =
      systemCode === "G"
        ? ["A", "B", "H", "C", "C#", "D", "D#", "E", "F", "F#", "G", "G#"]
        : ["A", "A#", "B", "C", "C#", "D", "D#", "E", "F", "F#", "G", "G#"];

    const set = new Set<string>();
    for (const key of this.baseNoteList) set.add(key.endsWith("#") ? key.substr(0, key.length - 1) : key);

    let list = "";
    set.forEach((value) => {
      const char = value.toLowerCase();
      list += char + char.toUpperCase();
    });
    this.possibleNoteList = list;
  }

  noteToString(note: number, keySignature: number = 0) {
    let noteList = this.noteLists.get(keySignature);
    if (!noteList) {
      if (keySignature) {
        const modifiers = new Set(keySignature >= 0 ? sharpOrder.slice(0, keySignature) : flatOrder.slice(0, -keySignature));
        noteList = [];
        for (let i = 0; i < 12; ++i) {
          const m = ((keySignature >= 0 ? i - 1 : i + 1) + 12) % 12;
          const s = modifiers.has(m) ? this.baseNoteList[m] + (keySignature >= 0 ? "#" : "b") : this.baseNoteList[i];
          noteList.push(s === "Hb" ? "B" : s);
        }
      } else noteList = this.baseNoteList;
      this.noteLists.set(keySignature, noteList);
    }
    return noteList[(note + 1200000) % 12];
  }

  stringToNote(noteStr: string) {
    let pitch = this.baseNoteList.indexOf(noteStr.charAt(0).toUpperCase());
    if (pitch < 0) return null;
    for (const accidental of noteStr.slice(1)) {
      if (accidental === "#" || accidental === "♯") ++pitch;
      else if (accidental === "b" || accidental === "♭") --pitch;
      else return null;
    }
    return ((pitch % 12) + 12) % 12;
  }

  convertNotesToSteps(s: string, majChange?: boolean) {
    const notes = s.split("-");
    const baseNote = this.stringToNote(notes[0]);
    if (baseNote === null) return null;

    let mmIndex: number | undefined, mdIndex: number | undefined, fIndex: number | undefined;
    const steps = new Map<number, { order: number; label: string }>();
    steps.set(0, { order: 0, label: "1" });
    for (let i = 1; i < notes.length; ++i) {
      const note = this.stringToNote(notes[i]);
      if (note === null) return null;
      const relative = (note - baseNote + 12) % 12;
      if (majChange) {
        if (relative === 3 || relative === 4) {
          if (mmIndex !== undefined) steps.delete(mmIndex);
          mmIndex = relative;
        }
        if (6 <= relative && relative <= 8) {
          if (fIndex !== undefined) steps.delete(fIndex);
          fIndex = relative;
        }
        if (relative === 10 || relative === 11) {
          if (mdIndex !== undefined) steps.delete(mdIndex);
          mdIndex = relative;
        }
      }
      const existing = steps.get(relative);
      if (!existing)
        steps.set(relative, {
          order: relative === 1 ? 13 : relative,
          label: notesToSteps[relative],
        });
    }

    let hasAbove9 = steps.has(1);
    if (steps.has(3) || steps.has(4)) {
      // b3/3
      for (let i = 2; i < 6; ++i)
        if (i !== 3 && i !== 4) {
          const r = steps.get(i);
          if (r) {
            steps.set(i, { order: 12 + i, label: notesToStepsOctave[i] });
            if (i > 3) hasAbove9 = true;
          }
        }
    }
    if (steps.has(6) && steps.has(7)) {
      // b5 && 5
      steps.set(6, { order: 18, label: notesToStepsOctave[6] });
      hasAbove9 = true;
    }
    if (steps.has(7) && steps.has(8)) {
      // 5 && #5
      steps.set(8, { order: 20, label: notesToStepsOctave[8] });
      hasAbove9 = true;
    }
    if (hasAbove9 && steps.has(9))
      // 6
      steps.set(9, { order: 21, label: notesToStepsOctave[9] });

    const sorted: { order: number; label: string }[] = [];
    steps.forEach((value) => sorted.push(value));
    return sorted
      .sort((a, b) => a.order - b.order)
      .map((x) => x.label)
      .join("-");
  }

  shiftNote(note: string, shift: number) {
    const pitch = this.stringToNote(note);
    return pitch === null ? note : this.noteToString(pitch + shift);
  }

  getKey(name: string): Key | undefined {
    let key = this.keys.get(name);
    if (!key) {
      // Some imported songs spell the mode out (e.g. "{key:C Major}").
      const parts = /^([A-Ha-h])([#♯b♭]?)(m|\s+\S+)?$/.exec(name.trim());
      if (!parts) return undefined;
      const tonic = parts[1].toUpperCase() + parts[2].replace("♯", "#").replace("♭", "b");
      const suffix = parts[3]?.trim().toLowerCase() ?? "";
      const mode =
        suffix === "" || suffix === "major"
          ? Mode.ionian
          : suffix === "m" || suffix === "minor"
            ? Mode.aeolian
            : ((Mode as unknown as Record<string, number>)[suffix] ?? (decodeRoman(suffix.toUpperCase()) ?? 0) - 1);
      const baseNote = this.stringToNote(tonic);
      if (baseNote === null || !Number.isInteger(mode) || mode < Mode.ionian || mode > Mode.locrian) return undefined;
      // Prefer the exact spelling (Gb vs F#) before trying an enharmonic alias.
      key = this.keysMap.get(tonic + " " + Mode[mode]) ?? this.keysMap.get(10 * baseNote + mode);
      if (key) this.keysMap.set(name, key);
    }
    return key;
  }

  get keys() {
    if (this.keysMap.size === 0) {
      for (let i = -7; i <= 7; ++i) {
        for (let mode = 0; Mode[mode] !== undefined; ++mode) {
          const key = new Key(this, i, mode);
          this.keysMap.set(key.name, key);
          if (key.scaleType === Mode.ionian) this.keysMap.set(key.baseNote, key);
          if (key.scaleType === Mode.aeolian) this.keysMap.set(key.baseNote + "m", key);
          this.keysMap.set(key.baseNote + " " + Mode[mode], key);
          this.keysMap.set(key.baseNote + " " + romanUpper[mode + 1], key);
          const baseNote = this.stringToNote(key.baseNote);
          if (baseNote !== null) this.keysMap.set(10 * baseNote + mode, key);
        }
      }
    }
    return this.keysMap;
  }
}

export enum Mode {
  "ionian" = 0,
  "dorian" = 1,
  "phrygian" = 2,
  "lydian" = 3,
  "mixolydian" = 4,
  "aeolian" = 5,
  "locrian" = 6,
}

const ionianSteps = [2, 2, 1, 2, 2, 2, 1];
const ionianChordBasicModifiers = ["", "m", "m", "", "", "m", "dim"];
const ionianChordModifiers = ["maj7", "min7", "min7", "maj7", "7", "min7", "dim7"];

export class Key {
  private readonly baseScale: string[] = [];
  readonly scaleType: Mode;
  readonly name: string;

  constructor(
    readonly system: NoteSystem,
    readonly signature: number,
    scaleTypeParam: Mode | string
  ) {
    this.scaleType = typeof scaleTypeParam === "string" ? (Mode as unknown as Record<string, number>)[scaleTypeParam] : scaleTypeParam;
    let note = 3 - 5 * (this.signature % 12); // kvints starting on C
    let noteOffsetIndex = 0;
    this.baseScale.push(system.noteToString(note, this.signature));
    for (let i = 0; i < 6; ++i) {
      const index = noteOffsetIndex++ % 7;
      this.baseScale.push(system.noteToString((note += ionianSteps[index]), this.signature));
    }
    this.name = this.baseNote + (this.scaleType ? (this.scaleType === Mode.aeolian ? "m" : " " + romanUpper[this.scaleType + 1]) : "");
  }

  get baseNote() {
    return this.baseScale[this.scaleType];
  }

  get baseChord() {
    return this.baseScale[this.scaleType] + ionianChordBasicModifiers[this.scaleType];
  }

  noteName(note: number | string) {
    if (typeof note === "string") {
      const n = this.system.stringToNote(note);
      if (n === null) return note;
      note = n;
    }
    return this.system.noteToString(note, this.signature);
  }

  *notes() {
    for (let i = 0; i < 7; ++i) yield this.baseScale[(this.scaleType + i) % 7];
  }

  *chords(basic?: boolean) {
    for (let i = 0; i < 7; ++i) {
      const index = (this.scaleType + i) % 7;
      yield this.baseScale[index] + (basic ? ionianChordBasicModifiers : ionianChordModifiers)[index];
    }
  }

  transposedKey(shift: number) {
    if (!shift) return this.name;
    let fs = this.name.indexOf(" ");
    if (fs < 0) fs = this.name.endsWith("m") ? this.name.length - 1 : this.name.length;
    const name = this.system.shiftNote(this.name.substring(0, fs), shift) + this.name.substring(fs);
    return this.system.getKey(name)?.name ?? "";
  }
}
