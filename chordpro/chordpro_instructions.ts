// Instruction list model used by the ChordPro editor (instructions side pane,
// rendering pipeline) and by Song.ts (electron section list, projector preview).
// Extracted from chordpro_editor.ts so non-editor consumers can use it without
// pulling the full editor surface.

import { ChordProDocument, ChordProLine, ChordProSectionInfo } from "./chordpro_base";

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

export class Instructions {
  constructor(readonly items: InstructionItem[] = []) {}

  private static itemKey(item: InstructionItem) {
    return item.info ? item.info.withoutModifiers() : item.value;
  }

  static findSection(doc: ChordProDocument, tag: string): ChordProSectionInfo | undefined {
    if (!tag) return undefined;
    const probe = new ChordProSectionInfo("start_of_chorus:" + tag);
    const target = probe.withoutModifiers().toLocaleLowerCase();
    if (!target) return undefined;
    let baseFallback: ChordProSectionInfo | undefined;
    const targetBase = probe.baseTag.toLocaleLowerCase();
    for (const si of doc.sectionInfo.values()) {
      const info = si.info;
      if (!info.tag) continue;
      if (info.withoutModifiers().toLocaleLowerCase() === target) return info;
      if (!baseFallback && targetBase && info.baseTag.toLocaleLowerCase() === targetBase) baseFallback = info;
    }
    return baseFallback;
  }

  static createSectionItem(doc: ChordProDocument, tag: string, multiplier = 1, transpose?: number): InstructionItem {
    const info = Instructions.findSection(doc, tag);
    const item: InstructionItem = info ? { value: info.withoutModifiers(), multiplier, info } : { value: tag, multiplier };
    const t = clampTranspose(transpose);
    if (t !== undefined) item.transpose = t;
    return item;
  }

  static matchesSection(line: ChordProLine, item: InstructionItem) {
    if (line.isComment || item.multiplier == null) return false;
    if (item.info) {
      const lineInfo = line.getSectionInfo();
      if (lineInfo === item.info) return true;
      return lineInfo.withoutModifiers().toLocaleLowerCase() === item.info.withoutModifiers().toLocaleLowerCase();
    }
    return line.getTagInfo().tag.toString().toLocaleLowerCase() === item.value.toLocaleLowerCase();
  }

  format() {
    this.normalize();
    return this.items
      .map((x) => {
        const base = x.info ? x.info.withoutModifiers() : x.value;
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
    for (const line of data.split("\n")) {
      const trimmedLine = line.trim();
      const item: InstructionItem = { value: trimmedLine };
      if (trimmedLine) {
        const probe = new ChordProSectionInfo("start_of_chorus:" + trimmedLine);
        const canonical = probe.withoutModifiers();
        const section = Instructions.findSection(doc, canonical || trimmedLine);
        if (section) {
          item.info = section;
          item.value = section.withoutModifiers();
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
