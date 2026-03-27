import { AbcVisualParams, renderAbc, strTranspose, synth, TuneObjectArray } from "abcjs";
import { allChordInfo, ChordInfo, chordMap, findOrCreateChordVariant, rxChordExtension } from "./allchords";
import { ChordDetails, Key, NoteSystem, NoteSystemCode } from "./note_system";
import { ItemToPosition } from "./placer";
import { UnicodeSymbol } from "../common/symbols";
import { DifferentialText } from "../common/utils";

export type ChordSystemCode = NoteSystemCode;

const systems = new Map<ChordSystemCode, ChordSystem>();

export function getChordSystem(systeCode: ChordSystemCode) {
  let system = systems.get(systeCode);
  if (!system) systems.set(systeCode, (system = new ChordSystem(systeCode)));
  return system;
}

export function fixChordProText(text: string) {
  return text.replace(/\r/g, "");
}

export class ChordSystem extends NoteSystem {
  readonly noteRegexPattern: string;
  readonly chordLikeRegexPattern: string;
  readonly chordFindAndSplitPattern: string;

  readonly rxChordFindAndSplit: RegExp;
  private readonly rxChordFinder: RegExp;
  private readonly fourNoteVariantMap = new Map<string, string>();

  static isMinor(info: ChordInfo) {
    return info.desc.includes("-b3-") && info.desc.includes("-5");
  }

  static noThird(info: ChordInfo) {
    return !info.desc.match(/-[b#]?3-/);
  }

  constructor(readonly systemCode: ChordSystemCode) {
    super(systemCode);
    this.noteRegexPattern = `[${this.possibleNoteList}][#${UnicodeSymbol.sharp}b${UnicodeSymbol.flat}]?`;

    const set = new Set<string>();
    chordMap.forEach((value, key) => {
      for (const ch of key.replace(/\(.*/, "")) set.add(ch);
    });
    let modifChars = "";
    set.forEach((value) => {
      if (value !== "/") {
        if (value === "-") modifChars += "\\";
        modifChars += value;
      }
    });
    //(?<=\\W|^) ... (?=\\W|$) lookahead/behind not supported by IE and old browsers :/
    this.chordLikeRegexPattern =
      "(" + this.noteRegexPattern + ")((?:(?:[" + modifChars + "]|\\/[0-9])+(?:\\([^)]+\\))?)?)(?:(\\/)(" + this.noteRegexPattern + "))?";

    /*
export const chordRegexPattern = (() => {
    const set = new Set<string>();
    chordMap.forEach((value, key) => set.add(key.replace(/[( )]/g, s => '\\' + s)));
    let modifierRegexPattern = Array.from(set).join('|');
    return `(${noteRegexPattern})(${modifierRegexPattern})?(/${noteRegexPattern})?`;
})();
*/
    this.chordFindAndSplitPattern = "^([^" + this.possibleNoteList + "]*)(" + this.chordLikeRegexPattern + ")(.*)$";
    this.rxChordFindAndSplit = new RegExp(this.chordFindAndSplitPattern, "i");
    this.rxChordFinder = new RegExp(this.chordLikeRegexPattern, "g");
  }

  identifyChord(chord: string | ChordProChordBase): ChordDetails | null {
    if (typeof chord === "string") chord = new ChordProChordBase(this, chord);
    const baseNote = this.stringToNote(chord.baseNote);
    return baseNote !== null && chord.chordInfo && !chord.prefix && !chord.suffix
      ? {
          baseNote,
          bassNote: chord.bassNote ? this.stringToNote(chord.bassNote) : null,
          subscript: chord.symbol,
          chordInfo: chord.chordInfo,
          label: chord.text,
        }
      : null;
  }

  chordDetails(chord: string | ChordProChordBase | ChordDetails) {
    return typeof chord === "string" || chord instanceof ChordProChordBase ? this.identifyChord(chord) : chord;
  }

  chordLabel(chord: string | ChordProChordBase | ChordDetails) {
    if (typeof chord === "string") return chord;
    if (chord instanceof ChordProChordBase) return chord.chord;
    return chord.label;
  }

  compareChords(chord1: string | ChordProChordBase, chord2: string | ChordProChordBase, basic?: boolean) {
    if (chord1 === chord2) return true;
    const info1 = this.identifyChord(chord1);
    const info2 = this.identifyChord(chord2);
    if (!info1 || !info2) return false;
    const same = info1.baseNote === info2.baseNote && info1.bassNote === info2.bassNote && info1.chordInfo === info2.chordInfo;
    if (same || !basic || info1.baseNote !== info2.baseNote) return same;
    return (
      ChordSystem.noThird(info1.chordInfo) ||
      ChordSystem.noThird(info2.chordInfo) ||
      ChordSystem.isMinor(info1.chordInfo) === ChordSystem.isMinor(info2.chordInfo)
    );
  }

  chordNotes(chord: string | ChordProChordBase, ascending?: boolean): number[] | null;
  chordNotes(chord: ChordDetails, ascending?: boolean): number[];
  chordNotes(chord: string | ChordProChordBase | ChordDetails, ascending?: boolean) {
    const info = this.chordDetails(chord);
    let prevNote: number;
    return info
      ? info.chordInfo.steps.map((note) => {
          if (ascending) {
            if (prevNote !== undefined) while (prevNote > note) note += 12;
            prevNote = note;
          }
          return info.baseNote + note;
        })
      : null;
  }

  findAllChords(str: string, cb: (chord: string, prefix: string, suffix: string) => void | string) {
    let m = this.rxChordFinder.exec(str),
      start = 0;
    while (m)
      if (m.index >= start) {
        const chord = m[0],
          index = m.index;
        m = this.rxChordFinder.exec(str);
        cb(chord, str.substr(start, index - start), m ? "" : str.substr(index + chord.length));
        start = index + chord.length;
      }
  }

  getMaxFourNoteVariant(chord: string | ChordProChordBase, _keepBase: boolean = true, forcePerfectFifth: boolean = false) {
    if (typeof chord === "string") chord = new ChordProChordBase(this, chord);

    let chordInfo = chordMap.get(chord.symbol);
    if (!chordInfo) {
      const match = rxChordExtension.exec(chord.symbol);
      if (match) chordInfo = chordMap.get(match[1]);
    }
    if (!chordInfo || (chordInfo.steps.length <= 4 && (!forcePerfectFifth || chordInfo.desc.indexOf("-5") >= 0))) return chord.symbol;

    let fnv = this.fourNoteVariantMap.get(chord.symbol);
    if (!fnv) {
      const originalSteps = chordInfo.desc.split("-");
      const stepsToKeep = new Map<number, string>();
      for (let i = 1; stepsToKeep.size < 3 && i < originalSteps.length; ++i) {
        const s = originalSteps[i];
        let offset = "";
        let n = parseInt(
          s.replace(/[b#]/g, (c) => {
            offset = c;
            return "";
          })
        );
        if (!isNaN(n)) {
          const sus = n === 9 || n === 11;
          if (n > 7) n -= 7;
          if (!sus || !offset || !stepsToKeep.has(n)) {
            stepsToKeep.set(n, offset + n);
            if (sus) {
              stepsToKeep.delete(3);
              stepsToKeep.delete(7);
              break;
            }
          }
        }
      }
      let desc = "1";
      for (let i = 2; i < 14; ++i) {
        const s = stepsToKeep.get(i);
        if (s) desc += "-" + (forcePerfectFifth && i === 5 ? "5" : s);
      }

      let simplified: ChordInfo | null = null;
      for (chordInfo of allChordInfo)
        if (chordInfo.desc === desc) {
          simplified = chordInfo;
          break;
        }

      this.fourNoteVariantMap.set(chord.symbol, (fnv = simplified ? simplified.symbols[0] : chord.symbol));
    }
    return fnv;
  }

  findKeysWithChords(chords: Iterable<string>, keys?: Set<Key>, basic = true) {
    const result = new Set<Key>();
    if (keys === undefined) keys = new Set(this.keys.values());
    for (const key of keys) {
      let found = 0;
      let total = 0;
      for (const chordInSet of chords) {
        for (const chordInKey of key.chords(basic))
          if (this.compareChords(chordInKey, chordInSet)) {
            ++found;
            break;
          }
        ++total;
      }
      if (found === total) result.add(key);
    }
    return result;
  }

  getChordDetails(chord: string | ChordProChordBase, simplify: boolean) {
    if (typeof chord === "string") chord = new ChordProChordBase(this, chord);
    if (!chord.chordInfo) return null;

    const symbol = /*simplify ? getMaxFourNoteVariant(chord, true, true) :*/ chord.symbol;
    const retval = {
      prefix: chord.baseNote ? chord.prefix : chord.text,
      baseNote: chord.baseNote,
      modifier: symbol,
      normalized: symbol,
      bassNote: chord.bassNote,
      suffix: chord.suffix,
      minor: false,
    };
    if (retval.normalized && chord.chordInfo) {
      retval.normalized = chord.chordInfo.symbols[0];
      retval.minor = ChordSystem.isMinor(chord.chordInfo);
    }
    if (simplify) retval.modifier = retval.minor ? "m" : "";
    return retval;
  }
}

export class ChordProProperties {
  private current = new Map<string, string>();
  private old = new Map<string, string>();
  private diffCache = new Map<string, DifferentialText>();

  private normalizeValue(value: string) {
    return value.replace(/\r/g, "").trim();
  }

  get empty() {
    return this.current.size + this.old.size === 0;
  }
  keys(current = true) {
    return (current ? this.current : this.old).keys();
  }
  allKeys() {
    const keys = new Set<string>([...this.current.keys(), ...this.old.keys()]);
    return keys.keys();
  }
  has(key: string, current = true) {
    return (current ? this.current : this.old).has(key);
  }
  get(key: string, current = true) {
    return (current ? this.current : this.old).get(key) ?? "";
  }
  set(key: string, value: string, current = true) {
    (current ? this.current : this.old).set(key, value);
    this.diffCache.delete(key);
  }
  delete(key: string, current = true) {
    (current ? this.current : this.old).delete(key);
    this.diffCache.delete(key);
  }
  differential(key: string) {
    let value = this.diffCache.get(key);
    if (value === undefined) {
      value = DifferentialText.create(this.normalizeValue(this.old.get(key) ?? ""), this.normalizeValue(this.current.get(key) ?? ""));
      this.diffCache.set(key, value);
    }
    return value;
  }
  forEach(cb: (value: string, key: string) => void, current: boolean): void;
  forEach(cb: (value: string, key: string, curr: boolean) => void): void;
  forEach(cb: (value: string, key: string, curr: boolean) => void, current?: boolean) {
    if (!current) this.old.forEach((v, k) => cb(v, k, false));
    if (current === undefined || current) this.current.forEach((v, k) => cb(v, k, true));
  }
  copyFrom(src: ChordProProperties) {
    src.forEach((value, key, current) => this.set(key, value, current));
  }
  clone() {
    const c = new ChordProProperties();
    c.copyFrom(this);
    return c;
  }
}

export type ChordProContext = {
  env: ChordProProperties;
  format: ChordProProperties;
  style: ChordProProperties;
  comments: DifferentialText;
  other: ChordProProperties;
  pending_abc?: ChordProAbc;
};

export type ChordProLineRange = { top: number; bottom: number };
export type ChordProMovableItemInfo = { chunks: { str: string; width: number }[] } & ItemToPosition;
export type ChordProChunkDrawBox = { x: number; width: number; chordsStartOffset?: number; chordsEndOffset?: number };
export type ChordProWordInfo = { text: string; box: ChordProChunkDrawBox };

export class ChordProLineWords {
  words: ChordProWordInfo[] = [];
  private boundingBox: ChordProChunkDrawBox = { x: 0, width: 0 };

  get right() {
    return (
      this.boundingBox.x +
      (this.boundingBox.chordsEndOffset !== undefined ? Math.max(this.boundingBox.width, this.boundingBox.chordsEndOffset) : this.boundingBox.width)
    );
  }

  clone() {
    const c = new ChordProLineWords();
    c.words = this.words.map((x) => ({ text: x.text, box: { ...x.box } }));
    c.boundingBox = { ...this.boundingBox };
    return c;
  }

  push(elem: ChordProWordInfo) {
    this.updateBox(elem);
    this.words.push(elem);
  }

  split(pos: number) {
    const c = new ChordProLineWords();
    for (let idx = 0, count = 0; idx < this.words.length; ++idx) {
      if (idx && count >= pos) {
        c.words = this.words.splice(idx, this.words.length - idx);
        const offset = c.words[0].box.x - this.words[0].box.x;
        for (const w of c.words) {
          w.box.x -= offset;
          this.updateBox(w);
        }
        break;
      }
      count += this.words[idx].text.length;
    }
    return c;
  }

  appendOffset(other: ChordProLineWords) {
    return Math.max(
      this.boundingBox.x + this.boundingBox.width - other.boundingBox.x,
      this.boundingBox.x +
        (this.boundingBox.chordsEndOffset ?? Number.MIN_SAFE_INTEGER) -
        other.boundingBox.x -
        (other.boundingBox.chordsStartOffset ?? Number.MAX_SAFE_INTEGER)
    );
  }

  append(other: ChordProLineWords) {
    const lOffset = this.appendOffset(other);
    for (const o of other.words) {
      const elem = { text: o.text, box: { ...o.box } };
      elem.box.x += lOffset;
      this.words.push(elem);
      this.updateBox(elem);
    }
  }

  private updateBox(elem: ChordProWordInfo) {
    if (this.words.length === 0) this.boundingBox.x = elem.box.x;
    this.boundingBox.width = elem.box.x + elem.box.width - this.boundingBox.x;
    if (this.boundingBox.chordsStartOffset === undefined && elem.box.chordsStartOffset)
      this.boundingBox.chordsStartOffset = elem.box.x + elem.box.chordsStartOffset - this.boundingBox.x;
    if (elem.box.chordsEndOffset) this.boundingBox.chordsEndOffset = elem.box.x + elem.box.chordsEndOffset - this.boundingBox.x;
  }
}

export type ChordProCommentType = "" | "normal" | "italic" | "box";

export type LyricsCharInfo = { str: string; pos: number; width: number };
export class ChordProLine {
  text = "";
  lyricsData = new DifferentialText();
  chords: ChordProChord[] = [];
  comments = new DifferentialText();
  styles = new ChordProProperties();
  private commentDirectiveType?: ChordProCommentType;
  sourceLineNumber = -1;
  sectionChordDuplicate: boolean | null = null;
  yRange: ChordProLineRange = { top: 0, bottom: 0 };
  marked = 0;
  posCache: { lyrics: LyricsCharInfo[]; chords: number[] } | null = null;
  modifyRanges: { start: number; added?: boolean }[] | null = null;
  wordsWithBoxes: ChordProLineWords | null = null;
  multiplierOverride?: number;

  constructor(public doc: ChordProDocument) {}

  copyLineData(targetLine: ChordProLine, dataOnly: boolean) {
    targetLine.text = this.text;
    targetLine.lyricsData = this.lyricsData.clone();
    targetLine.chords = this.chords.map((chord) => chord.clone(targetLine));
    targetLine.comments = this.comments.clone();
    targetLine.styles = this.styles.clone();
    targetLine.sourceLineNumber = this.sourceLineNumber;
    targetLine.multiplierOverride = this.multiplierOverride;
    if (!dataOnly) {
      targetLine.sectionChordDuplicate = this.sectionChordDuplicate;
      targetLine.yRange = { ...this.yRange };
      targetLine.marked = this.marked;
      targetLine.posCache = this.posCache ? { lyrics: this.posCache.lyrics.map((x) => ({ ...x })), chords: [...this.posCache.chords] } : null;
      targetLine.modifyRanges = this.modifyRanges ? this.modifyRanges.map((x) => ({ ...x })) : null;
      targetLine.wordsWithBoxes = this.wordsWithBoxes ? this.wordsWithBoxes.clone() : null;
    }
  }

  clone(dataOnly = false) {
    const line = new ChordProLine(this.doc);
    this.copyLineData(line, dataOnly);
    return line;
  }

  get isComment() {
    return this.commentDirectiveType != null;
  }

  get isInstrumental(): boolean {
    return this instanceof ChordProAbc || this.isGrid;
  }

  get isGrid() {
    return this.styles.has("start_of_grid");
  }

  get lyrics() {
    return this.lyricsData.toString();
  }

  getCommentType() {
    return this.commentDirectiveType || (this.commentDirectiveType == null ? undefined : "normal");
  }

  getCommentDirective() {
    return "comment" + (this.commentDirectiveType ? "_" + this.commentDirectiveType : "");
  }

  setCommentDirectiveType(type: ChordProCommentType | undefined = "") {
    if (type === undefined) this.commentDirectiveType = undefined;
    else this.commentDirectiveType = type === "normal" ? "" : type;
  }

  setLyrics(s: string | DifferentialText) {
    this.lyricsData = typeof s === "string" ? new DifferentialText(s) : s;
  }

  getTagInfo(differential = false) {
    const find = (current: boolean) => {
      let name = "",
        tag: string | DifferentialText = "",
        key = "";
      for (name of current && differential ? this.styles.allKeys() : this.styles.keys(current))
        if (name.startsWith("start_of_")) {
          tag = differential ? this.styles.differential(name) : this.styles.get(name, current);
          if (name !== "start_of_grid") key = name + (tag ? ":" + tag : "");
          break;
        }
      if (typeof tag === "string" && this.multiplierOverride != null) {
        tag = tag.replace(/[ \t]+[0-9]+[xX*]$/, "");
        if (this.multiplierOverride > 1) tag += " " + this.multiplierOverride + "x";
      }
      return { name, tag, key };
    };
    const info = find(true);
    if (differential) {
      const prevInfo = find(false);
      if (prevInfo.name !== info.name) info.tag = DifferentialText.create(prevInfo.tag.toString(false), info.tag.toString(), { wordLevel: true });
    }
    return info;
  }

  invalidateCache() {
    this.sectionChordDuplicate = null;
    this.posCache = null;
    this.doc.invalidateCache();
  }

  transpose(shift: number): this {
    if (this.isGrid) {
      let s = "";
      this.doc.system.findAllChords(this.lyrics, (chord, prefix, suffix) => {
        const chordBase = new ChordProChord(this, chord, 0).transpose(shift);
        s += prefix + chordBase.text + suffix;
      });
      this.setLyrics(s);
    } else for (const chord of this.chords) chord.transpose(shift);

    this.genText();
    return this;
  }

  genText() {
    this.invalidateCache();
    this.text = "";
    let ci = 0;
    for (let i = 0; i < this.lyrics.length; ++i) {
      while (ci < this.chords.length) {
        const chord = this.chords[ci];
        if (chord.pos > i) break;
        this.text += "[" + chord.text + "]";
        ++ci;
      }
      this.text += this.lyrics.substr(i, 1);
    }
    while (ci < this.chords.length) {
      const chord = this.chords[ci];
      this.text += "[" + chord.text + "]";
      ++ci;
    }
  }

  insertString(pos: number, text: string) {
    // TODO: implement differential version
    this.setLyrics(this.lyrics.substr(0, pos) + fixChordProText(text) + this.lyrics.substr(pos));
    const len = text.length;
    for (let i = 0; i < this.chords.length; ++i) {
      const chord = this.chords[i];
      if (chord.pos > pos) chord.pos += len;
    }
    this.genText();
  }

  deleteString(pos: number, len: number) {
    // TODO: implement differential version
    this.setLyrics(this.lyrics.substr(0, pos) + this.lyrics.substr(pos + len));
    for (let i = 0; i < this.chords.length; ++i) {
      const chord = this.chords[i];
      if (chord.pos > pos) {
        if (chord.pos < pos + len) this.chords.splice(i--, 1);
        else chord.pos -= len;
      }
    }
    this.genText();
  }

  append(line: ChordProLine) {
    const offset = this.lyrics.length;
    this.text += line.text;
    this.lyricsData.append(line.lyricsData);
    for (let i = 0; i < line.chords.length; ++i) {
      const chord = line.chords[i];
      chord.pos += offset;
      chord.line = this;
      this.chords.push(chord);
    }
    if (this.wordsWithBoxes && line.wordsWithBoxes) {
      this.wordsWithBoxes.append(line.wordsWithBoxes);
    }
    this.posCache = null;
  }

  combineWithNext(backward?: boolean) {
    const i = this.getLineIndex();
    if (i >= 0 && i + 1 < this.doc.lines.length) {
      const n = this.doc.lines[i + 1];
      this.doc.lines.splice(i + 1, 1);
      if (backward && !n.styles.empty) this.styles = n.styles.clone();
      else if (this.styles.empty) this.styles = n.styles.clone();
      this.append(n);
      this.genText();
    }
  }

  splitAt(pos: number, drawSplitOnly?: boolean) {
    let i = drawSplitOnly ? 0 : this.getLineIndex();
    if (i >= 0) {
      const nl = new ChordProLine(this.doc);
      this.styles.forEach((value, name) => nl.styles.set(name, value));

      if (!drawSplitOnly) this.doc.lines.splice(i + 1, 0, nl);

      // TODO: implement differential version
      nl.setLyrics(this.lyrics.substring(pos));
      this.setLyrics(this.lyrics.substring(0, pos));

      nl.chords = [];
      i = 0;
      while (i < this.chords.length && this.chords[i].pos < pos) ++i;
      while (i < this.chords.length) {
        const chord = this.chords[i];
        chord.pos -= pos;
        chord.line = nl;
        nl.chords.push(chord);
        this.chords.splice(i, 1);
      }
      if (this.wordsWithBoxes) nl.wordsWithBoxes = this.wordsWithBoxes.split(pos);
      if (drawSplitOnly) {
        this.invalidateCache();
      } else {
        nl.genText();
        this.genText();
      }
      return nl;
    }
    return null;
  }

  removeChord(chord: ChordProChord) {
    if (this.isInstrumental) return;
    const idx = this.chords.indexOf(chord);
    if (idx >= 0) this.chords.splice(idx, 1);
    this.invalidateCache();
  }

  insertChord(chord: ChordProChord) {
    if (this.isInstrumental) return;
    for (let i = 0; i < this.chords.length; ++i) {
      const p = this.chords[i];
      if (chord.pos < p.pos) {
        this.chords.splice(i, 0, chord);
        return;
      }
    }
    this.chords.push(chord);
    this.invalidateCache();
  }

  getLineIndex() {
    return this.doc.lines.indexOf(this);
  }

  getPrevLine() {
    const idx = this.doc.lines.indexOf(this);
    return idx > 0 ? this.doc.lines[idx - 1] : null;
  }

  getNextLine() {
    const idx = this.doc.lines.indexOf(this);
    return idx >= 0 && idx < this.doc.lines.length - 1 ? this.doc.lines[idx + 1] : null;
  }
}

export class ChordProChordBase {
  private textData = "";
  private prefixData = "";
  private chordData = "";
  private baseNoteData = "";
  private symbolData = "";
  private bassNoteData = "";
  private suffixData = "";
  private chordInfoRef?: ChordInfo | null;

  constructor(system: ChordSystem, value: string) {
    this.setText(system, value);
  }

  static formatSingleNote(s: string) {
    return !s ? "" : s.length > 1 ? s.substr(0, 1).toUpperCase() + s.substr(1).toLowerCase() : s.toUpperCase();
  }

  setText(system: ChordSystem, value: string) {
    const match = system.rxChordFindAndSplit.exec(value); // 0: total, 1: prefix, 2: chord, 3: note, 4: modif, 5: /, 6: basenote, 7: suffix
    if (match) {
      this.prefixData = match[1];
      this.baseNoteData = ChordProChordBase.formatSingleNote(match[3]);
      this.symbolData = match[4].toLowerCase();
      this.bassNoteData = ChordProChordBase.formatSingleNote(match[6]);
      this.suffixData = match[7];
      this.chordData = this.baseNoteData + this.symbolData + (this.bassNoteData ? "/" + this.bassNoteData : "");
      this.textData = this.prefixData + this.chordData + this.suffixData;
    } else {
      this.textData = this.chordData = value;
      this.prefixData = this.baseNoteData = this.symbolData = this.bassNoteData = this.suffixData = "";
    }
    this.chordInfoRef = undefined;
  }

  getText() {
    return this.textData;
  }

  get text() {
    return this.textData;
  }
  get prefix() {
    return this.prefixData;
  }
  get chord() {
    return this.chordData;
  }
  get baseNote() {
    return this.baseNoteData;
  }
  get symbol() {
    return this.symbolData;
  }
  get bassNote() {
    return this.bassNoteData;
  }
  get suffix() {
    return this.suffixData;
  }

  get chordInfo() {
    if (this.chordInfoRef === undefined) this.chordInfoRef = chordMap.get(this.symbol) || findOrCreateChordVariant(this.symbol);
    return this.chordInfoRef;
  }
}

export class ChordProChord extends ChordProChordBase {
  marked = 0;

  constructor(
    public line: ChordProLine,
    text: string,
    public pos: number,
    public modif?: boolean | number
  ) {
    super(line.doc.system, text);
  }

  clone(line?: ChordProLine) {
    const c = new ChordProChord(line ?? this.line, this.text, this.pos, this.modif);
    c.marked = this.marked;
    return c;
  }

  get text() {
    return this.getText();
  }

  set text(text: string) {
    this.setText(this.line.doc.system, text);
  }

  get moved() {
    return typeof this.modif === "number";
  }

  get added() {
    return typeof this.modif === "boolean" ? this.modif : undefined;
  }

  get prevPos() {
    return typeof this.modif === "number" ? this.modif : this.pos;
  }

  insertString(pos: number, text: string) {
    let newText = this.text;
    newText = newText.substr(0, pos) + text + newText.substr(pos);
    this.text = newText.replace(/\s+$/, " ");
    if (this.line) this.line.genText();
  }

  deleteString(pos: number, len: number) {
    const text = this.text;
    this.text = text.substr(0, pos) + text.substr(pos + len);
    if (this.line) this.line.genText();
  }

  transpose(shift: number): this {
    if (this.baseNote) {
      let chord = this.line.doc.system.shiftNote(this.baseNote, shift) + this.symbol;
      if (this.bassNote) chord += "/" + this.line.doc.system.shiftNote(this.bassNote, shift);
      this.text = this.prefix + chord + this.suffix;
    }
    return this;
  }
}

export type AbcRenderParams = AbcVisualParams & { currentColor?: string };

export class ChordProAbc extends ChordProLine {
  private forcedLabel?: string | DifferentialText;
  constructor(
    doc: ChordProDocument,
    private readonly lines: (string | DifferentialText)[] = []
  ) {
    super(doc);
    this.styles.set("start_of_abc", "", true);
  }
  getAbc(current = true, addLabel = true) {
    const code = this.lines.map((line) => line.toString(current)).join("\n");
    const suffix = addLabel && this.forcedLabel ? "\nR:" + this.forcedLabel : "";
    return code + suffix;
  }
  setLabel(label: string, current: boolean) {
    this.forcedLabel = label;
    this.styles.set("start_of_abc", label, current);
  }
  render(element: HTMLElement, renderParams?: AbcVisualParams, current = true) {
    return renderAbc(element, this.getAbc(current), renderParams);
  }
  generateSvg(renderParams?: AbcRenderParams, current = true) {
    const div = document.createElement("div");
    this.render(div, renderParams, current);
    const svg = div.getElementsByTagName("svg")[0];
    let xmlText = new XMLSerializer().serializeToString(svg);
    if (renderParams?.currentColor) xmlText = xmlText.replace(/="currentColor"/g, `="${renderParams.currentColor}"`);
    const retval = {
      svg: xmlText,
      width: svg.width.baseVal.value,
      height: svg.height.baseVal.value,
    };
    if (!svg.width.baseVal.value || !svg.height.baseVal.value) console.warn("Invalid abc svg generated");
    return retval;
  }
  generateImage(renderParams?: AbcRenderParams, current = true) {
    const imgId = "chordpro_svg_holder_image";
    let img = document.getElementById(imgId) as HTMLImageElement | null;
    if (!img) {
      img = document.createElement("img");
      img.id = imgId;
      document.body.appendChild(img);
    }
    const svg = this.generateSvg(renderParams, current);
    img.width = svg.width;
    img.height = svg.height;
    img.src = "data:image/svg+xml;charset=utf-8," + svg.svg;
    return img;
  }
  generateMidi(chordsOff = false, current = true) {
    return synth.getMidiFile(this.getAbc(current, false), {
      chordsOff,
      midiOutputType: "binary",
    })[0];
  }
  push(line: string | DifferentialText) {
    if (!this.forcedLabel || !line.toString(true).startsWith("R:")) this.lines.push(line);
  }
  updateMeta() {
    let key = this.doc.getMeta("key");
    let tempo = ""; //this.doc.getMeta("tempo"); // dont override
    for (const line of this.lines) {
      const current = line.toString(true);
      if (current.startsWith("Q:")) tempo = "";
      else if (current.startsWith("K:")) key = "";
    }
    if (key) this.lines.unshift("K:" + key);
    if (tempo) this.lines.unshift("Q:" + tempo);
  }
  transpose(shift: number): this {
    if (shift) {
      const code = this.getAbc(true);
      const transposed = strTranspose(code, renderAbc("*", code) as TuneObjectArray, shift);
      this.lines.splice(0, this.lines.length);
      for (const line of transposed.split("\n")) this.push(line);
    }
    return this;
  }
  clone(dataOnly = false) {
    const line = new ChordProAbc(this.doc, [...this.lines]);
    line.forcedLabel = typeof this.forcedLabel === "string" ? this.forcedLabel : this.forcedLabel?.clone();
    this.copyLineData(line, dataOnly);
    return line;
  }
  toGrid(single: true, current?: boolean): ChordProLine;
  toGrid(single: false, current?: boolean): ChordProLine[];
  toGrid(single: boolean, current = true) {
    const gridLines: ChordProLine[] = [];
    let chords: string[] = [];
    const genLine = () => {
      const gridLine = new ChordProLine(this.doc);
      gridLine.setLyrics(chords.join(" "));
      gridLine.styles.set("start_of_grid", this.forcedLabel?.toString(current) ?? "");
      gridLine.genText();
      chords = [];
      return gridLine;
    };
    for (const visualObj of renderAbc("*", this.getAbc(current), {}) as TuneObjectArray) {
      for (const line of visualObj.lines) {
        for (const staff of line.staff ?? []) {
          let found = true;
          for (let i = 0; found; ++i) {
            found = false;
            for (const voices of staff.voices ?? []) {
              const voice = voices[i];
              if (voice != null) {
                let bar = "";
                switch (voice.el_type) {
                  case "bar":
                    if (voice.endEnding) chords.push(")");
                    switch (voice.type) {
                      case "bar_dbl_repeat":
                        bar = ":|:";
                        break;
                      case "bar_left_repeat":
                        bar = "|:";
                        break;
                      case "bar_right_repeat":
                        bar = ":|";
                        break;
                    }
                    if (bar) chords.push(bar);
                    if (voice.startEnding) chords.push(voice.startEnding + "(");
                    break;
                  case "note":
                    if (voice.chord?.length) chords.push(...voice.chord.map((x: { name: string }) => x.name));
                    break;
                }
                found = true;
              }
            }
          }
        }
      }
      if (chords.length > 0 && !single) gridLines.push(genLine());
    }
    if (gridLines.length === 0) gridLines.push(genLine());
    return single ? gridLines[0] : gridLines;
  }
}

export type SectionInfo = { signature: string; baseTag?: string; duplicate?: boolean };
export type SectionInfoMap = Map<string, SectionInfo>;
export class ChordProDocument {
  private static directiveAbbrevations = {
    t: "title",
    st: "subtitle",
    c: "comment",
    ci: "comment_italic",
    cb: "comment_box",
    soc: "start_of_chorus",
    eoc: "end_of_chorus",
    sob: "start_of_bridge",
    eob: "end_of_bridge",
    sot: "start_of_tab",
    eot: "end_of_tab",
    sov: "start_of_verse",
    eov: "end_of_verse",
    npp: "new_physical_page",
    g: "grid",
    np: "new_page",
    ng: "no_grid",
    col: "columns",
  };

  static readonly metaDataDirectives = [
    "title",
    "subtitle",
    "artist",
    "composer",
    "lyricist",
    "copyright",
    "album",
    "year",
    "key",
    "time",
    "tempo",
    "duration",
    "capo",
    "meta",
  ];

  private static formattingDirectives = ["comment", "comment_italic", "comment_box", "image", "x_section_break"];

  private static environmentDirectives = [
    "start_of_chorus",
    "end_of_chorus",
    "chorus",
    "start_of_verse",
    "end_of_verse",
    "start_of_tab",
    "end_of_tab",
    "start_of_grid",
    "end_of_grid",
    "start_of_bridge",
    "end_of_bridge",
  ];

  private static styleDirectives = ["textfont", "textsize", "textcolour", "chordfont", "chordsize", "chordcolour", "tabfont", "tabsize", "tabcolour"];

  private static outputDirectives = ["new_page", "new_physical_page", "column_break", "grid", "no_grid", "titles", "columns"];

  lines: ChordProLine[] = [];
  private metaData = new ChordProProperties();
  output = new ChordProProperties();
  private sectionInfoMap: SectionInfoMap | null = null;
  customChordModifers = new Map<string, ChordInfo>();

  constructor(
    readonly system: ChordSystem,
    chp_text: string | DifferentialText[]
  ) {
    const simple = typeof chp_text === "string";
    const context: ChordProContext = {
      env: new ChordProProperties(),
      format: new ChordProProperties(),
      style: new ChordProProperties(),
      comments: new DifferentialText(),
      other: new ChordProProperties(),
    };
    const lines = simple ? chp_text.split(/\r?\n/) : chp_text;
    for (let line = 0; line < lines.length; ++line) {
      const cpl = this.read(lines[line], context);
      if (cpl) {
        cpl.sourceLineNumber = line;
        this.lines.push(cpl);
      }
    }
    for (const line of this.lines) if (line instanceof ChordProAbc) line.updateMeta();
  }

  forAllChords(cb: (chord: ChordProChordBase | string, line: ChordProLine) => ChordProChordBase | string | void) {
    for (const line of this.lines) {
      let changed = false;
      if (line.isGrid) {
        const replacement = new DifferentialText();
        this.system.findAllChords(line.lyrics, (chord, prefix, suffix) => {
          let rep = cb(chord, line);
          if (!rep) rep = chord;
          else if (rep !== chord) changed = true;
          replacement.append(
            new DifferentialText(prefix + (rep instanceof ChordProChordBase ? rep : new ChordProChordBase(this.system, rep)).text + suffix)
          );
        });
        if (changed) line.setLyrics(replacement);
      } else if (!(line instanceof ChordProAbc))
        for (const chord of line.chords) {
          const rep = cb(chord, line);
          if (rep && (typeof rep === "string" ? rep : rep.chord).toLowerCase() !== chord.chord.toLowerCase()) {
            chord.text = chord.prefix + rep + chord.suffix;
            changed = true;
          }
        }
      if (changed) line.genText();
    }
  }

  invalidateCache() {
    this.sectionInfoMap = null;
  }

  get key() {
    return (this.metaData.get("key", true) ?? "").trim();
  }

  get capo() {
    const s = this.metaData.get("capo", true).trim();
    const c = s ? parseInt(s, 10) : 0;
    return isNaN(c) ? 0 : Math.max(0, Math.min(c, 11));
  }

  getMeta(key: string) {
    return this.metaData.get(key);
  }

  setMeta(key: string, value: string) {
    this.metaData.set(key, value);
  }

  hasMeta(key: string, current?: boolean) {
    return this.metaData.has(key, current);
  }

  differentialMeta(key: string) {
    return this.metaData.differential(key);
  }

  transpose(shift: number) {
    if (shift) {
      for (const line_obj of this.lines) line_obj.transpose(shift);
      if (this.key) {
        const key = this.system.getKey(this.key);
        this.setMeta("key", key ? key.transposedKey(shift) : "");
      }
    }
  }

  get sectionInfo() {
    if (this.sectionInfoMap) return this.sectionInfoMap;

    const m = new Map<string, SectionInfo>();
    const sep = "~";
    for (const line_obj of this.lines)
      line_obj.styles.forEach((value, k) => {
        if (k.startsWith("start_of_")) {
          const current = k + ":" + (value ?? "");
          const info = k !== "start_of_grid" ? m.get(current) : undefined;
          let signature = info?.signature ?? "";
          for (const chord of line_obj.chords) {
            const ch = chord.text;
            if (ch) {
              if (signature) signature += sep;
              signature += ch;
            }
          }
          if (!info) m.set(current, { signature });
          else info.signature = signature;
        }
      });

    const autoBaseTags = new Map<string, SectionInfo>();
    const uniqueBaseTags = new Map<string, boolean>();
    m.forEach((info, tag) => {
      const match = /^(.*) [0-9]+$/g.exec(tag);
      if (match) {
        info.baseTag = match[1];
        const unique = uniqueBaseTags.get(info.baseTag);
        if (!unique) {
          const baseInfo = m.get(info.baseTag) ?? autoBaseTags.get(info.baseTag);
          if (!baseInfo) autoBaseTags.set(info.baseTag, info);
          else uniqueBaseTags.set(info.baseTag, baseInfo.signature !== info.signature);
        }
      }
    });

    const usedBaseTags = new Set<string>();
    m.forEach((info, tag) => {
      info.duplicate = info.baseTag !== undefined && !uniqueBaseTags.get(info.baseTag) && usedBaseTags.has(info.baseTag);
      usedBaseTags.add(info.baseTag ?? tag);
    });

    return (this.sectionInfoMap = m);
  }

  getSections() {
    const sections: string[] = [];
    for (const key of this.sectionInfo.keys()) {
      const sep = key.indexOf(":");
      if (sep >= 0) sections.push(key.substring(sep + 1));
      else if (key.startsWith("start_of_")) sections.push(key.substring(9));
    }
    return sections;
  }

  read(lineToProcess: string | DifferentialText, context: ChordProContext) {
    let match: RegExpMatchArray | null;
    const line =
      typeof lineToProcess === "string"
        ? fixChordProText(lineToProcess)
        : (() => {
            const c = lineToProcess.clone();
            c.forEachChunk((chunk) => {
              chunk.text = fixChordProText(chunk.text);
            });
            return c;
          })();
    const simple = typeof line === "string";
    let processed = false;
    let comment_directive_type: string | undefined;
    for (let current = true; ; current = false) {
      const actual = simple ? line : line.toString(current);
      match = /^[ \t]*{[ \t]*([^ \t:]+)[ \t]*:?[ \t]*(.*)[ \t]*}[ \t\u23ce]*$/.exec(actual);
      if (match) {
        let name = match[1];
        const value = match.length > 2 ? match[2] || "" : "";

        const abbrevOf = ChordProDocument.directiveAbbrevations[name as keyof typeof ChordProDocument.directiveAbbrevations];
        if (abbrevOf) name = abbrevOf;

        if (name === "start_of_abc") {
          context.pending_abc = new ChordProAbc(this);
          context.pending_abc.setLabel(value, current);
          return null;
        }

        if (name === "end_of_abc") {
          const abc = context.pending_abc;
          context.pending_abc = undefined;
          return abc;
        }

        const target =
          ChordProDocument.metaDataDirectives.indexOf(name) >= 0
            ? this.metaData
            : ChordProDocument.outputDirectives.indexOf(name) >= 0
              ? this.output
              : ChordProDocument.environmentDirectives.indexOf(name) >= 0
                ? context.env
                : ChordProDocument.styleDirectives.indexOf(name) >= 0
                  ? context.style
                  : ChordProDocument.formattingDirectives.indexOf(name) >= 0
                    ? context.format
                    : context.other;

        if (name.startsWith("end_of_")) {
          name = "start_of_" + name.substr(7);
          target.delete(name, current);
        } else target.set(name, value, current);

        if (target === context.format && name.startsWith("comment")) comment_directive_type = name.substring(8);
        processed = comment_directive_type == null;
      } else {
        if (context.pending_abc != null) {
          context.pending_abc.push(line);
          return null;
        }
        match = /^[ \t]*#.*$/.exec(actual);
        if (match) {
          context.comments.append(new DifferentialText(match[0] + "\n", current));
          processed = true;
        }
      }
      if (simple || !current) break;
    }

    if (processed) return null;

    const line_obj = new ChordProLine(this);

    if (comment_directive_type != null) {
      line_obj.setCommentDirectiveType(comment_directive_type as ChordProCommentType);
      line_obj.setLyrics(simple ? context.format.get(line_obj.getCommentDirective()) : context.format.differential(line_obj.getCommentDirective()));
      line_obj.genText();
    } else if (simple) {
      const rx = /(.*?)\[(.*?)\]/g;
      let pos = 0;
      while ((match = rx.exec(line))) {
        const text = match[1];
        if (text) line_obj.lyricsData.append(text);
        const chord = match[2];
        if (chord) line_obj.chords.push(new ChordProChord(line_obj, chord, line_obj.lyrics.length));
        pos = rx.lastIndex;
      }
      if (pos < line.length) line_obj.lyricsData.append(line.substring(pos));
      line_obj.text = line;
    } else {
      let chord: string | null = null;
      line_obj.modifyRanges = [];
      let prevChord: ChordProChord | null = null;
      line.forEachChunk((chunk) => {
        line_obj.modifyRanges!.push({ start: line_obj.lyrics.length, added: chunk.added });
        for (const ch of chunk.text) {
          if (ch === "[") chord = "";
          else if (chord != null && ch === "]") {
            if (
              !prevChord ||
              chunk.added === undefined ||
              prevChord.added === undefined ||
              prevChord.text !== chord ||
              prevChord.added === chunk.added
            )
              line_obj.chords.push((prevChord = new ChordProChord(line_obj, chord, line_obj.lyrics.length, chunk.added)));
            else if (chunk.added) {
              prevChord.modif = prevChord.pos;
              prevChord.pos = line_obj.lyrics.length;
            } else prevChord.modif = line_obj.lyrics.length;
            chord = null;
          } else if (chord != null) chord += ch;
          else line_obj.lyricsData.append(ch, chunk.added);
        }
      });
    }

    line_obj.comments = DifferentialText.create(context.comments.toString(false), context.comments.toString(true));
    context.comments = new DifferentialText();

    for (const k of Object.keys(context) as (keyof ChordProContext)[]) {
      const o = context[k];
      if (o instanceof ChordProProperties) {
        o.forEach((value, name, current) => {
          if (value != null) line_obj.styles.set(name, value, current);
          if (!name.startsWith("start_of_")) o.delete(name, current);
        });
      }
    }

    return line_obj;
  }

  get hasDocument() {
    return this.lines.length > 0 || !this.metaData.empty;
  }

  generateDocument() {
    const context = new Map<string, string>();

    let strlist: string[] = [];
    this.metaData.forEach((value, name) => strlist.push("{" + name + ":" + value + "}\n"), true);
    let text = strlist
      .sort((a, b) => {
        if (a.startsWith("{title:")) return -1;
        if (b.startsWith("{title:")) return 1;
        return a.localeCompare(b);
      })
      .join("");

    const format_directive = (name: string, value: string) => {
      let t = "{" + name;
      if (value) t += ":" + value;
      return t + "}\n";
    };

    for (const line_obj of this.lines) {
      strlist = [];
      for (const name of Array.from(context.keys()))
        if (name.startsWith("start_of_") && !line_obj.styles.has(name)) {
          strlist.push("{end_of_" + name.substr(9) + "}\n");
          context.delete(name);
        }
      text += strlist.sort().join("") + line_obj.comments;

      strlist = [];
      if (!line_obj.isComment)
        line_obj.styles.forEach((value, name) => {
          if (!name.startsWith("start_of_") || !context.has(name)) strlist.push(format_directive(name, value));
          else if (context.get(name) !== value) strlist.push("{end_of_" + name.substr(9) + "}\n" + format_directive(name, value));
          context.set(name, value);
        });
      else if (line_obj.text) strlist.push(format_directive(line_obj.getCommentDirective(), line_obj.text));
      text += strlist.sort().join("");
      if (line_obj instanceof ChordProAbc) text += line_obj.getAbc(true, false) + "\n";
      else if (!line_obj.isComment) text += line_obj.text + "\n";
    }

    strlist = [];
    context.forEach((_value, name) => {
      if (name.startsWith("start_of_")) strlist.push("{end_of_" + name.substr(9) + "}\n");
    });

    return text + strlist.sort().join("");
  }
}
