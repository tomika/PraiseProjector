import type { ChordTransitionSettings, ChordTransitionStyle } from "../../../common/chord-transition-settings";
import type { Display } from "../../../common/pp-types";
import { matchesAbcRange } from "../../../chordpro/abc-range";
import { loadAbcjs } from "../../../chordpro/abcjs-lazy";
import { rankChordTransitions, type RankedChordTransition } from "../../../chordpro/chord-transition";
import { ChordProAbc, ChordProChordBase, ChordProDocument, getChordSystem, type ChordProLine } from "../../../chordpro/chordpro_base";
import { Instructions } from "../../../chordpro/chordpro_instructions";
import { analyzeDocumentKeys } from "../../../chordpro/key-analysis";
import { Key, type NoteSystemCode } from "../../../chordpro/note_system";
import { projectDisplaySequence } from "../../../chordpro/render/display-plan";
import {
  matchesTransitionPair,
  parseTransitionInstruction,
  splitInstructionLines,
  type TransitionInstruction,
  type TransitionRecommendation,
  type TransitionSongPair,
} from "../../../chordpro/transition-instruction";

const standard = getChordSystem("S");
type StyledTransition = RankedChordTransition & Pick<TransitionRecommendation, "style">;

export type SongHighlight = Pick<Display, "from" | "to" | "section" | "abcRange" | "song">;

interface SongTransitionDialogBase {
  pair: TransitionSongPair;
  sourceKey: string;
  targetKey: string;
  recommendations: TransitionRecommendation[];
  durationMs: number;
}

export type SongTransitionDialog = SongTransitionDialogBase &
  (
    | { saved: true }
    | {
        saved: false;
        styles: readonly ChordTransitionStyle[];
        recommendForStyles(styles: readonly ChordTransitionStyle[]): TransitionRecommendation[];
      }
  );

function readSong(display: Display): ChordProDocument {
  return new ChordProDocument(getChordSystem(display.system), display.song);
}

export function defaultTransitionInstructions(display: Display): string {
  return Instructions.defaultsFor(readSong(display).expandAbc());
}

function chordsInLine(line: ChordProLine): string[] {
  if (line.isComment) return [];
  if (!line.isGrid) return line.chords.map((chord) => chord.chord);
  const chords: string[] = [];
  line.doc.system.findAllChords(line.lyrics, (chord) => {
    chords.push(chord);
  });
  return chords;
}

/** The renderer owns grid/ABC order, instruction repeats and section transposes. */
function songEndpoint(doc: ChordProDocument, display: Display, first: boolean, highlight?: SongHighlight) {
  const songKey = doc.system.getKey(doc.key) ?? doc.system.getKey(analyzeDocumentKeys(doc.expandAbc()).key ?? "");
  if (!songKey) return null;
  doc.transpose(display.transpose ?? 0);
  const soundingKey = doc.system.getKey(songKey.transposedKey(display.transpose ?? 0)) ?? songKey;
  const key = new Key(standard, soundingKey.signature, soundingKey.scaleType);
  const raw = () => projectDisplaySequence({ document: doc, readOnly: true, instructionsMode: "", abcMode: "CHORDS" }).lines;
  const instructions = display.instructions?.trim() ? new Instructions() : null;
  if (instructions) instructions.parse(display.instructions!, doc);
  const instructed = instructions
    ? projectDisplaySequence({ document: doc, readOnly: true, instructions, instructionsMode: "FULL", abcMode: "CHORDS" }).lines
    : [];

  const endpoint = (rows: ReturnType<typeof raw>) => {
    for (let i = 0; i < rows.length; i++) {
      const { line } = rows[first ? i : rows.length - 1 - i];
      const names = chordsInLine(line);
      const chord = first ? names[0] : names.at(-1);
      if (!chord) continue;
      const parsed = doc.system.identifyChord(chord);
      if (!parsed) continue;
      const label = new ChordProChordBase(doc.system, chord);
      const symbol = key.noteName(parsed.baseNote) + label.symbol + (parsed.bassNote == null ? "" : "/" + key.noteName(parsed.bassNote));
      return symbol;
    }
    return null;
  };
  let chord: string | null = null;
  if (highlight) {
    const matches = ({ line }: (typeof instructed)[number]) =>
      line.sourceLineNumber >= highlight.from && line.sourceLineNumber < highlight.to && matchesAbcRange(line, highlight.abcRange);
    const matchingSections = instructed.filter(matches);
    const exact = matchingSections.filter(({ instructionIndex }) => instructionIndex === highlight.section);
    chord = endpoint(exact) ?? endpoint(raw().filter(matches)) ?? endpoint(matchingSections);
  }
  chord ??= endpoint(instructed) ?? endpoint(raw());
  return chord ? { key, chord } : null;
}

export function localizeTransitionChord(chord: string, noteSystem: NoteSystemCode): string {
  if (noteSystem === "S") return chord;
  const note = (value: string) => value.replace(/^Bb|^B/, (prefix) => (prefix === "Bb" ? "B" : "H"));
  return note(chord.replace(/\/([A-G][b#]?)$/, (_, bass: string) => "/" + note(bass)));
}

export function localizeTransitionKey(name: string, noteSystem: NoteSystemCode): string {
  const key = standard.getKey(name);
  return key ? new Key(getChordSystem(noteSystem), key.signature, key.scaleType).name : name;
}

function savedFor(instructions: string | undefined, pair: TransitionSongPair, placement: TransitionInstruction["placement"]) {
  const saved = splitInstructionLines(instructions ?? "")
    .map((line) => parseTransitionInstruction(line.trim()))
    .find((item) => item?.placement === placement && matchesTransitionPair(item, pair));
  return saved ?? null;
}

export async function recommendSongTransition(
  previous: Display,
  current: Display,
  highlight: SongHighlight | undefined,
  settings: ChordTransitionSettings,
  adjacent: boolean
): Promise<SongTransitionDialog | null> {
  const pair = { from: previous.songId, to: current.songId };
  const oldSong = readSong(previous);
  const newSong = readSong(current);
  if ([oldSong, newSong].some((doc) => doc.lines.some((line) => line instanceof ChordProAbc))) {
    await loadAbcjs().catch(() => undefined);
  }
  const from = songEndpoint(oldSong, previous, false, highlight);
  const to = songEndpoint(newSong, current, true);
  if (
    !from ||
    !to ||
    (standard.stringToNote(from.key.baseNote) === standard.stringToNote(to.key.baseNote) && from.key.scaleType === to.key.scaleType)
  )
    return null;
  const { minSteps, maxSteps, maxRecommendations, styles, order } = settings;
  const dialog = {
    pair,
    sourceKey: from.key.name,
    targetKey: to.key.name,
    durationMs: settings.autoClose ? settings.seconds * 1000 : 0,
  };
  const saved = adjacent && (savedFor(current.instructions, pair, "next") ?? savedFor(previous.instructions, pair, "previous"));
  if (saved) return { ...dialog, sourceKey: saved.sourceKey, targetKey: saved.targetKey, saved: true, recommendations: [saved] };

  const candidatesByStyle = new Map<ChordTransitionStyle, StyledTransition[]>();
  const rankedForStyle = (style: ChordTransitionStyle) => {
    const cached = candidatesByStyle.get(style);
    if (cached) return cached;
    const ranked = rankChordTransitions(dialog.sourceKey, dialog.targetKey, from.chord, to.chord, {
      minSteps,
      maxSteps,
      style,
      order,
      limit: maxRecommendations,
    }).map((item) => ({ ...item, style }));
    candidatesByStyle.set(style, ranked);
    return ranked;
  };
  const recommendForStyles = (activeStyles: readonly ChordTransitionStyle[]): TransitionRecommendation[] => {
    const rankedByStyle = activeStyles.map(rankedForStyle);
    // Give every style a turn before choosing another entry from the same style.
    // With one slot, the best result from each style ties for quality, so prefer the shorter one.
    const queues = maxRecommendations === 1 ? [rankedByStyle.flat().sort((a, b) => a.chords.length - b.chords.length)] : rankedByStyle;
    const selected = new Map<string, StyledTransition>();
    while (selected.size < maxRecommendations) {
      const size = selected.size;
      for (const queue of queues) {
        const next = queue.find((item) => !selected.has(item.chords.join(" ")));
        if (next) selected.set(next.chords.join(" "), next);
        if (selected.size === maxRecommendations) break;
      }
      if (selected.size === size) break;
    }
    // Each style has its own scoring rules. Measure the gap from its best visible
    // recommendation after deduplication so the same scale works for both styles.
    const bestByStyle = new Map<ChordTransitionStyle, number>();
    for (const { style, score } of selected.values()) {
      bestByStyle.set(style, Math.max(bestByStyle.get(style) ?? -Infinity, score));
    }
    const ranked = Array.from(selected.values(), ({ chords, style, score }) => ({
      chords,
      style,
      scoreGap: (bestByStyle.get(style) ?? score) - score,
    })).sort((a, b) => {
      const stepDifference = a.chords.length - b.chords.length;
      return (order === "steps" ? stepDifference : 0) || a.scoreGap - b.scoreGap || stepDifference;
    });
    return ranked.map(({ chords, style, scoreGap }) => ({
      chords: [from.chord, ...chords, to.chord],
      style,
      rating: Math.max(1, 5 - Math.round(scoreGap / 0.75)),
    }));
  };
  const recommendations = recommendForStyles(styles);
  return recommendations.length ? { ...dialog, recommendations, styles, recommendForStyles, saved: false } : null;
}
