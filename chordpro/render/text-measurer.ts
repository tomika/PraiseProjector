/**
 * Measurement seam shared by every rendering backend. A `TextMeasurer` takes
 * a batch of requests and returns their measured sizes in one call, so a
 * layout pass never measures one glyph/chord token at a time. Callers own
 * matching results back to requests via each request's `id`.
 *
 * The production adapter is `DomTextMeasurer` (dom-text-measurer.ts);
 * `CanvasTextMeasurer` here is the headless adapter used by the unit tests.
 */
import type { ChordVisualTokenRole } from "./chord-visual";

export interface MeasurementRequest {
  /** Caller-supplied identity used to match a `MeasurementResult` back to this request. Never recomputed. */
  readonly id: string;
  readonly text: string;
  readonly role: ChordVisualTokenRole | "lyric";
  /** Resolved CSS font shorthand (e.g. canvas `ctx.font` / DOM computed font), exactly as it will be measured with. */
  readonly font: string;
  /** Chord-format bitmask (CHORDFORMAT_* from chord-visual.ts), when measuring a chord token. */
  readonly chordFormat?: number;
  readonly noteSystemCode?: string;
  /** Active song key, when relevant (INKEY note-name spelling can change a glyph's text/width). */
  readonly key?: string;
}

export interface MeasuredSize {
  readonly width: number;
  readonly height: number;
}

export interface MeasurementResult {
  readonly id: string;
  readonly size: MeasuredSize;
}

/**
 * A `TextMeasurer` is only ever consulted for its current `styleRevision` at
 * the moment `measure` is called; there is no separate "subscribe to
 * changes" contract here. `styleRevision` is monotonically increasing:
 * bumping it must invalidate every measurement cached under a lower
 * revision, since a style change (font, theme, zoom) can change any glyph's
 * measured size even when its text/role/flags are unchanged.
 */
export interface TextMeasurer {
  readonly styleRevision: number;
  measure(requests: readonly MeasurementRequest[]): readonly MeasurementResult[];
}

export type MeasurementCacheKey = string;

/**
 * Two requests that are identical in every field that can affect measured
 * size — resolved font, text, role, chord-format flags, note system/key, and
 * style revision — must produce the same cache key; changing any one of them
 * must produce a different key.
 */
export function buildMeasurementCacheKey(request: MeasurementRequest, styleRevision: number): MeasurementCacheKey {
  return JSON.stringify([
    request.font,
    request.text,
    request.role,
    request.chordFormat ?? 0,
    request.noteSystemCode ?? "",
    request.key ?? "",
    styleRevision,
  ]);
}

/** Minimal shape this module needs from `TextMetrics`/`CanvasRenderingContext2D`, so tests can supply a plain fake. */
export interface MeasuredTextMetrics {
  readonly width: number;
  readonly actualBoundingBoxAscent?: number;
  readonly actualBoundingBoxDescent?: number;
}

export interface CanvasMeasurementContext {
  font: string;
  measureText(text: string): MeasuredTextMetrics;
}

/**
 * Canvas-context adapter, used by the headless unit tests. Production
 * rendering measures through `DomTextMeasurer` instead.
 */
export class CanvasTextMeasurer implements TextMeasurer {
  private readonly cache = new Map<MeasurementCacheKey, MeasuredSize>();
  private revision = 0;

  constructor(private readonly ctx: CanvasMeasurementContext) {}

  get styleRevision() {
    return this.revision;
  }

  /** Invalidates every cached measurement. Call when font/theme/zoom changes. */
  bumpStyleRevision() {
    this.revision++;
    this.cache.clear();
  }

  measure(requests: readonly MeasurementRequest[]): readonly MeasurementResult[] {
    const results: MeasurementResult[] = [];
    for (const request of requests) {
      const cacheKey = buildMeasurementCacheKey(request, this.revision);
      let size = this.cache.get(cacheKey);
      if (!size) {
        this.ctx.font = request.font;
        const metrics = this.ctx.measureText(request.text);
        size = { width: metrics.width, height: (metrics.actualBoundingBoxAscent ?? 0) + (metrics.actualBoundingBoxDescent ?? 0) };
        this.cache.set(cacheKey, size);
      }
      results.push({ id: request.id, size });
    }
    return results;
  }
}
