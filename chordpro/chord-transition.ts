import { getChordSystem, type ChordSystem } from "./chordpro_base";
import type { NoteSystemCode } from "./note_system";

export interface ChordTransitionOptions {
  /** Number of inserted chords (0–32). Defaults to 2. */
  steps?: number;
  /** Inclusive range of inserted chord counts. Defaults to 0 through 4. */
  minSteps?: number;
  maxSteps?: number;
  /** Pop uses diatonic triads. Cadential also allows V7 of the landing chord. */
  style?: "pop" | "cadential";
  /** S uses international B/Bb, G uses German H/B. Defaults to S. */
  noteSystem?: NoteSystemCode;
}

function readChord(system: ChordSystem, label: string) {
  const chord = system.identifyChord(label.trim());
  if (!chord) throw new RangeError(`Unknown chord: ${label}`);
  const root = chord.baseNote;
  const tones = new Set(chord.chordInfo.steps.map((step) => (root + step + 12) % 12));
  return { label, root, bass: chord.bassNote ?? root, tones, id: root + ":" + chord.chordInfo.desc };
}

type Harmony = ReturnType<typeof readChord>;

function movement(from: Harmony, to: Harmony, cadential: boolean) {
  if (from.root === to.root) return from.id === to.id ? 0 : 1;
  const interval = (to.root - from.root + 12) % 12;
  const bassDistance = Math.abs(from.bass - to.bass);
  let score = -0.25 * Math.min(bassDistance, 12 - bassDistance);
  for (const tone of from.tones) if (to.tones.has(tone)) score += 1;
  if (interval === 5) score += cadential ? 3 : 1.5;
  if (interval === 7) score += cadential ? 1 : 2;
  if (interval === 5 && from.tones.has((from.root + 4) % 12) && from.tones.has((from.root + 10) % 12)) score += 4;
  return score;
}

export interface RankedChordTransition {
  /** Inserted chord symbols, in playing order. */
  chords: string[];
  /** Style-dependent heuristic score. Higher is preferred within one request. */
  score: number;
}

interface Path {
  score: number;
  chord: Harmony;
  parent?: Path;
}

/** Ranks distinct bridges across all allowed lengths. Both endpoints are in concert pitch. */
export function rankChordTransitions(
  sourceKey: string,
  targetKey: string,
  sourceChord: string,
  targetChord: string,
  options: ChordTransitionOptions & { limit?: number } = {}
): RankedChordTransition[] {
  const { steps, style = "cadential", noteSystem = "S", limit = 5 } = options;
  if (steps !== undefined && (options.minSteps !== undefined || options.maxSteps !== undefined))
    throw new RangeError("Use either steps or minSteps/maxSteps");
  const min = steps ?? options.minSteps ?? 0;
  const max = steps ?? options.maxSteps ?? Math.max(min, 4);
  if (!Number.isInteger(min) || !Number.isInteger(max) || min < 0 || min > max || max > 32)
    throw new RangeError("Expected integer step counts with 0 <= minSteps <= maxSteps <= 32");
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new RangeError("limit must be an integer between 1 and 100");
  if (style !== "pop" && style !== "cadential") throw new RangeError("Unknown transition style");
  if (noteSystem !== "G" && noteSystem !== "S") throw new RangeError("Unknown note system");
  const system = getChordSystem(noteSystem);
  const source = system.getKey(sourceKey.trim());
  const target = system.getKey(targetKey.trim());
  if (!source || !target) throw new RangeError(`Unknown key: ${source ? targetKey : sourceKey}`);
  const start = readChord(system, sourceChord);
  const end = readChord(system, targetChord);

  const sourceTriads = Array.from(source.chords(true), (label) => readChord(system, label));
  const targetTriads = Array.from(target.chords(true), (label) => readChord(system, label));
  const sourceIds = new Set(sourceTriads.map((chord) => chord.id));
  const targetIds = new Set(targetTriads.map((chord) => chord.id));
  const vocabulary = new Map([...sourceTriads, ...targetTriads].map((chord) => [chord.id, chord]));
  const cadential = style === "cadential";
  if (cadential) {
    const dominant = readChord(system, target.noteName((end.root + 7) % 12) + "7");
    vocabulary.set(dominant.id, dominant);
  }
  const candidates = [...vocabulary.values()];

  // Local edge costs let every length share one layered search. Paths ending on
  // the same last two chords have identical future costs, including the penalty
  // for immediately retracing a change. Keeping their best K is therefore exact.
  function edge(from: Harmony, to: Harmony) {
    let score = movement(from, to, cadential);
    if (targetIds.has(from.id) && !sourceIds.has(from.id) && sourceIds.has(to.id) && !targetIds.has(to.id)) score -= 2;
    if (cadential && from.tones.has((from.root + 4) % 12) && from.tones.has((from.root + 10) % 12) && (from.root + 5) % 12 !== to.root) score -= 3;
    return score;
  }

  const winners: { path: Path; steps: number; score: number }[] = [];
  let groups: Path[][] = [[{ chord: start, score: 0 }]];
  for (let length = 0; length <= max; length++) {
    if (length >= min) {
      for (const group of groups) {
        if (!group.length) continue;
        const last = group[0].chord;
        if (length && last.id === end.id) continue;
        const arrival = edge(last, end) + (group[0].parent?.chord.id === end.id ? -3 : 0);
        // Average movement quality per change, reward a convincing arrival
        // separately, and charge a small cost for each extra harmony.
        for (const path of group) {
          const score = (path.score + arrival) / (length + 1) + 0.35 * arrival - 0.22 * length;
          winners.push({ path, steps: length, score });
        }
      }
      winners.sort((a, b) => b.score - a.score || a.steps - b.steps);
      winners.splice(limit);
    }
    if (length === max) break;
    groups = candidates.flatMap((chord) => {
      const byPredecessor = new Map<string, Path[]>();
      for (const group of groups) {
        if (!group.length) continue;
        const from = group[0].chord;
        if (from.id === chord.id) continue;
        let cost = edge(from, chord);
        if (!length && !sourceIds.has(chord.id)) cost -= 1;
        if (chord.id === end.id || chord.id === start.id) cost -= 2;
        if (group[0].parent?.chord.id === chord.id) cost -= 3;
        let paths = byPredecessor.get(from.id);
        if (!paths) byPredecessor.set(from.id, (paths = []));
        for (const parent of group) paths.push({ chord, score: parent.score + cost, parent });
      }
      return [...byPredecessor.values()].map((paths) => paths.sort((a, b) => b.score - a.score).slice(0, limit));
    });
  }
  return winners.map(({ path, score }) => {
    const chords: string[] = [];
    for (let node = path; node.parent; node = node.parent) chords.push(node.chord.label);
    return { chords: chords.reverse(), score };
  });
}

/** Returns the highest-ranked bridge. Use steps for a fixed length or minSteps/maxSteps for a range. */
export function generateChordTransition(
  sourceKey: string,
  targetKey: string,
  sourceChord: string,
  targetChord: string,
  options: ChordTransitionOptions = {}
): string[] {
  return rankChordTransitions(sourceKey, targetKey, sourceChord, targetChord, { ...options, limit: 1 })[0].chords;
}
