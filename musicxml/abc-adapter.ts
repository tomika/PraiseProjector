/** abcjs adaptation of xml2abc's one-measure-per-line output. Based on the
 * project's pic2abc/abcconv.py: use one L:, align all voices' systems, and keep
 * each lyric verse attached to exactly the same measures as its notes. */
interface Voice {
  head: string;
  pre: string[];
  measures: string[];
  lyrics: string[][];
  breaks: number[];
}

function gcd(a: number, b: number): number {
  return b ? gcd(b, a % b) : a;
}
function duration(text: string): number {
  const m = /^(\d*)(\/*)(\d*)$/.exec(text)!;
  return (Number(m[1]) || 1) / (m[2] ? (Number(m[3]) || 2) * 2 ** (m[2].length - 1) : 1);
}
function formatDuration(value: number): string {
  let den = 1;
  while (den < 65536 && Math.abs(value * den - Math.round(value * den)) > 1e-8) den *= 2;
  const num = Math.round(value * den),
    g = gcd(num, den);
  const n = num / g,
    d = den / g;
  return d === 1 ? (n === 1 ? "" : String(n)) : `${n === 1 ? "" : n}/${d === 2 ? "" : d}`;
}
const representable = [
  ...new Set(Array.from({ length: 6 }, (_, k) => Array.from({ length: 6 }, (_, dots) => (2 - 1 / 2 ** dots) / 2 ** (k + 1))).flat()),
].sort((a, b) => b - a);

/** Exact rational duration is retained, including non-binary OMR gap fillers.
 * The emitted notes/rests each have a duration abcjs can engrave. */
function splitRest(kind: string, text: string): string {
  const units = duration(text),
    value = units / 8;
  if (value >= 1 || value <= 0 || representable.some((v) => Math.abs(v - value) < 1e-9)) return kind + text;
  const parts = (v: number): number[] | undefined => {
    const result: number[] = [];
    while (v > 1e-9) {
      const part = representable.find((p) => p <= v + 1e-9);
      if (!part) return;
      result.push(part);
      v -= part;
    }
    return result;
  };
  // Recover the small rational denominator from the ABC spelling, not from
  // floating point approximations. Tuplets are limited to abcjs's 2..9 range.
  const m = /^(\d*)(\/*)(\d*)$/.exec(text)!;
  let num = Number(m[1]) || 1;
  let den = (m[2] ? (Number(m[3]) || 2) * 2 ** (m[2].length - 1) : 1) * 8;
  const g = gcd(num, den);
  num /= g;
  den /= g;
  let odd = den;
  while (odd % 2 === 0) odd /= 2;
  const rests = (ps: number[]) => ps.map((p) => kind + formatDuration(p * 8)).join(" ");
  if (odd === 1) {
    const ps = parts(value);
    return ps ? rests(ps) : kind + text;
  }
  if (odd > 9) return kind + text;
  const binary = Math.floor(num / odd) / (den / odd);
  const q = 2 ** Math.floor(Math.log2(odd));
  const head = parts(binary),
    tail = parts(((value - binary) * odd) / q);
  if (!head || !tail) return kind + text;
  return `${head.length ? rests(head) + " " : ""}(${odd}:${q}:${tail.length}${rests(tail)}`;
}

function adaptMeasure(source: string, warnings: Set<string>): { text: string; lineBreak: boolean } {
  let text = "",
    i = 0,
    tuplet = 0,
    lineBreak = false;
  while (i < source.length) {
    const rest = source.slice(i);
    const opaque = /^(?:"(?:\\.|[^"\\])*"|![^!]*!|\{[^}]*\}|\[[A-Za-z]:[^\]]*\])/.exec(rest)?.[0];
    if (opaque) {
      if (/^\[I:\s*staff\s/.test(opaque)) warnings.add("Cross-staff notes remain on their voice's staff.");
      else if (/^!ped(?:-up)?!$/.test(opaque)) warnings.add("Pedal markings are not supported by abcjs and were omitted.");
      else {
        // abcjs treats an inline field after a decoration as a note chord.
        // Moving the field in front of those same decorations leaves its time
        // and the decorated note unchanged.
        const decorations = /^\[[A-Za-z]:/.test(opaque) ? /(?:![^!]*!\s*)+$/.exec(text) : null;
        if (decorations) text = text.slice(0, decorations.index) + opaque + decorations[0];
        else text += opaque;
      }
      i += opaque.length;
      continue;
    }
    if (rest[0] === "$") {
      lineBreak = true;
      i++;
      continue;
    }
    const tuple = /^\((\d+)(?::(\d*))?(?::(\d*))?/.exec(rest);
    if (tuple) {
      tuplet = Number(tuple[3] || tuple[1]);
      text += tuple[0];
      i += tuple[0].length;
      continue;
    }
    const token = /^(?:\[[^\]]+\]|[\^_=]*[A-Ga-g][,']*|[zx])(\d*\/*\d*)/.exec(rest);
    if (token) {
      const before = text.trimEnd().slice(-1),
        after = rest[token[0].length];
      if (/^[zx]/.test(token[0]) && !tuplet && before !== ">" && before !== "<" && after !== ">" && after !== "<") {
        const replacement = splitRest(token[0][0], token[1]);
        text += replacement;
        if (replacement.includes("(")) warnings.add("An irregular gap was preserved with tuplet rests; check the source rhythm.");
      } else text += token[0];
      tuplet = Math.max(0, tuplet - 1);
      i += token[0].length;
      continue;
    }
    if (rest[0] === "s") warnings.add("Stemless note styling is not supported by abcjs; note values are preserved.");
    else text += rest[0];
    i++;
  }
  return { text, lineBreak };
}

function splitLineEnd(measure: string): [string, string] {
  const m = /(::|[[\]|:]*[|\]])(:?)(\d[\d,-]*)?\s*$/.exec(measure);
  if (!m) return [measure, ""];
  let [, bar, opening] = m;
  const volta = m[3];
  if (bar === "::") {
    bar = ":|";
    opening = ":";
  }
  if (opening && volta) return [measure, ""];
  if (opening) return [measure.slice(0, m.index) + bar.replace("||", "|"), "|: "];
  if (volta) return [measure.slice(0, m.index) + bar, "[" + volta + " "];
  return [measure, ""];
}

export function adaptAbc(raw: string, fallbackTitle: string | null, warnings: Set<string>): string {
  const lines = raw.split(/\r?\n/),
    firstVoice = lines.findIndex((l) => /^V:\S+$/.test(l));
  if (firstVoice < 0) throw new Error("The MusicXML score contains no convertible music.");
  const header = lines.slice(0, firstVoice).filter((l) => !/^I:linebreak|^U:s=/.test(l));
  const titleIndex = header.findIndex((l) => l.startsWith("T:"));
  if (fallbackTitle !== null && titleIndex >= 0 && header[titleIndex] === "T:Title")
    header[titleIndex] = "T:" + fallbackTitle.replace(/[\r\n]/g, " ");
  const voices: Voice[] = [];
  let voice: Voice | undefined;
  for (const line of lines.slice(firstVoice)) {
    if (!line.trim()) continue;
    if (/^V:\S+$/.test(line)) {
      voice = { head: line, pre: [], measures: [], lyrics: [], breaks: [] };
      voices.push(voice);
      continue;
    }
    if (!voice) throw new Error("Unexpected MusicXML converter output.");
    if (line.startsWith("w:")) {
      if (!voice.measures.length || !line.endsWith("|")) throw new Error("Unexpected MusicXML lyric alignment.");
      voice.lyrics[voice.lyrics.length - 1].push(line.slice(3, -1));
      continue;
    }
    if (!voice.measures.length && /^(I:|%%)/.test(line)) {
      voice.pre.push(line);
      continue;
    }
    const { text, lineBreak } = adaptMeasure(line.replace(/ %\d+$/, ""), warnings);
    voice.measures.push(text);
    voice.lyrics.push([]);
    if (lineBreak) voice.breaks.push(voice.measures.length);
  }
  const count = Math.max(...voices.map((v) => v.measures.length));
  const breaks = [...new Set([0, ...voices.flatMap((v) => v.breaks)])].filter((i) => i < count).sort((a, b) => a - b);
  if (breaks.length === 1) for (let i = 4; i < count; i += 4) breaks.push(i);
  for (const v of voices) {
    header.push(v.head, ...v.pre);
    let carry = "";
    for (let n = 0; n < breaks.length; n++) {
      const a = breaks[n],
        b = breaks[n + 1] ?? count,
        measures = v.measures.slice(a, b);
      if (!measures.length) continue;
      measures[0] = carry + measures[0].trimStart();
      carry = "";
      if (b < v.measures.length) [measures[measures.length - 1], carry] = splitLineEnd(measures[measures.length - 1]);
      header.push(measures.join("").trim() + ` %${Math.min(b, v.measures.length)}`);
      const cells = v.lyrics.slice(a, b);
      let verses = Math.max(0, ...cells.map((c) => c.length));
      while (verses && !cells.some((c) => c[verses - 1]?.trim())) verses--;
      for (let k = 0; k < verses; k++) header.push("w: " + cells.map((c) => c[k] ?? "").join("|") + "|");
    }
  }
  return header.join("\n").trim() + "\n";
}
