import { ChordProDocument, ChordSystem } from "../chordpro_base";
import { CHORDFORMAT_SIMPLIFIED } from "./chord-visual";

/**
 * Collects the chord labels that the diagram region must render.
 *
 * In simplified read-only mode these labels deliberately use the same reduced
 * chord identity as the inline display: extensions and slash-bass notes are
 * removed before deduplication. This prevents diagrams for authored chords
 * such as Cmaj7 or C/E from surviving next to an inline song that only shows C.
 */
export function collectChordDiagramLabels(
  document: ChordProDocument,
  system: ChordSystem,
  chordFormat: number,
  readOnly: boolean,
  preferNormalizedChord = false
): string[] {
  const simplify = readOnly && (chordFormat & CHORDFORMAT_SIMPLIFIED) === CHORDFORMAT_SIMPLIFIED;
  const chordSet = new Map<string, string>();
  let displayNormalizedChord = preferNormalizedChord;

  document.forAllChords((chord) => {
    const details = system.getChordDetails(chord, simplify);
    if (!details) return;

    // Simplified inline chords omit slash-bass notes as well as extensions.
    const bassSuffix = simplify || !details.bassNote ? "" : "/" + details.bassNote;
    const key = details.baseNote + (simplify ? details.modifier : details.normalized) + bassSuffix;
    const value = details.baseNote + details.modifier + bassSuffix;

    if (!displayNormalizedChord) {
      const previous = chordSet.get(key);
      if (previous) displayNormalizedChord = previous !== value;
    }
    chordSet.set(key, value);
  });

  const chords: string[] = [];
  chordSet.forEach((value, key) => chords.push(displayNormalizedChord ? key : value));
  return chords;
}
