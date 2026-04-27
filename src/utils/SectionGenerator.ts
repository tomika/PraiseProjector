import { TextMeasurer, TextSplitter, ChunkData } from "./TextMeasurer";
import { Song } from "../../db-common/Song";

/**
 * Section item for display list (port of C# SectionListBox.Item)
 */
export interface SectionItem {
  text: string;
  from: number;
  to: number;
  block: number;
  type: number; // Song.Section.Type
  label: string | null; // Original label before modification
}

/**
 * Display settings for section generation
 */
export interface DisplaySettings {
  fontFamily: string;
  fontSize: number;
  bold: boolean;
  italic: boolean;
  underline: boolean;
  alignment: "left" | "center" | "right";
  renderRectWidth: number;
  renderRectHeight: number;
  contentBasedSections: boolean;
  checkSectionsProjectable: boolean;
  allowFontSizeReduction: boolean;
  displayFaultThreshold: number;
  nonSplittingWords: string[];
  displayMinimumFontSize?: number;
  displayMinimumFontSizePercent?: number;
}

/**
 * Section generator (port of C# GenerateSections and related methods)
 */
export class SectionGenerator {
  private measurer: TextMeasurer;
  private splitter: TextSplitter;

  constructor() {
    this.measurer = new TextMeasurer();
    this.splitter = new TextSplitter(this.measurer);
  }

  /**
   * Determine if font would cause word breaking (port of C# DetermineNonWordBreakingFont)
   */
  private determineNonWordBreakingFont(text: string, settings: DisplaySettings, minimalFontSize: number | null): boolean {
    if (!settings.checkSectionsProjectable) return true;

    const margin = settings.renderRectWidth * 0.7;
    const rxWord = /\w+/g;
    const matches = text.match(rxWord) || [];

    // Sort words by length descending - match C# OrderByDescending
    const words = matches.sort((a, b) => b.length - a.length);

    for (const word of words) {
      const result = this.measurer.measureTextConstrained(
        word,
        settings.fontFamily,
        settings.fontSize,
        settings.renderRectWidth,
        settings.bold,
        settings.italic
      );

      if (result.linesFilled > 1) {
        if (minimalFontSize === null) return false;

        const minResult = this.measurer.measureTextConstrained(
          word,
          settings.fontFamily,
          minimalFontSize,
          settings.renderRectWidth,
          settings.bold,
          settings.italic
        );

        return minResult.linesFilled <= 1;
      } else if (result.width < margin) {
        break;
      }
    }

    return true;
  }

  /**
   * Generate sections from text (port of C# GenerateSections)
   */
  generateSections(
    text: string,
    block: number,
    settings: DisplaySettings,
    soff: number,
    type: number,
    minimalFontSize: number | null
  ): SectionItem[] {
    const items: SectionItem[] = [];

    // Split into lines and filter empty - match C# exactly
    const textLines = text.split("\n");
    const ls: string[] = [];
    for (const l of textLines) {
      const tl = l.replace(/\r/g, "").trim();
      if (tl.length > 0) ls.push(tl);
    }
    const lines = ls;

    // Try content-based and simple splitting
    for (let cbs = settings.contentBasedSections ? 0 : 1; cbs < 2; ++cbs) {
      for (let part_count = 1; part_count <= lines.length; ++part_count) {
        const labels = new Map<{ text: string; from: number; to: number }, string | null>();
        const chunks: { text: string; from: number; to: number }[] = [];

        for (let offset = 0, extra = 0; offset < lines.length; ) {
          let part_len = Math.floor(lines.length / part_count);
          const rem = lines.length - part_count * part_len - extra;

          let label = lines.slice(offset, offset + Math.min(part_len, lines.length - offset)).join("\r\n");
          let part = this.splitter.modifyString(
            label,
            settings.fontFamily,
            settings.fontSize,
            settings.renderRectWidth,
            cbs === 0,
            settings.bold,
            settings.italic,
            settings.nonSplittingWords
          );

          const size = this.measurer.measureTextConstrained(
            part,
            settings.fontFamily,
            settings.fontSize,
            settings.renderRectWidth,
            settings.bold,
            settings.italic
          );

          const wordLevelFontOk = this.determineNonWordBreakingFont(part, settings, minimalFontSize);
          let wontFit = size.height > settings.renderRectHeight + settings.displayFaultThreshold;
          if (!wontFit) wontFit = !wordLevelFontOk;

          if (wontFit) {
            if (cbs > 0 && part_len <= 1) {
              const section = { text: label, from: soff + offset, to: soff + offset + 1 };
              chunks.push(section);

              let sectionLabel: string | null;
              if (minimalFontSize !== null && this.determineNonWordBreakingFont(label, settings, minimalFontSize)) {
                const minSize = this.measurer.measureTextConstrained(
                  label,
                  settings.fontFamily,
                  minimalFontSize,
                  settings.renderRectWidth,
                  settings.bold,
                  settings.italic
                );
                sectionLabel = minSize.height > settings.renderRectHeight ? null : "";
              } else {
                sectionLabel = null;
              }

              labels.set(section, sectionLabel);
              ++offset;
            } else {
              // Can't fit, abort this configuration - set chunks to null equivalent
              offset = lines.length;
              chunks.length = 0;
            }
            continue;
          }

          // Try to include extra lines - match C# exactly: for (int i = rem; i > 0; --i)
          for (let i = rem; i > 0; --i) {
            const p = lines.slice(offset, offset + Math.min(part_len + i, lines.length - offset)).join("\r\n");
            const p2 = this.splitter.modifyString(
              p,
              settings.fontFamily,
              settings.fontSize,
              settings.renderRectWidth,
              cbs === 0,
              settings.bold,
              settings.italic,
              settings.nonSplittingWords
            );

            const pSize = this.measurer.measureTextConstrained(
              p2,
              settings.fontFamily,
              settings.fontSize,
              settings.renderRectWidth,
              settings.bold,
              settings.italic
            );

            if (pSize.height <= settings.renderRectHeight) {
              label = p;
              part = p2;
              part_len += i;
              extra += i;
              break;
            }
          }

          const section = { text: part, from: soff + offset, to: soff + offset + part_len };
          chunks.push(section);
          labels.set(section, label);
          offset += part_len;
        }

        if (chunks.length > 0) {
          // Success, return sections
          for (const section of chunks) {
            const s = section.text.trim();
            if (s.length > 0) {
              const labelValue = labels.get(section);
              items.push({
                text: s,
                from: section.from,
                to: section.to,
                block,
                type,
                label: labelValue !== undefined ? labelValue : null,
              });
            }
          }
          return items;
        }
      }
    }

    // Fallback: one section per line
    for (let i = 0; i < lines.length; ++i) {
      const s = lines[i].trim();
      if (s.length > 0) {
        items.push({
          text: s,
          from: soff + i,
          to: soff + i + 1,
          block,
          type,
          label: null,
        });
      }
    }

    return items;
  }

  /**
   * Update section list from song (port of C# UpdateSectionList)
   */
  updateSectionList(song: Song, settings: DisplaySettings, useInstructions: boolean = false, instructions: string = ""): SectionItem[] {
    const items: SectionItem[] = [];

    // Get minimal font size for reduction - match C# CalcMinFontSize logic
    const minimalFontSize = settings.allowFontSizeReduction
      ? Math.max(settings.displayMinimumFontSize || 0, Math.floor(settings.fontSize * ((settings.displayMinimumFontSizePercent || 70) / 100)))
      : null;

    // Get sections (normal or instructed)
    let sections = song.Sections;
    if (useInstructions && instructions) {
      sections = song.InstructedSections(instructions);
    }

    for (const s of sections) {
      const size = this.measurer.measureText(s.text, settings.fontFamily, settings.fontSize, settings.bold, settings.italic);

      let split = size.width > settings.renderRectWidth || size.height > settings.renderRectHeight;
      if (!split) {
        split = !this.determineNonWordBreakingFont(s.text, settings, minimalFontSize);
      }

      if (split) {
        const generated = this.generateSections(s.text, s.block, settings, s.from, s.type, minimalFontSize);

        // Keep split ranges inside the source section range.
        for (const section of generated) {
          section.from = Math.max(s.from, Math.min(section.from, s.to));
          section.to = Math.max(section.from + 1, Math.min(section.to, s.to));
        }

        items.push(...generated);
      } else {
        items.push({
          text: s.text,
          from: s.from,
          to: s.to,
          block: s.block,
          type: s.type,
          label: s.text,
        });
      }
    }

    return items;
  }

  /**
   * Dispose resources
   */
  dispose(): void {
    this.measurer.dispose();
  }
}
