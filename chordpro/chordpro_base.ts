import type { AbcVisualParams, TuneObjectArray } from "abcjs";
import { abcjs, isAbcjsLoaded, loadAbcjs } from "./abcjs-lazy";
import { allChordInfo, ChordInfo, chordMap, findOrCreateChordVariant, rxChordExtension } from "./allchords";
import { ChordDetails, Key, NoteSystem, NoteSystemCode } from "./note_system";
import { ItemToPosition } from "./placer";
import { diffChars } from "diff";
import { UnicodeSymbol } from "../common/symbols";
import { DifferentialText } from "../common/utils";
import { parseAbcSource, resolveAbcOptions } from "./abc-options";
import { abcToChordPro } from "./abc-to-chordpro";
import { differentialCoordinateToSource, differentialTextUnits } from "./render/differential";

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

/**
 * Decides whether a chord offset in the previous lyrics and one in the current
 * lyrics denote the same place. Raw offsets of the two sides are not
 * comparable: any lyric insertion or deletion before a chord shifts its offset
 * although the chord stays on the same syllable. A char-level diff is used so
 * a chord stays matched to the very character it was attached to.
 */
export function createChordAnchorMatcher(previousLyrics: string, currentLyrics: string) {
  type Segment = { before: number; beforeLength: number; after: number; afterLength: number; equal: boolean };
  // Zero-length equal sentinels make the line start and end unchanged anchors
  // too (e.g. a line-final chord whose preceding tail was deleted).
  const segments: Segment[] = [{ before: 0, beforeLength: 0, after: 0, afterLength: 0, equal: true }];
  let before = 0;
  let after = 0;
  let group: Segment | null = null;
  for (const change of diffChars(previousLyrics, currentLyrics)) {
    const length = change.value.length;
    if (!change.added && !change.removed) {
      group = null;
      segments.push({ before, beforeLength: length, after, afterLength: length, equal: true });
      before += length;
      after += length;
      continue;
    }
    if (!group) segments.push((group = { before, beforeLength: 0, after, afterLength: 0, equal: false }));
    if (change.added) {
      group.afterLength += length;
      after += length;
    } else {
      group.beforeLength += length;
      before += length;
    }
  }
  segments.push({ before, beforeLength: 0, after, afterLength: 0, equal: true });

  return (previousPos: number, currentPos: number) =>
    segments.some((segment) => {
      const offset = previousPos - segment.before;
      if (segment.equal) return offset >= 0 && offset <= segment.beforeLength && currentPos === segment.after + offset;
      // Strictly inside replaced or deleted text: the same relative offset into
      // the replacement (clamped) still counts as the original place.
      return offset > 0 && offset < segment.beforeLength && currentPos === segment.after + Math.min(offset, segment.afterLength);
    });
}

/** The only line that closes an ABC block: a whole-line `{end_of_abc}` directive
 *  (⏎ is the editor's line-end marker). Everything before it, including JSON
 *  envelopes and grace notes (`{g}`), belongs to the score. */
export const rxAbcEndDirective = /^[ \t]*\{[ \t]*end_of_abc(?=[ \t:}])[ \t]*:?[ \t]*.*\}[ \t⏎]*$/;

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
  marked = 0;
  modifyRanges: { start: number; added?: boolean }[] | null = null;
  multiplierOverride?: number;
  transposeOverride?: number;
  /** Present only on a readonly ABC expansion, never on the stored document. */
  abcSource?: ChordProAbc;
  /** Row identity within the full expansion of abcSource, independent of views. */
  abcRow?: number;
  abcMusicRanges?: readonly { start: number; end: number }[];
  /**
   * For lines synthesized by `ChordProEditor.getInstructedLines()`, the
   * 0-based index of the `Instructions.items[]` entry that produced this
   * line. Used to align highlight/projection across the Electron projector
   * and the editor's instructed rendering (both use the instruction index
   * as the canonical section number, independent of how the projector
   * paginates a section across multiple screens).
   */
  instructedSectionIndex?: number;
  private sectionInfoCache: ChordProSectionInfo | null = null;

  constructor(public doc: ChordProDocument) {}

  copyLineData(targetLine: ChordProLine, dataOnly: boolean) {
    targetLine.text = this.text;
    targetLine.lyricsData = this.lyricsData.clone();
    targetLine.chords = this.chords.map((chord) => chord.clone(targetLine));
    targetLine.comments = this.comments.clone();
    targetLine.styles = this.styles.clone();
    targetLine.commentDirectiveType = this.commentDirectiveType;
    targetLine.sourceLineNumber = this.sourceLineNumber;
    targetLine.multiplierOverride = this.multiplierOverride;
    targetLine.transposeOverride = this.transposeOverride;
    targetLine.instructedSectionIndex = this.instructedSectionIndex;
    targetLine.abcSource = this.abcSource;
    targetLine.abcRow = this.abcRow;
    targetLine.abcMusicRanges = this.abcMusicRanges;
    if (!dataOnly) {
      targetLine.sectionChordDuplicate = this.sectionChordDuplicate;
      targetLine.marked = this.marked;
      targetLine.modifyRanges = this.modifyRanges ? this.modifyRanges.map((x) => ({ ...x })) : null;
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

  setCommentDirectiveType(type: ChordProCommentType | undefined) {
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
      if (typeof tag === "string" && (this.multiplierOverride != null || this.transposeOverride != null)) {
        tag = this.getSectionInfo().withoutModifiers();
        if (this.transposeOverride) tag += " " + (this.transposeOverride > 0 ? "#" : "b") + Math.abs(this.transposeOverride);
        if (this.multiplierOverride != null && this.multiplierOverride > 1) tag += " " + this.multiplierOverride + "x";
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
    this.sectionInfoCache = null;
    this.doc.invalidateCache();
  }

  getSectionInfo(): ChordProSectionInfo {
    if (this.sectionInfoCache) return this.sectionInfoCache;
    let key = "";
    for (const name of this.styles.keys(true))
      if (name.startsWith("start_of_")) {
        const tag = this.styles.get(name, true);
        key = name + (tag ? ":" + tag : "");
        break;
      }
    return (this.sectionInfoCache = this.doc.getSectionInfoFor(key));
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

  splitAt(pos: number) {
    let i = this.getLineIndex();
    if (i >= 0) {
      const nl = new ChordProLine(this.doc);
      this.styles.forEach((value, name) => nl.styles.set(name, value));
      nl.setCommentDirectiveType(this.getCommentType());

      this.doc.lines.splice(i + 1, 0, nl);

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
      nl.genText();
      this.genText();
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
    // Text the chord regex could not parse at all (no base note, e.g. "xyz")
    // must stay unknown. Without the baseNote guard its empty symbol would hit
    // the plain-major-chord entry in chordMap (whose modifier is also ""), so
    // arbitrary bracket text was treated as a known major chord and never got
    // the unknown-chord rendering or a getUnknownChords() listing.
    if (this.chordInfoRef === undefined)
      this.chordInfoRef = this.baseNoteData ? chordMap.get(this.symbol) || findOrCreateChordVariant(this.symbol) : null;
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
  private chordProCache?: { source: string; lines: readonly ChordProLine[] };
  /** Set by readonly projections on their clone: the R: header shown instead of
   *  the authored label, e.g. an instructed repeat's "Intro 3x". */
  headerLabel?: string;
  constructor(
    doc: ChordProDocument,
    private readonly lines: (string | DifferentialText)[] = []
  ) {
    super(doc);
    this.styles.set("start_of_abc", "", true);
  }
  getAbc(current = true, addLabel = true) {
    const code = this.lines.map((line) => line.toString(current)).join("\n");
    const label = this.headerLabel ?? this.forcedLabel;
    const suffix = addLabel && label ? "\nR:" + label : "";
    return code + suffix;
  }
  setLabel(label: string, current: boolean) {
    this.forcedLabel = label;
    this.styles.set("start_of_abc", label, current);
  }
  render(element: HTMLElement, renderParams?: AbcVisualParams, current = true) {
    if (!isAbcjsLoaded()) {
      void loadAbcjs();
      return undefined;
    }
    const source = resolveAbcOptions(this.getAbc(current), this.doc.getMeta("tempo"));
    return abcjs().renderAbc(element, source.abc, { ...source.visual, ...renderParams });
  }
  generateSvg(renderParams?: AbcRenderParams, current = true) {
    if (!isAbcjsLoaded()) {
      void loadAbcjs();
      return { svg: "", width: 0, height: 0 };
    }
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
  generateMidi(chordsOff?: boolean, current = true) {
    if (!isAbcjsLoaded()) {
      void loadAbcjs();
      return undefined;
    }
    const source = resolveAbcOptions(this.getAbc(current, false), this.doc.getMeta("tempo"));
    return abcjs().synth.getMidiFile(source.abc, {
      ...source.synth,
      ...(chordsOff === undefined ? {} : { chordsOff }),
      midiOutputType: "binary",
    })[0];
  }
  push(line: string | DifferentialText) {
    if (!this.forcedLabel || !line.toString(true).startsWith("R:")) this.lines.push(line);
  }
  updateMeta() {
    const source = this.getAbc(true, false);
    const parsed = parseAbcSource(source);
    if (/^\s*K:/m.test(parsed.abc)) return;
    const key = this.doc.getAbcKey();
    if (!key) return;
    // K: must follow X:/metadata, immediately before music, and after the JSON envelope.
    const body = source.slice(parsed.bodyStart).split("\n");
    const firstMusic = body.findIndex((line) => line.trim() && !/^\s*(?:[A-Za-z]:|%)/.test(line));
    const bodyLine = source.slice(0, parsed.bodyStart).split("\n").length - 1;
    this.lines.splice(bodyLine + (firstMusic < 0 ? body.length : firstMusic), 0, "K:" + key);
  }
  transpose(shift: number): this {
    if (shift) {
      if (!isAbcjsLoaded()) {
        void loadAbcjs();
        return this;
      }
      const source = this.getAbc(true, false);
      const parsed = parseAbcSource(source);
      const code = source.slice(parsed.bodyStart);
      const transposed = source.slice(0, parsed.bodyStart) + abcjs().strTranspose(code, abcjs().renderAbc("*", code) as TuneObjectArray, shift);
      this.lines.splice(0, this.lines.length);
      for (const line of transposed.split("\n")) this.push(line);
    }
    return this;
  }
  clone(dataOnly = false) {
    const line = new ChordProAbc(this.doc, [...this.lines]);
    line.forcedLabel = typeof this.forcedLabel === "string" ? this.forcedLabel : this.forcedLabel?.clone();
    line.headerLabel = this.headerLabel;
    this.copyLineData(line, dataOnly);
    return line;
  }
  /** The same conversion serves instructions and readonly viewing. Instrumental
   * scores deliberately retain the old single-grid representation. */
  toChordPro(current = true): readonly ChordProLine[] {
    if (!isAbcjsLoaded()) return [this.toGrid(true, current)];
    const source = this.getAbc(current, false);
    const sectionInfo = this.getSectionInfo();
    const cacheKey = source + "\n" + sectionInfo.key;
    if (this.chordProCache?.source === cacheKey) return this.chordProCache.lines;
    let lines: readonly ChordProLine[];
    try {
      const converted = abcToChordPro(parseAbcSource(source).abc, sectionInfo.withoutModifiers(), (code) => abcjs().parseOnly(code));
      if (!converted) lines = [this.toGrid(true, current)];
      else {
        const partial = new ChordProDocument(this.doc.system, "");
        partial.lines = [];
        for (const name of ChordProDocument.metaDataDirectives) if (this.doc.hasMeta(name)) partial.setMeta(name, this.doc.getMeta(name));
        const chordName = (name: string) =>
          this.doc.system.systemCode === "G"
            ? name.replace(/^B(b|♭)?/, (_, flat) => (flat ? "B" : "H")).replace(/\/B(b|♭)?$/, (_, flat) => "/" + (flat ? "B" : "H"))
            : name;
        for (const section of converted) {
          const directive = section.grid
            ? "start_of_grid"
            : /^(?:refr|chorus)/i.test(section.label)
              ? "start_of_chorus"
              : /^bridge/i.test(section.label)
                ? "start_of_bridge"
                : "start_of_verse";
          const label =
            section.label +
            (sectionInfo.multiplier != null ? ` ${sectionInfo.multiplier}x` : "") +
            (sectionInfo.transpose ? ` ${sectionInfo.transpose > 0 ? "+" : ""}${sectionInfo.transpose}` : "");
          for (const row of section.rows) {
            const line = new ChordProLine(partial);
            line.styles.set(directive, label);
            let lyrics = row.lyrics;
            // Grid chord spans belong to the grid text, not its overlay row.
            // Replace backwards so changing B-flat's spelling cannot shift a
            // later slash-bass or repeat/ending marker.
            if (section.grid)
              for (const chord of [...row.chords].reverse())
                lyrics = lyrics.slice(0, chord.pos) + chordName(chord.name) + lyrics.slice(chord.pos + chord.name.length);
            line.setLyrics(lyrics);
            line.abcMusicRanges = row.musicRanges;
            if (!section.grid) for (const chord of row.chords) line.chords.push(new ChordProChord(line, chordName(chord.name), chord.pos));
            line.genText();
            partial.lines.push(line);
          }
        }
        lines = partial.lines;
      }
    } catch {
      // An unfinished/unsupported score remains visible and editable as notation.
      lines = [this.clone(true)];
    }
    this.chordProCache = { source: cacheKey, lines };
    return lines;
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
    if (!isAbcjsLoaded()) {
      // abcjs chunk still loading: yield an empty grid line; the editor schedules a
      // redraw once it resolves (ChordProEditor.ensureAbcjsLoaded).
      void loadAbcjs();
      return single ? genLine() : [genLine()];
    }
    for (const visualObj of abcjs().parseOnly(parseAbcSource(this.getAbc(current)).abc)) {
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

export type SectionInfo = { signature: string; baseTag?: string; duplicate?: boolean; info: ChordProSectionInfo };
export type SectionInfoMap = Map<string, SectionInfo>;

export class ChordProSectionInfo {
  private static sectionMultiplierTokenRegex = /^[(]?([0-9]+)[xX*][)]?$/;
  private static sectionTransposeTokenRegex = /^[(]?([+\-#b♯♭])([0-9]+)[)]?$/;

  readonly key: string;
  readonly baseTag: string;
  readonly variant?: string | number;
  readonly multiplier?: number;
  readonly transpose?: number;
  private readonly isSection: boolean;

  constructor(key: string) {
    this.key = key;

    const sep = key.indexOf(":");
    const name = sep >= 0 ? key.substring(0, sep) : key;
    const rawTag = sep >= 0 ? key.substring(sep + 1) : "";

    const tag = rawTag.trim();
    const parts = tag ? tag.split(/[ \t]+/).filter((part) => !!part) : [];

    let end = parts.length - 1;
    let multiplier: number | undefined;
    let transpose: number | undefined;

    while (end >= 0) {
      const token = parts[end];
      if (multiplier === undefined) {
        const match = ChordProSectionInfo.sectionMultiplierTokenRegex.exec(token);
        if (match) {
          multiplier = parseInt(match[1], 10);
          --end;
          continue;
        }
      }

      if (transpose === undefined) {
        const match = ChordProSectionInfo.sectionTransposeTokenRegex.exec(token);
        if (match) {
          const sign = match[1];
          const amount = parseInt(match[2], 10);
          transpose = sign === "-" || sign === "b" || sign === UnicodeSymbol.flat ? -amount : amount;
          --end;
          continue;
        }
      }

      break;
    }

    const mainParts = parts.slice(0, end + 1);
    let baseTag = "";
    let variant: string | number | undefined;
    if (mainParts.length > 0) {
      baseTag = mainParts[0];
      if (mainParts.length > 1) {
        const rawVariant = mainParts
          .slice(1)
          .join(" ")
          .replace(/^-+\s*/, "")
          .trim();
        if (rawVariant) variant = /^[0-9]+$/.test(rawVariant) ? parseInt(rawVariant, 10) : rawVariant;
      } else {
        const inlineVariant = /^([^\-\s]+)-(.+)$/.exec(baseTag);
        if (inlineVariant) {
          baseTag = inlineVariant[1];
          const rawVariant = inlineVariant[2].trim();
          if (rawVariant) variant = /^[0-9]+$/.test(rawVariant) ? parseInt(rawVariant, 10) : rawVariant;
        }
      }
    }

    this.baseTag = baseTag || tag;
    this.variant = variant;
    this.multiplier = multiplier;
    this.transpose = transpose;
    this.isSection = name.startsWith("start_of_") && name !== "start_of_grid";
  }

  get name() {
    const sep = this.key.indexOf(":");
    return sep >= 0 ? this.key.substring(0, sep) : this.key;
  }

  get tag() {
    const sep = this.key.indexOf(":");
    return sep >= 0 ? this.key.substring(sep + 1) : "";
  }

  get familyKey() {
    return this.isSection && this.baseTag ? this.name + ":" + this.baseTag : undefined;
  }

  withoutModifiers() {
    return this.compose(false, false);
  }

  withoutMultiplier() {
    return this.compose(false, true);
  }

  withoutTranspose() {
    return this.compose(true, false);
  }

  normalized() {
    return this.compose(true, true);
  }

  /** Canonical section name used by instructions. Unlabelled standard section
   * directives (for example `{start_of_verse}`) still need an addressable name
   * even though their visual tag is intentionally empty. */
  instructionName() {
    const authored = this.withoutModifiers();
    if (authored) return authored;
    return this.isSection && this.name.startsWith("start_of_") ? this.name.substring(9) : "";
  }

  /** Instruction name including authored repeat/transpose modifiers. */
  normalizedInstructionName() {
    return this.normalized() || this.instructionName();
  }

  private compose(includeMultiplier: boolean, includeTranspose: boolean) {
    if (!this.baseTag) return this.tag;
    const parts = [this.baseTag];
    if (this.variant != null && String(this.variant).trim()) parts.push(String(this.variant).trim());
    if (includeMultiplier && this.multiplier !== undefined) parts.push(this.multiplier + "x");
    if (includeTranspose && this.transpose !== undefined) parts.push((this.transpose >= 0 ? "+" : "-") + Math.abs(this.transpose));
    return parts.filter((part) => !!part).join(" ");
  }
}
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
  private sectionInfoInstances = new Map<string, ChordProSectionInfo>();
  private abcExpansionCache?: { signature: string; documents: Map<string, ChordProDocument> };
  customChordModifers = new Map<string, ChordInfo>();

  /** A cached, disposable document: its lines are real ChordPro objects for the
   * existing identity/layout machinery, while their ABC parent preserves legacy
   * section references and source-line highlighting. Never serialize it as a song. */
  expandAbc(include: (abc: ChordProAbc) => boolean = () => true): ChordProDocument {
    const selected = this.lines.filter(
      (line): line is ChordProAbc => line instanceof ChordProAbc && include(line) && line.toChordPro().some((row) => !(row instanceof ChordProAbc))
    );
    if (!selected.length) return this;
    const signature = JSON.stringify([isAbcjsLoaded(), this.generateDocument()]);
    if (this.abcExpansionCache?.signature !== signature) this.abcExpansionCache = { signature, documents: new Map() };
    const selection = selected.map((line) => this.lines.indexOf(line)).join(",");
    const cached = this.abcExpansionCache.documents.get(selection);
    if (cached) return cached;
    const expanded = new ChordProDocument(this.system, "");
    expanded.lines = [];
    expanded.metaData = this.metaData.clone();
    expanded.output = this.output.clone();
    expanded.customChordModifers = this.customChordModifers;
    const selectedSet = new Set<ChordProLine>(selected);
    const conversions = new Map(this.lines.filter((line): line is ChordProAbc => line instanceof ChordProAbc).map((abc) => [abc, abc.toChordPro()]));
    const names = new Map<string, Set<ChordProLine>>();
    const rememberName = (line: ChordProLine, origin: ChordProLine) => {
      const name = line.getSectionInfo().instructionName().toLocaleLowerCase();
      if (!name) return;
      const owners = names.get(name) ?? new Set<ChordProLine>();
      owners.add(origin);
      names.set(name, owners);
    };
    const allocated = new Set<string>();
    for (const origin of this.lines) {
      rememberName(origin, origin);
      allocated.add(origin.getSectionInfo().instructionName().toLocaleLowerCase());
      if (origin instanceof ChordProAbc) for (const line of conversions.get(origin)!) rememberName(line, origin);
    }
    const labels = new Map<ChordProAbc, Map<string, string>>();
    const scores = [...conversions.keys()];
    for (const [abc, rows] of conversions) {
      const sectionLabels = new Map<string, string>();
      labels.set(abc, sectionLabels);
      // A legacy instrumental block keeps its authored grid name. New vocal
      // parts (including their intros) must not shadow any authored section,
      // parent alias, or another part's preferred name, even after prefixing.
      if (!rows.some((row) => !row.isGrid && !(row instanceof ChordProAbc))) continue;
      const partNames = new Set(rows.map((row) => row.getSectionInfo().instructionName().toLocaleLowerCase()));
      const parentName = abc.getSectionInfo().instructionName().toLocaleLowerCase();
      for (const row of rows) {
        const info = row.getSectionInfo();
        if (sectionLabels.has(info.key)) continue;
        let name = info.instructionName();
        if ((names.get(name.toLocaleLowerCase())?.size ?? 0) > 1 || (partNames.size > 1 && name.toLocaleLowerCase() === parentName)) {
          let parent = abc.getSectionInfo().instructionName() || "ABC";
          if (scores.some((other) => other !== abc && other.getSectionInfo().instructionName().toLocaleLowerCase() === parent.toLocaleLowerCase()))
            parent += ` ${scores.indexOf(abc) + 1}`;
          const prefix = `${parent} / ${name}`;
          name = prefix;
          let ordinal = 2;
          while (allocated.has(name.toLocaleLowerCase()) || names.has(name.toLocaleLowerCase())) name = `${prefix} (${ordinal++})`;
          sectionLabels.set(
            info.key,
            name +
              (info.multiplier != null ? ` ${info.multiplier}x` : "") +
              (info.transpose ? ` ${info.transpose > 0 ? "+" : ""}${info.transpose}` : "")
          );
        } else sectionLabels.set(info.key, info.tag);
        allocated.add(name.toLocaleLowerCase());
      }
    }
    for (const origin of this.lines) {
      if (!(origin instanceof ChordProAbc) || !selectedSet.has(origin)) {
        // Hit testing and persistent marks must keep targeting the actual song
        // objects. Only converted ABC rows belong to the disposable document.
        expanded.lines.push(origin);
        continue;
      }
      const converted = conversions.get(origin)!;
      for (let i = 0; i < converted.length; ++i) {
        const line = converted[i].clone(true);
        line.doc = expanded;
        line.sourceLineNumber = origin.sourceLineNumber;
        line.abcSource = origin;
        line.abcRow = i;
        const info = converted[i].getSectionInfo();
        const label = labels.get(origin)?.get(info.key);
        if (label != null) line.styles.set(info.name, label);
        if (i === 0) line.comments = origin.comments.clone();
        origin.styles.forEach((value, name) => {
          if (!name.startsWith("start_of_")) line.styles.set(name, value);
        });
        expanded.lines.push(line);
      }
    }
    if (this.abcExpansionCache.documents.size >= 8) this.abcExpansionCache.documents.delete(this.abcExpansionCache.documents.keys().next().value!);
    this.abcExpansionCache.documents.set(selection, expanded);
    return expanded;
  }

  getSectionInfoFor(key: string): ChordProSectionInfo {
    let info = this.sectionInfoInstances.get(key);
    if (!info) this.sectionInfoInstances.set(key, (info = new ChordProSectionInfo(key)));
    return info;
  }

  /**
   * Returns the song's built-in "default" instruction string: one entry per
   * comment line (raw text) and one entry per distinct section block (in
   * `ChordProSectionInfo.normalized()` form, or the directive name for an
   * unlabelled standard section). This is the source the editor uses to seed
   * the instructions side pane, and the source `Song.ts` uses when no explicit
   * playlist instructions are supplied.
   */
  getDefaultInstructions(): string {
    const lines: string[] = [];
    for (let i = 0; i < this.lines.length; ++i) {
      const line_obj = this.lines[i];
      if (line_obj.isComment) {
        lines.push(line_obj.text);
      } else {
        const info = line_obj.getSectionInfo();
        const instructionName = info.normalizedInstructionName() || line_obj.abcSource?.getSectionInfo().normalizedInstructionName();
        if (instructionName) {
          while (i + 1 < this.lines.length && this.lines[i + 1].getSectionInfo() === info) ++i;
          lines.push(instructionName);
        }
      }
    }
    return lines.join("\n");
  }

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

  /** ABC always uses international note names, even for Hungarian/German songs. */
  getAbcKey(name = this.key) {
    const key = this.system.getKey(name);
    if (!key) return "";
    const standard = new Key(getChordSystem("S"), key.signature, key.scaleType);
    return standard.baseNote + ["", "dor", "phr", "lyd", "mix", "m", "loc"][key.scaleType];
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
          if (!info) m.set(current, { signature, info: this.getSectionInfoFor(current) });
          else info.signature = signature;
        }
      });

    const autoBaseTags = new Map<string, SectionInfo>();
    const uniqueBaseTags = new Map<string, boolean>();
    for (const info of m.values()) {
      const parsed = info.info;
      if (parsed.familyKey) {
        info.baseTag = parsed.familyKey;
        const unique = uniqueBaseTags.get(info.baseTag);
        if (!unique) {
          const baseInfo = m.get(info.baseTag) ?? autoBaseTags.get(info.baseTag);
          if (!baseInfo) autoBaseTags.set(info.baseTag, info);
          else uniqueBaseTags.set(info.baseTag, baseInfo.signature !== info.signature);
        }
      }
    }

    const usedBaseTags = new Set<string>();
    m.forEach((info, tag) => {
      info.duplicate = info.baseTag !== undefined && !uniqueBaseTags.get(info.baseTag) && usedBaseTags.has(info.baseTag);
      usedBaseTags.add(info.baseTag ?? tag);
    });

    return (this.sectionInfoMap = m);
  }

  getSections() {
    const sections: string[] = [];
    for (const info of this.sectionInfo.values()) {
      const parsed = info.info;
      // Keep this legacy query's public shape distinct from instruction
      // matching: callers historically received the authored tag including
      // modifiers, and an unlabelled grid was exposed as "grid".
      if (parsed.tag) sections.push(parsed.tag);
      else if (parsed.name.startsWith("start_of_")) sections.push(parsed.name.substring(9));
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
    // An ABC block owns its contents, including JSON objects and grace notes.
    // Only its closing directive may be interpreted as ChordPro.
    if (context.pending_abc && !rxAbcEndDirective.test(line.toString(true))) {
      context.pending_abc.push(line);
      return null;
    }
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
      const parseChordLine = (input: string) => {
        const chords: { text: string; pos: number }[] = [];
        let lyrics = "";
        let chord: string | null = null;

        for (const ch of input) {
          if (chord == null) {
            if (ch === "[") chord = "";
            else lyrics += ch;
          } else if (ch === "]") {
            chords.push({ text: chord, pos: lyrics.length });
            chord = null;
          } else chord += ch;
        }

        return { lyrics, chords };
      };

      const previous = parseChordLine(line.toString(false));
      const currentLine = parseChordLine(line.toString(true));

      line_obj.setLyrics(DifferentialText.create(previous.lyrics, currentLine.lyrics));
      line_obj.modifyRanges = [];
      let modifyStart = 0;
      line_obj.lyricsData.forEachChunk((chunk) => {
        line_obj.modifyRanges!.push({ start: modifyStart, added: chunk.added });
        modifyStart += chunk.text.length;
      });

      const oldUsed = previous.chords.map(() => false);
      const newUsed = currentLine.chords.map(() => false);
      // Old and new chord offsets live in different lyric coordinate spaces.
      const sameAnchor = createChordAnchorMatcher(previous.lyrics, currentLine.lyrics);

      // First keep exact matches (same chord text at the same lyric place) unchanged.
      for (let j = 0; j < currentLine.chords.length; ++j) {
        const nextChord = currentLine.chords[j];
        let match = -1;
        for (let i = 0; i < previous.chords.length; ++i) {
          if (oldUsed[i]) continue;
          const prevChord = previous.chords[i];
          if (prevChord.text === nextChord.text && sameAnchor(prevChord.pos, nextChord.pos)) {
            match = i;
            break;
          }
        }
        if (match >= 0) {
          oldUsed[match] = true;
          newUsed[j] = true;
          line_obj.chords.push(new ChordProChord(line_obj, nextChord.text, nextChord.pos));
        }
      }

      // Pair remaining same-text chords as moves from old position to new position.
      for (let j = 0; j < currentLine.chords.length; ++j) {
        if (newUsed[j]) continue;
        const nextChord = currentLine.chords[j];
        let match = -1;
        for (let i = 0; i < previous.chords.length; ++i) {
          if (oldUsed[i]) continue;
          if (previous.chords[i].text === nextChord.text) {
            match = i;
            break;
          }
        }

        if (match >= 0) {
          oldUsed[match] = true;
          const prevPos = previous.chords[match].pos;
          line_obj.chords.push(new ChordProChord(line_obj, nextChord.text, nextChord.pos, sameAnchor(prevPos, nextChord.pos) ? undefined : prevPos));
        } else {
          line_obj.chords.push(new ChordProChord(line_obj, nextChord.text, nextChord.pos, true));
        }
      }

      // Any leftover old chords are removals.
      for (let i = 0; i < previous.chords.length; ++i)
        if (!oldUsed[i]) {
          const prevChord = previous.chords[i];
          line_obj.chords.push(new ChordProChord(line_obj, prevChord.text, prevChord.pos, false));
        }

      // A removed chord's `pos` is an old-lyrics offset, every other chord's a
      // new-lyrics one; order them in the rendered (before + after) stream, the
      // same anchor the display plan lays them out by.
      const lyricUnits = differentialTextUnits(line_obj.lyricsData);
      const renderedPos = (chord: ChordProChord) => differentialCoordinateToSource(lyricUnits, chord.added === false ? "before" : "after", chord.pos);
      line_obj.chords.sort((a, b) => {
        const aPos = renderedPos(a);
        const bPos = renderedPos(b);
        if (aPos !== bPos) return aPos - bPos;
        const aRank = a.added === false ? -1 : a.added === true ? 1 : 0;
        const bRank = b.added === false ? -1 : b.added === true ? 1 : 0;
        return aRank - bRank;
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
