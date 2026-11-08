import type { AbcRange } from "../common/pp-types";
import { ChordProAbc, type ChordProLine } from "./chordpro_base";

export function lineAbcRange(line: ChordProLine): AbcRange | undefined {
  return line.abcSource && line.abcRow != null ? { source: line.abcSource.sourceLineNumber, from: line.abcRow, to: line.abcRow + 1 } : undefined;
}

export function matchesAbcRange(line: ChordProLine, range: AbcRange | undefined): boolean {
  if (!range) return true;
  if (line instanceof ChordProAbc) return line.sourceLineNumber === range.source;
  const row = lineAbcRange(line);
  return !!row && row.source === range.source && row.from >= range.from && row.from < range.to;
}
