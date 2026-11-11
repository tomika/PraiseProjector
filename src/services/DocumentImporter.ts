import mammoth from "mammoth";
import { ImportLine, ImportLines } from "../../db-common/ImportLine";
import { extractDocumentText } from "./documentText";

function checkCancelled(signal?: AbortSignal): void {
  if (signal?.aborted) throw new DOMException("Import cancelled", "AbortError");
}

/**
 * Service for importing documents and extracting text
 * Replaces WordForm.cs Word Interop functionality with web-based parsing
 */
export class DocumentImporter {
  /**
   * Parse a document file and extract lines of text
   * Supports: .docx, .pdf, .html, .txt, .chp, .abc
   */
  async parseDocument(file: File, signal?: AbortSignal): Promise<ImportLines> {
    checkCancelled(signal);
    const extension = this.getFileExtension(file.name).toLowerCase();
    let lines: ImportLines;
    switch (extension) {
      case ".docx":
        lines = await this.parseDocx(file, signal);
        break;
      case ".pdf":
        lines = await this.parsePdf(file, signal);
        break;
      case ".html":
      case ".htm":
        lines = await this.parseHtml(file);
        break;
      case ".txt":
      case ".chp":
      case ".abc":
        lines = await this.parseText(file);
        break;
      default:
        throw new Error(`Unsupported file format: ${extension}`);
    }
    checkCancelled(signal);
    return lines;
  }

  /**
   * Parse .docx file using mammoth.js
   */
  private async parseDocx(file: File, signal?: AbortSignal): Promise<ImportLines> {
    const arrayBuffer = await file.arrayBuffer();
    checkCancelled(signal);
    const result = await mammoth.extractRawText({ arrayBuffer });
    checkCancelled(signal);
    return this.textToLines(result.value);
  }

  /**
   * Parse .pdf file using pdf.js
   */
  private async parsePdf(file: File, signal?: AbortSignal): Promise<ImportLines> {
    const arrayBuffer = await file.arrayBuffer();
    checkCancelled(signal);
    const pdfjsLib = await import("pdfjs-dist");
    checkCancelled(signal);
    // Load PDF.js and its local worker only when this request needs them.
    pdfjsLib.GlobalWorkerOptions.workerSrc = new URL("pdfjs-dist/build/pdf.worker.min.mjs", import.meta.url).toString();
    const loadingTask = pdfjsLib.getDocument({ data: arrayBuffer });
    let destruction: Promise<void> | undefined;
    const destroy = () => (destruction ??= loadingTask.destroy());
    const onAbort = () => {
      void destroy().catch(() => undefined);
    };
    signal?.addEventListener("abort", onAbort, { once: true });
    try {
      const pdf = await loadingTask.promise;
      checkCancelled(signal);

      let fullText = "";

      // Extract text from all pages
      for (let pageNum = 1; pageNum <= pdf.numPages; pageNum++) {
        const page = await pdf.getPage(pageNum);
        checkCancelled(signal);
        const textContent = await page.getTextContent();
        checkCancelled(signal);

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
    } finally {
      signal?.removeEventListener("abort", onAbort);
      await destroy();
    }
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
    const extractedText = extractDocumentText(body);

    return this.textToLines(extractedText);
  }

  /**
   * The text of a plain-text or HTML file as it reads, keeping its line breaks
   * and blank lines (format detection, e.g. ABC notation copied from a page).
   */
  async readPlainText(file: File, signal?: AbortSignal): Promise<string> {
    checkCancelled(signal);
    const text = await file.text();
    checkCancelled(signal);
    const extension = this.getFileExtension(file.name).toLowerCase();
    if (extension !== ".html" && extension !== ".htm") return text;
    const doc = new DOMParser().parseFromString(text, "text/html");
    return extractDocumentText(doc.body);
  }

  /**
   * Parse plain text file (.txt, .chp, .abc)
   */
  private async parseText(file: File): Promise<ImportLines> {
    const text = await file.text();
    return this.textToLines(text);
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
    return DocumentImporter.getSupportedExtensions().includes(ext);
  }

  /**
   * Get list of supported file extensions
   */
  static getSupportedExtensions(): string[] {
    return [".chp", ".abc", ".musicxml", ".xml", ".mxl", ".txt", ".pdf", ".docx", ".htm", ".html"];
  }
}
