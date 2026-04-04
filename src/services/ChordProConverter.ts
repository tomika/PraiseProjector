import { ImportLines, ImportLine } from "../../db-common/ImportLine";
import { ChordMap } from "../../db-common/ChordMap";

/**
 * Service for converting multi-line chord/lyric format to ChordPro format
 * Simplified port of C# GenerateChordPro - works with text-based ImportLines
 */
export class ChordProConverter {
  /**
   * Convert ImportLines to ChordPro format
   * Simplified version that merges chord and lyric lines using whitespace alignment
   */
  static convertToChordPro(lines: ImportLines, chordMap?: ChordMap): string {
    let s = "";
    let chordsToMerge: ImportLine | null = null;

    for (let i = 0; i < lines.count; i++) {
      const line = lines.get(i);
      if (!line) continue;

      const trimmedText = line.text.trim();
      if (!trimmedText) continue;

      // Check if this is a chord line
      if (this.isChordLine(line)) {
        // If we already have chords waiting to merge, output them first
        if (chordsToMerge !== null) {
          const chordParts = chordsToMerge.text.trim().split(/\s+/);
          for (const part of chordParts) {
            if (!part) continue;
            let chord = part;
            if (chordMap) {
              const mapped = chordMap.get(chord);
              if (mapped) chord = mapped;
            }
            s += `[${chord}]`;
          }
          s += "\r\n";
        }
        chordsToMerge = line;
        continue;
      }

      // Not a chord line - process as lyrics/title/comment
      let suffix = "";
      let prefix = "";
      if (line.line_type === "title") {
        prefix = "{title:";
        suffix = "}";
      } else if (line.line_type === "comment") {
        prefix = "#";
      }

      s += prefix;

      // Merge chords with lyrics if we have chords waiting
      if (chordsToMerge !== null) {
        const mergedLine = this.mergeChordAndLyricLines(chordsToMerge.text, trimmedText, chordMap);
        s += mergedLine;
        chordsToMerge = null;
      } else {
        s += trimmedText;
      }

      s += suffix + "\r\n";
    }

    // Handle any remaining unmerged chords
    if (chordsToMerge !== null) {
      const chordParts = chordsToMerge.text.trim().split(/\s+/);
      for (const part of chordParts) {
        if (!part) continue;
        let chord = part;
        if (chordMap) {
          const mapped = chordMap.get(chord);
          if (mapped) chord = mapped;
        }
        s += `[${chord}]`;
      }
      s += "\r\n";
    }

    // Apply chord adjustment regex (move chords to word boundaries)
    // Port of rxChordAdjustWord from C#: move [chord] that splits a word
    s = s.replace(/(?:^|\b)([a-zéáőúűöüóí])(\[[^\]]+\])([a-zéáőúűöüóí])/gi, "$2$1$3");

    return s;
  }

  /**
   * Merge chord line with lyric line using position-based alignment
   * Uses whitespace positions to align chords with lyrics
   */
  private static mergeChordAndLyricLines(chordLine: string, lyricLine: string, chordMap?: ChordMap): string {
    const chordParts = chordLine.trim().split(/\s+/);
    const result: string[] = [];

    // Find positions of chords in original line
    const chordPositions: Array<{ pos: number; chord: string }> = [];
    let searchPos = 0;

    for (const chord of chordParts) {
      if (!chord.trim()) continue;

      const pos = chordLine.indexOf(chord, searchPos);
      if (pos !== -1) {
        let normalizedChord = chord;
        if (chordMap) {
          const mapped = chordMap.get(chord);
          if (mapped) normalizedChord = mapped;
        }
        chordPositions.push({ pos, chord: normalizedChord });
        searchPos = pos + chord.length;
      }
    }

    // Insert chords at appropriate positions in lyric line
    let lastPos = 0;
    for (const { pos, chord } of chordPositions) {
      // Add lyrics up to this chord position
      if (pos < lyricLine.length) {
        result.push(lyricLine.substring(lastPos, Math.min(pos, lyricLine.length)));
        result.push(`[${chord}]`);
        lastPos = pos;
      } else {
        // Chord past end of lyric line
        result.push(lyricLine.substring(lastPos));
        result.push(`[${chord}]`);
        lastPos = lyricLine.length;
        break;
      }
    }

    // Add remaining lyrics
    if (lastPos < lyricLine.length) {
      result.push(lyricLine.substring(lastPos));
    }

    return result.join("");
  }

  /**
   * Collect all chords from lines
   */
  static collectChords(lines: ImportLines): Set<string> {
    const chords = new Set<string>();

    for (let i = 0; i < lines.count; i++) {
      const line = lines.get(i);
      if (!line) continue;

      // Only collect from identified chord lines
      if (this.isChordLine(line)) {
        const parts = line.text.trim().split(/\s+/);
        for (const part of parts) {
          if (part.trim()) {
            chords.add(part.trim());
          }
        }
      }
    }

    return chords;
  }

  /**
   * Auto-detect line types based on content
   * Port of IsChordLine logic from C#
   */
  static autoDetectLineTypes(lines: ImportLines): void {
    for (let i = 0; i < lines.count; i++) {
      const line = lines.get(i);
      if (!line || line.line_type) continue; // Skip if already typed

      const text = line.text.trim();
      if (!text) continue;

      // Detect line type
      if (this.isChordLine(line)) {
        line.line_type = "chord";
      } else if (/^\[.+\]$/.test(text) || /^(Verse|Chorus|Bridge|Intro|Outro)/i.test(text)) {
        line.line_type = "title";
      } else if (/^[#/]/.test(text)) {
        line.line_type = "comment";
      } else {
        line.line_type = "lyrics";
      }
    }
  }

  /**
   * Check if a line is likely a chord line
   * Port of IsChordLine from C# SongImporterForm
   */
  private static isChordLine(line: ImportLine): boolean {
    // If already typed, use that
    if (line.line_type === "chord") return true;
    if (line.line_type === "lyrics" || line.line_type === "title" || line.line_type === "comment") return false;

    // Regex for quick chord test (from C# rxChordQuickTest)
    const rxChordQuickTest = /^([a-h0-9m/()+-](#|b|sz?|isz?)?(sus|add[0-9]+|maj|aug)?)+$/i;
    const rxMultiplier = /[(]?(x|[*])[0-9]+[)]?/i;

    // Check each word
    const parts = line.text.trim().split(/\s+/);
    for (const part of parts) {
      const trimmed = part.trim();
      if (!trimmed) continue;

      // Strong indicators of chord line
      if (trimmed.includes("#") || trimmed.includes("sus4")) {
        line.line_type = "chord";
        return true;
      }

      // Check if it matches chord pattern or multiplier pattern
      if (!rxChordQuickTest.test(trimmed) && !rxMultiplier.test(trimmed)) {
        line.line_type = "lyrics";
        return false;
      }
    }

    // If we have parts and they all look like chords, it's a chord line
    line.line_type = parts.length > 0 ? "chord" : "lyrics";
    return line.line_type === "chord";
  }
}
