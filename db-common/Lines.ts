import { Line } from "./Line";
import { WordProp } from "./WordProp";

export class Lines extends Array<Line> {
  public attributes: Map<string, string> = new Map();

  public static fromText(text: string): Lines {
    const lines = new Lines();
    let lineNumber = 1;
    for (const l of text.replace(/\r\n/g, "\n").split("\n")) {
      if (l.trim() !== "") {
        const line = new Line();
        line.page_number = 0;
        line.line_number = lineNumber++;

        let col = 1;
        for (const w of l.split(" ")) {
          if (w !== "") {
            const word = new WordProp();
            word.text = w;
            for (let i = 0; i < w.length; ++i) {
              word.pos.push(++col);
            }
            line.push(word);
          }
          col++;
        }
        lines.push(line);
      }
    }
    return lines;
  }
}
