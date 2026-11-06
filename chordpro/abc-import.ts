// Plain ABC notation → ChordPro song text for the song importer.
//
// The score becomes one {start_of_abc} block. Header fields with a ChordPro
// equivalent move into the song metadata: the title and composer would otherwise
// be engraved a second time above the score. K: and M: stay in the score as well,
// because ABC needs them (K: starts the music and may carry a clef, M: sets the
// default note length and the time signature); their values are copied. Only the
// header — the values the tune starts with — is read: later key, meter or tempo
// changes in the body stay where they are.

import { getChordSystem, type ChordSystemCode } from "./chordpro_base";
import { Key, Mode } from "./note_system";

const DIRECTIVE_LINE = /^[ \t]*\{[ \t]*[a-z_]+[ \t]*(?::[^}\n]*)?\}[ \t]*$/im;

/** Plain ABC notation (not ChordPro with embedded ABC): a key field together with
 * a tune reference number, or a title with a meter or unit note length. */
export function looksLikeAbc(text: string): boolean {
  if (DIRECTIVE_LINE.test(text) || !/^[ \t]*K:/m.test(text)) return false;
  return /^[ \t]*X:/m.test(text) || (/^[ \t]*T:/m.test(text) && /^[ \t]*[ML]:/m.test(text));
}

const ABC_MODES: Record<string, Mode> = {
  "": Mode.ionian,
  maj: Mode.ionian,
  ion: Mode.ionian,
  min: Mode.aeolian,
  aeo: Mode.aeolian,
  mix: Mode.mixolydian,
  dor: Mode.dorian,
  phr: Mode.phrygian,
  lyd: Mode.lydian,
  loc: Mode.locrian,
};

/** An ABC K: value as a song key written in `systemCode` (K:Bb is "B" in the
 * German alphabet, K:Ador is A dorian). Empty when it names no key (K:none, K:Hp). */
export function abcKeyToSongKey(value: string, systemCode: ChordSystemCode): string {
  const [first = "", second = ""] = value.trim().split(/\s+/);
  const head = /^([A-G])([#b]?)([A-Za-z]*)$/.exec(first);
  if (!head) return "";
  // "D dor" spells the mode as a separate word; "G clef=bass" or "C treble" do not.
  const modeName = (head[3] || (/^[A-Za-z]+$/.test(second) ? second : "")).toLowerCase();
  let mode: Mode | undefined = modeName === "m" ? Mode.aeolian : ABC_MODES[modeName.slice(0, 3)];
  if (mode === undefined) {
    if (head[3]) return "";
    mode = Mode.ionian;
  }
  const name = head[1] + head[2] + (mode === Mode.ionian ? "" : mode === Mode.aeolian ? "m" : " " + Mode[mode]);
  const key = getChordSystem("S").getKey(name);
  return key ? new Key(getChordSystem(systemCode), key.signature, key.scaleType).name : "";
}

function songMeter(value: string): string {
  if (value === "C") return "4/4";
  if (value === "C|") return "2/2";
  return /^\(?\d+(?:\+\d+)*\)?\/\d+$/.test(value) ? value : "";
}

/** A Q: field as quarter notes per minute — the unit {tempo} is played with — and
 * whether {tempo} alone reproduces it (a plain "1/4=N" with no text label). */
function songTempo(value: string): { qpm: number; exact: boolean } | null {
  const text = value.replace(/"[^"]*"/g, " ").trim();
  const beat = /^((?:\d+\/\d+\s*)+)=\s*(\d+(?:\.\d+)?)$/.exec(text);
  if (beat) {
    const units = beat[1].trim().split(/\s+/);
    const length = units.reduce((sum, unit) => {
      const [numerator, denominator] = unit.split("/").map(Number);
      return sum + numerator / denominator;
    }, 0);
    const qpm = Math.round(Number(beat[2]) * length * 4);
    return qpm > 0 ? { qpm, exact: units.length === 1 && units[0] === "1/4" && !value.includes('"') } : null;
  }
  // A bare number is relative to the unit note length (ABC 2.1): keep Q: itself.
  return /^\d+$/.test(text) && Number(text) > 0 ? { qpm: Number(text), exact: false } : null;
}

const ABC_ACCENTS: Record<string, string> = {
  "'": "\u0301",
  "`": "\u0300",
  "^": "\u0302",
  '"': "\u0308",
  "~": "\u0303",
  H: "\u030b",
  c: "\u0327",
  v: "\u030c",
  o: "\u030a",
};
const HTML_ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " " };

/** Header text as plain Unicode: ABC accent mnemonics (\'e, \Ho), \u escapes and
 * HTML entities are engraved by abcjs but would show literally in ChordPro. */
function decodeAbcText(value: string): string {
  return value
    .replace(/\\u([0-9a-fA-F]{4})|\\U([0-9a-fA-F]{8})/g, (_, short: string | undefined, long: string | undefined) =>
      String.fromCodePoint(parseInt(short ?? long!, 16))
    )
    .replace(/\\(['`^"~Hcvo])([A-Za-z])/g, (all, accent: string, letter: string) => (letter + ABC_ACCENTS[accent]).normalize("NFC"))
    .replace(/&(?:#(\d+)|#x([0-9a-fA-F]+)|([a-z]+));/gi, (all, decimal: string | undefined, hex: string | undefined, name: string | undefined) => {
      if (decimal || hex) return String.fromCodePoint(parseInt(decimal ?? hex!, decimal ? 10 : 16));
      return HTML_ENTITIES[name!.toLowerCase()] ?? all;
    })
    .replace(/\\(.)/g, "$1")
    .replace(/[{}]/g, "")
    .trim();
}

/** ChordPro song text for a pasted or loaded ABC score, with chords and keys in
 * `systemCode`. A tunebook (several X: tunes) stays one score whose titles name
 * its tunes, so its header fields are only copied, never removed. */
export function abcToChordProSong(abcText: string, systemCode: ChordSystemCode): string {
  const lines = abcText.replace(/\r\n?/g, "\n").split("\n");
  while (lines.length && !lines[0].trim()) lines.shift();
  while (lines.length && !lines[lines.length - 1].trim()) lines.pop();

  const references = lines.filter((line) => /^[ \t]*X:/.test(line)).length;
  const move = references <= 1;
  const titles: string[] = [];
  const composers: string[] = [];
  let key = "";
  let time = "";
  let tempo = "";
  const score: string[] = [];
  // Without X: the header starts at the top; otherwise at the first tune's X:.
  let inHeader = references === 0;
  let headerDone = false;
  let continued: string[] | null = null;
  for (const line of lines) {
    const field = headerDone ? null : /^[ \t]*([A-Za-z+]):(.*)$/.exec(line);
    if (!inHeader && field?.[1] === "X") inHeader = true;
    if (!field || !inHeader) {
      if (inHeader && line.trim() && !line.trimStart().startsWith("%")) continued = null;
      score.push(line);
      continue;
    }
    const name = field[1];
    const value = field[2].replace(/(^|[^\\])%.*$/, "$1").trim();
    if (name === "+" && continued) {
      continued[continued.length - 1] += " " + decodeAbcText(value);
      continue;
    }
    continued = null;
    if (name === "T" || name === "C") {
      const list = name === "T" ? titles : composers;
      list.push(decodeAbcText(value));
      if (move) {
        continued = list;
        continue;
      }
    } else if (name === "K") {
      key = abcKeyToSongKey(value, systemCode);
      headerDone = true;
    } else if (name === "M") {
      time = songMeter(value);
    } else if (name === "Q") {
      const parsed = songTempo(value);
      if (parsed) {
        tempo = String(parsed.qpm);
        if (move && parsed.exact) continue;
      }
    }
    score.push(line);
  }

  const song: string[] = [];
  const directive = (name: string, value: string) => {
    if (value) song.push(`{${name}: ${value}}`);
  };
  directive("title", titles[0] ?? "");
  directive("subtitle", titles.slice(1).filter(Boolean).join(" / "));
  directive("composer", composers.filter(Boolean).join(", "));
  directive("key", key);
  directive("time", time);
  directive("tempo", tempo);
  song.push("{start_of_abc}", ...score, "{end_of_abc}");
  return song.join("\n");
}

const ABC_BLOCK = /(^[ \t]*\{[ \t]*start_of_abc\b[\s\S]*?(?:^[ \t]*\{[ \t]*end_of_abc\b[^\n]*$|$(?![\s\S])))/m;

/** Applies `transform` to ChordPro text outside its ABC blocks. ABC writes note
 * chords and inline fields in square brackets ([CEG], [K:G], [P:A]), which must
 * never be taken for — or rewritten as — ChordPro chords. */
export function mapOutsideAbcBlocks(text: string, transform: (chordPro: string) => string): string {
  return text
    .split(ABC_BLOCK)
    .map((part, index) => (index % 2 ? part : transform(part)))
    .join("");
}
