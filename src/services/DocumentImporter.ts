import mammoth from "mammoth";
import * as pdfjsLib from "pdfjs-dist";
import { ImportLine, ImportLines } from "../../db-common/ImportLine";

// Configure PDF.js worker - use local worker instead of CDN
pdfjsLib.GlobalWorkerOptions.workerSrc = new URL("pdfjs-dist/build/pdf.worker.min.mjs", import.meta.url).toString();

/**
 * Service for importing documents and extracting text
 * Replaces WordForm.cs Word Interop functionality with web-based parsing
 */
export class DocumentImporter {
  /**
   * Parse a document file and extract lines of text
   * Supports: .docx, .pdf, .html, .txt, .chp
   */
  async parseDocument(file: File): Promise<ImportLines> {
    const extension = this.getFileExtension(file.name).toLowerCase();

    switch (extension) {
      case ".docx":
        return await this.parseDocx(file);
      case ".pdf":
        return await this.parsePdf(file);
      case ".html":
      case ".htm":
        return await this.parseHtml(file);
      case ".txt":
      case ".chp":
        return await this.parseText(file);
      default:
        throw new Error(`Unsupported file format: ${extension}`);
    }
  }

  /**
   * Parse .docx file using mammoth.js
   */
  private async parseDocx(file: File): Promise<ImportLines> {
    const arrayBuffer = await file.arrayBuffer();
    const result = await mammoth.extractRawText({ arrayBuffer });
    return this.textToLines(result.value);
  }

  /**
   * Parse .pdf file using pdf.js
   */
  private async parsePdf(file: File): Promise<ImportLines> {
    const arrayBuffer = await file.arrayBuffer();
    const loadingTask = pdfjsLib.getDocument({ data: arrayBuffer });
    const pdf = await loadingTask.promise;

    let fullText = "";

    // Extract text from all pages
    for (let pageNum = 1; pageNum <= pdf.numPages; pageNum++) {
      const page = await pdf.getPage(pageNum);
      const textContent = await page.getTextContent();

      // Sort items by Y position to maintain line order
      const items = textContent.items as Array<{ str: string; transform: number[] }>;
      items.sort((a, b) => {
        // Sort by Y first (top to bottom), then X (left to right)
        if (Math.abs(a.transform[5] - b.transform[5]) > 2) {
          return b.transform[5] - a.transform[5]; // Descending Y (top to bottom)
        }
        return a.transform[4] - b.transform[4]; // Ascending X (left to right)
      });

      // Group items by Y position to form lines
      let currentY = items[0]?.transform[5];
      let currentLine = "";

      for (const item of items) {
        const y = item.transform[5];

        // If Y position changed significantly, start new line
        if (Math.abs(currentY - y) > 2) {
          if (currentLine.trim()) {
            fullText += currentLine.trim() + "\n";
          }
          currentLine = item.str;
          currentY = y;
        } else {
          // Same line, add space if needed
          if (currentLine && !currentLine.endsWith(" ") && !item.str.startsWith(" ")) {
            currentLine += " ";
          }
          currentLine += item.str;
        }
      }

      // Add last line of page
      if (currentLine.trim()) {
        fullText += currentLine.trim() + "\n";
      }

      // Add page separator
      if (pageNum < pdf.numPages) {
        fullText += "\n";
      }
    }

    return this.textToLines(fullText);
  }

  /**
   * Parse .html file
   */
  private async parseHtml(file: File): Promise<ImportLines> {
    const text = await file.text();
    const parser = new DOMParser();
    const doc = parser.parseFromString(text, "text/html");

    // Extract text from body, preserving line breaks
    const body = doc.body;
    const extractedText = this.extractTextFromElement(body);

    return this.textToLines(extractedText);
  }

  /**
   * Parse plain text file (.txt, .chp)
   */
  private async parseText(file: File): Promise<ImportLines> {
    const text = await file.text();
    return this.textToLines(text);
  }

  /**
   * Extract text from HTML element, preserving structure
   */
  private extractTextFromElement(element: Element): string {
    let text = "";

    for (const node of Array.from(element.childNodes)) {
      if (node.nodeType === Node.TEXT_NODE) {
        text += node.textContent;
      } else if (node.nodeType === Node.ELEMENT_NODE) {
        const el = node as Element;
        const tagName = el.tagName.toLowerCase();

        // Block elements create new lines
        if (["p", "div", "br", "h1", "h2", "h3", "h4", "h5", "h6", "li"].includes(tagName)) {
          text += this.extractTextFromElement(el) + "\n";
        } else {
          text += this.extractTextFromElement(el);
        }
      }
    }

    return text;
  }

  /**
   * Convert plain text to ImportLines
   * Automatically filters out empty and whitespace-only lines
   */
  private textToLines(text: string): ImportLines {
    const lines = new ImportLines();
    const textLines = text.split(/\r?\n/);

    for (const line of textLines) {
      // Skip empty or whitespace-only lines
      if (line.trim() === "") {
        continue;
      }
      lines.add(new ImportLine(line, ""));
    }

    return lines;
  }

  /**
   * Get file extension including the dot
   */
  private getFileExtension(filename: string): string {
    const lastDot = filename.lastIndexOf(".");
    return lastDot === -1 ? "" : filename.substring(lastDot);
  }

  /**
   * Check if file type is supported
   */
  static isSupportedFile(filename: string): boolean {
    const ext = filename.substring(filename.lastIndexOf(".")).toLowerCase();
    const supportedExtensions = [".chp", ".txt", ".pdf", ".docx", ".htm", ".html"];
    return supportedExtensions.includes(ext);
  }

  /**
   * Get list of supported file extensions
   */
  static getSupportedExtensions(): string[] {
    return [".chp", ".txt", ".pdf", ".docx", ".htm", ".html"];
  }
}
