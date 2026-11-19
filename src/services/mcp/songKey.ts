/**
 * A song's key estimated from its chords by the app's own key detector (the one the
 * editor and the song view use), for the MCP tools. The estimate ignores the song's
 * {key} line on purpose, so an assistant can check the stated key against the chords.
 */
import type { ChordSystemCode } from "../../../common/pp-types";
import { ChordProDocument, getChordSystem, type ChordSystem } from "../../../chordpro/chordpro_base";
import { analyzeSections, collectChordSections } from "../../../chordpro/key-analysis";
import { Mode } from "../../../chordpro/note_system";
import { songKeyDirective } from "./songMeta";
import type { McpKeyEstimate, McpSectionKey } from "./types";

const systemOf = (system: string): ChordSystemCode => (system === "S" ? "S" : "G");

/** Same tonic and mode, whatever the spelling (F# = Gb, Am = A minor). */
function sameKey(system: ChordSystem, a: string, b: string): boolean | undefined {
  const keyA = system.getKey(a),
    keyB = system.getKey(b);
  if (!keyA || !keyB) return undefined;
  const rootA = system.stringToNote(keyA.baseNote),
    rootB = system.stringToNote(keyB.baseNote);
  if (rootA === null || rootB === null) return undefined;
  return rootA === rootB && keyA.scaleType === keyB.scaleType;
}

/** The stated key's tonic chord (minor for minor modes, major for the others) occurs in the song. */
function tonicUsed(system: ChordSystem, stated: string, sections: ReturnType<typeof collectChordSections>): boolean | undefined {
  const key = system.getKey(stated);
  const root = key ? system.stringToNote(key.baseNote) : null;
  if (!key || root === null) return undefined;
  const minor = key.scaleType === Mode.aeolian || key.scaleType === Mode.dorian || key.scaleType === Mode.phrygian;
  const wanted = key.scaleType === Mode.locrian ? "dim" : minor ? "minor" : "major";
  return sections.some((section) => section.chords.some((chord) => chord.root === root && chord.quality === wanted));
}

export function estimateSongKey(text: string, system: string): McpKeyEstimate {
  const chordSystem = getChordSystem(systemOf(system));
  const document = new ChordProDocument(chordSystem, text);
  const sections = collectChordSections(document);
  const analysis = analyzeSections(sections, chordSystem);
  const statedKey = songKeyDirective(text);
  const estimatedKey = analysis.key;
  const agrees = statedKey && estimatedKey ? sameKey(chordSystem, statedKey, estimatedKey) : undefined;
  const tonic = statedKey && sections.length ? tonicUsed(chordSystem, statedKey, sections) : undefined;
  const sectionKeys: McpSectionKey[] = analysis.sections.map((result, i) => ({
    section: sections[i].lines[0]?.getSectionInfo().instructionName() || result.tag || "",
    line: result.line,
    writtenKey: result.writtenKey,
    soundingKey: result.soundingKey,
    semitonesFromBase: result.semitonesFromBase,
    ...(result.explicitShift ? { sectionTranspose: result.explicitShift } : {}),
  }));
  const modulates = sectionKeys.some((section) => section.semitonesFromBase !== 0 || section.writtenKey !== estimatedKey);
  return {
    estimatedKey,
    statedKey,
    ...(agrees === undefined ? {} : { agreesWithStatedKey: agrees }),
    ...(tonic === undefined ? {} : { statedKeyTonicUsed: tonic }),
    ...(modulates ? { sectionKeys } : {}),
  };
}
