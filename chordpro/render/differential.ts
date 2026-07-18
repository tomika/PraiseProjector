import { DifferentialText } from "../../common/utils";
import { segmentVisualUnits } from "../layout/text-units";

/**
 * A visual unit in the differential coordinate system. `source*` is the
 * rendered (before + after) stream used solely for layout. The before/after
 * spans remain the authoritative document coordinates; a removed unit has no
 * after span and can therefore never be mistaken for an editable offset.
 */
export interface DifferentialTextUnit {
  readonly text: string;
  readonly sourceStart: number;
  readonly sourceEnd: number;
  readonly beforeStart?: number;
  readonly beforeEnd?: number;
  readonly afterStart?: number;
  readonly afterEnd?: number;
  readonly change: "equal" | "added" | "removed";
}

export function differentialTextUnits(text: string | DifferentialText): DifferentialTextUnit[] {
  const result: DifferentialTextUnit[] = [];
  let sourceOffset = 0;
  let beforeOffset = 0;
  let afterOffset = 0;
  const append = (chunkText: string, added: boolean | undefined) => {
    const change = added === true ? "added" : added === false ? "removed" : "equal";
    for (const unit of segmentVisualUnits(chunkText)) {
      const length = unit.sourceEnd - unit.sourceStart;
      const entry: DifferentialTextUnit = {
        text: unit.text,
        sourceStart: sourceOffset,
        sourceEnd: sourceOffset + length,
        change,
        ...(change !== "added" ? { beforeStart: beforeOffset, beforeEnd: beforeOffset + length } : {}),
        ...(change !== "removed" ? { afterStart: afterOffset, afterEnd: afterOffset + length } : {}),
      };
      result.push(entry);
      sourceOffset += length;
      if (change !== "added") beforeOffset += length;
      if (change !== "removed") afterOffset += length;
    }
  };
  if (typeof text === "string") append(text, undefined);
  else text.forEachChunk((chunk) => append(chunk.text, chunk.added));
  return result;
}

export function flattenDifferentialUnits(units: readonly DifferentialTextUnit[]) {
  return units.map((unit) => unit.text).join("");
}

/** Maps a before/after UTF-16 anchor to the rendered-stream anchor for layout. */
export function differentialCoordinateToSource(units: readonly DifferentialTextUnit[], side: "before" | "after", offset: number) {
  const startKey = side === "before" ? "beforeStart" : "afterStart";
  const endKey = side === "before" ? "beforeEnd" : "afterEnd";
  let fallback = 0;
  for (const unit of units) {
    const start = unit[startKey];
    const end = unit[endKey];
    if (start == null || end == null) continue;
    fallback = unit.sourceEnd;
    if (offset <= start) return unit.sourceStart;
    if (offset <= end) return unit.sourceStart + Math.max(0, Math.min(unit.sourceEnd - unit.sourceStart, offset - start));
  }
  return fallback;
}

/** Adds an unchanged visual prefix while preserving both coordinate spaces. */
export function prefixDifferentialTextUnits(prefix: string, units: readonly DifferentialTextUnit[]) {
  if (!prefix) return [...units];
  const prefixUnits = differentialTextUnits(prefix);
  const sourceOffset = prefix.length;
  const beforeOffset = prefix.length;
  const afterOffset = prefix.length;
  return [
    ...prefixUnits,
    ...units.map((unit) => ({
      ...unit,
      sourceStart: unit.sourceStart + sourceOffset,
      sourceEnd: unit.sourceEnd + sourceOffset,
      ...(unit.beforeStart != null ? { beforeStart: unit.beforeStart + beforeOffset, beforeEnd: unit.beforeEnd! + beforeOffset } : {}),
      ...(unit.afterStart != null ? { afterStart: unit.afterStart + afterOffset, afterEnd: unit.afterEnd! + afterOffset } : {}),
    })),
  ];
}
