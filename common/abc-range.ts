import { abcRangeCodec } from "./pp-codecs";
import type { AbcRange } from "./pp-types";

export function parseAbcRange(value: unknown): AbcRange | undefined {
  if (typeof value === "string") {
    try {
      value = JSON.parse(value);
    } catch {
      return undefined;
    }
  }
  if (!abcRangeCodec.is(value)) return undefined;
  return [value.source, value.from, value.to].every((n) => Number.isSafeInteger(n) && n >= 0) && value.to > value.from ? value : undefined;
}

export function sameAbcRange(a: AbcRange | undefined, b: AbcRange | undefined): boolean {
  return a === b || (!!a && !!b && a.source === b.source && a.from === b.from && a.to === b.to);
}

export function containsAbcRange(outer: AbcRange | undefined, inner: AbcRange | undefined): boolean {
  return !outer || (!!inner && outer.source === inner.source && outer.from <= inner.from && inner.to <= outer.to);
}
