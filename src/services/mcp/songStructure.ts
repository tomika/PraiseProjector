/**
 * A song's sections and its instructions as the app reads them, for the MCP tools: the
 * names instructions can use, the song's own order, and an instruction text resolved
 * line by line (the reading of the instructions editor and the projection).
 */
import type { ChordSystemCode } from "../../../common/pp-types";
import { ChordProDocument, ChordProSectionInfo, getChordSystem } from "../../../chordpro/chordpro_base";
import { InstructionItem, Instructions } from "../../../chordpro/chordpro_instructions";
import { Song } from "../../../db-common/Song";
import type { McpInstructionAnalysis, McpInstructionLine, McpSongSection, McpSongStructure } from "./types";

const systemOf = (system: string): ChordSystemCode => (system === "S" ? "S" : "G");

/**
 * Sections written out with the same lyrics, by the names instructions use. A song should
 * hold each section once and repeat it with instructions or a comment line naming it.
 */
function repeatedSections(song: Song, document: ChordProDocument): string[][] {
  const blocks = new Map<number, { name: string; lyrics: string }>();
  for (const section of song.Sections) {
    // Lyrics outside any section have no name an instruction could use.
    if (!section.tag) continue;
    const name = Instructions.findSection(document, section.tag)?.instructionName() || section.tag.trim();
    const block = blocks.get(section.block) ?? { name, lyrics: "" };
    block.lyrics += ` ${section.text}`;
    blocks.set(section.block, block);
  }
  const byLyrics = new Map<string, string[]>();
  for (const { name, lyrics } of blocks.values()) {
    const key = lyrics.replace(/\s+/g, " ").trim().toLocaleLowerCase();
    if (key) byLyrics.set(key, [...(byLyrics.get(key) ?? []), name]);
  }
  return [...byLyrics.values()].filter((names) => names.length > 1);
}

export function songStructure(text: string, system: string): McpSongStructure {
  const song = new Song(text, systemOf(system));
  const document = new ChordProDocument(getChordSystem(systemOf(system)), text);
  const sections: McpSongSection[] = [];
  const seen = new Set<string>();
  const addSections = (doc: ChordProDocument) => {
    for (const { info } of doc.sectionInfo.values()) {
      const name = info.instructionName();
      if (!name || seen.has(name.toLocaleLowerCase())) continue;
      seen.add(name.toLocaleLowerCase());
      const firstLine =
        song
          .InstructedSections(name, false)[0]
          ?.text.split("\n")
          .find((line) => line.trim())
          ?.trim() ?? "";
      // A part or verse of a score: the score that plays it when named as a whole.
      const partOf =
        doc === document
          ? ""
          : (doc.lines
              .find((line) => line.getSectionInfo() === info)
              ?.abcSource?.getSectionInfo()
              .instructionName() ?? "");
      sections.push({
        name,
        kind: info.name.replace(/^start_of_/, ""),
        ...(info.multiplier && info.multiplier > 1 ? { repeat: info.multiplier } : {}),
        ...(info.transpose ? { transpose: info.transpose } : {}),
        ...(partOf ? { partOf } : {}),
        firstLine: firstLine.slice(0, 80),
      });
    }
  };
  addSections(document);
  // Parts and verses of a score with lyrics can be named as well.
  const expanded = document.expandAbc();
  if (expanded !== document) addSections(expanded);
  return { sections, defaultInstructions: Instructions.defaultsFor(document), repeatedSections: repeatedSections(song, document) };
}

export function analyzeInstructions(text: string, system: string, instructions: string): McpInstructionAnalysis {
  const document = new ChordProDocument(getChordSystem(systemOf(system)), text);
  const read = (source: string) => {
    const list = new Instructions();
    list.parse(source, document);
    return list;
  };
  const asSection = (item: InstructionItem | undefined) =>
    item?.info && item.multiplier != null ? { section: item.info.instructionName(), repeat: item.multiplier, transpose: item.transpose ?? 0 } : null;
  const lines = instructions.split(/\r?\n/).map((line): McpInstructionLine => {
    if (!line.trim()) return { line, kind: "empty" };
    const section = asSection(read(line).items[0]);
    if (!section) return { line, kind: "note" };
    // The parser's own reading of the written name (spacing, modifiers): anything else
    // means the line fell back to another section with the same base name.
    const written = new ChordProSectionInfo("start_of_chorus:" + line.trim()).instructionName();
    return { line, kind: "section", ...section, exact: written.toLocaleLowerCase() === section.section.toLocaleLowerCase() };
  });
  const list = read(instructions);
  return {
    lines,
    normalized: list.format(),
    order: list.items.filter((item) => item.value.trim()).map((item) => asSection(item) ?? { note: item.value.trim() }),
  };
}
