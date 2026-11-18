import { ChordProChord, type ChordProChordBase, type ChordProDocument, type ChordProLine, type ChordSystem } from "./chordpro_base";
import { type Key, Mode } from "./note_system";

type ChordQuality = "major" | "minor" | "dim" | "aug" | "open";
interface ChordEvent {
  root: number;
  quality: ChordQuality;
  dominant: boolean;
}
interface ChordSection {
  tag: string;
  line: number;
  explicit: number;
  chords: ChordEvent[];
}
interface ProgressionGroup {
  id: number;
  first: number;
  pattern: ChordEvent[];
  scores: number[];
  count: number;
}
interface Occurrence {
  section: ChordSection;
  group: number;
  shift: number;
  similarity?: number;
}
export interface DocumentKeyAnalysis {
  key: string | null;
  sections: ReturnType<typeof analyzeSections>["sections"];
  writtenKeyByLine: ReadonlyMap<ChordProLine, string>;
}

const pc = (n: number) => ((n % 12) + 12) % 12;
const signed = (n: number) => (pc(n) > 6 ? pc(n) - 12 : pc(n));
const majorScale = [0, 2, 4, 5, 7, 9, 11];
const qualities: ChordQuality[] = ["major", "minor", "minor", "major", "major", "minor", "dim"];
const modes = ["", " II", " III", " IV", " V", "m", " VII"];
const states = Array.from({ length: 84 }, (_, i) => i);
const modeOf = (state: number) => Math.floor(state / 12);
const shiftState = (state: number, shift: number) => modeOf(state) * 12 + pc(state + shift);
const commonMode = (mode: number) => mode === Mode.ionian || mode === Mode.aeolian;
const nameCache = new WeakMap<ChordSystem, string[]>();
function keyName(state: number, system: ChordSystem) {
  let names = nameCache.get(system);
  if (!names) {
    names = [];
    const keys = [...new Set(system.keys.values())].sort((a, b) => Math.abs(a.signature) - Math.abs(b.signature));
    for (const key of keys) {
      const root = system.stringToNote(key.baseNote);
      if (root !== null) names[12 * key.scaleType + root] ??= key.name;
    }
    nameCache.set(system, names);
  }
  return names[state] ?? system.noteToString(state % 12) + modes[modeOf(state)];
}
const scaleQualities = modes.map((_, mode) => {
  const scale = new Map<number, ChordQuality>();
  majorScale.forEach((interval, degree) => scale.set(pc(interval - majorScale[mode]), qualities[degree]));
  return scale;
});

export function chordEvent(system: ChordSystem, chord: string | ChordProChordBase): ChordEvent | null {
  const info = system.identifyChord(chord);
  if (!info) return null;
  // Degrees preserve the distinction between a minor third and an altered 9th.
  const tones = new Set(info.chordInfo.desc.split("-"));
  let quality: ChordQuality = "open";
  if (tones.has("b3")) quality = tones.has("b5") ? "dim" : "minor";
  else if (tones.has("3")) quality = tones.has("#5") ? "aug" : "major";
  return { root: info.baseNote, quality, dominant: quality === "major" && tones.has("b7") };
}

export function collectChordSections(doc: ChordProDocument) {
  const events = new Map<ChordProLine, ChordEvent[]>();
  doc.forAllChords((chord, line) => {
    if (chord instanceof ChordProChord && chord.added === false) return;
    const event = chordEvent(doc.system, chord);
    if (!event) return;
    const existing = events.get(line);
    if (existing) existing.push(event);
    else events.set(line, [event]);
  });
  const sections: (ChordSection & { lines: ChordProLine[] })[] = [];
  let current: (typeof sections)[number] | undefined;
  for (const [index, line] of doc.lines.entries()) {
    const info = line.getSectionInfo();
    const chords = events.get(line);
    if (!current || current.tag !== info.key || line.startsSection === info.name || (!info.key && !line.lyrics.trim() && !chords)) {
      current = { tag: info.key, line: index + 1, explicit: info.transpose ?? 0, chords: [], lines: [] };
      sections.push(current);
    }
    current.lines.push(line);
    if (chords) {
      if (!current.chords.length) current.line = line.sourceLineNumber >= 0 ? line.sourceLineNumber + 1 : index + 1;
      current.chords.push(...chords);
    }
  }
  return sections.filter((s) => s.chords.length);
}

export function progression(events: ChordEvent[]) {
  // Rearticulating the same harmony on several syllables adds no new change.
  return events.filter((c, i) => !i || c.root !== events[i - 1].root || c.quality !== events[i - 1].quality);
}

function repeatMatch(a: ChordEvent[], b: ChordEvent[]) {
  // Require several distinct roots and agreement on the order and chord quality.
  // A longer common subsequence tolerates a passing chord or a changed ending.
  const shortest = Math.min(a.length, b.length),
    longest = Math.max(a.length, b.length);
  if (shortest < 4 || shortest / longest < 0.8 || new Set(a.map((c) => c.root)).size < 3 || new Set(b.map((c) => c.root)).size < 3) return null;
  const same = (x: ChordEvent, y: ChordEvent, shift: number) => pc(x.root + shift) === y.root && x.quality === y.quality;
  const shift = pc(b[0].root - a[0].root);
  if (a.length === b.length && a.every((x, i) => same(x, b[i], shift))) return { shift, similarity: 1 };
  if (shortest < 5 || longest > 128) return null;
  const ranks = [];
  for (let offset = 0; offset < 12; offset++) {
    const row = new Uint16Array(b.length + 1);
    for (const x of a) {
      let diagonal = 0;
      for (let j = 1; j <= b.length; j++) {
        const old = row[j];
        row[j] = same(x, b[j - 1], offset) ? diagonal + 1 : Math.max(old, row[j - 1]);
        diagonal = old;
      }
    }
    ranks.push({ shift: offset, similarity: row[b.length] / longest });
  }
  ranks.sort((x, y) => y.similarity - x.similarity);
  return ranks[0].similarity >= 0.8 && ranks[0].similarity - ranks[1].similarity >= 0.15 ? ranks[0] : null;
}

function harmonicScore(chords: ChordEvent[], state: number) {
  const mode = modeOf(state),
    scale = scaleQualities[mode],
    tonicQuality = scale.get(0);
  let score = 0;
  for (let i = 0; i < chords.length; i++) {
    const c = chords[i],
      degree = pc(c.root - state),
      expected = scale.get(degree);
    const prev = chords[i - 1],
      next = chords[i + 1];
    const tonic = degree === 0 && c.quality === tonicQuality;
    const resolves = next && pc(c.root - next.root) === 7 && scale.has(pc(next.root - state));
    if (expected === c.quality) score += 1.35;
    else if (c.quality === "open" && expected) score += 0.8;
    else if (mode === Mode.aeolian && degree === 7 && c.quality === "major") score += 1.2;
    else if (c.quality === "major" && resolves) score += 0.6;
    else score -= expected ? 0.65 : 1.3;
    if (c.dominant && degree !== 7 && !resolves) score -= 0.5;
    if (!tonic) continue;
    score += 0.6;
    if (!i) score += 1.65;
    if (i === chords.length - 1) {
      score += 2.1;
      if (prev && chords[0].root === c.root && chords[0].quality === c.quality && pc(prev.root - c.root) === 7 && prev.quality === "major")
        score += 1.5;
    }
    if (prev && pc(prev.root - c.root) === 7 && prev.quality === "major") score += prev.dominant ? 3.5 : 2;
    if (prev && pc(prev.root - c.root) === 5) score += 0.9;
  }
  // Bound the leverage of a long vamp. Modal explanations need distinctive harmony.
  return (score / Math.sqrt(chords.length)) * Math.min(1, Math.sqrt(24 / chords.length)) - (commonMode(mode) ? 0 : 2.6);
}

function groupSections(sections: ChordSection[]) {
  const groups: ProgressionGroup[] = [];
  const entries: Occurrence[] = [];
  for (const section of sections) {
    const pattern = progression(section.chords);
    let group, match;
    for (const candidate of groups) {
      const found = repeatMatch(candidate.pattern, pattern);
      if (found && (!match || found.similarity > match.similarity)) {
        group = candidate;
        match = found;
      }
    }
    if (!group) {
      group = { id: groups.length, first: entries.length, pattern, scores: states.map(() => 0), count: 0 };
      groups.push(group);
    }
    const shift = match?.shift ?? 0;
    for (const k of states) group.scores[k] += harmonicScore(section.chords, shiftState(k, shift));
    group.count++;
    entries.push({ section, group: group.id, shift, similarity: match?.similarity });
  }
  // Reprises inform the reference progression once, even if the finale repeats many times.
  for (const g of groups) g.scores = g.scores.map((s) => s / g.count);
  return { groups, entries };
}

// Each distinct progression has one unknown reference key. Neighbouring sections
// favour continuity of their written local keys. Reprises share a key variable
// even across intervening sections; their detected interval is a hard constraint.
function fit(groups: ProgressionGroup[], entries: Occurrence[], openingState?: number) {
  const neighbours = groups.map((): [number, number][] => []);
  const edges: [number, number, number][] = [],
    seen = new Set();
  for (let i = 1; i < entries.length; i++) {
    const a = entries[i - 1],
      b = entries[i];
    // A written lift already has independent interval evidence. The preceding
    // bridge need not end in the lifted key; forcing continuity here can
    // incorrectly move the reference chorus and hence the song's opening key.
    if (b.shift !== 0 && b.similarity !== undefined) continue;
    if (a.group === b.group) continue;
    const edge: [number, number, number] = [a.group, b.group, pc(a.shift - b.shift)];
    const identity = a.group < b.group ? edge.join("/") : [b.group, a.group, pc(-edge[2])].join("/");
    if (seen.has(identity)) continue;
    seen.add(identity);
    edges.push(edge);
    neighbours[a.group].push([b.group, edge[2]]);
    neighbours[b.group].push([a.group, -edge[2]]);
  }
  const continuity = 3.4;
  const local = groups.map((g) => bestIndex(g.scores));
  // Coordinate ascent with independent and common-key starts handles loops
  // introduced by non-adjacent reprises. This is a bounded heuristic search.
  const common = states.map((k) => groups.reduce((s, g) => s + g.scores[k], 0));
  const starts = [
    ...new Set([
      local[0],
      ...states
        .slice()
        .sort((a, b) => common[b] - common[a])
        .slice(0, 5),
    ]),
  ];
  let best = local,
    bestScore = -Infinity;
  for (const seed of [local, ...starts.map((k) => groups.map(() => k))]) {
    const keys = seed.slice();
    if (openingState !== undefined) keys[0] = openingState;
    for (let pass = 0; pass < 16; pass++) {
      let changed = false;
      for (let j = 0; j < groups.length; j++) {
        const i = pass % 2 ? groups.length - 1 - j : j;
        if (i === 0 && openingState !== undefined) continue;
        const scores = groups[i].scores.slice();
        for (const [other, shift] of neighbours[i]) scores[shiftState(keys[other], -shift)] += continuity;
        const next = bestIndex(scores);
        if (scores[next] > scores[keys[i]] + 1e-8) {
          keys[i] = next;
          changed = true;
        }
      }
      if (!changed) break;
    }
    let score = groups.reduce((s, g) => s + g.scores[keys[g.id]], 0);
    for (const [a, b, diff] of edges) if (shiftState(keys[a], diff) === keys[b]) score += continuity;
    if (score > bestScore + 1e-8) {
      best = keys;
      bestScore = score;
    }
  }
  return best;
}

function bestIndex(scores: number[]) {
  return scores.reduce((best, n, i) => (n > scores[best] ? i : best), 0);
}

export function analyzeSections(sections: ChordSection[], system: ChordSystem, authoredKey?: Key) {
  if (!sections.length) return { key: authoredKey?.name ?? null, sections: [] };
  // Express the search relative to the first chord so even ambiguous ties
  // resolve identically if a player transposes the whole song.
  const origin = sections[0].chords[0].root;
  const relative = sections.map((s) => ({ ...s, chords: s.chords.map((c) => ({ ...c, root: pc(c.root - origin) })) }));
  const { groups, entries } = groupSections(relative);
  const tonic = authoredKey ? system.stringToNote(authoredKey.baseNote) : null;
  const opening = authoredKey && tonic !== null ? authoredKey.scaleType * 12 + pc(tonic - origin) : undefined;
  const keys = fit(groups, entries, opening).map((k) => shiftState(k, origin));
  const base = keys[entries[0].group];
  const displayName = (state: number) => (state === base && authoredKey ? authoredKey.name : keyName(state, system));
  const results = entries.map(({ section, group, shift, similarity }, i) => {
    const written = shiftState(keys[group], shift),
      sounding = shiftState(written, section.explicit);
    return {
      line: section.line,
      tag: section.tag,
      chords: section.chords.length,
      writtenKey: displayName(written),
      soundingKey: displayName(sounding),
      semitonesFromBase: signed(sounding - base),
      explicitShift: section.explicit,
      ...(similarity === undefined ? {} : { referenceSection: groups[group].first + 1, writtenRepeatShift: signed(shift), similarity }),
      changed: i > 0 && sounding !== shiftState(keys[entries[i - 1].group], entries[i - 1].shift + entries[i - 1].section.explicit),
    };
  });
  return { key: displayName(base), sections: results };
}

export function analyzeDocumentKeys(doc: ChordProDocument): DocumentKeyAnalysis {
  const sections = collectChordSections(doc);
  const result = analyzeSections(sections, doc.system, doc.key ? doc.system.getKey(doc.key) : undefined);
  const writtenKeyByLine = new Map<ChordProLine, string>();
  sections.forEach((section, i) => {
    for (const line of section.lines) writtenKeyByLine.set(line, result.sections[i].writtenKey);
  });
  return { ...result, writtenKeyByLine };
}

/** Use the same enharmonic spelling as the detector after an instruction or section-tag transpose. */
export function projectedKeyName(system: ChordSystem, writtenKey: string, shift = 0) {
  if (!writtenKey || !pc(shift)) return writtenKey;
  const key = system.getKey(writtenKey);
  if (!key) return writtenKey;
  const root = system.stringToNote(key.baseNote);
  return root === null ? key.transposedKey(shift) : keyName(key.scaleType * 12 + pc(root + shift), system);
}
