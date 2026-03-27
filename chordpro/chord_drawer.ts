import { UnicodeSymbol } from "../common/symbols";
import { VersionedMap } from "../common/utils";
import { ChordSelector } from "./chord_selector";
import { ChordProChordBase, ChordSystem } from "./chordpro_base";
import { defaultDisplayProperties } from "./chordpro_styles";
import { ChordDetails, isHalfNote } from "./note_system";
import { NoteHitBox, Rectangle, Size } from "./ui_base";

export const CHORDFORMAT_LCMOLL = 1;
export const CHORDFORMAT_NOMMOL = 3;
export const CHORDFORMAT_SUBSCRIPT = 4;
export const CHORDFORMAT_BB = 8;
export const CHORDFORMAT_SIMPLIFIED = 16;
export const CHORDFORMAT_NOSECTIONDUP = 32;
export const CHORDFORMAT_NOCHORDS = 64;
export const CHORDFORMAT_INKEY = 128;

export type ChordBoxType = "PIANO" | "GUITAR" | "";

const chordSubscriptFontCache = new Map<string, { font: string; offset: number }>();

function getSubscriptParams(chordFont: string) {
  let rv = chordSubscriptFontCache.get(chordFont);
  if (!rv) {
    rv = { font: chordFont, offset: 0 };
    const m = /^([^0-9]*)([0-9]+(?:\.[0-9]+)?)(em|px|pt)(.*)$/.exec(chordFont);
    if (m) {
      const chordFontSize = parseFloat(m[2]);
      const chordSSFontSize = Math.round((chordFontSize * 9) / 14);
      rv.font = m[1] + chordSSFontSize + m[3] + m[4];
      rv.offset = Math.round((chordFontSize * 4) / 14);
    }
    chordSubscriptFontCache.set(chordFont, rv);
  }
  return rv;
}

export class ChordDrawer {
  protected readonly chordVariantCache = new Map<string, number>();
  protected chordFormat = 0;
  protected chordsSizeCache = new VersionedMap<string, number, number>(-1);
  protected chordsInKey = new VersionedMap<string, string, string>("");

  constructor(
    public readonly system: ChordSystem,
    protected readonly chordSelector?: ChordSelector,
    public readOnly = true,
    protected displayProps = defaultDisplayProperties()
  ) {}

  protected getChordDetails(chord: string | ChordProChordBase, simplify?: boolean) {
    if (simplify === undefined)
      // tslint:disable-next-line: no-bitwise
      simplify = this.readOnly && (this.chordFormat & CHORDFORMAT_SIMPLIFIED) === CHORDFORMAT_SIMPLIFIED;
    return this.system.getChordDetails(chord, simplify);
  }

  getCapo(): number {
    return 0;
  }

  getKey(): string | undefined {
    return undefined;
  }

  formatNote(note: string, moll: boolean) {
    // tslint:disable-next-line: no-bitwise
    if (this.readOnly && this.chordFormat & CHORDFORMAT_BB) {
      const n = this.system.stringToNote(note);
      if (n === 1) note = "Bb";
      else if (n === 2) note = "B";
    }
    // tslint:disable-next-line: no-bitwise
    return !this.readOnly || !moll || !(this.chordFormat & CHORDFORMAT_LCMOLL) ? ChordProChordBase.formatSingleNote(note) : note.toLowerCase();
  }

  drawModifier(text: string, ctx: CanvasRenderingContext2D, x?: number, y?: number) {
    let fb = ""; // tslint:disable-next-line: no-bitwise
    const ssp = this.readOnly && (this.chordFormat & CHORDFORMAT_SUBSCRIPT) === CHORDFORMAT_SUBSCRIPT ? getSubscriptParams(ctx.font) : null;
    if (ssp) {
      fb = ctx.font;
      ctx.font = ssp.font;
    }
    const s = ssp ? text.replace(/[#b]/g, (r) => (r === "#" ? UnicodeSymbol.sharp : UnicodeSymbol.flat)) : text.replace(/b/g, UnicodeSymbol.flat);
    if (x !== undefined && y !== undefined) ctx.fillText(s, x, y - (ssp?.offset || 0));
    const w = ctx.measureText(s).width;
    if (ssp) ctx.font = fb;
    return w;
  }

  drawChordText(chord: string | ChordProChordBase, ctx: CanvasRenderingContext2D, x?: number, y?: number, actual?: boolean) {
    const chordVersion = this.chordFormat;
    const chordCacheKey = (typeof chord === "string" ? chord : chord.text) + ":" + ctx.font;

    if (x == null || y == null) {
      const width = this.chordsSizeCache.get(chordVersion, chordCacheKey);
      if (width !== undefined) return { width };
    }

    let s: string;
    let width = 0;
    const chordDetails = this.getChordDetails(chord);

    const fillStyleBackup = x === undefined || chordDetails ? undefined : ctx.fillStyle;
    if (fillStyleBackup !== undefined) ctx.fillStyle = this.displayProps.unknownChordTextColor;

    if (chordDetails) {
      if (chordDetails.prefix) {
        if (x !== undefined && y !== undefined) ctx.fillText(chordDetails.prefix, x + width, y);
        width += ctx.measureText(chordDetails.prefix).width;
      }

      let baseNote = chordDetails.baseNote;
      const actualKey = this.getKey();
      if (this.readOnly && (this.chordFormat & CHORDFORMAT_INKEY) === CHORDFORMAT_INKEY && actualKey) {
        const key = this.system.getKey(actualKey);
        if (key) {
          let b = this.chordsInKey.get(key.name, baseNote);
          if (!b) this.chordsInKey.set(key.name, baseNote, (b = key.noteName(baseNote)));
          baseNote = b;
        }
      }

      let note = this.formatNote(baseNote, chordDetails.minor);
      s = note.substring(0, 1);
      if (x !== undefined && y !== undefined) ctx.fillText(s, x + width, y);
      width += ctx.measureText(s).width;

      s = note.substring(1);

      // tslint:disable-next-line: no-bitwise
      if (this.readOnly && chordDetails.minor && (this.chordFormat & CHORDFORMAT_NOMMOL) === CHORDFORMAT_NOMMOL) s += chordDetails.modifier.substr(1);
      else s += chordDetails.modifier;

      if (s) width += this.drawModifier(s, ctx, x !== undefined ? x + width + 1 : undefined, y) + 1;

      // tslint:disable-next-line: no-bitwise
      if (!this.readOnly || (this.chordFormat & CHORDFORMAT_SIMPLIFIED) === 0) {
        if (chordDetails.bassNote) {
          if (x !== undefined && y !== undefined) ctx.fillText("/", x + width, y);
          width += ctx.measureText("/").width;
          note = this.formatNote(chordDetails.bassNote, false);
          s = note.substring(0, 1);
          if (x !== undefined && y !== undefined) ctx.fillText(s, x + width, y);
          width += ctx.measureText(s).width;
          s = note.substring(1);
          width += this.drawModifier(s, ctx, x !== undefined ? x + width : undefined, y);
        }
      }

      s = chordDetails.suffix;
      if (s) {
        if (x !== undefined && y !== undefined) ctx.fillText(s, x + width, y);
        width += ctx.measureText(s).width;
      }

      if (actual && x !== undefined && y !== undefined)
        ctx.fillRect(x, y + this.displayProps.chordLineHeight / 2 - this.displayProps.chordBorder, width, 1);

      if (fillStyleBackup !== undefined) ctx.fillStyle = fillStyleBackup;
    } else {
      const text = typeof chord === "string" ? chord : chord.text;
      if (x !== undefined && y !== undefined) ctx.fillText(text, x, y);
      if (fillStyleBackup !== undefined) ctx.fillStyle = fillStyleBackup;
      width = ctx.measureText(text).width;
    }

    this.chordsSizeCache.set(chordVersion, chordCacheKey, width);
    return { width };
  }

  genPianoChordNotes(chord: ChordDetails, notes: Set<number>, forcedVariantIndex?: number) {
    notes.clear();
    let firstNote: number,
      lastNote: number,
      keyCount = 1,
      bassNote = chord.bassNote,
      variantIndex = 0;
    if (bassNote !== null) {
      bassNote %= 12;
      firstNote = lastNote = bassNote - (isHalfNote(bassNote) ? 1 : 0) + 12;
      const ns = new Set<number>();
      ns.add(bassNote);
      for (const n of this.system.chordNotes(chord)) ns.add(n % 12);
      while (ns.size > 0) {
        const n = lastNote % 12;
        if (ns.has(n)) {
          notes.add(lastNote);
          ns.delete(n);
        }
        if (!isHalfNote(++lastNote)) ++keyCount;
      }
    } else if (chord.chordInfo.steps.length < 4) {
      let baseNote = chord.baseNote;
      const na = this.system.chordNotes(chord);
      if (forcedVariantIndex) {
        variantIndex = ((forcedVariantIndex % na.length) + na.length) % na.length;
        baseNote = na[variantIndex];
      }
      firstNote = lastNote = baseNote - (isHalfNote(baseNote) ? 1 : 0) + 12;
      const stepOffset = chord.chordInfo.steps[variantIndex % chord.chordInfo.steps.length];
      for (let stepIndex = 0; stepIndex < chord.chordInfo.steps.length; ++stepIndex) {
        const step = chord.chordInfo.steps[(stepIndex + variantIndex) % chord.chordInfo.steps.length] - stepOffset;
        while (lastNote % 12 !== (baseNote + step) % 12) if (!isHalfNote(++lastNote)) ++keyCount;
        notes.add(lastNote);
      }
    } else {
      if (forcedVariantIndex) variantIndex = ((forcedVariantIndex % 2) + 2) % 2;
      const overOctave = () => {
        let prevStep = 0;
        for (const step of chord.chordInfo.steps) {
          if (step >= 12 || step < prevStep) return true;
          prevStep = step;
        }
        return false;
      };
      if (variantIndex && overOctave()) {
        firstNote = lastNote = chord.baseNote - (isHalfNote(chord.baseNote) ? 1 : 0) + 12;
        const ns = new Set<number>();
        for (const n of this.system.chordNotes(chord)) ns.add(n % 12);
        while (ns.size > 0) {
          const n = lastNote % 12;
          if (ns.has(n)) {
            notes.add(lastNote);
            ns.delete(n);
          }
          if (!isHalfNote(++lastNote)) ++keyCount;
        }
      } else {
        variantIndex = 0;
        firstNote = lastNote = chord.baseNote - (isHalfNote(chord.baseNote) ? 1 : 0) + 12;
        for (const step of chord.chordInfo.steps) {
          while (lastNote % 12 !== (chord.baseNote + step) % 12) if (!isHalfNote(++lastNote)) ++keyCount;
          notes.add(lastNote);
        }
      }
    }
    if (isHalfNote(lastNote)) {
      ++lastNote;
      ++keyCount;
    }
    if (keyCount < 8) {
      while (isHalfNote(--firstNote));
      keyCount = 8;
    }
    return { firstNote, lastNote, keyCount, variantIndex };
  }

  drawPianoChordLayout(
    ctx: CanvasRenderingContext2D,
    rect: Rectangle,
    chord: string | ChordDetails,
    pVariantIndex?: number,
    noteHitBoxes?: NoteHitBox[]
  ) {
    let key = "",
      forcedVariantIndex = pVariantIndex ?? 0;
    if (typeof chord === "string") {
      key = chord;
      if (pVariantIndex === undefined) forcedVariantIndex = this.chordVariantCache.get(chord) ?? 0;
      const tmp = this.system.identifyChord(chord);
      if (!tmp) return false;
      chord = tmp;
    }

    ctx.save();
    ctx.strokeStyle = this.displayProps.lineColor;
    const marked = new Set<number>();
    const { firstNote, lastNote, keyCount, variantIndex } = this.genPianoChordNotes(chord, marked, forcedVariantIndex);
    if (key && variantIndex !== undefined) this.chordVariantCache.set(key, variantIndex);

    const nameHeight = rect.height / 3;
    const fontSize = Math.round(nameHeight / 2);
    ctx.font = "bold " + fontSize + "px arial";
    const leftMargin = ctx.measureText("1").width;
    const keyRect = {
      x: Math.round(rect.x + leftMargin),
      y: Math.round(rect.y + nameHeight),
      width: Math.round(rect.width) - leftMargin,
      height: Math.round(rect.height - nameHeight) - 2,
    };

    ctx.fillStyle = this.displayProps.chordBoxColor;

    let label = chord.label;
    if (variantIndex) label += " v" + (variantIndex + 1);
    this.drawChordText(label, ctx, keyRect.x, Math.floor(rect.y + nameHeight - fontSize / 2));

    const keyWidth = Math.round(keyRect.width / keyCount);
    const halfKeyWidth = Math.round(keyWidth * 0.5);
    const halfKeyHeight = Math.round(keyRect.height * 0.65);

    const circle = (cx: number, cy: number, radius: number) => {
      ctx.beginPath();
      ctx.arc(cx, cy, radius, 0, 2 * Math.PI);
      ctx.fill();
    };

    ctx.strokeRect(keyRect.x, keyRect.y, keyWidth * keyCount, keyRect.height);
    for (let i = 0, note = firstNote; i < keyCount; ++note)
      if (!isHalfNote(note)) {
        const left = keyRect.x + i * keyWidth;
        ctx.fillRect(left, keyRect.y, 1, keyRect.height);
        if (noteHitBoxes) noteHitBoxes.push({ x: left, y: keyRect.y, width: keyWidth, height: keyRect.height, note });
        if (note <= lastNote && marked.has(note)) circle(left + keyWidth / 2 + 0.5, keyRect.y + keyRect.height - keyWidth / 2, keyWidth / 3);
        ++i;
      }
    for (let i = 0, note = firstNote; i < keyCount; ++note)
      if (isHalfNote(note)) {
        let left = keyRect.x + i * keyWidth - halfKeyWidth / 2 + 0.5;
        if (!isHalfNote(note - 2)) {
          left -= halfKeyWidth / 4;
          if (!isHalfNote(note + 4)) left += halfKeyWidth / 8;
        } else if (!isHalfNote(note + 2)) {
          left += halfKeyWidth / 4;
          if (!isHalfNote(note - 4)) left -= halfKeyWidth / 8;
        }
        ctx.fillRect(left, keyRect.y, halfKeyWidth, halfKeyHeight);
        ctx.strokeRect(left, keyRect.y, halfKeyWidth, halfKeyHeight);
        if (noteHitBoxes) noteHitBoxes.splice(0, 0, { x: left, y: keyRect.y, width: halfKeyWidth, height: halfKeyHeight, note });
        if (marked.has(note)) {
          ctx.fillStyle = this.displayProps.backgroundColor;
          circle(left + halfKeyWidth / 2, keyRect.y + halfKeyHeight - halfKeyWidth, halfKeyWidth / 2);
          ctx.fillStyle = this.displayProps.chordBoxColor;
        }
      } else {
        if (i === 0 && isHalfNote(note - 1)) {
          ctx.fillRect(keyRect.x, keyRect.y, halfKeyWidth / 2, halfKeyHeight);
          ctx.strokeRect(keyRect.x, keyRect.y, halfKeyWidth / 2, halfKeyHeight);
        }
        if (++i === keyCount && isHalfNote(note + 1)) {
          const left = keyRect.x + i * keyWidth - halfKeyWidth / 2;
          ctx.fillRect(left, keyRect.y, halfKeyWidth / 2, halfKeyHeight);
          ctx.strokeRect(left, keyRect.y, halfKeyWidth / 2, halfKeyHeight);
        }
      }
    ctx.restore();

    return true;
  }

  getActualChordLayout(chord: string | ChordDetails) {
    if (!this.chordSelector) return null;
    const layouts = this.chordSelector.genChordLayoutsFromChordString(chord, this.getCapo());
    if (!layouts || layouts.length === 0) return null;
    let variantIndex = this.chordVariantCache.get(this.system.chordLabel(chord)) || 0;
    if (variantIndex < 0) variantIndex = layouts.length - 1;
    else if (variantIndex >= layouts.length) variantIndex = 0;
    this.chordVariantCache.set(this.system.chordLabel(chord), variantIndex);
    return { layouts, variantIndex };
  }

  drawGuitarChordLayout(
    ctx: CanvasRenderingContext2D,
    rect: Rectangle,
    chord: string | ChordDetails,
    forcedVariantIndex?: number,
    noteHitBoxes?: NoteHitBox[]
  ) {
    const rv = this.getActualChordLayout(chord);
    if (rv && this.chordSelector) {
      ctx.save();
      ctx.strokeStyle = this.displayProps.lineColor;
      const layouts = rv.layouts;
      let variantIndex = rv.variantIndex;
      if (forcedVariantIndex !== undefined) variantIndex = ((forcedVariantIndex % layouts.length) + layouts.length) % layouts.length;
      const layout = layouts[variantIndex];
      let minBund = 10000,
        maxBund = 0;
      for (const pos of layout)
        if (pos !== null) {
          if (pos > 0) minBund = Math.min(minBund, pos);
          maxBund = Math.max(maxBund, pos);
        }
      if (minBund >= maxBund) minBund = maxBund;
      if (maxBund < 4) {
        minBund = 1;
        maxBund = 4;
      } else if (maxBund - minBund < 3) maxBund = minBund + 3;
      const bundCount = maxBund - minBund + 1;
      const bundStep = rect.height / (bundCount + 2);

      let fontSize = Math.floor(rect.height / 6);
      ctx.font = "bold " + fontSize + "px arial";

      const leftMargin = ctx.measureText("11").width + bundStep / 8 + 2;
      const rightMargin = leftMargin / 2;
      const gridRect = {
        x: Math.round(rect.x + leftMargin),
        y: Math.floor(rect.y + 2 * bundStep) - 1,
        width: Math.round(rect.width - leftMargin - rightMargin),
        height: Math.round(rect.height - 2 * bundStep),
      };

      ctx.fillStyle = this.displayProps.chordBoxColor;
      const stringCount = this.chordSelector.tuning.length;
      const stringStep = gridRect.width / (stringCount - 1);

      for (let s = 0; s < stringCount; ++s) {
        const left = gridRect.x + s * stringStep;
        ctx.fillRect(left, gridRect.y, 1, gridRect.height);
        if (noteHitBoxes)
          for (let b = 0; b <= bundCount; ++b) {
            const sIndex = stringCount - s - 1;
            const pos = layout[sIndex];
            const note = this.chordSelector.tuning[sIndex] + b + minBund - 1;
            const param = pos === null ? undefined : this.chordSelector.tuning[sIndex] + (pos === b ? 0 : pos) + minBund - 1;
            noteHitBoxes.push({
              x: left - stringStep / 2,
              y: gridRect.y + (b - 1) * bundStep,
              width: stringStep,
              height: bundStep,
              note,
              param,
            });
          }
      }
      for (let b = 0; b <= bundCount; ++b) ctx.fillRect(gridRect.x, gridRect.y + b * bundStep, gridRect.width, 1);

      const markRadius = Math.ceil(Math.min(stringStep, bundStep) / 4);
      const circle = (bund: number, string: number) => {
        const cx = gridRect.x + string * stringStep + 0.5;
        const cy = bund > 0 ? gridRect.y + (bund - minBund) * bundStep + bundStep / 2 + 0.5 : gridRect.y - 1.5 * markRadius;
        ctx.beginPath();
        ctx.arc(cx, cy, markRadius + (bund > 0 ? 0.33 : 0), 0, 2 * Math.PI);
        if (bund > 0) ctx.fill();
        else ctx.stroke();
      };
      const drawX = (string: number) => {
        const cx = gridRect.x + string * stringStep + 0.5;
        const cy = gridRect.y - 1.5 * markRadius;
        ctx.beginPath();
        ctx.moveTo(cx - markRadius, cy - markRadius);
        ctx.lineTo(cx + markRadius, cy + markRadius);
        ctx.moveTo(cx - markRadius, cy + markRadius);
        ctx.lineTo(cx + markRadius, cy - markRadius);
        ctx.stroke();
      };
      for (let s = 0; s < stringCount; ++s) {
        const pos = layout[stringCount - s - 1];
        if (pos === null) drawX(s);
        else circle(pos, s);
      }
      if (minBund > 1) {
        const minBundStr = minBund.toString();
        const sw = ctx.measureText(minBundStr).width;
        ctx.fillText(minBundStr, gridRect.x - sw - markRadius / 2 - 2, gridRect.y + bundStep / 2 + 1);
      }

      let label = this.system.chordLabel(chord);
      if (variantIndex) label += " v" + (variantIndex + 1);
      while (this.drawChordText(label, ctx).width > gridRect.width) {
        ctx.font = fontSize + "px arial";
        if (--fontSize <= bundStep / 2) break;
      }
      this.drawChordText(label, ctx, gridRect.x, Math.max(rect.y, gridRect.y - bundStep));
      ctx.restore();
      return true;
    }
    return false;
  }

  chordBoxDraw(
    type: ChordBoxType,
    chord: string | ChordDetails,
    canvas: HTMLCanvasElement,
    forcedVariantIndex?: number,
    rect?: Rectangle,
    noteHitBoxes?: NoteHitBox[]
  ) {
    canvas.width = canvas.offsetWidth;
    canvas.height = canvas.offsetHeight;
    const ctx = canvas.getContext("2d");
    if (ctx) {
      ctx.strokeStyle = this.displayProps.lineColor;
      ctx.fillStyle = this.displayProps.backgroundColor;
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      const maxRect = (refSize: Size) => {
        const center = {
          x: canvas.width / 2,
          y: canvas.height / 2,
        };
        const scale = refSize.width / refSize.height;
        let width: number, height: number;
        if (canvas.width / canvas.height > scale) {
          height = canvas.height;
          width = height * scale;
        } else {
          width = canvas.width;
          height = width / scale;
        }
        return {
          x: center.x - width / 2,
          y: center.y - height / 2,
          width,
          height,
        };
      };
      switch (type) {
        case "GUITAR":
          return this.drawGuitarChordLayout(ctx, rect || maxRect(this.displayProps.guitarChordSize), chord, forcedVariantIndex, noteHitBoxes);
        case "PIANO":
          return this.drawPianoChordLayout(ctx, rect || maxRect(this.displayProps.pianoChordSize), chord, forcedVariantIndex, noteHitBoxes);
      }
    }
    return false;
  }
}
