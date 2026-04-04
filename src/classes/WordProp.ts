export class WordProp {
  public text: string = "";
  public pos: number[] = [];

  public get WordPos(): number {
    const firstPos = this.pos[0];
    return firstPos !== undefined ? firstPos : Infinity;
  }
}
