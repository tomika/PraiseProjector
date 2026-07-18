/**
 * Pure, render-neutral whole-row LP glyph/chord placement.
 *
 * Extracted from the `if (!line_obj.posCache)` block of
 * `ChordProEditor._drawSongOnly` (public/chordpro/chordpro_editor.ts). The
 * grouping algorithm below (which glyphs share one LP "item") and the
 * `calcBestPositions` call are preserved byte-for-byte in behavior; only the
 * surrounding shape is new. This module has no DOM globals, does not import
 * from chordpro_editor.ts, and never reads/writes a `ChordProLine`: callers
 * pre-measure every glyph and supply a stable identity plus UTF-16 source
 * span, and this module returns positioned results by that same identity —
 * it never renumbers and never invents padding.
 */
import { calcBestPositions, ItemToPosition } from "../placer";

export type RowGlyphKind = "lyric" | "chord";

interface RowGlyphRequestBase<Id> {
  /** Caller-supplied stable identity. Never recomputed or reassigned by this module. */
  readonly id: Id;
  /** Opaque display text for this glyph (a single lyric visual unit, or a chord's label). */
  readonly text: string;
  /** Pre-measured width. For a chord, the caller has already added any occupied-width padding. */
  readonly width: number;
  /** The caller's natural/default x position for this glyph before LP adjustment. */
  readonly naturalPos: number;
  /** UTF-16 offset where this glyph's source text begins. */
  readonly sourceStart: number;
  /** UTF-16 offset where this glyph's source text ends. */
  readonly sourceEnd: number;
}

export type RowGlyphRequest<Id> =
  | (RowGlyphRequestBase<Id> & {
      readonly kind: "lyric";
      /** Stretch/shrink cost: 0 = neutral, >0 = vowel-like (always starts a fresh LP item), <0 = rigid (merges with neighbors). */
      readonly expandCost: number;
    })
  | (RowGlyphRequestBase<Id> & { readonly kind: "chord" });

export interface RowLayoutOptions {
  /** Row-left anchor; matches the `left` argument to `calcBestPositions`. */
  readonly left: number;
  readonly overlayRevMoveCost: number;
  readonly overlayFwdMoveCost: number;
  readonly moveChordsOnly?: boolean;
}

export interface PositionedRowGlyph<Id> {
  readonly id: Id;
  readonly kind: RowGlyphKind;
  readonly text: string;
  readonly pos: number;
  readonly width: number;
  readonly sourceStart: number;
  readonly sourceEnd: number;
}

/** A legal caret boundary: before the first lyric glyph, between two lyric glyphs, or after the last one. */
export interface RowCaretStop {
  readonly pos: number;
  readonly sourceOffset: number;
}

export interface RowLayoutResult<Id> {
  /** Positioned glyphs (lyric and chord), in original source order, by identity. */
  readonly items: PositionedRowGlyph<Id>[];
  /** N+1 stops for a row with N lyric glyphs; exactly one stop for a row with none. */
  readonly caretStops: RowCaretStop[];
  readonly occupiedBounds: { left: number; right: number };
}

type LpItem<Id> = ItemToPosition & { parts: RowGlyphRequest<Id>[] };

/**
 * Runs the existing whole-row LP placement over pre-measured glyphs. Groups
 * consecutive glyphs into LP items exactly as the original inline
 * `addPosItem` did (never rewrite this grouping without re-verifying the
 * canvas fixture output), calls `calcBestPositions` unchanged, then unpacks
 * final positions back onto each glyph's own identity.
 */
export function layoutRow<Id>(glyphs: readonly RowGlyphRequest<Id>[], options: RowLayoutOptions): RowLayoutResult<Id> {
  const items: LpItem<Id>[] = [];
  let pending: LpItem<Id> | null = null;

  for (const glyph of glyphs) {
    const expandCost = glyph.kind === "chord" ? undefined : glyph.expandCost;
    if (!pending || pending.expandCost !== expandCost || (expandCost ?? 0) > 0) {
      pending = { pos: glyph.naturalPos, width: 0, expandCost, parts: [] };
      items.push(pending);
    }
    pending.width += glyph.width;
    pending.parts.push(glyph);
    if (pending.expandCost === undefined && pending.parts.length > 1) pending.inplaceSize = pending.width - 0.75 * glyph.width;
  }

  calcBestPositions(options.left, items, {
    overlayRevMoveCost: options.overlayRevMoveCost,
    overlayFwdMoveCost: options.overlayFwdMoveCost,
    moveChordsOnly: options.moveChordsOnly,
  });

  const positioned: PositionedRowGlyph<Id>[] = [];
  for (const item of items) {
    let accumulated = 0;
    for (const glyph of item.parts) {
      positioned.push({
        id: glyph.id,
        kind: glyph.kind,
        text: glyph.text,
        pos: item.pos + accumulated,
        width: glyph.width,
        sourceStart: glyph.sourceStart,
        sourceEnd: glyph.sourceEnd,
      });
      accumulated += glyph.width;
    }
  }

  const caretStops: RowCaretStop[] = [];
  const lyrics = positioned.filter((glyph) => glyph.kind === "lyric");
  if (lyrics.length === 0) {
    caretStops.push({ pos: options.left, sourceOffset: 0 });
  } else {
    for (const glyph of lyrics) caretStops.push({ pos: glyph.pos, sourceOffset: glyph.sourceStart });
    const last = lyrics[lyrics.length - 1];
    caretStops.push({ pos: last.pos + last.width, sourceOffset: last.sourceEnd });
  }

  let left = options.left;
  let right = options.left;
  for (const glyph of positioned) {
    if (glyph.pos < left) left = glyph.pos;
    if (glyph.pos + glyph.width > right) right = glyph.pos + glyph.width;
  }

  return { items: positioned, caretStops, occupiedBounds: { left, right } };
}
