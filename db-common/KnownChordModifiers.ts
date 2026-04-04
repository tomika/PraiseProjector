export class KnownChordModifiers {
  private static rxCustom = /^(.*)\(((?:(?:[-+b#](?:[2-79]|1[13])|(?:[2-79]|1[13])[-+b#]),)*(?:[-+b#](?:[2-79]|1[13])|(?:[2-79]|1[13])[-+b#]))\)$/;

  private map: Map<string, string> = new Map();
  private rxFindAndSplit: RegExp;

  constructor(findAndSplitPattern: string, pairs: string[]) {
    this.rxFindAndSplit = new RegExp(findAndSplitPattern); // 0: total, 1: prefix, 2: chord, 3: note, 4: modif, 5: /, 6: basenote, 7: suffix
    for (let i = 0; i + 1 < pairs.length; i += 2) {
      const key = pairs[i];
      const value = pairs[i + 1];
      if (key && value) {
        this.map.set(key, value);
      }
    }
  }

  public identifyChordModifier(modif: string): string | null {
    const norm = this.map.get(modif);
    if (norm) {
      return norm;
    }
    const m = modif.match(KnownChordModifiers.rxCustom);
    if (m && m[1] && m[2]) {
      const norm2 = this.map.get(m[1]);
      if (norm2) {
        return norm2 + "(" + m[2] + ")";
      }
    }
    return null;
  }

  private findAndSplit(chordLikeString: string): string[] | null {
    const m = chordLikeString.match(this.rxFindAndSplit);
    if (m) {
      // Ensure all groups are present, even if empty
      const result = [];
      for (let i = 0; i < 8; i++) {
        result.push(m[i] || "");
      }
      return result;
    }
    return null;
  }

  public validate(chordLikeString: string): boolean {
    const res = this.findAndSplit(chordLikeString);
    if (!res || res.length < 5) {
      return false;
    }
    const modif = res[4] || "";
    return modif === "" || this.identifyChordModifier(modif) != null;
  }
}
