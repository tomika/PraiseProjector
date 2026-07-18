import type { ChordProChord, ChordProLine } from "../chordpro_base";
import type { RowCaretStop } from "../layout/row-layout";
import type { SongLayoutResult } from "../layout/song-layout";
import { isHighlightedOccurrence, type DisplayHighlight, type DisplayOccurrence, type DisplayPlan } from "./display-plan";

export interface Point {
  readonly x: number;
  readonly y: number;
}

/** Root-local box of one rendered chord, owned by the renderer. */
export interface ChordGeometry {
  readonly left: number;
  readonly top: number;
  readonly width: number;
  readonly height: number;
  readonly chord: ChordProChord;
}

/** Root-local box of one retained guitar/piano diagram canvas. */
export interface DiagramGeometry {
  readonly left: number;
  readonly top: number;
  readonly width: number;
  readonly height: number;
  readonly chord: string;
}

/**
 * Root-local geometry of one wrapped lyric row, carrying the layout's caret
 * stops. Stops are row-local (the same coordinate space as the row's lyric
 * runs); `left` converts them to root-local x. Every stop is a valid UTF-16
 * visual boundary produced by the centralized visual-unit helper — hit
 * resolution never lands inside a surrogate pair or grapheme cluster.
 */
export interface RowGeometry {
  readonly id: string;
  readonly top: number;
  readonly bottom: number;
  /** Root-local x origin for the row's row-local positions (caret stops, runs). */
  readonly left: number;
  /** Root-local top of the lyric band (the row's chord band precedes it). */
  readonly lyricsTop: number;
  readonly lyricsHeight: number;
  readonly caretStops: readonly RowCaretStop[];
}

/**
 * Root-local box of one rendered section label. Present only where the label is
 * actually painted — the first occurrence of a tag change (`DisplayTag.visible`).
 */
export interface TagGeometry {
  readonly left: number;
  readonly top: number;
  readonly width: number;
  readonly height: number;
  readonly name: string;
  readonly text: string;
}

/**
 * Root-local vertical extent of one displayed occurrence, owned by the
 * renderer instead of being written back onto the song model.
 */
export interface OccurrenceGeometry {
  readonly id: string;
  readonly occurrence: DisplayOccurrence;
  readonly top: number;
  readonly bottom: number;
  /** Root-local x of the occurrence's content, after the margin and tag lane. */
  readonly contentLeft: number;
  readonly contentRight: number;
  /** Present for lyric occurrences only; block occurrences have no caret rows. */
  readonly rows?: readonly RowGeometry[];
  /** Present only where the section label renders. */
  readonly tag?: TagGeometry;
}

export interface SongGeometryIndex {
  readonly occurrences: readonly OccurrenceGeometry[];
  /** Every rendered chord's box, in document order. */
  readonly chords: readonly ChordGeometry[];
  /** Diagram canvases, attached by the renderer after it places them. */
  readonly diagrams: readonly DiagramGeometry[];
  /**
   * Root-local x boundary of the tag column. A readonly pointer completion left
   * of this selects the whole tagged section, mirroring `ChordProEditor.tagWidth`.
   */
  readonly tagBoundary: number;
  /** Root-local x where highlight bands start, and the song's rightmost content edge. */
  readonly highlightLeft: number;
  readonly songMaxRight: number;
  readonly highlightPadding: number;
  /**
   * Width of the chord-template strip gutter. A drag released left of it is a
   * no-drop (the chord returns to the strip).
   */
  readonly stripWidth: number;
  readonly width: number;
  readonly height: number;
}

/**
 * Builds the renderer-owned geometry index from a committed plan/layout pair.
 *
 * Coordinates are root-local logical pixels: the root's vertical margin and the
 * metadata block precede the body, and each occurrence stacks by its layout
 * height in document order.
 *
 * `leftOffset` is the renderer-owned chord-template strip gutter, which shifts
 * the whole song right. The canvas did the same by passing
 * `horizontalMargin + chordStripWidth` as `_drawSongOnly`'s left margin; the
 * pure layout stays strip-unaware either way.
 */
export function buildGeometryIndex(plan: DisplayPlan, layout: SongLayoutResult, leftOffset = 0): SongGeometryIndex {
  const metaHeight = layout.meta.reduce((total, entry) => total + entry.height, 0);
  const contentLeft = leftOffset + plan.display.horizontalMargin + layout.tagLaneWidth + layout.tagGap;
  const occurrences: OccurrenceGeometry[] = [];
  const chords: ChordGeometry[] = [];
  let y = plan.display.verticalMargin + metaHeight;
  let songMaxRight = contentLeft;

  for (const entry of layout.occurrences) {
    const top = y;
    const bottom = y + entry.height;
    const contentRight = contentLeft + entry.contentWidth;
    songMaxRight = Math.max(songMaxRight, contentRight);

    // Chord boxes: each starts one `chordBorder` LEFT of the drawn text and is
    // `2 * chordBorder` wider and
    // taller than the chord line. `LayoutChord.x` is already that outer edge
    // (the renderer offsets the visible node by `chordBorder`), so the occupied
    // width is the box width. Rows stack inside the line box, which itself
    // starts after the section separation.
    let rowTop = top + entry.tagSeparation;
    const rowGeometry: RowGeometry[] = [];
    for (const row of entry.rows ?? []) {
      const remaining = Math.max(0, layout.bodyWidth - row.width);
      const rowLeft = contentLeft + (entry.source.style.align === "right" ? remaining : entry.source.style.align === "center" ? remaining / 2 : 0);
      rowGeometry.push({
        id: row.id,
        top: rowTop,
        bottom: rowTop + row.height,
        left: rowLeft,
        lyricsTop: rowTop + row.lyricsY,
        lyricsHeight: plan.display.lyricsLineHeight,
        caretStops: row.caretStops ?? [],
      });
      for (const positioned of row.chords) {
        const chord = entry.source.chords.find((candidate) => candidate.id === positioned.id);
        if (!chord) continue;
        chords.push({
          left: rowLeft + positioned.x,
          top: rowTop + positioned.y,
          width: positioned.occupiedWidth,
          height: plan.display.chordLineHeight + 2 * plan.display.chordBorder,
          chord: chord.source,
        });
      }
      rowTop += row.height;
    }
    // The label is right-aligned in the tag lane (CSS `text-align: right` over a
    // fixed lane column) and shares the exact top/line-height of the first
    // row's lyrics.
    const tag =
      plan.showTags && entry.source.tag?.visible
        ? {
            left: leftOffset + plan.display.horizontalMargin + layout.tagLaneWidth - entry.tagWidth,
            top: top + entry.tagSeparation + (entry.rows?.[0]?.lyricsY ?? 0),
            width: entry.tagWidth,
            height: plan.display.lyricsLineHeight,
            name: entry.source.tag.name,
            text: entry.source.tag.text,
          }
        : null;

    occurrences.push({
      id: entry.id,
      occurrence: entry.source,
      top,
      bottom,
      contentLeft,
      contentRight,
      ...(entry.rows ? { rows: rowGeometry } : {}),
      ...(tag ? { tag } : {}),
    });
    y = bottom;
  }

  // The base is computed from `showTags` alone, so a song with no visible tags
  // still reserves the separation gap even though its text starts at the left
  // margin. Deliberate: keeps highlight geometry stable across songs.
  const horizontalSeparation = 2 * plan.display.lyricsLineHeight;
  const baseHighlightLeft = leftOffset + plan.display.horizontalMargin + (plan.showTags ? layout.tagLaneWidth + horizontalSeparation : 0);
  const highlightPadding = Math.max(2, Math.round(plan.display.lyricsLineHeight * 0.2));
  const width = layout.width + leftOffset;

  return {
    occurrences,
    chords,
    diagrams: [],
    tagBoundary: leftOffset + plan.display.horizontalMargin + layout.tagLaneWidth,
    highlightLeft: Math.max(0, Math.min(baseHighlightLeft - highlightPadding, width)),
    songMaxRight,
    highlightPadding,
    stripWidth: leftOffset,
    width,
    height: layout.height,
  };
}

function contains(box: { left: number; top: number; width: number; height: number }, point: Point) {
  return box.left <= point.x && point.x <= box.left + box.width && box.top <= point.y && point.y <= box.top + box.height;
}

/**
 * Resolves the chord under a root-local point.
 */
export function hitTestChord(index: SongGeometryIndex, point: Point): ChordGeometry | null {
  for (const chord of index.chords) if (contains(chord, point)) return chord;
  return null;
}

/** Resolves the diagram canvas under a root-local point. Diagram boxes are
 *  searched BEFORE chords, since they overlay the song. */
export function hitTestDiagram(index: SongGeometryIndex, point: Point): DiagramGeometry | null {
  for (const diagram of index.diagrams) if (contains(diagram, point)) return diagram;
  return null;
}

/**
 * Resolves the section label under a root-local point.
 *
 * `extension` widens the box to the RIGHT, into the tag/lyrics separation gap:
 * a text-tight box would leave the label's trailing caret position unreachable
 * by mouse.
 */
export function hitTestTag(
  index: SongGeometryIndex,
  point: Point,
  extension = 0
): (TagGeometry & { readonly occurrence: OccurrenceGeometry }) | null {
  for (const entry of index.occurrences) {
    const tag = entry.tag;
    if (!tag) continue;
    if (contains({ ...tag, width: tag.width + extension }, point)) return { ...tag, occurrence: entry };
  }
  return null;
}

/**
 * Root-local caret/selection box inside a chord's RAW text.
 *
 * `prefixWidth`/`spanWidth` are measured by the caller in the chord font
 * (measurement stays out of this module). Known quirk: the visible chord is the
 * FORMATTED token run, while the caret is placed by measuring the raw
 * `chord.text` prefix — so a known, reformatted chord's caret only approximates
 * its glyphs. An unknown chord (the state while typing) renders its raw text,
 * where the two agree exactly.
 */
export function resolveChordTextBox(
  index: SongGeometryIndex,
  chord: ChordProChord,
  prefixWidth: number,
  spanWidth: number,
  chordBorder: number
): { readonly x: number; readonly top: number; readonly width: number; readonly height: number } | null {
  const geometry = index.chords.find((candidate) => candidate.chord === chord);
  if (!geometry) return null;
  // `ChordGeometry.left/top` is the OUTER hit box; the drawn text starts one
  // chord border inside it, which is where the caret is measured from.
  return {
    x: geometry.left + chordBorder + prefixWidth,
    top: geometry.top + chordBorder,
    width: spanWidth,
    height: geometry.height - 2 * chordBorder,
  };
}

/** Root-local caret/selection box inside a section label's text. */
export function resolveTagTextBox(
  index: SongGeometryIndex,
  line: ChordProLine,
  prefixWidth: number,
  spanWidth: number
): { readonly x: number; readonly top: number; readonly width: number; readonly height: number } | null {
  const entry = index.occurrences.find(
    (candidate) => candidate.tag && (candidate.occurrence.source === line || candidate.occurrence.origin === line)
  );
  if (!entry?.tag) return null;
  return { x: entry.tag.left + prefixWidth, top: entry.tag.top, width: spanWidth, height: entry.tag.height };
}

/**
 * Converts client coordinates into root-local logical coordinates.
 *
 * The host may be scaled with a CSS `transform` (the client view scales the whole
 * renderer host to fit its pane), so the displayed box is divided out against the
 * logical size the renderer committed onto the root.
 */
export function normalizeClientPoint(root: HTMLElement, clientX: number, clientY: number, logical: { width: number; height: number }): Point {
  const rect = root.getBoundingClientRect();
  const scaleX = rect.width > 0 && logical.width > 0 ? rect.width / logical.width : 1;
  const scaleY = rect.height > 0 && logical.height > 0 ? rect.height / logical.height : 1;
  return {
    x: (clientX - rect.left) / (Number.isFinite(scaleX) && scaleX > 0 ? scaleX : 1),
    y: (clientY - rect.top) / (Number.isFinite(scaleY) && scaleY > 0 ? scaleY : 1),
  };
}

/** Resolves the occurrence under a root-local point, mirroring `HitTestLine`. */
export function hitTestOccurrence(index: SongGeometryIndex, point: Point): OccurrenceGeometry | null {
  for (const entry of index.occurrences) if (entry.top <= point.y && point.y < entry.bottom) return entry;
  return null;
}

/** True when a readonly pointer completion lands in the tag column. */
export function isTagColumnPoint(index: SongGeometryIndex, point: Point) {
  return point.x < index.tagBoundary;
}

/**
 * One valid caret boundary resolved from row geometry — the transitional hit
 * adapter's payload. The editor wraps it in its existing per-character
 * `ChordProLineHitBox` shape, so the gesture pipeline above stays unchanged.
 */
export interface LineCaretHit {
  readonly occurrence: OccurrenceGeometry;
  readonly row: RowGeometry;
  /** UTF-16 offset of the chosen visual boundary within the occurrence text. */
  readonly column: number;
  /** Root-local x of the chosen caret stop. */
  readonly caretX: number;
  /** Legacy hit-cell shape: the chosen stop's cell, or the end-of-line space. */
  readonly cellLeft: number;
  readonly cellWidth: number;
}

/**
 * Resolves a caret placement for a root-local point.
 *
 * - the cell CONTAINING the point selects that glyph's leading boundary;
 * - beyond the last glyph the end-of-line space selects the trailing boundary;
 * - a blank row has exactly one stop, so its whole space selects offset 0;
 * - space above/below the wrapped rows and left of the first stop clamps to
 *   the nearest row/boundary instead of dead-zoning.
 * Every returned column is a valid UTF-16 visual boundary by construction.
 */
export function resolveLineCaretHit(index: SongGeometryIndex, point: Point): LineCaretHit | null {
  const occurrence = hitTestOccurrence(index, point);
  if (!occurrence?.rows || occurrence.rows.length === 0) return null;
  let row = occurrence.rows[occurrence.rows.length - 1];
  for (const candidate of occurrence.rows) {
    if (point.y < candidate.bottom) {
      row = candidate;
      break;
    }
  }
  const stops = row.caretStops;
  if (stops.length === 0) return null;
  let chosen = stops[0];
  let next: RowCaretStop | null = stops.length > 1 ? stops[1] : null;
  for (let i = stops.length - 1; i >= 0; --i) {
    if (row.left + stops[i].pos <= point.x) {
      chosen = stops[i];
      next = i + 1 < stops.length ? stops[i + 1] : null;
      break;
    }
  }
  const cellLeft = row.left + chosen.pos;
  const cellWidth = next ? row.left + next.pos - cellLeft : Math.max(1, index.width - cellLeft);
  return { occurrence, row, column: chosen.sourceOffset, caretX: cellLeft, cellLeft, cellWidth };
}

/**
 * One legal drop stop for a dragged chord: a caret boundary of the candidate
 * line, in root-local coordinates.
 *
 * `width` is the per-character hit box width; the LAST stop of a line is its
 * end-of-line box spanning to the surface edge — hence `width` reaching
 * `SongGeometryIndex.width` there.
 */
export interface ChordDropStop {
  readonly left: number;
  readonly width: number;
  readonly column: number;
}

/** One candidate line for a chord drop, with its root-local vertical band. */
export interface ChordDropLine {
  readonly line: ChordProLine;
  readonly top: number;
  readonly bottom: number;
  /** Root-local top of the line's lyric band — the drop marker's vertical anchor. */
  readonly lyricsTop: number;
  readonly isInstrumental: boolean;
  readonly stops: readonly ChordDropStop[];
}

export interface ChordDropTarget {
  readonly line: ChordProLine;
  /** UTF-16 column the dragged chord anchors to. */
  readonly column: number;
  /** Root-local x of the chosen stop — where the drop marker points. */
  readonly markerX: number;
  /** Root-local top of the target line's lyric band. */
  readonly lyricsTop: number;
}

/**
 * Resolves where a dragged chord would land, from geometry alone. The
 * controller calls this from explicit pointer handling and applies the
 * mutation itself; rendering only draws the ghost and the marker.
 *
 * - the drag stays on the chord's current line until the ghost's TOP passes the
 *   midpoint between the previous and current line tops (moving up) or the
 *   current line's bottom (moving down); only then is another line searched;
 * - within the target line the nearest stop by |stop.left - ghostLeft| wins;
 * - the end-of-line stop's RIGHT edge is considered last and, when nearer,
 *   yields `column + 1` (the trailing hit box);
 * - stops are scoped to the TARGET line only, so dropping a chord onto an
 *   empty line never takes a column from an unrelated earlier line.
 */
export function resolveChordDropTarget(
  lines: readonly ChordDropLine[],
  currentLine: ChordProLine,
  ghost: Point,
  farLimit: number
): ChordDropTarget | null {
  const current = lines.findIndex((candidate) => candidate.line === currentLine);
  if (current < 0 || lines[current].isInstrumental) return null;

  let targetIndex = current;
  const leftUpwards = current > 0 && ghost.y < (lines[current - 1].top + lines[current].top) / 2;
  const leftDownwards = ghost.y > lines[current].bottom;
  if (leftUpwards || leftDownwards) {
    for (let i = 0; i < lines.length; ++i) {
      if (i === current) continue;
      if (lines[i].top < ghost.y && ghost.y <= lines[i].bottom) {
        targetIndex = i;
        break;
      }
    }
  }

  const target = lines[targetIndex];
  if (target.isInstrumental || target.stops.length === 0) return null;

  let minDiff = farLimit;
  let column = -1;
  let markerX = 0;
  for (const stop of target.stops) {
    const diff = Math.abs(stop.left - ghost.x);
    if (diff < minDiff) {
      minDiff = diff;
      column = stop.column;
      markerX = stop.left;
    }
  }
  const last = target.stops[target.stops.length - 1];
  if (Math.abs(last.left + last.width - ghost.x) < minDiff) {
    column = last.column + 1;
    markerX = last.left + last.width;
  }
  if (column < 0) return null;
  return { line: target.line, column, markerX, lyricsTop: target.lyricsTop };
}

/**
 * Builds the drop candidates for the DOM backend from the renderer's geometry.
 *
 * A wrapped line contributes every row's stops. Row-local stop positions
 * become root-local here.
 */
export function buildChordDropLines(index: SongGeometryIndex): ChordDropLine[] {
  const lines: ChordDropLine[] = [];
  for (const entry of index.occurrences) {
    const line = entry.occurrence.origin ?? entry.occurrence.source;
    const stops: ChordDropStop[] = [];
    for (const row of entry.rows ?? []) {
      for (let i = 0; i < row.caretStops.length; ++i) {
        const left = row.left + row.caretStops[i].pos;
        const next = row.caretStops[i + 1];
        stops.push({
          left,
          // The end-of-line stop spans to the surface edge.
          width: next ? row.left + next.pos - left : Math.max(1, index.width - left),
          column: row.caretStops[i].sourceOffset,
        });
      }
    }
    lines.push({
      line,
      top: entry.top,
      bottom: entry.bottom,
      lyricsTop: entry.rows?.[0]?.lyricsTop ?? entry.top,
      isInstrumental: entry.occurrence.source.isInstrumental,
      stops,
    });
  }
  return lines;
}

export interface CaretGeometry {
  readonly x: number;
  readonly top: number;
  readonly height: number;
  readonly rowId: string;
}

/**
 * Root-local caret box for a (line, UTF-16 column) pair, or null when the line
 * has no displayed rows. The line resolves by object identity.
 * Wrapped rows share their boundary offset; the caret shows at the START of the
 * continuation row. A column that is not itself a valid visual boundary (the
 * legacy arrow keys step by UTF-16 code unit, so it can sit mid-surrogate)
 * clamps to the nearest boundary at or before it for display.
 */
export function resolveCaretGeometry(index: SongGeometryIndex, line: ChordProLine, column: number): CaretGeometry | null {
  const entry = index.occurrences.find((candidate) => candidate.occurrence.source === line || candidate.occurrence.origin === line);
  if (!entry?.rows || entry.rows.length === 0) return null;
  let row = entry.rows[0];
  for (const candidate of entry.rows) {
    const first = candidate.caretStops[0];
    if (first && first.sourceOffset <= column) row = candidate;
  }
  const stops = row.caretStops;
  if (stops.length === 0) return null;
  let chosen = stops[0];
  for (const stop of stops) if (stop.sourceOffset <= column) chosen = stop;
  return { x: row.left + chosen.pos, top: row.lyricsTop, height: row.lyricsHeight, rowId: row.id };
}

export interface SelectionSpan {
  readonly start: number;
  readonly end: number;
}

export interface EditingSelectionRange {
  readonly startLine: ChordProLine;
  readonly startColumn: number;
  readonly endLine: ChordProLine;
  readonly endColumn: number;
}

/**
 * Per-occurrence selected UTF-16 spans for a document-ordered selection. Lines
 * resolve by object identity, never by mutable index. Only lyric glyph cells
 * paint, so a fully selected middle line spans its text exactly — no synthetic
 * end-of-line cell is added.
 */
export function computeSelectionSpans(
  occurrences: readonly Pick<DisplayOccurrence, "id" | "source" | "origin" | "kind" | "text">[],
  selection: EditingSelectionRange
): Map<string, SelectionSpan> {
  const spans = new Map<string, SelectionSpan>();
  const matches = (occurrence: Pick<DisplayOccurrence, "source" | "origin">, line: ChordProLine) =>
    occurrence.source === line || occurrence.origin === line;
  let inside = false;
  for (const occurrence of occurrences) {
    const isStart = matches(occurrence, selection.startLine);
    const isEnd = matches(occurrence, selection.endLine);
    let span: SelectionSpan | null = null;
    if (isStart && isEnd) span = { start: selection.startColumn, end: selection.endColumn };
    else if (isStart) span = { start: selection.startColumn, end: occurrence.text.length };
    else if (isEnd) span = { start: 0, end: selection.endColumn };
    else if (inside) span = { start: 0, end: occurrence.text.length };
    if (isStart) inside = !isEnd;
    else if (isEnd) inside = false;
    if (span && span.end > span.start && occurrence.kind === "lyrics") spans.set(occurrence.id, span);
  }
  return spans;
}

export interface SelectionBand {
  readonly left: number;
  readonly width: number;
}

/**
 * Merged row-local horizontal bands over the lyric runs a selection span
 * intersects. Only glyph cells paint, and an LP-inserted gap between words
 * breaks the band.
 */
export function computeRowSelectionBands(
  runs: readonly { readonly x: number; readonly width: number; readonly sourceStart: number; readonly sourceEnd: number }[],
  span: SelectionSpan
): SelectionBand[] {
  const bands: { left: number; width: number }[] = [];
  for (const run of runs) {
    if (run.sourceEnd <= span.start || run.sourceStart >= span.end) continue;
    const last = bands[bands.length - 1];
    if (last && Math.abs(last.left + last.width - run.x) < 0.5) last.width = run.x + run.width - last.left;
    else bands.push({ left: run.x, width: run.width });
  }
  return bands;
}

/** One merged, root-local highlight band covering adjacent highlighted rows. */
export interface HighlightBand {
  readonly top: number;
  readonly bottom: number;
  readonly radius: number;
}

export interface HighlightDecoration {
  readonly left: number;
  readonly width: number;
  readonly bands: readonly HighlightBand[];
  readonly opacity: number;
  /** Repeat-segment mode: the whole band is faded and the active segment solid. */
  readonly segment: { readonly index: number; readonly total: number } | null;
}

/**
 * Computes the highlight decoration geometry. Adjacent highlighted line ranges are merged,
 * the band spans from the tag column to the song's widest content edge, and a
 * repeated section renders a faded full band plus one solid active segment.
 */
export function computeHighlightDecoration(
  index: SongGeometryIndex,
  highlight: DisplayHighlight | null,
  groups: readonly number[] | undefined,
  highlightOpacity: number
): HighlightDecoration | null {
  const opacity = Math.max(0, Math.min(1, highlightOpacity));
  if (!highlight || opacity <= 0) return null;

  const ranges = index.occurrences
    .filter((entry) => isHighlightedOccurrence(entry.occurrence, highlight, groups))
    .map((entry) => ({ top: entry.top, bottom: entry.bottom }));
  if (ranges.length === 0) return null;

  const right = Math.max(index.highlightLeft + 1, Math.min(index.width, index.songMaxRight + index.highlightPadding));
  const width = right - index.highlightLeft;
  if (width <= 0) return null;

  const merged: { top: number; bottom: number }[] = [];
  for (const range of ranges.sort((a, b) => a.top - b.top)) {
    const last = merged[merged.length - 1];
    if (!last || range.top > last.bottom + 0.5) merged.push({ ...range });
    else last.bottom = Math.max(last.bottom, range.bottom);
  }

  const bands: HighlightBand[] = [];
  for (const band of merged) {
    const height = Math.max(0, band.bottom - band.top);
    if (height <= 0) continue;
    bands.push({ top: band.top, bottom: band.bottom, radius: Math.max(2, Math.min(10, height * 0.35, width * 0.2)) });
  }
  if (bands.length === 0) return null;

  const total = highlight.repeatTotal ?? 1;
  const activeIndex = highlight.repeatIndex ?? 1;
  const segmentMode = total > 1 && activeIndex > 0;
  return {
    left: index.highlightLeft,
    width,
    bands,
    opacity,
    segment: segmentMode ? { index: activeIndex, total } : null,
  };
}
