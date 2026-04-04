import { WordProp } from "./WordProp";

export class Line extends Array<WordProp> {
  public line_number: number = -1;
  public line_pos: number = 0;
  public page_number: number = 0;
  public line_type: string = "";

  public get IsChordLine(): boolean {
    return this.line_type === "chord";
  }

  public override toString(): string {
    return this.map((wp) => wp.text).join(" ");
  }
}
