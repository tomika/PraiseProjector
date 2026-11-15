/**
 * The application's own chord knowledge, for the MCP host. Three different questions:
 *
 * - does the app know the chord in a chord system (`identifyChord`: it can transpose it
 *   and draw its diagram),
 * - is the bracket text at least chord-shaped (the song model's `InvalidChords` check:
 *   it is stored and shown as written either way),
 * - what does the import wizard's normalizer make of a chord spelled as in a source
 *   text (`ChordNormalizer`): it accepts more spellings (fisz, lowercase minors, moll)
 *   but fewer chord types, and its result is German/Hungarian notation.
 */
import { allChordInfo } from "../../../chordpro/allchords";
import { getChordSystem } from "../../../chordpro/chordpro_base";
import { ChordNormalizer } from "../../../db-common/ChordMap";
import { Song } from "../../../db-common/Song";
import type { McpChordStatus } from "./types";

/** Chord checks repeat the same few hundred chords over thousands of songs. */
const statusCache = new Map<string, McpChordStatus>();

export function chordStatus(chord: string, system: string): McpChordStatus {
  const code = system === "S" ? "S" : "G";
  const cacheKey = code + chord;
  let status = statusCache.get(cacheKey);
  if (!status) {
    if (chord.trim() && getChordSystem(code).identifyChord(chord)) status = "recognized";
    else status = chord.trim() && !new Song(`[${chord}]`, code).InvalidChords.length ? "chord-shaped" : "not-a-chord";
    statusCache.set(cacheKey, status);
  }
  return status;
}

/** Every chord type with the suffixes that select it ("" is the plain major chord). */
export const knownChordTypes = (): { name: string; suffixes: string[] }[] =>
  allChordInfo.map((info) => ({ name: info.name, suffixes: [...info.symbols] }));

export const importerChord = (chord: string, sourceUsesH: boolean, lowercaseIsMinor: boolean): string =>
  ChordNormalizer.normalize(chord, sourceUsesH, lowercaseIsMinor);

/** Repeat marks and the like that may stand in a grid besides chords and separators. */
const GRID_MARK = /^(\(?\d*x\d*\)?|\(?\d+\)?|%|n\.?c\.?)$/i;

/**
 * A grid line split at its separators (spaces, |, a lone /, ., :, …). A token is a chord
 * when the app's chord finder reads the whole of it as one chord ("D/F#", "(Em7)"). Any
 * other word is reported apart: the finder also matches letters inside words, so on
 * transposing the app would change "Bridge" or "Fisz" letter by letter.
 */
export function gridChords(line: string, system: string): { chords: string[]; other: string[] } {
  const finder = getChordSystem(system === "S" ? "S" : "G");
  const chords: string[] = [];
  const other: string[] = [];
  for (const token of line.split(/[\s|.:,;]+/)) {
    if (!token || /^[/\-–—%]+$/.test(token) || GRID_MARK.test(token)) continue;
    const bare = /^\((.+)\)$/.exec(token)?.[1] ?? token;
    const found: string[] = [];
    let whole = true;
    finder.findAllChords(bare, (chord, prefix, suffix) => {
      found.push(chord);
      if (prefix || suffix) whole = false;
    });
    if (found.length === 1 && whole && found[0] === bare) chords.push(bare);
    else other.push(token);
  }
  return { chords, other };
}

export const importerConventions = (chords: string[]) => ({
  sourceUsesH: ChordNormalizer.tryDetermineHMode(chords),
  lowercaseIsMinor: ChordNormalizer.tryDetermineLCMollMode(chords),
});
