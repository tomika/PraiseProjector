import { StringExtensions } from "./StringExtensions";

// Note: This is a simplified implementation for demonstration.
// A full-featured Damerau-Levenshtein might be better sourced from a library if complex features are needed.

export class DamerauLevenshtein {
  private static invariants: Map<string, string> = new Map();
  private static dlBuff: number[][] = Array(101)
    .fill(0)
    .map(() => Array(101).fill(0));

  private static getUnaccentedChar(ch: string): string {
    if (DamerauLevenshtein.invariants.has(ch)) {
      return DamerauLevenshtein.invariants.get(ch)!;
    }

    const s = ch.normalize("NFD").replace(/[\u0300-\u036f]/g, "");
    DamerauLevenshtein.invariants.set(ch, s);
    return s;
  }

  private static getCharDifference(ch1: string, ch2: string): number {
    const unaccentedCh1 = DamerauLevenshtein.getUnaccentedChar(ch1);
    const unaccentedCh2 = DamerauLevenshtein.getUnaccentedChar(ch2);
    return unaccentedCh1 === unaccentedCh2 ? 0.1 : 1.0;
  }

  public static accentedDamerauLevenshteinDistance(string1: string, string2: string, caseSensitive: boolean = false): number {
    return DamerauLevenshtein.distance(string1, string2, Infinity, caseSensitive);
  }

  public static accentedDamerauLevenshteinDistanceBounded(string1: string, string2: string, maxCost: number, caseSensitive: boolean = false): number {
    if (maxCost === Infinity) return DamerauLevenshtein.accentedDamerauLevenshteinDistance(string1, string2, caseSensitive);
    if (!Number.isFinite(maxCost) || maxCost < 0) return Infinity;
    return DamerauLevenshtein.distance(string1, string2, maxCost, caseSensitive);
  }

  // Both entry points share the same edit costs; only finite limits enable pruning.
  private static distance(string1: string, string2: string, maxCost: number, caseSensitive: boolean): number {
    if (!string1) return string2 ? string2.length : 0;
    if (!string2) return string1.length;

    const length1 = Math.min(string1.length, 100);
    const length2 = Math.min(string2.length, 100);
    const lengthDiff = Math.abs(length1 - length2);
    if (lengthDiff > maxCost) return Number.POSITIVE_INFINITY;

    for (let i = 0; i <= length1; i++) {
      const row = DamerauLevenshtein.dlBuff[i];
      if (row) row[0] = i;
    }
    for (let i = 0; i <= length2; i++) {
      const row = DamerauLevenshtein.dlBuff[0];
      if (row) row[i] = i;
    }

    for (let i = 1; i <= length1; i++) {
      let rowMin = Number.POSITIVE_INFINITY;
      for (let j = 1; j <= length2; j++) {
        const s1_char = string1[i - 1];
        const s2_char = string2[j - 1];
        if (s1_char === undefined || s2_char === undefined) continue;

        // Case-only substitutions must not be accepted as ordinary typos.
        const caseMismatch =
          caseSensitive &&
          s1_char !== s2_char &&
          DamerauLevenshtein.getUnaccentedChar(s1_char).toLowerCase() === DamerauLevenshtein.getUnaccentedChar(s2_char).toLowerCase() &&
          (s1_char === s1_char.toUpperCase()) !== (s2_char === s2_char.toUpperCase());
        const cost = caseMismatch ? Infinity : s1_char !== s2_char ? DamerauLevenshtein.getCharDifference(s1_char, s2_char) : 0;
        const prevRow = DamerauLevenshtein.dlBuff[i - 1];
        const currentRow = DamerauLevenshtein.dlBuff[i];
        if (!prevRow || !currentRow) continue;

        const del = prevRow[j];
        const ins = currentRow[j - 1];
        const sub = prevRow[j - 1];
        if (del === undefined || ins === undefined || sub === undefined) continue;

        let cell = Math.min(del + 1, ins + 1, sub + cost);

        if (i > 1 && j > 1) {
          const s1_prev_char = string1[i - 2];
          const s2_prev_char = string2[j - 2];
          if (s1_prev_char !== undefined && s2_prev_char !== undefined) {
            if (s1_char === s2_prev_char && s1_prev_char === s2_char) {
              const prevPrevRow = DamerauLevenshtein.dlBuff[i - 2];
              if (prevPrevRow) {
                const val = prevPrevRow[j - 2];
                if (val !== undefined) {
                  cell = Math.min(cell, val + cost);
                }
              }
            }
          }
        }

        currentRow[j] = cell;
        if (cell < rowMin) rowMin = cell;
      }

      if (Number.isFinite(maxCost) && rowMin > maxCost) {
        return Number.POSITIVE_INFINITY;
      }
    }

    const finalRow = DamerauLevenshtein.dlBuff[length1];
    const result = finalRow ? finalRow[length2] : undefined;
    if (result === undefined || result > maxCost) return Number.POSITIVE_INFINITY;
    return result;
  }

  public static calcDifferenceTo(
    s: string,
    targetString: string,
    acceptPrefixWithLowerCost: boolean,
    maxCost: number = Number.POSITIVE_INFINITY
  ): number {
    if (acceptPrefixWithLowerCost) {
      const tl = targetString.length;
      const sl = s.length;
      if (tl > sl) {
        // Check exact prefix match first (accented then unaccented) — avoids expensive distance computation
        if (targetString.startsWith(s)) return 0.01 * (tl - sl);
        const unaccentedTarget = StringExtensions.toUnaccented(targetString);
        const unaccentedS = StringExtensions.toUnaccented(s);
        if (unaccentedTarget.startsWith(unaccentedS)) return 0.1 * (tl - sl);
      }
    }

    const f = DamerauLevenshtein.accentedDamerauLevenshteinDistanceBounded(s, targetString, maxCost);
    if (!isFinite(f)) return Number.POSITIVE_INFINITY;

    if (acceptPrefixWithLowerCost) {
      const tl = targetString.length;
      const sl = s.length;
      if (tl > sl && tl - sl === Math.floor(f)) {
        if (targetString.startsWith(s)) return 0.01 * f;
        const unaccentedTarget = StringExtensions.toUnaccented(targetString);
        const unaccentedS = StringExtensions.toUnaccented(s);
        if (unaccentedTarget.startsWith(unaccentedS)) return 0.1 * f;
      }
    }
    return f;
  }
}
