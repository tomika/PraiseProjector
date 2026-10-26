import { VersionedMap } from "../common/utils";
import { ChordSelector } from "./chord_selector";
import { ChordProChordBase, ChordSystem } from "./chordpro_base";
import { defaultDisplayProperties } from "./chordpro_styles";
import { ChordDetails, isHalfNote } from "./note_system";
import { buildChordVisualModel, ChordVisualToken, CHORDFORMAT_BB, CHORDFORMAT_LCMOLL, CHORDFORMAT_SIMPLIFIED } from "./render/chord-visual";
import { NoteHitBox, Rectangle, Size } from "./ui_base";
import { CanvasDiagramSurface, DiagramSurface, SvgDiagramSurface } from "./render/diagram-surface";

export {
  CHORDFORMAT_LCMOLL,
  CHORDFORMAT_NOMMOL,
  CHORDFORMAT_SUBSCRIPT,
  CHORDFORMAT_BB,
  CHORDFORMAT_SIMPLIFIED,
  CHORDFORMAT_NOSECTIONDUP,
  CHORDFORMAT_NOCHORDS,
  CHORDFORMAT_INKEY,
} from "./render/chord-visual";

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

  private getCanvasBackgroundColor(canvas: HTMLCanvasElement) {
    const backgroundColor = getComputedStyle(canvas).backgroundColor;
    return backgroundColor && backgroundColor !== "transparent" && backgroundColor !== "rgba(0, 0, 0, 0)" ? backgroundColor : null;
  }

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

  /** Draws (or, with x/y omitted, only measures) one chord-visual token, honoring its subscript font/offset. */
  private drawChordVisualToken(token: ChordVisualToken, ctx: DiagramSurface, x?: number, y?: number) {
    if (!token.subscript) {
      if (x !== undefined && y !== undefined) ctx.fillText(token.text, x, y);
      return ctx.measureText(token.text).width;
    }
    const ssp = getSubscriptParams(ctx.font);
    const fontBackup = ctx.font;
    ctx.font = ssp.font;
    if (x !== undefined && y !== undefined) ctx.fillText(token.text, x, y - ssp.offset);
    const width = ctx.measureText(token.text).width;
    ctx.font = fontBackup;
    return width;
  }

  drawChordText(chord: string | ChordProChordBase, ctx: DiagramSurface, x?: number, y?: number, actual?: boolean) {
    const chordVersion = this.chordFormat;
    const chordCacheKey = (typeof chord === "string" ? chord : chord.text) + ":" + ctx.font;

    if (x == null || y == null) {
      const width = this.chordsSizeCache.get(chordVersion, chordCacheKey);
      if (width !== undefined) return { width };
    }

    const chordDetails = this.getChordDetails(chord);
    const model = buildChordVisualModel({
      chord,
      chordDetails,
      system: this.system,
      chordFormat: this.chordFormat,
      readOnly: this.readOnly,
      actual,
      actualKey: this.getKey(),
      chordsInKey: this.chordsInKey,
    });

    const fillStyleBackup = x === undefined || !model.unknown ? undefined : ctx.fillStyle;
    if (fillStyleBackup !== undefined) ctx.fillStyle = this.displayProps.unknownChordTextColor;

    let width = 0;
    for (const token of model.tokens) {
      width += token.gapBefore;
      width += this.drawChordVisualToken(token, ctx, x !== undefined ? x + width : undefined, y);
    }

    if (model.underline && x !== undefined && y !== undefined)
      ctx.fillRect(x, y + this.displayProps.chordLineHeight / 2 - this.displayProps.chordBorder, width, 1);

    if (fillStyleBackup !== undefined) ctx.fillStyle = fillStyleBackup;

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

  drawPianoChordLayout(ctx: DiagramSurface, rect: Rectangle, chord: string | ChordDetails, pVariantIndex?: number, noteHitBoxes?: NoteHitBox[]) {
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

    const circle = (cx: number, cy: number, radius: number) => ctx.fillCircle(cx, cy, radius);

    ctx.strokeRect(keyRect.x, keyRect.y, keyWidth * keyCount, keyRect.height);
    for (let i = 1, note = firstNote; i < keyCount; ++note)
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
    ctx: DiagramSurface,
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
        ctx.fillRect(left, gridRect.y, 1, gridRect.height + 1);
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
        const radius = markRadius + (bund > 0 ? 0.33 : 0);
        if (bund > 0) ctx.fillCircle(cx, cy, radius);
        else ctx.strokeCircle(cx, cy, radius);
      };
      const drawX = (string: number) => {
        const cx = gridRect.x + string * stringStep + 0.5;
        const cy = gridRect.y - 1.5 * markRadius;
        ctx.strokeLine(cx - markRadius, cy - markRadius, cx + markRadius, cy + markRadius);
        ctx.strokeLine(cx - markRadius, cy + markRadius, cx + markRadius, cy - markRadius);
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
      this.drawChordText(label, ctx, gridRect.x, Math.max(rect.y, gridRect.y - (3 * bundStep) / 4));
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
    const hasExplicitCSSSize = canvas.style.width !== "";
    const cssW = hasExplicitCSSSize ? canvas.offsetWidth : 0;
    const cssH = hasExplicitCSSSize ? canvas.offsetHeight : 0;
    const logicalW = cssW > 0 ? cssW : canvas.width;
    const logicalH = cssH > 0 ? cssH : canvas.height;
    if (!hasExplicitCSSSize) {
      canvas.width = logicalW;
      canvas.height = logicalH;
    }
    const ctx = canvas.getContext("2d");
    if (ctx) {
      const dpr = canvas.width / logicalW;
      if (dpr !== 1) ctx.scale(dpr, dpr);
      const backgroundColor = this.getCanvasBackgroundColor(canvas);
      const originalBackgroundColor = this.displayProps.backgroundColor;
      if (backgroundColor) this.displayProps.backgroundColor = backgroundColor;
      try {
        ctx.strokeStyle = this.displayProps.lineColor;
        ctx.fillStyle = this.displayProps.backgroundColor;
        ctx.fillRect(0, 0, logicalW, logicalH);
        const maxRect = (refSize: Size) => {
          const center = {
            x: logicalW / 2,
            y: logicalH / 2,
          };
          const scale = refSize.width / refSize.height;
          let width: number, height: number;
          if (logicalW / logicalH > scale) {
            height = logicalH;
            width = height * scale;
          } else {
            width = logicalW;
            height = width / scale;
          }
          return {
            x: center.x - width / 2,
            y: center.y - height / 2,
            width,
            height,
          };
        };
        const surface = new CanvasDiagramSurface(ctx);
        switch (type) {
          case "GUITAR":
            return this.drawGuitarChordLayout(surface, rect || maxRect(this.displayProps.guitarChordSize), chord, forcedVariantIndex, noteHitBoxes);
          case "PIANO":
            return this.drawPianoChordLayout(surface, rect || maxRect(this.displayProps.pianoChordSize), chord, forcedVariantIndex, noteHitBoxes);
        }
      } finally {
        this.displayProps.backgroundColor = originalBackgroundColor;
      }
    }
    return false;
  }

  /**
   * SVG counterpart of `chordBoxDraw` for the DOM song surface. Clears and
   * repopulates `svg` with a resolution-independent diagram sized to `size` (its
   * `viewBox` becomes `0 0 size.width size.height`), so the fit-to-screen
   * `transform: scale()` scales it as vectors and it never blurs. The geometry
   * is the SAME `drawGuitarChordLayout`/`drawPianoChordLayout` the canvas path
   * runs — only the surface backend differs. Returns false (leaving the svg
   * cleared) when the chord cannot be laid out. Diagram-level interaction is
   * owned by the caller, so no per-note hit boxes are collected here.
   */
  chordBoxDrawSvg(type: ChordBoxType, chord: string | ChordDetails, svg: SVGSVGElement, size: Size, forcedVariantIndex?: number) {
    while (svg.firstChild) svg.removeChild(svg.firstChild);
    if (type !== "GUITAR" && type !== "PIANO") return false;
    svg.setAttribute("viewBox", `0 0 ${size.width} ${size.height}`);
    svg.setAttribute("preserveAspectRatio", "xMidYMid meet");
    const surface = new SvgDiagramSurface(svg, this.displayProps.backgroundColor);
    surface.strokeStyle = this.displayProps.lineColor;
    const rect = { x: 0, y: 0, width: size.width, height: size.height };
    return type === "GUITAR"
      ? this.drawGuitarChordLayout(surface, rect, chord, forcedVariantIndex)
      : this.drawPianoChordLayout(surface, rect, chord, forcedVariantIndex);
  }
}
