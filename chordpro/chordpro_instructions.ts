// Instruction list model used by the ChordPro editor (instructions side pane,
// rendering pipeline) and by Song.ts (electron section list, projector preview).
// Extracted from chordpro_editor.ts so non-editor consumers can use it without
// pulling the full editor surface.

import { ChordProAbc, ChordProDocument, ChordProLine, ChordProSectionInfo } from "./chordpro_base";
import { isAbcjsLoaded } from "./abcjs-lazy";

export type InstructionItem = {
  value: string;
  multiplier?: number;
  transpose?: number;
  info?: ChordProSectionInfo;
};

export const INSTRUCTION_TRANSPOSE_MIN = -11;
export const INSTRUCTION_TRANSPOSE_MAX = 11;

/** Clamps a transpose value into the supported [-11, +11] range and returns
 *  `undefined` for 0 so the item drops back to its untransposed form. */
export function clampTranspose(value: number | undefined): number | undefined {
  if (value == null || !isFinite(value) || value === 0) return undefined;
  if (value < INSTRUCTION_TRANSPOSE_MIN) return INSTRUCTION_TRANSPOSE_MIN;
  if (value > INSTRUCTION_TRANSPOSE_MAX) return INSTRUCTION_TRANSPOSE_MAX;
  return Math.trunc(value);
}

/** Formats a transpose shift as a signed integer suffix (" +2" / " -3"). */
export function formatTransposeSuffix(transpose: number | undefined): string {
  if (!transpose) return "";
  return " " + (transpose > 0 ? "+" : "-") + Math.abs(transpose);
}

/** One lazily built ABC expansion shared by a whole lookup pass. The document
 *  caches the expansion itself, but validating that cache serializes the whole
 *  song, so a loop over many unresolved (comment) lines must not repeat it. */
function lazyAbcExpansion(doc: ChordProDocument): () => ChordProDocument {
  let expanded: ChordProDocument | undefined;
  return () => (expanded ??= doc.expandAbc());
}

export class Instructions {
  constructor(readonly items: InstructionItem[] = []) {}

  private static itemKey(item: InstructionItem) {
    return item.info ? item.info.instructionName() : item.value;
  }

  static findSection(doc: ChordProDocument, tag: string, abcExpansion = lazyAbcExpansion(doc)): ChordProSectionInfo | undefined {
    if (!tag) return undefined;
    const probe = new ChordProSectionInfo("start_of_chorus:" + tag);
    const target = probe.instructionName().toLocaleLowerCase();
    if (!target) return undefined;
    let baseFallback: ChordProSectionInfo | undefined;
    const targetBase = probe.baseTag.toLocaleLowerCase();
    for (const si of doc.sectionInfo.values()) {
      const info = si.info;
      const sectionName = info.instructionName();
      if (!sectionName) continue;
      if (sectionName.toLocaleLowerCase() === target) return info;
      if (!baseFallback && targetBase && info.baseTag.toLocaleLowerCase() === targetBase) baseFallback = info;
    }
    for (const line of doc.lines) {
      const parent = line.abcSource?.getSectionInfo();
      if (parent?.instructionName().toLocaleLowerCase() === target) return parent;
    }
    const expanded = abcExpansion();
    if (expanded !== doc)
      for (const section of expanded.sectionInfo.values()) if (section.info.instructionName().toLocaleLowerCase() === target) return section.info;
    // A not-yet-loaded ABC may later expose this exact verse. Preserve the text
    // instead of silently reducing "Verse 2" to its parent "Verse".
    if (
      baseFallback?.name === "start_of_abc" &&
      !doc.lines.some(
        (line) =>
          line instanceof ChordProAbc && line.getSectionInfo() === baseFallback && isAbcjsLoaded() && line.toChordPro().every((row) => row.isGrid)
      )
    )
      return undefined;
    return baseFallback;
  }

  /** Rebind deferred ABC names after the lazy parser becomes available. Existing
   * instruction objects keep their identity for highlighting and DOM reuse. */
  resolveAbcSections(doc: ChordProDocument, abcExpansion = lazyAbcExpansion(doc)) {
    for (const item of this.items) {
      if (item.multiplier != null || !item.value.trim()) continue;
      const probe = new ChordProSectionInfo("start_of_chorus:" + item.value.trim());
      const info = Instructions.findSection(doc, probe.instructionName(), abcExpansion);
      if (!info) continue;
      item.info = info;
      item.value = info.instructionName();
      item.multiplier = Math.max(1, probe.multiplier ?? 1);
      item.transpose = clampTranspose(probe.transpose ?? info.transpose);
    }
  }

  /** The instructions editor exposes the parts of a legacy whole-score entry.
   * Repeating the whole score repeats the entire part sequence, preserving the
   * existing performance order instead of repeating each verse in place. */
  expandAbcSections(doc: ChordProDocument) {
    const expanded = doc.expandAbc();
    const items: InstructionItem[] = [];
    for (const item of this.items) {
      if (item.info?.name !== "start_of_abc" || item.multiplier == null) {
        items.push(item);
        continue;
      }
      const parts: ChordProSectionInfo[] = [];
      let previous: ChordProLine | undefined;
      for (const line of expanded.lines) {
        if (!line.abcSource || !Instructions.matchesSection(line, item)) continue;
        const info = line.getSectionInfo();
        if (!previous || previous.abcSource !== line.abcSource || previous.getSectionInfo() !== info) parts.push(info);
        previous = line;
      }
      if (!parts.length || parts.length * item.multiplier > 1000 || (parts.length === 1 && parts[0].instructionName() === item.value)) {
        // Preserve unusually large aggregate repeats without allocating an
        // unbounded number of editor controls from one imported instruction.
        items.push(item);
        continue;
      }
      for (let repeat = 0; repeat < item.multiplier; ++repeat)
        for (const part of parts) items.push(Instructions.createSectionItem(expanded, part.instructionName(), 1, item.transpose));
    }
    this.items.splice(0, this.items.length, ...items);
    this.normalize();
  }

  static createSectionItem(doc: ChordProDocument, tag: string, multiplier = 1, transpose?: number): InstructionItem {
    const info = Instructions.findSection(doc, tag);
    const item: InstructionItem = info ? { value: info.instructionName(), multiplier, info } : { value: tag, multiplier };
    const t = clampTranspose(transpose);
    if (t !== undefined) item.transpose = t;
    return item;
  }

  static matchesSection(line: ChordProLine, item: InstructionItem) {
    if (line.isComment || item.multiplier == null) return false;
    const parent = line.abcSource?.getSectionInfo().instructionName().toLocaleLowerCase();
    if (parent && parent === (item.info?.instructionName() ?? item.value).toLocaleLowerCase()) return true;
    if (item.info) {
      const targetTag = item.info.instructionName().toLocaleLowerCase();
      const lineTag = line.getTagInfo().tag.toString().toLocaleLowerCase();
      if (lineTag === targetTag) return true;
      const lineInfo = line.getSectionInfo();
      if (lineInfo === item.info) return true;
      return lineInfo.instructionName().toLocaleLowerCase() === targetTag;
    }
    return line.getTagInfo().tag.toString().toLocaleLowerCase() === item.value.toLocaleLowerCase();
  }

  format() {
    this.normalize();
    return this.items
      .map((x) => {
        const base = x.info ? x.info.instructionName() : x.value;
        const mult = (x.multiplier ?? 0) > 1 ? " " + x.multiplier + "x" : "";
        return base + mult + formatTransposeSuffix(x.transpose);
      })
      .join("\n");
  }
  parse(data: string, doc: ChordProDocument) {
    try {
      data = JSON.parse('"' + data + '"');
    } catch {
      // ignore parse errors
    }
    this.items.splice(0, this.items.length);
    const abcExpansion = lazyAbcExpansion(doc);
    for (const line of data.split("\n")) {
      const trimmedLine = line.trim();
      const item: InstructionItem = { value: trimmedLine };
      if (trimmedLine) {
        const probe = new ChordProSectionInfo("start_of_chorus:" + trimmedLine);
        const canonical = probe.instructionName();
        const section = Instructions.findSection(doc, canonical || trimmedLine, abcExpansion);
        if (section) {
          item.info = section;
          item.value = section.instructionName();
          item.multiplier = probe.multiplier ?? 1;
          if (item.multiplier < 1) item.multiplier = 1;
          // Inherit transpose from the section tag (e.g. `{soc: Chorus +2}`) when
          // the instruction line doesn't specify one explicitly. This keeps tag
          // transposes effective even with custom user-supplied instructions.
          const t = clampTranspose(probe.transpose ?? section.transpose);
          if (t !== undefined) item.transpose = t;
        }
      }
      this.items.push(item);
    }
    this.normalize();
  }
  normalize(index?: number) {
    let normalized_index = index ?? -1;
    for (let i = 0; i < this.items.length; ++i) {
      const item = this.items[i];
      if (item.multiplier != null) {
        const myKey = Instructions.itemKey(item);
        const myTranspose = item.transpose ?? 0;
        let next: InstructionItem | undefined;
        while ((next = this.items[i + 1])?.multiplier != null && Instructions.itemKey(next) === myKey && (next.transpose ?? 0) === myTranspose) {
          item.multiplier += next.multiplier;
          this.items.splice(i + 1, 1);
          if (normalized_index >= i + 1) --normalized_index;
        }
      }
    }
    return normalized_index >= 0 ? normalized_index : undefined;
  }
  insertBefore(item: InstructionItem, before: InstructionItem, normalize = true) {
    const i = this.items.indexOf(before);
    this.items.splice(i, 0, item);
    return normalize ? this.normalize(i) : i;
  }
  insertAfter(item: InstructionItem, after: InstructionItem, normalize = true) {
    const i = this.items.indexOf(after);
    this.items.splice(i + 1, 0, item);
    return normalize ? this.normalize(i + 1) : i + 1;
  }
  deleteItem(item: InstructionItem, normalize = true) {
    const i = this.items.indexOf(item);
    if (i >= 0) this.items.splice(i, 1);
    if (normalize) this.normalize();
  }
  add(item: InstructionItem, normalize = true) {
    this.items.push(item);
    if (normalize) this.normalize();
    return this.items.length - 1;
  }
}
