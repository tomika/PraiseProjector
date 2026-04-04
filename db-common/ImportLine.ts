/**
 * Port of C# Line class from SongImporterForm
 * Represents a single line in the import process with type classification
 */
export class ImportLine {
  line_type: string = ""; // 'title', 'chord', 'lyrics', 'comment', or ''
  text: string;

  constructor(text: string, lineType: string = "") {
    this.text = text;
    this.line_type = lineType;
  }

  /**
   * Clone this line
   */
  clone(): ImportLine {
    return new ImportLine(this.text, this.line_type);
  }
}

/**
 * Port of C# Lines class from SongImporterForm
 * Collection of ImportLine objects
 */
export class ImportLines {
  private lines: ImportLine[] = [];

  constructor(lines?: ImportLine[]) {
    if (lines) {
      this.lines = lines;
    }
  }

  /**
   * Get line at index
   */
  get(index: number): ImportLine | undefined {
    return this.lines[index];
  }

  /**
   * Add a line
   */
  add(line: ImportLine): void {
    this.lines.push(line);
  }

  /**
   * Get line count
   */
  get count(): number {
    return this.lines.length;
  }

  /**
   * Get all lines
   */
  getAll(): ImportLine[] {
    return this.lines;
  }

  /**
   * Remove line at index
   */
  removeAt(index: number): void {
    this.lines.splice(index, 1);
  }

  /**
   * Clear all lines
   */
  clear(): void {
    this.lines = [];
  }

  /**
   * Clone this collection
   */
  clone(): ImportLines {
    const clonedLines = this.lines.map((l) => l.clone());
    return new ImportLines(clonedLines);
  }
}
