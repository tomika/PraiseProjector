/**
 * Port of C# ChordMap class from SongImporterForm
 * Maps original chord notations to normalized forms
 */
export class ChordMap {
  private map: Map<string, string> = new Map();

  /**
   * Add or update a chord mapping
   */
  set(original: string, normalized: string): void {
    this.map.set(original, normalized);
  }

  /**
   * Get normalized form of a chord
   */
  get(original: string): string | undefined {
    return this.map.get(original);
  }

  /**
   * Get all original chords
   */
  getOriginals(): string[] {
    return Array.from(this.map.keys());
  }

  /**
   * Get all normalized chords
   */
  getNormalized(): string[] {
    return Array.from(this.map.values());
  }

  /**
   * Get count of mappings
   */
  get count(): number {
    return this.map.size;
  }

  /**
   * Clear all mappings
   */
  clear(): void {
    this.map.clear();
  }

  /**
   * Get all entries as array of [original, normalized] pairs
   */
  getEntries(): Array<[string, string]> {
    return Array.from(this.map.entries());
  }
}

export type ChordDetectionMode = -1 | 0 | 1;

export type ChordMapBuildResult = {
  map: ChordMap | null;
  hMode: ChordDetectionMode;
  lcMollMode: ChordDetectionMode;
};

/**
 * Chord normalization utilities
 */
export class ChordNormalizer {
  private static readonly mollPattern = /m(?!aj)(?:oll)?/i;
  private static readonly chordPattern = /^(#?)([a-h])(#|b|[ei]?sz?)?(m|moll?)?((?:maj|sus|add|b|#|[0-9])*)$/i;
  private static readonly chordTrimmingPattern = /^[ \n\t\r,|.]+|[ \n\t\r,|.]+$/g;

  static extractMainNotes(chord: string): string[] {
    const notes: string[] = [];

    for (const segment of chord.split("/")) {
      let token = segment.trim();
      if (token.startsWith("(")) token = token.substring(1).trim();
      if (token.startsWith("#")) token = token.substring(1).trim();

      if (token.length > 1) {
        const second = token.substring(1, 2);
        notes.push(second === "b" || second === "#" ? token.substring(0, 2) : token.substring(0, 1));
      } else if (token.length === 1) {
        notes.push(token);
      }
    }

    return notes;
  }

  static tryDetermineHMode(chords: Iterable<string>): ChordDetectionMode {
    let hasH = false;
    let hasB = false;
    let hasBb = false;

    for (const chord of chords) {
      for (const segment of this.extractMainNotes(chord)) {
        const token = segment.trim().toLowerCase();
        if (token === "bb") hasBb = true;
        else if (token === "b") hasB = true;
        if (token === "h") hasH = true;
      }
    }

    if ((hasBb && hasH) || hasB) return -1;
    if (hasH || !hasB) return 1;
    if (hasBb) return 0;
    return -1;
  }

  static tryDetermineLCMollMode(chords: Iterable<string>): ChordDetectionMode {
    let hasUpper = false;
    let hasLower = false;
    let hasExplicitMoll = false;

    for (const chord of chords) {
      const explicitMoll = this.mollPattern.test(chord);
      if (explicitMoll) hasExplicitMoll = true;

      for (const segment of this.extractMainNotes(chord)) {
        const token = segment.trim();
        if (!token) continue;

        const firstChar = token.substring(0, 1);
        if (firstChar.toUpperCase() === firstChar) hasUpper = true;
        else if (!explicitMoll) hasLower = true;
      }
    }

    if (hasUpper && hasLower) {
      return hasExplicitMoll ? -1 : 1;
    }

    return 0;
  }

  private static trimChordToken(chord: string): string {
    return chord.replace(this.chordTrimmingPattern, "");
  }

  private static normalizeSingleChord(chord: string, sourceUsesH: boolean, lowercaseMoll: boolean, bassOnly: boolean): string {
    const match = this.chordPattern.exec(this.trimChordToken(chord));
    if (!match) return "";

    const accidentalPrefix = match[1] ?? "";
    const note = match[2] ?? "";
    const shift = match[3] ?? "";
    let mode = match[4] ?? "";
    const modifiers = match[5] ?? "";

    let normalized = note.toUpperCase();
    const shiftValue = shift.toLowerCase();

    if (accidentalPrefix || shiftValue === "#" || shiftValue.startsWith("is")) normalized += "#";
    else if (shiftValue === "b" || shiftValue.startsWith("es") || shiftValue.startsWith("s")) normalized += "b";

    if (!sourceUsesH) {
      if (normalized === "Bb") normalized = "B";
      else if (normalized === "B") normalized = "H";
    }

    if (/^moll?/i.test(mode)) mode = "m";
    else if (lowercaseMoll && note === note.toLowerCase()) mode = `m${mode}`;

    return bassOnly ? normalized : `${normalized}${mode}${modifiers}`;
  }

  /**
   * Normalize chord according to the original importer rules.
   */
  static normalize(chord: string, sourceUsesH: boolean, lowercaseMoll: boolean): string {
    let workingChord = chord;
    let prefix = "";
    let suffix = "";

    if (workingChord.startsWith("(")) {
      prefix = "(";
      workingChord = workingChord.substring(1);
    }

    if (workingChord.endsWith(")")) {
      suffix = ")";
      workingChord = workingChord.substring(0, workingChord.length - 1);
    }

    let result = "";
    let bassOnly = false;

    for (const segment of workingChord.split("/")) {
      if (result) result += "/";
      const normalizedSegment = this.normalizeSingleChord(segment, sourceUsesH, lowercaseMoll, bassOnly);
      if (!normalizedSegment) return "";
      result += normalizedSegment;
      bassOnly = true;
    }

    return `${prefix}${result}${suffix}`;
  }

  /**
   * Build chord map from a set of chords
   */
  static buildChordMap(chords: Set<string>, useH: boolean, lcMoll: boolean): ChordMap {
    const result = this.createChordMap(chords, useH ? 1 : 0, lcMoll ? 1 : 0);
    return result.map ?? new ChordMap();
  }

  static createChordMap(chords: Set<string>, hMode: ChordDetectionMode, lcMollMode: ChordDetectionMode): ChordMapBuildResult {
    const resolvedHMode = hMode < 0 ? this.tryDetermineHMode(chords) : hMode;
    const resolvedLcMollMode = lcMollMode < 0 ? this.tryDetermineLCMollMode(chords) : lcMollMode;

    const map = new ChordMap();

    if (resolvedHMode < 0 || resolvedLcMollMode < 0) {
      for (const chord of chords) {
        map.set(chord, chord);
      }

      return {
        map,
        hMode: resolvedHMode,
        lcMollMode: resolvedLcMollMode,
      };
    }

    for (const chord of chords) {
      const normalized = this.normalize(chord, resolvedHMode > 0, resolvedLcMollMode > 0);
      map.set(chord, normalized);
    }

    return {
      map,
      hMode: resolvedHMode,
      lcMollMode: resolvedLcMollMode,
    };
  }

  /**
   * Quick test if a string could be a chord
   * Port of rxChordQuickTest regex from C#
   */
  static couldBeChord(text: string): boolean {
    // Pattern: ^([a-h0-9m/()-+](#|b|sz?|isz?)?(sus|add[0-9]+|maj|aug)?)+$
    const pattern = /^([a-h0-9m/()+-](#|b|sz?|isz?)?(sus|add[0-9]+|maj|aug)?)+$/i;
    return pattern.test(text);
  }

  /**
   * Count possible chords in a string (separated by whitespace)
   */
  static possibleChordCount(text: string): number {
    const parts = text.trim().split(/\s+/);
    let count = 0;

    for (const part of parts) {
      if (ChordNormalizer.couldBeChord(part)) {
        count++;
      }
    }

    return count;
  }
}
