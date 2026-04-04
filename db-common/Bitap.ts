export class Bitap {
  static fuzzyBitwiseSearch(text: string, pattern: string, k: number): string {
    const m = pattern.length;
    if (!pattern) return text;
    if (m > 64) {
      console.error("Search", "Pattern too long for bitap search");
      return "";
    }

    const pattern_mask: bigint[] = new Array(256).fill(~0n);
    for (let i = 0; i < m; ++i) {
      const charCode = pattern.charCodeAt(i);
      if (charCode < 256) {
        pattern_mask[charCode]! &= ~(1n << BigInt(i));
      }
    }

    const R: bigint[] = new Array(k + 1).fill(~1n);

    for (let i = 0; i < text.length; ++i) {
      let old_Rd1 = R[0];
      const charCode = text.charCodeAt(i);
      const mask = charCode < 256 ? pattern_mask[charCode]! : ~0n;

      R[0] = (R[0]! | mask) << 1n;

      for (let d = 1; d <= k; ++d) {
        const tmp = R[d];
        R[d] = (old_Rd1! & (R[d]! | mask)) << 1n;
        old_Rd1 = tmp;
      }

      if (0n === (R[k]! & (1n << BigInt(m - 1)))) {
        return text.substring(i - m + 1);
      }
    }

    return ""; // Return empty if no match is found
  }
}
