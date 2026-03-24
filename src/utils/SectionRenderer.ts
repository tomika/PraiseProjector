import { TextMeasurer } from "./TextMeasurer";
import { generateQRCodeSVG } from "../hooks/useSessionUrl";

export interface RenderSettings {
  fontFamily: string;
  fontSize: number;
  bold: boolean;
  italic: boolean;
  underline: boolean;
  alignment: "left" | "center" | "right";
  textColor: string;
  bgColor: string;
  textBorderColor: string;
  textBorderWidth: number;
  textShadowOffset: number;
  renderWidth: number;
  renderHeight: number;
  backgroundImageFit: "touchInner" | "touchOuter" | "stretch";
  // Render margins (percentage)
  marginLeft: number;
  marginRight: number;
  marginTop: number;
  marginBottom: number;
  // Font size reduction settings
  checkSectionsProjectable: boolean;

  // Optional QR / web server settings (added so SectionRenderer can embed a QR)
  qrCodeUrl?: string;
  qrCodeX?: number; // Left edge as % of canvas width (0–100)
  qrCodeY?: number; // Top edge as % of canvas height (0–100)
  qrCodeSizePercent?: number; // Size as % of canvas height (5–50)
  webEnabled?: boolean;
  webServerDomainName?: string;
  webServerPort?: number;
}

export class SectionRenderer {
  private canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;
  private textMeasurer: TextMeasurer;

  constructor() {
    this.canvas = document.createElement("canvas");
    const ctx = this.canvas.getContext("2d");
    if (!ctx) {
      throw new Error("Could not get 2D context from canvas");
    }
    this.ctx = ctx;
    this.textMeasurer = new TextMeasurer();
  }

  /**
   * Renders a section text to a canvas with the given settings
   */
  renderSection(text: string, settings: RenderSettings, bgImage?: HTMLImageElement | null): HTMLCanvasElement {
    // Setup canvas size
    this.canvas.width = settings.renderWidth;
    this.canvas.height = settings.renderHeight;

    // Clear canvas
    this.ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);

    // Draw background
    this.drawBackground(settings, bgImage);

    // Draw text if provided
    if (text && text.trim() !== "") {
      this.drawText(text, settings);
    }

    // add QR code if enabled (for web display section)
    if (settings.qrCodeUrl) {
      const sizePercent = settings.qrCodeSizePercent ?? 15;
      const qrSize = Math.round(this.canvas.height * (sizePercent / 100));
      const qrX = Math.round(this.canvas.width * ((settings.qrCodeX ?? 85) / 100));
      const qrY = Math.round(this.canvas.height * ((settings.qrCodeY ?? 82) / 100));

      // Generate QR SVG markup, then rasterize the path data into a temporary canvas.
      try {
        const svgMarkup = generateQRCodeSVG(settings.qrCodeUrl, qrSize, "M");

        // Parse the SVG markup
        const parser = new DOMParser();
        const doc = parser.parseFromString(svgMarkup, "image/svg+xml");
        const svg = doc.querySelector("svg");
        const path = doc.querySelectorAll("svg > path");
        let fgPathD: string | null = null;
        let numCells = qrSize; // fallback
        if (svg) {
          const viewBox = svg.getAttribute("viewBox");
          if (viewBox) {
            const parts = viewBox.split(" ").map((p) => parseInt(p, 10));
            if (parts.length === 4 && !Number.isNaN(parts[2])) numCells = parts[2];
          }
        }
        // QRCodeSVG renders two <path> elements: background then foreground
        if (path && path.length >= 2) fgPathD = (path[1] as SVGPathElement).getAttribute("d");
        else if (path && path.length === 1) fgPathD = (path[0] as SVGPathElement).getAttribute("d");

        // Create a temporary canvas and draw parsed path rectangles onto it
        const qrCanvas = document.createElement("canvas");
        qrCanvas.width = qrSize;
        qrCanvas.height = qrSize;
        const qctx = qrCanvas.getContext("2d");
        if (qctx && fgPathD) {
          // Clear and paint a white background so the QR is visible on dark slides.
          qctx.clearRect(0, 0, qrCanvas.width, qrCanvas.height);
          qctx.fillStyle = "#ffffff";
          qctx.fillRect(0, 0, qrCanvas.width, qrCanvas.height);
          qctx.fillStyle = "#000000";

          // Path format used by QRCodeSVG.generatePath is sequences of `M{x} {y}h{w}v1H{x}z` (integers)
          // We'll extract all `M` segments and draw rectangles scaled to requested size.
          const scale = qrSize / numCells;
          const rx = /M\s*([0-9]+)[, ]\s*([0-9]+)[^h]*h([0-9]+)/g;
          let m;
          while ((m = rx.exec(fgPathD)) !== null) {
            const startX = parseInt(m[1], 10);
            const startY = parseInt(m[2], 10);
            const runW = parseInt(m[3], 10);
            qctx.fillRect(startX * scale, startY * scale, runW * scale, 1 * scale);
          }
        }

        // Draw QR onto real canvas
        this.ctx.drawImage(qrCanvas, qrX, qrY, qrSize, qrSize);
      } catch (error) {
        // Non-fatal: skip QR if anything fails
        console.error("SectionRenderer: QR generation failed", error);
      }
    }

    return this.canvas;
  }

  /**
   * Draws the background (color + optional image)
   */
  private drawBackground(settings: RenderSettings, bgImage?: HTMLImageElement | null): void {
    // Fill with background color
    this.ctx.fillStyle = settings.bgColor;
    this.ctx.fillRect(0, 0, this.canvas.width, this.canvas.height);

    // Draw background image using the configured fit mode.
    if (bgImage) {
      switch (settings.backgroundImageFit) {
        case "stretch":
          this.ctx.drawImage(bgImage, 0, 0, this.canvas.width, this.canvas.height);
          break;
        case "touchOuter": {
          const crop = this.calculateCoverSourceRect(bgImage.width, bgImage.height, this.canvas.width, this.canvas.height);
          this.ctx.drawImage(bgImage, crop.x, crop.y, crop.width, crop.height, 0, 0, this.canvas.width, this.canvas.height);
          break;
        }
        case "touchInner":
        default: {
          const letterbox = this.calculateLetterboxRect(bgImage.width, bgImage.height, this.canvas.width, this.canvas.height);
          this.ctx.drawImage(bgImage, letterbox.x, letterbox.y, letterbox.width, letterbox.height);
          break;
        }
      }
    }
  }

  /**
   * Calculates point size based on render area (exact port from C# PointSize property)
   * PointSize = Min(width, height) / 200
   */
  static calculatePointSize(renderWidth: number, renderHeight: number): number {
    return (Math.min(renderWidth, renderHeight) / 200) * 1.4;
  }

  /**
   * Converts user font size (percentage-based) to actual pixel size
   * In C#: ActualFontSize = PointSize * userFontSize
   * The C# GDI+ MeasureString includes line spacing automatically
   * We match that behavior here
   */
  static calculateActualFontSize(userFontSize: number, renderWidth: number, renderHeight: number): number {
    const pointSize = this.calculatePointSize(renderWidth, renderHeight);
    return pointSize * userFontSize;
  }

  /**
   * Draws text with optimal font size, outline, and shadow (exact port from C# DrawString + GenerateProjectedImage)
   */
  private drawText(text: string, settings: RenderSettings): void {
    // Calculate render rectangle (with margins)
    const renderRect = this.calculateRenderRect(settings);

    // Convert user font size to actual pixel size
    let fontSize = SectionRenderer.calculateActualFontSize(settings.fontSize, settings.renderWidth, settings.renderHeight);

    // Calculate minimum font size (matching C# CalcMinFontSize logic)
    const minFontSize = Math.max(6, Math.floor(fontSize * 0.3));

    // Main rendering loop (exact port from C# GenerateProjectedImage)

    while (true) {
      // Build font string for current size
      const fontString = this.buildFontString(settings.fontFamily, fontSize, settings.bold, settings.italic);
      this.ctx.font = fontString;

      // Check if we should attempt rendering with this font size
      // Port of: nMinFontSize >= nFontSize || DetermineNonWordBreakingFont(...) == font
      const shouldTryRender = minFontSize >= fontSize || this.determineNonWordBreakingFont(text, fontSize, settings, renderRect.width);

      if (shouldTryRender) {
        // Measure text height (port of: g.MeasureString(displayText, font, renderRect.Width, format))
        const textHeight = this.measureTextHeight(text, settings.fontFamily, fontSize, settings.bold, settings.italic, renderRect.width);

        // Check if fits or we've reached minimum size
        // Port of: size.Height <= renderRect.Height || --nFontSize < nMinFontSize
        if (textHeight <= renderRect.height || fontSize <= minFontSize) {
          // Render the text and break
          this.renderTextWithFont(text, settings, renderRect, fontSize);
          break;
        } else {
          // Decrease font size and continue
          fontSize--;
        }
      } else {
        // Font doesn't pass word-breaking test, decrease size
        fontSize--;
      }

      // Safety check to prevent infinite loop
      if (fontSize < 6) {
        this.renderTextWithFont(text, settings, renderRect, 6);
        break;
      }
    }
  }

  /**
   * Draws multiline text (handles line breaks)
   */
  private drawMultilineText(
    text: string,
    x: number,
    y: number,
    maxWidth: number,
    fontFamily: string,
    fontSize: number,
    bold: boolean,
    italic: boolean,
    stroke: boolean = false
  ): void {
    const lines = text.split(/\r?\n/);
    const lineHeight = this.textMeasurer.getLineHeight(fontFamily, fontSize, bold, italic);
    const totalHeight = lines.length * lineHeight;

    // Start from the top of the text block, centered vertically
    // textBaseline is 'middle', so we position at the middle of each line
    let currentY = y - totalHeight / 2 + lineHeight / 2;

    for (const line of lines) {
      const trimmedLine = line.trim();
      if (trimmedLine) {
        if (stroke) {
          this.ctx.strokeText(trimmedLine, x, currentY, maxWidth);
        } else {
          this.ctx.fillText(trimmedLine, x, currentY, maxWidth);
        }
      }
      // Move to next line - this is where line spacing happens
      currentY += lineHeight;
    }
  }

  /**
   * Draws underline for text
   */
  private drawUnderline(
    text: string,
    x: number,
    y: number,
    maxWidth: number,
    fontFamily: string,
    fontSize: number,
    bold: boolean,
    italic: boolean,
    textColor: string
  ): void {
    const lines = text.split(/\r?\n/);
    const lineHeight = this.textMeasurer.getLineHeight(fontFamily, fontSize, bold, italic);
    const totalHeight = lines.length * lineHeight;
    let currentY = y - totalHeight / 2 + lineHeight / 2;

    this.ctx.strokeStyle = textColor;
    this.ctx.lineWidth = Math.max(1, fontSize / 20);

    for (const line of lines) {
      const trimmedLine = line.trim();
      if (trimmedLine) {
        const metrics = this.textMeasurer.measureText(trimmedLine, fontFamily, fontSize, bold, italic);
        const textWidth = metrics.width;

        let underlineX = x;
        // Note: x position already accounts for alignment from calculateTextPosition
        // For left align, text starts at x
        // For center, text is centered at x
        // For right, text ends at x
        underlineX = x - textWidth / 2; // Assuming center aligned calculation

        const underlineY = currentY + lineHeight / 4;
        this.ctx.beginPath();
        this.ctx.moveTo(underlineX, underlineY);
        this.ctx.lineTo(underlineX + textWidth, underlineY);
        this.ctx.stroke();
      }
      currentY += lineHeight;
    }
  }

  /**
   * Optimizes font size to fit text within render rectangle
   */
  private optimizeFontSize(text: string, settings: RenderSettings, renderRect: { width: number; height: number }, baseFontSize: number): number {
    let fontSize = baseFontSize;
    const minFontSize = Math.max(6, Math.floor(baseFontSize * 0.3));

    // Check if text fits with initial font size
    while (fontSize >= minFontSize) {
      const lines = text.split(/\r?\n/);
      const lineHeight = this.textMeasurer.getLineHeight(settings.fontFamily, fontSize, settings.bold, settings.italic);
      const totalHeight = lines.length * lineHeight;

      // Check height
      if (totalHeight > renderRect.height) {
        fontSize--;
        continue;
      }

      // Check width for each line
      let fits = true;
      for (const line of lines) {
        const metrics = this.textMeasurer.measureText(line.trim(), settings.fontFamily, fontSize, settings.bold, settings.italic);
        if (metrics.width > renderRect.width) {
          fits = false;
          break;
        }
      }

      if (fits) {
        break;
      }

      fontSize--;
    }

    return Math.max(minFontSize, fontSize);
  }

  /**
   * Calculates the render rectangle with margins applied
   */
  private calculateRenderRect(settings: RenderSettings): {
    x: number;
    y: number;
    width: number;
    height: number;
  } {
    const x = Math.floor((this.canvas.width * settings.marginLeft) / 100);
    const y = Math.floor((this.canvas.height * settings.marginTop) / 100);
    const width = this.canvas.width - Math.floor((this.canvas.width * (settings.marginLeft + settings.marginRight)) / 100);
    const height = this.canvas.height - Math.floor((this.canvas.height * (settings.marginTop + settings.marginBottom)) / 100);

    return { x, y, width, height };
  }

  /**
   * Calculates text position based on alignment
   */
  private calculateTextPosition(
    alignment: "left" | "center" | "right",
    renderRect: { x: number; y: number; width: number; height: number }
  ): { x: number; y: number } {
    let x: number;
    if (alignment === "left") {
      x = renderRect.x;
    } else if (alignment === "right") {
      x = renderRect.x + renderRect.width;
    } else {
      x = renderRect.x + renderRect.width / 2;
    }

    const y = renderRect.y + renderRect.height / 2;

    return { x, y };
  }

  /**
   * Converts alignment to canvas textAlign value
   */
  private getCanvasAlignment(alignment: "left" | "center" | "right"): CanvasTextAlign {
    switch (alignment) {
      case "left":
        return "left";
      case "center":
        return "center";
      case "right":
        return "right";
    }
  }

  /**
   * Builds a CSS font string
   */
  private buildFontString(family: string, size: number, bold: boolean, italic: boolean): string {
    let font = "";
    if (italic) font += "italic ";
    if (bold) font += "bold ";
    font += `${size}px ${family}`;
    return font;
  }

  /**
   * Calculates letterbox rectangle for image to fit within bounds while maintaining aspect ratio
   */
  private calculateLetterboxRect(
    imageWidth: number,
    imageHeight: number,
    containerWidth: number,
    containerHeight: number
  ): { x: number; y: number; width: number; height: number } {
    const imageAspect = imageWidth / imageHeight;
    const containerAspect = containerWidth / containerHeight;

    let width: number, height: number, x: number, y: number;

    if (imageAspect > containerAspect) {
      // Image is wider than container
      width = containerWidth;
      height = containerWidth / imageAspect;
      x = 0;
      y = (containerHeight - height) / 2;
    } else {
      // Image is taller than container
      width = containerHeight * imageAspect;
      height = containerHeight;
      x = (containerWidth - width) / 2;
      y = 0;
    }

    return { x, y, width, height };
  }

  /**
   * Calculates source crop rectangle for image to fully cover bounds while maintaining aspect ratio.
   */
  private calculateCoverSourceRect(
    imageWidth: number,
    imageHeight: number,
    containerWidth: number,
    containerHeight: number
  ): { x: number; y: number; width: number; height: number } {
    const imageAspect = imageWidth / imageHeight;
    const containerAspect = containerWidth / containerHeight;

    if (imageAspect > containerAspect) {
      const width = imageHeight * containerAspect;
      const x = (imageWidth - width) / 2;
      return { x, y: 0, width, height: imageHeight };
    }

    const height = imageWidth / containerAspect;
    const y = (imageHeight - height) / 2;
    return { x: 0, y, width: imageWidth, height };
  }

  /**
   * Checks if text fits within a rectangle
   */
  private doesTextFit(
    text: string,
    fontFamily: string,
    fontSize: number,
    bold: boolean,
    italic: boolean,
    renderRect: { width: number; height: number }
  ): boolean {
    const lines = text.split(/\r?\n/);
    const lineHeight = this.textMeasurer.getLineHeight(fontFamily, fontSize, bold, italic);
    const totalHeight = lines.length * lineHeight;

    if (totalHeight > renderRect.height) {
      return false;
    }

    for (const line of lines) {
      const metrics = this.textMeasurer.measureText(line.trim(), fontFamily, fontSize, bold, italic);
      if (metrics.width > renderRect.width) {
        return false;
      }
    }

    return true;
  }

  /**
   * Wraps text to fit within specified width
   */
  private wrapText(text: string, fontFamily: string, fontSize: number, bold: boolean, italic: boolean, maxWidth: number): string {
    const lines = text.split(/\r?\n/);
    const wrappedLines: string[] = [];

    for (const line of lines) {
      if (line.trim() === "") {
        wrappedLines.push("");
        continue;
      }

      const words = line.split(" ");
      let currentLine = "";

      for (let i = 0; i < words.length; i++) {
        const word = words[i];
        const testLine = currentLine === "" ? word : currentLine + " " + word;
        const metrics = this.textMeasurer.measureText(testLine, fontFamily, fontSize, bold, italic);

        if (metrics.width <= maxWidth || currentLine === "") {
          currentLine = testLine;
        } else {
          wrappedLines.push(currentLine);
          currentLine = word;
        }
      }

      if (currentLine !== "") {
        wrappedLines.push(currentLine);
      }
    }

    return wrappedLines.join("\n");
  }

  /**
   * Calculates total height of text
   */
  private calculateTextHeight(text: string, fontFamily: string, fontSize: number, bold: boolean, italic: boolean): number {
    const lines = text.split(/\r?\n/);
    const lineHeight = this.textMeasurer.getLineHeight(fontFamily, fontSize, bold, italic);
    return lines.length * lineHeight;
  }

  /**
   * Determine if font would cause word breaking (port of C# DetermineNonWordBreakingFont)
   * Returns true if font is OK to use (doesn't break words), false if font is too big
   */
  private determineNonWordBreakingFont(text: string, fontSize: number, settings: RenderSettings, width: number): boolean {
    if (!settings.checkSectionsProjectable) return true;

    const margin = width * 0.7;
    const rxWord = /\w+/g;
    const matches = text.match(rxWord) || [];

    // Sort words by length descending - match C# OrderByDescending
    const words = matches.sort((a, b) => b.length - a.length);

    for (const word of words) {
      const result = this.textMeasurer.measureTextConstrained(word, settings.fontFamily, fontSize, width, settings.bold, settings.italic);

      if (result.linesFilled > 1) {
        // Would break this word - font too big
        return false;
      } else if (result.width < margin) {
        break;
      }
    }

    return true;
  }

  /**
   * Measure text height for given constraints (port of C# MeasureString height logic)
   */
  private measureTextHeight(text: string, fontFamily: string, fontSize: number, bold: boolean, italic: boolean, width: number): number {
    const result = this.textMeasurer.measureTextConstrained(text, fontFamily, fontSize, width, bold, italic);
    return result.height;
  }

  /**
   * Render text with specific font size (port of C# DrawString)
   */
  private renderTextWithFont(
    text: string,
    settings: RenderSettings,
    renderRect: { x: number; y: number; width: number; height: number },
    fontSize: number
  ): void {
    // Build font string
    const fontString = this.buildFontString(settings.fontFamily, fontSize, settings.bold, settings.italic);

    // Setup text rendering
    this.ctx.font = fontString;
    this.ctx.textAlign = this.getCanvasAlignment(settings.alignment);
    this.ctx.textBaseline = "middle";

    // Calculate text position
    const { x, y } = this.calculateTextPosition(settings.alignment, renderRect);

    // Wrap text if needed
    const wrappedText = this.wrapText(text, settings.fontFamily, fontSize, settings.bold, settings.italic, renderRect.width);

    // Draw shadow first (if enabled)
    if (settings.textShadowOffset > 0) {
      this.ctx.save();
      this.ctx.shadowColor = "rgba(0, 0, 0, 0.8)";
      this.ctx.shadowBlur = 4;
      this.ctx.shadowOffsetX = settings.textShadowOffset;
      this.ctx.shadowOffsetY = settings.textShadowOffset;
      this.ctx.fillStyle = settings.textColor;
      this.drawMultilineText(wrappedText, x, y, renderRect.width, settings.fontFamily, fontSize, settings.bold, settings.italic);
      this.ctx.restore();
    }

    // Draw text outline (stroke)
    if (settings.textBorderWidth > 0) {
      this.ctx.strokeStyle = settings.textBorderColor;
      this.ctx.lineWidth = settings.textBorderWidth;
      this.ctx.lineJoin = "round";
      this.ctx.miterLimit = 2;
      this.drawMultilineText(wrappedText, x, y, renderRect.width, settings.fontFamily, fontSize, settings.bold, settings.italic, true);
    }

    // Draw text fill
    this.ctx.fillStyle = settings.textColor;
    this.drawMultilineText(wrappedText, x, y, renderRect.width, settings.fontFamily, fontSize, settings.bold, settings.italic);

    // Draw underline if enabled
    if (settings.underline) {
      this.drawUnderline(wrappedText, x, y, renderRect.width, settings.fontFamily, fontSize, settings.bold, settings.italic, settings.textColor);
    }
  }

  /**
   * Disposes of resources
   */
  dispose(): void {
    // Canvas cleanup if needed
    this.textMeasurer.dispose();
  }
}
