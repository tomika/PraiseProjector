export class StringExtensions {
  // Match C# \W behaviour: accented Latin (\u00C0-\u024F) and Cyrillic (\u0400-\u04FF)
  // are treated as word characters, not stripped out.
  // Input is normalized to NFC in simplify(), so composed accented characters are preserved.
  private static rxNonWordList = /[^a-zA-Z0-9\u00C0-\u024F\u0400-\u04FF]+/g;
  private static rxSpaces = /\s+/g;

  public static simplify(s: string, caseSensitive: boolean = false): string {
    if (!s) return "";
    // Normalize to NFC first so accented characters are represented consistently.
    const normalized = s.normalize("NFC");
    return (caseSensitive ? normalized : normalized.toLowerCase()).replace(StringExtensions.rxNonWordList, " ").trim();
  }

  public static minimizeSpaces(s: string): string {
    if (!s) return "";
    return s.replace(StringExtensions.rxSpaces, " ").trim();
  }

  public static getWords(s: string, caseSensitive: boolean = false): string[] {
    if (!s) return [];
    const text = StringExtensions.simplify(s, caseSensitive);
    return text.split(" ").filter((word) => word.length > 0);
  }

  public static toUnaccented(s: string): string {
    return s.normalize("NFD").replace(/[\u0300-\u036f]/g, "");
  }
}
