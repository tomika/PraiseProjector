import { isVowel, simplifyString } from "../../common/stringTools";
import type { DisplayOccurrence, DisplayPlan } from "../render/display-plan";
import { CHORDFORMAT_NOCHORDS } from "../render/chord-visual";
import type { TextMeasurer, MeasurementRequest } from "../render/text-measurer";
import { breakLine } from "./line-break";
import { layoutRow, type RowCaretStop, type RowGlyphRequest } from "./row-layout";
import { buildWordSources, computeWordMetrics, isWhitespaceText, type WordSource } from "./word-metrics";

export type SongWidthPolicy = "FIT_PAGE" | "FIT_WIDTH" | "PRINT";

export interface SongLayoutOptions {
  readonly tagWidths: ReadonlyMap<string, number>;
  readonly overlayRevMoveCost: number;
  readonly overlayFwdMoveCost: number;
  readonly moveChordsOnly?: boolean;
  /**
   * Measured ABC block heights by occurrence id. An occurrence with no entry
   * keeps the pending placeholder height, which is what keeps a song with
   * unrendered ABC unsettled.
   */
  readonly abcHeights?: ReadonlyMap<string, number>;
  /** FIT_PAGE is natural width; FIT_WIDTH/PRINT use the supplied content box. */
  readonly widthPolicy?: SongWidthPolicy;
  readonly contentWidth?: number;
  /**
   * Keep metadata out of the song's natural width, for a host that scales the
   * song to fit a pane. See `DomSongRendererInput.clipMetaToSongWidth`.
   */
  readonly clipMetaToSongWidth?: boolean;
  /** Keep the full editor's title out of the song body's natural width. */
  readonly viewportAlignedTitle?: boolean;
}

export interface LayoutMeta {
  readonly id: string;
  readonly width: number;
  readonly height: number;
}

export interface LayoutLyricRun {
  readonly id: string;
  readonly text: string;
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly sourceStart: number;
  readonly sourceEnd: number;
  readonly beforeStart?: number;
  readonly beforeEnd?: number;
  readonly afterStart?: number;
  readonly afterEnd?: number;
  readonly change: "equal" | "added" | "removed";
}

export interface LayoutChord {
  readonly id: string;
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly occupiedWidth: number;
  readonly sourceOffset: number;
  readonly previousSourceOffset?: number;
  readonly beforeStart?: number;
  readonly beforeEnd?: number;
  readonly afterStart?: number;
  readonly afterEnd?: number;
  readonly change: "equal" | "added" | "removed" | "moved";
}

export interface LayoutRow {
  readonly id: string;
  readonly width: number;
  readonly height: number;
  readonly lyricsY: number;
  readonly lyricRuns: readonly LayoutLyricRun[];
  readonly chords: readonly LayoutChord[];
  readonly caretStops: readonly RowCaretStop[];
  readonly occupiedBounds: { readonly left: number; readonly right: number };
}

export interface LayoutOccurrence {
  readonly id: string;
  readonly source: DisplayOccurrence;
  readonly height: number;
  readonly contentWidth: number;
  readonly tagWidth: number;
  readonly tagSeparation: number;
  readonly rows?: readonly LayoutRow[];
  readonly blockWidth?: number;
  readonly blockHeight?: number;
}

export interface SongLayoutResult {
  readonly pending: boolean;
  readonly width: number;
  readonly height: number;
  /** Content-column width used to align rows after tag lane/gap subtraction. */
  readonly bodyWidth: number;
  readonly tagLaneWidth: number;
  readonly tagGap: number;
  readonly meta: readonly LayoutMeta[];
  readonly occurrences: readonly LayoutOccurrence[];
}

type GlyphIdentity = { readonly type: "lyric" | "chord"; readonly id: string };

function resultMap(measurer: TextMeasurer, requests: readonly MeasurementRequest[]) {
  return new Map(measurer.measure(requests).map((result) => [result.id, result.size] as const));
}

function measurementRequests(plan: DisplayPlan): MeasurementRequest[] {
  const requests: MeasurementRequest[] = [];
  for (const meta of plan.meta) requests.push({ id: `${meta.id}:text`, text: meta.text, role: "lyric", font: meta.font });
  for (const occurrence of plan.occurrences) {
    if (occurrence.kind === "lyrics") {
      for (const unit of occurrence.textUnits)
        requests.push({
          id: `${occurrence.id}:u${unit.sourceStart}-${unit.sourceEnd}`,
          text: unit.text,
          role: "lyric",
          font: occurrence.style.font,
        });
      for (const chord of occurrence.chords)
        chord.visual.tokens.forEach((token, index) =>
          requests.push({
            id: `${chord.id}:token:${index}`,
            text: token.text,
            role: token.role,
            font: plan.display.chordFont,
            chordFormat: plan.chordFormat,
            noteSystemCode: plan.noteSystemCode,
            key: plan.key,
          })
        );
    } else if (occurrence.kind === "grid") {
      for (const run of occurrence.gridRuns) {
        if (run.kind === "text") requests.push({ id: run.id, text: run.text, role: "lyric", font: occurrence.style.font });
        else
          run.visual.tokens.forEach((token, index) =>
            requests.push({
              id: `${run.id}:token:${index}`,
              text: token.text,
              role: token.role,
              font: plan.display.chordFont,
              chordFormat: plan.chordFormat,
              noteSystemCode: plan.noteSystemCode,
              key: plan.key,
            })
          );
      }
    } else if (occurrence.kind !== "abc") {
      requests.push({ id: `${occurrence.id}:block`, text: occurrence.text, role: "lyric", font: occurrence.style.font });
    }
  }
  return requests;
}

function lineTagWidth(occurrence: DisplayOccurrence, tagWidths: ReadonlyMap<string, number>) {
  return occurrence.tag?.visible ? (tagWidths.get(occurrence.id) ?? 0) : 0;
}

function layoutLyrics(
  plan: DisplayPlan,
  occurrence: DisplayOccurrence,
  measured: ReadonlyMap<string, { width: number; height: number }>,
  options: SongLayoutOptions,
  measure: number
): { readonly pending: boolean; readonly rows: readonly LayoutRow[] } {
  const chordWidths = new Map<string, number>();
  for (const chord of occurrence.chords) {
    let width = 2 * plan.display.chordBorder;
    chord.visual.tokens.forEach((token, tokenIndex) => {
      width += token.gapBefore + (measured.get(`${chord.id}:token:${tokenIndex}`)?.width ?? 0);
    });
    chordWidths.set(chord.id, width);
  }

  const sources = buildWordSources(
    occurrence.text,
    (unit) => {
      const id = `${occurrence.id}:u${unit.sourceStart}-${unit.sourceEnd}`;
      return { id, width: measured.get(id)?.width ?? 0 };
    },
    occurrence.chords.map((chord) => ({ id: chord.id, anchor: chord.anchor, width: chordWidths.get(chord.id) ?? 0 })),
    undefined,
    occurrence.textUnits
  );
  const words = sources.map((source) => ({ source, metrics: computeWordMetrics(source) }));
  const broken = breakLine(words, measure);
  if (broken.pending) return { pending: true, rows: [] };

  const rows = broken.rows.map((span, rowIndex) => {
    const rowWords = span.lastWord < span.firstWord ? [] : sources.slice(span.firstWord, span.lastWord + 1);
    const glyphs: RowGlyphRequest<GlyphIdentity>[] = [];
    let naturalWordStart = occurrence.style.indent;

    for (const word of rowWords) {
      const pending: Array<{ readonly naturalOffset: number; readonly chordOrder: number; readonly glyph: RowGlyphRequest<GlyphIdentity> }> = [];
      let unitOffset = 0;
      word.units.forEach((unit, unitOrder) => {
        const simple = simplifyString(unit.text);
        pending.push({
          naturalOffset: unitOffset,
          chordOrder: occurrence.chords.length + unitOrder,
          glyph: {
            id: { type: "lyric", id: unit.id },
            kind: "lyric",
            text: unit.text,
            width: unit.width,
            naturalPos: naturalWordStart + unitOffset,
            sourceStart: unit.sourceStart,
            sourceEnd: unit.sourceEnd,
            expandCost: !simple ? 0 : isVowel(unit.text) ? 1 : -1,
          },
        });
        unitOffset += unit.width;
      });
      word.chords.forEach((bound, chordOrder) => {
        let naturalOffset = 0;
        const absoluteAnchor = word.sourceStart + bound.anchorOffset;
        for (const unit of word.units) {
          if (unit.sourceEnd > absoluteAnchor) break;
          naturalOffset += unit.width;
        }
        const chord = occurrence.chords.find((candidate) => candidate.id === bound.id);
        pending.push({
          naturalOffset,
          chordOrder,
          glyph: {
            id: { type: "chord", id: bound.id },
            kind: "chord",
            text: chord?.source.text ?? "",
            width: bound.width,
            naturalPos: naturalWordStart + naturalOffset,
            sourceStart: bound.sourceOffset,
            sourceEnd: bound.sourceOffset,
          },
        });
      });
      pending.sort((a, b) => a.naturalOffset - b.naturalOffset || a.chordOrder - b.chordOrder);
      glyphs.push(...pending.map((entry) => entry.glyph));
      naturalWordStart += word.units.reduce((total, unit) => total + unit.width, 0);
    }

    // The whole-row engine is called exactly once for this FINAL row. It is
    // never consulted by word measurement or break-candidate scoring.
    const result = layoutRow(glyphs, {
      left: occurrence.style.indent,
      overlayRevMoveCost: options.overlayRevMoveCost,
      overlayFwdMoveCost: options.overlayFwdMoveCost,
      moveChordsOnly: options.moveChordsOnly,
    });
    const rowChordIds = new Set(rowWords.flatMap((word) => word.chords.map((chord) => chord.id)));
    const hasChords = rowChordIds.size > 0;
    // The canvas reserves the chord line plus its borders in the row height.
    // `chordLyricSep` participates in its baseline placement, not an additional
    // row band; adding it here made DOM lyrics drift lower on every chord line.
    const chordBandHeight = hasChords ? plan.display.chordLineHeight + 2 * plan.display.chordBorder : 0;
    const height = chordBandHeight + plan.display.lyricsLineHeight;
    const lyricRuns: LayoutLyricRun[] = [];
    const chords: LayoutChord[] = [];
    const unitsBySource = new Map(occurrence.textUnits.map((unit) => [`${unit.sourceStart}:${unit.sourceEnd}`, unit] as const));
    for (const item of result.items) {
      if (item.id.type === "lyric") {
        const unit = unitsBySource.get(`${item.sourceStart}:${item.sourceEnd}`);
        lyricRuns.push({
          id: item.id.id,
          text: item.text,
          x: item.pos,
          y: chordBandHeight,
          width: item.width,
          sourceStart: item.sourceStart,
          sourceEnd: item.sourceEnd,
          ...(unit?.beforeStart != null ? { beforeStart: unit.beforeStart, beforeEnd: unit.beforeEnd } : {}),
          ...(unit?.afterStart != null ? { afterStart: unit.afterStart, afterEnd: unit.afterEnd } : {}),
          change: unit?.change ?? "equal",
        });
      } else {
        const chord = occurrence.chords.find((candidate) => candidate.id === item.id.id);
        const occupiedWidth = item.width;
        chords.push({
          id: item.id.id,
          x: item.pos,
          y: 0,
          width: Math.max(0, occupiedWidth - 2 * plan.display.chordBorder),
          occupiedWidth,
          sourceOffset: chord?.anchor ?? item.sourceStart,
          ...(chord?.previousAnchor != null ? { previousSourceOffset: chord.previousAnchor } : {}),
          ...(chord?.beforeStart != null ? { beforeStart: chord.beforeStart, beforeEnd: chord.beforeEnd } : {}),
          ...(chord?.afterStart != null ? { afterStart: chord.afterStart, afterEnd: chord.afterEnd } : {}),
          change: chord?.change ?? "equal",
        });
      }
    }

    let rowRight = result.occupiedBounds.right;
    const lastWord = rowWords[rowWords.length - 1] as WordSource<string, string> | undefined;
    const hasVisibleLyric = lastWord?.units.some((unit) => !isWhitespaceText(unit.text));
    if (Number.isFinite(measure) && lastWord && hasVisibleLyric) {
      const trailingIds = new Set(lastWord.units.filter((unit) => unit.sourceStart >= lastWord.trimmedSourceEnd).map((unit) => unit.id));
      rowRight = occurrence.style.indent;
      for (const item of result.items)
        if (item.id.type === "chord" || !trailingIds.has(item.id.id)) rowRight = Math.max(rowRight, item.pos + item.width);
    }
    return {
      id: `${occurrence.id}:row:${rowIndex}`,
      width: Math.max(occurrence.style.indent, rowRight),
      height,
      lyricsY: chordBandHeight,
      lyricRuns,
      chords,
      caretStops: result.caretStops,
      occupiedBounds: result.occupiedBounds,
    };
  });
  return { pending: false, rows };
}

/** Natural-width FIT_PAGE layout. It is pure and performs no DOM access. */
export function layoutSong(plan: DisplayPlan, measurer: TextMeasurer, options: SongLayoutOptions): SongLayoutResult {
  const measured = resultMap(measurer, measurementRequests(plan));
  const widthPolicy = options.widthPolicy ?? "FIT_PAGE";
  const constrainedWidth = widthPolicy === "FIT_PAGE" ? Number.POSITIVE_INFINITY : (options.contentWidth ?? 0);
  const tagLaneWidth = plan.showTags
    ? plan.occurrences.reduce((maximum, occurrence) => Math.max(maximum, lineTagWidth(occurrence, options.tagWidths)), 0)
    : 0;
  const tagGap = tagLaneWidth > 0 ? 2 * plan.display.lyricsLineHeight : 0;
  const meta: LayoutMeta[] = [];
  let metaHeight = 0;
  let maximumWidth = Number.isFinite(constrainedWidth) && constrainedWidth > 0 ? constrainedWidth : 2 * plan.display.horizontalMargin;
  // For a pane-fitted host, metadata reserves VERTICAL space only: the row is
  // clipped to the song's own content width and ellipsised rather than
  // widening the song, because the natural width is what the host scales by
  // — a long title otherwise shrinks the whole song to fit itself. Hosts that
  // render at natural size keep sizing to their metadata and let it overflow.
  // The second term guards a song with no body, which has nothing to clip
  // against.
  const metaDrivesWidth = !options.clipMetaToSongWidth || plan.occurrences.length === 0;
  for (const entry of plan.meta) {
    const size = measured.get(`${entry.id}:text`) ?? { width: 0, height: 0 };
    const width = entry.indent + size.width;
    meta.push({ id: entry.id, width, height: entry.height });
    metaHeight += entry.height;
    const viewportTitle = options.viewportAlignedTitle && !options.clipMetaToSongWidth && entry.name === "title";
    if (metaDrivesWidth && !viewportTitle) maximumWidth = Math.max(maximumWidth, 2 * plan.display.horizontalMargin + width);
  }

  const occurrences: LayoutOccurrence[] = [];
  let bodyHeight = 0;
  let pending = false;
  const bodyMeasure = constrainedWidth - 2 * plan.display.horizontalMargin - tagLaneWidth - tagGap;
  for (const occurrence of plan.occurrences) {
    const tagWidth = lineTagWidth(occurrence, options.tagWidths);
    const noChordSeparation = (plan.chordFormat & CHORDFORMAT_NOCHORDS) === CHORDFORMAT_NOCHORDS ? Math.max(2, plan.display.chordLineHeight / 2) : 0;
    const tagSeparation = (occurrence.tag?.visible ? 10 : 0) + noChordSeparation;
    if (occurrence.kind === "lyrics") {
      const lyricLayout = layoutLyrics(plan, occurrence, measured, options, bodyMeasure - occurrence.style.indent);
      pending ||= lyricLayout.pending;
      const rowsHeight = lyricLayout.rows.reduce((total, row) => total + row.height, 0);
      const contentWidth = lyricLayout.rows.reduce((maximum, row) => Math.max(maximum, row.width), occurrence.style.indent);
      const height = tagSeparation + rowsHeight;
      occurrences.push({ id: occurrence.id, source: occurrence, height, contentWidth, tagWidth, tagSeparation, rows: lyricLayout.rows });
      bodyHeight += height;
      maximumWidth = Math.max(maximumWidth, 2 * plan.display.horizontalMargin + tagLaneWidth + tagGap + contentWidth);
      continue;
    }

    const blockSize =
      occurrence.kind === "grid"
        ? occurrence.gridRuns.reduce(
            (size, run) => {
              if (run.kind === "text") {
                const measuredRun = measured.get(run.id) ?? { width: 0, height: 0 };
                size.width += measuredRun.width;
                size.height = Math.max(size.height, measuredRun.height);
              } else {
                let width = 0;
                let height = 0;
                run.visual.tokens.forEach((token, index) => {
                  const measuredToken = measured.get(`${run.id}:token:${index}`) ?? { width: 0, height: 0 };
                  width += token.gapBefore + measuredToken.width;
                  height = Math.max(height, measuredToken.height);
                });
                size.width += width;
                size.height = Math.max(size.height, height);
              }
              return size;
            },
            { width: 0, height: 0 }
          )
        : (measured.get(`${occurrence.id}:block`) ?? { width: 0, height: 0 });
    const extraCommentHeight = occurrence.kind === "comment" ? plan.display.chordLineHeight / 2 : 0;
    const measuredAbcHeight = occurrence.kind === "abc" ? options.abcHeights?.get(occurrence.id) : undefined;
    const blockHeight =
      occurrence.kind === "abc"
        ? (measuredAbcHeight ?? Math.max(plan.display.lyricsLineHeight, 2 * plan.display.chordLineHeight))
        : Math.max(plan.display.lyricsLineHeight, blockSize.height) + extraCommentHeight;
    const blockWidth = occurrence.style.indent + blockSize.width;
    const height = tagSeparation + blockHeight;
    occurrences.push({ id: occurrence.id, source: occurrence, height, contentWidth: blockWidth, tagWidth, tagSeparation, blockWidth, blockHeight });
    bodyHeight += height;
    maximumWidth = Math.max(maximumWidth, 2 * plan.display.horizontalMargin + tagLaneWidth + tagGap + blockWidth);
  }

  const width = Math.max(1, Math.ceil(maximumWidth));
  return {
    pending,
    width,
    height: Math.max(1, Math.ceil(2 * plan.display.verticalMargin + metaHeight + bodyHeight)),
    bodyWidth: Number.isFinite(bodyMeasure)
      ? Math.max(0, bodyMeasure)
      : Math.max(0, width - 2 * plan.display.horizontalMargin - tagLaneWidth - tagGap),
    tagLaneWidth,
    tagGap,
    meta,
    occurrences,
  };
}
