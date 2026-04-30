/**
 * Utility class for measuring text dimensions using Canvas API
 * Port of C# GDI+ Graphics.MeasureString() functionality
 */
export class TextMeasurer {
  private canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;

  constructor() {
    this.canvas = document.createElement("canvas");
    const context = this.canvas.getContext("2d");
    if (!context) {
      throw new Error("Could not create canvas context");
    }
    this.ctx = context;
  }

  /**
   * Build font string for Canvas API
   */
  private buildFontString(fontFamily: string, fontSize: number, bold: boolean, italic: boolean): string {
    let font = "";
    if (italic) font += "italic ";
    if (bold) font += "bold ";
    font += `${fontSize}px `;
    font += fontFamily;
    return font;
  }

  /**
   * Measure single line text dimensions
   */
  measureText(text: string, fontFamily: string, fontSize: number, bold: boolean = false, italic: boolean = false): { width: number; height: number } {
    this.ctx.font = this.buildFontString(fontFamily, fontSize, bold, italic);
    const metrics = this.ctx.measureText(text);

    const width = metrics.width;

    // Calculate height from font metrics
    const height = metrics.actualBoundingBoxAscent + metrics.actualBoundingBoxDescent;

    return { width, height };
  }

  /**
   * Measure text with width constraint (similar to C# MeasureString with maxWidth)
   * This method tries to match GDI+ MeasureString behavior more closely
   */
  measureTextConstrained(
    text: string,
    fontFamily: string,
    fontSize: number,
    maxWidth: number,
    bold: boolean = false,
    italic: boolean = false
  ): { width: number; height: number; linesFilled: number } {
    this.ctx.font = this.buildFontString(fontFamily, fontSize, bold, italic);

    // Handle empty text
    if (!text || text.trim() === "") {
      return { width: 0, height: 0, linesFilled: 0 };
    }

    // Split by explicit line breaks first (like GDI+)
    const explicitLines = text.replace(/\r/g, "").split("\n");
    let totalLines = 0;
    let maxLineWidth = 0;

    for (const line of explicitLines) {
      if (line.trim() === "") {
        totalLines++; // Empty lines still count
        continue;
      }

      // For each explicit line, do word wrapping
      const words = line.split(/\s+/).filter((w) => w.length > 0);
      if (words.length === 0) {
        totalLines++;
        continue;
      }

      let currentLine = "";
      let linesInThisBlock = 0;

      for (const word of words) {
        const testLine = currentLine + (currentLine ? " " : "") + word;
        const metrics = this.ctx.measureText(testLine);

        if (metrics.width > maxWidth && currentLine) {
          // Current line is full, start new line
          linesInThisBlock++;
          maxLineWidth = Math.max(maxLineWidth, this.ctx.measureText(currentLine).width);
          currentLine = word;

          // Check if single word is too long
          const wordMetrics = this.ctx.measureText(word);
          if (wordMetrics.width > maxWidth) {
            // Single word exceeds width - this will cause line breaks within the word
            // For simplicity, we'll count this as multiple lines based on estimated character count
            const estimatedLines = Math.ceil(wordMetrics.width / maxWidth);
            linesInThisBlock += estimatedLines - 1; // -1 because we already counted one line
            maxLineWidth = Math.max(maxLineWidth, maxWidth);
          }
        } else {
          currentLine = testLine;
        }
      }

      if (currentLine) {
        linesInThisBlock++;
        maxLineWidth = Math.max(maxLineWidth, this.ctx.measureText(currentLine).width);
      }

      totalLines += Math.max(1, linesInThisBlock); // At least 1 line per block
    }

    // Calculate line height more accurately for GDI+ compatibility
    const lineHeight = this.getLineHeight(fontFamily, fontSize, bold, italic);

    return {
      width: maxLineWidth,
      height: lineHeight * totalLines,
      linesFilled: totalLines,
    };
  }

  /**
   * Get line height for font (matches GDI+ Font.GetHeight() behavior)
   * GDI+ uses font's designed line spacing from font metrics
   */
  getLineHeight(fontFamily: string, fontSize: number, bold: boolean = false, italic: boolean = false): number {
    this.ctx.font = this.buildFontString(fontFamily, fontSize, bold, italic);

    // Try to get actual font metrics if available
    const metrics = this.ctx.measureText("Äg");
    if (metrics.actualBoundingBoxAscent !== undefined && metrics.actualBoundingBoxDescent !== undefined) {
      // Use actual font metrics with some line spacing
      const ascent = metrics.actualBoundingBoxAscent;
      const descent = metrics.actualBoundingBoxDescent;
      // Add small line gap (typical for fonts is 10-20% of font size)
      const lineGap = fontSize * 0.15;
      return ascent + descent + lineGap;
    }

    // Fallback to estimated height based on font size
    // GDI+ typically returns 1.15-1.25x the font size for most fonts
    return fontSize * 1.2;
  }

  /**
   * Dispose canvas
   */
  dispose(): void {
    // Canvas cleanup if needed
  }
}

/**
 * Interface for text chunk with size and combine level
 * Port of C# ChunkData class
 */
export interface ChunkData {
  text: string;
  width: number;
  height: number;
  combineLevel: number;
}

/**
 * Regex patterns for text splitting (port of C# rxSplits)
 */
export const RX_SPLITS: RegExp[] = [/(?<=[,.;!?)\u201d])|(?=[(\u201c])/, /\b(?=[""\u201c\u201d]?[A-ZÍÉÁŐÚŰÖÜÓ])/, /(?<=[ \t]+)/];

/**
 * Text splitter and combiner for optimal line breaking
 * Port of C# SplitText, CombineChunks, ModifyString methods
 */
export class TextSplitter {
  private measurer: TextMeasurer;

  constructor(measurer: TextMeasurer) {
    this.measurer = measurer;
  }

  /**
   * Split text into chunks (port of C# SplitText)
   */
  splitText(
    text: string,
    fontFamily: string,
    fontSize: number,
    maxWidth: number,
    combineLevel: number,
    bold: boolean = false,
    italic: boolean = false,
    nonSplittingWords: string[] = []
  ): ChunkData[] {
    const chunks: ChunkData[] = [];
    let pre = "";
    let first = true;

    if (combineLevel >= RX_SPLITS.length) {
      const size = this.measurer.measureText(text, fontFamily, fontSize, bold, italic);
      chunks.push({ text, width: size.width, height: size.height, combineLevel });
      return chunks;
    }

    const parts = text.split(RX_SPLITS[combineLevel]);

    for (const part of parts) {
      if (!part) continue;

      let banned = false;
      if (part.trim() !== "" && !".?!".includes(part)) {
        const p = pre + part;
        pre = "";

        if (!first && combineLevel === 1 && nonSplittingWords.length > 0) {
          for (const prefix of nonSplittingWords) {
            if (p.startsWith(prefix)) {
              banned = true;
              break;
            }
          }
        }

        if (!banned) {
          const size = this.measurer.measureText(p, fontFamily, fontSize, bold, italic);
          if (size.width <= maxWidth) {
            chunks.push({ text: p, width: size.width, height: size.height, combineLevel });
          } else {
            chunks.push(...this.splitText(p, fontFamily, fontSize, maxWidth, combineLevel + 1, bold, italic, nonSplittingWords));
          }
          continue;
        }
      }

      first = false;

      if (chunks.length > 0) {
        const last = chunks[chunks.length - 1];
        const p = last.text + part;
        const size = this.measurer.measureText(p, fontFamily, fontSize, bold, italic);

        if (banned && size.width > maxWidth) {
          chunks.pop();
          chunks.push(...this.splitText(p, fontFamily, fontSize, maxWidth, combineLevel + 1, bold, italic, nonSplittingWords));
          continue;
        }

        chunks[chunks.length - 1] = {
          text: p,
          width: size.width,
          height: Math.max(size.height, last.height),
          combineLevel: last.combineLevel,
        };
      } else {
        pre += part;
      }
    }

    if (pre !== "") {
      const size = this.measurer.measureText(pre, fontFamily, fontSize, bold, italic);
      chunks.push({ text: pre, width: size.width, height: size.height, combineLevel });
    }

    if (chunks.length > 1) {
      chunks[0].combineLevel--;
    }

    this.combineChunks(chunks, fontFamily, fontSize, maxWidth, combineLevel, bold, italic);

    return chunks;
  }

  /**
   * Combine chunks optimally (port of C# CombineChunks)
   */
  private combineChunks(
    chunks: ChunkData[],
    fontFamily: string,
    fontSize: number,
    maxWidth: number,
    minCombineLevel: number,
    bold: boolean = false,
    italic: boolean = false
  ): number {
    let maxCombineLevel = Number.MAX_SAFE_INTEGER;

    if (minCombineLevel >= RX_SPLITS.length - 1) {
      // Advanced combining algorithm
      let w = 0;
      for (const c of chunks) w += c.width;
      const l = Math.ceil(w / maxWidth);
      w = Math.ceil(w / l);
      let chl: number[] = [];

      const spaceWidth = this.measurer.measureText(" ", fontFamily, fontSize, bold, italic).width;
      const pipeWidth = this.measurer.measureText("|", fontFamily, fontSize, bold, italic).width;
      const step = Math.floor(Math.min(spaceWidth, pipeWidth));

      while (w <= maxWidth) {
        maxCombineLevel = Number.MAX_SAFE_INTEGER;
        chl = [];
        let aw = 0;

        for (let p = 0; p < chunks.length; ++p) {
          maxCombineLevel = Math.max(maxCombineLevel, chunks[p].combineLevel);
          if (chunks[p].combineLevel < minCombineLevel || aw + chunks[p].width > w) {
            if (p > 0) chl.push(p);
            aw = chunks[p].width;
            if (w < maxWidth - step && chl.length >= l) break;
            continue;
          }
          aw += chunks[p].width;
        }

        if (chl.length < l) break;
        w += step;
      }

      // Merge chunks based on breakpoints
      for (let pos = 1, offset = 0; pos < chunks.length; ++pos) {
        if (chl.length === 0 || chl[0] > pos + offset) {
          const prev = chunks[pos - 1];
          const curr = chunks[pos];
          chunks[pos - 1] = {
            text: prev.text + curr.text,
            width: prev.width + curr.width,
            height: Math.max(prev.height, curr.height),
            combineLevel: prev.combineLevel,
          };
          chunks.splice(pos--, 1);
          ++offset;
        } else if (chl.length > 0) {
          chl.shift();
        }
      }
    } else {
      // Simple combining based on cost
      while (maxCombineLevel >= minCombineLevel) {
        maxCombineLevel = 0;
        let pos = 0;
        let cost = Number.MAX_SAFE_INTEGER;

        for (let p = 1; p < chunks.length; ++p) {
          if (chunks[p].combineLevel >= minCombineLevel) {
            maxCombineLevel = Math.max(maxCombineLevel, chunks[p].combineLevel);
            const rem = maxWidth - chunks[p - 1].width - chunks[p].width;
            if (rem >= 0) {
              const c = -100000 * chunks[p].combineLevel;
              if (c < cost) {
                cost = c;
                pos = p;
              }
            }
          }
        }

        if (pos <= 0) break;

        const prev = chunks[pos - 1];
        const curr = chunks[pos];
        chunks[pos - 1] = {
          text: prev.text + curr.text,
          width: prev.width + curr.width,
          height: Math.max(prev.height, curr.height),
          combineLevel: prev.combineLevel,
        };
        chunks.splice(pos, 1);
      }
    }

    return maxCombineLevel;
  }

  /**
   * Modify string with optimal line breaking (port of C# ModifyString)
   */
  modifyString(
    text: string,
    fontFamily: string,
    fontSize: number,
    maxWidth: number,
    useContentBasedSplit: boolean,
    bold: boolean = false,
    italic: boolean = false,
    nonSplittingWords: string[] = []
  ): string {
    const combineLevel = useContentBasedSplit ? 0 : RX_SPLITS.length - 1;
    const lines = text.replace(/\r/g, "").split("\n");
    const sa: string[] = [];
    const chunks: ChunkData[] = [];

    for (const line of lines) {
      const size = this.measurer.measureText(line, fontFamily, fontSize, bold, italic);
      if (size.width <= maxWidth) {
        chunks.push({ text: line, width: size.width, height: size.height, combineLevel: -1 });
      } else {
        chunks.push(...this.splitText(line, fontFamily, fontSize, maxWidth, combineLevel, bold, italic, nonSplittingWords));
      }
    }

    if (!useContentBasedSplit) {
      this.combineChunks(chunks, fontFamily, fontSize, maxWidth, combineLevel, bold, italic);
    }

    for (const c of chunks) {
      sa.push(c.text.trim());
    }

    return sa.join("\r\n");
  }
}
