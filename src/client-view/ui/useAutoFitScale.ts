import { useCallback, useLayoutEffect, useRef, type RefObject } from "react";

/**
 * useAutoFitScale — shrink an em-sized control strip until every control fits,
 * instead of letting the last ones overflow out of sight.
 *
 * The client-view chrome sizes ALL of its chrome in `em` off ONE base font-size
 * per strip (`#mainToolbar { font-size: 20px }`, `.cv-options-bar { font-size:
 * 20px }` — see client-view.css). That base is therefore a single scale knob:
 * lowering it shrinks the icons, the glyph labels, the chord-mode <select> and
 * the capo/transpose values together, so a strip that would run off the right
 * edge on a narrow screen renders complete, just smaller.
 *
 * Why measure instead of a CSS breakpoint: how much width a strip needs depends
 * on WHICH controls are mounted (a follower has no prev/next/transpose; home,
 * netstatus, lamp and leader-mode are capability-gated), so no viewport or
 * container-query threshold can be right for every case.
 *
 * The pass is iterative because part of each row is fixed px (paddings, gaps,
 * the capo caret's min-width): one `available / required` ratio undershoots, so
 * we re-measure at the new size and refine until the row fits — or `minScale`
 * is reached, below which the controls would no longer be tappable.
 */

/** Refinement passes; the ratio converges in 2–3, the cap is only a guard. */
const MAX_PASSES = 4;
/** Never shrink past this fraction of the strip's CSS font-size. */
const DEFAULT_MIN_SCALE = 0.4;
/** Sub-pixel slack so layout rounding cannot trigger an endless shrink. */
const FIT_SLACK_PX = 0.5;

export interface AutoFitOptions {
  /**
   * Selector of the rows measured inside the host (all of them are scaled by the
   * SAME factor, so a multi-row strip stays visually consistent). Defaults to
   * the host element itself.
   */
  rowSelector?: string;
  /** Lower bound for the scale factor. */
  minScale?: number;
  /** False restores the CSS size — e.g. the toolbar's vertical column layout. */
  enabled?: boolean;
}

interface RowMetrics {
  /** Content+padding width the row actually has. */
  available: number;
  /** Content+padding width its children currently need. */
  required: number;
}

/**
 * Width the row's in-flow children occupy. Summing the children (rather than
 * reading scrollWidth) keeps the number meaningful with `overflow: visible`,
 * which is what these strips use.
 */
function requiredWidth(row: HTMLElement): number {
  const style = getComputedStyle(row);
  // "normal" (no gap declared) → NaN → 0.
  const gap = Number.parseFloat(style.columnGap) || 0;
  let total = (Number.parseFloat(style.paddingLeft) || 0) + (Number.parseFloat(style.paddingRight) || 0);
  let counted = 0;
  for (const child of Array.from(row.children) as HTMLElement[]) {
    // Popups anchored inside the strip (wheel picker, chord-box menu, zoom and
    // opacity panels, more-menu) take no room in the row.
    const position = getComputedStyle(child).position;
    if (position === "absolute" || position === "fixed") continue;
    const width = child.getBoundingClientRect().width;
    if (width <= 0) continue;
    total += width;
    counted += 1;
  }
  return counted > 1 ? total + gap * (counted - 1) : total;
}

function measureRows(rows: HTMLElement[]): RowMetrics[] {
  return rows.map((row) => ({ available: row.clientWidth, required: requiredWidth(row) }));
}

/** Smallest `available / required` across the rows; 1 when they all fit. */
function worstRatio(metrics: RowMetrics[]): number {
  let worst = 1;
  for (const { available, required } of metrics) {
    if (available <= 0 || required <= available + FIT_SLACK_PX) continue;
    worst = Math.min(worst, available / required);
  }
  return worst;
}

const sameMetrics = (a: RowMetrics[], b: RowMetrics[]): boolean =>
  a.length === b.length &&
  a.every((m, i) => Math.abs(m.available - b[i].available) < FIT_SLACK_PX && Math.abs(m.required - b[i].required) < FIT_SLACK_PX);

/**
 * Keeps the strip in `hostRef` — the element whose font-size is the strip's em
 * base — scaled to fit its width. Re-fits after every render of the calling
 * component and whenever the strip's container resizes.
 */
export function useAutoFitScale(hostRef: RefObject<HTMLElement | null>, options: AutoFitOptions = {}): void {
  const observerRef = useRef<ResizeObserver | null>(null);
  const observedRef = useRef<HTMLElement | null>(null);
  /**
   * Metrics as of the last completed fit. Re-measuring them is cheap (no style
   * write, so no forced reflow); when nothing moved the answer cannot have
   * changed and the whole pass is skipped. That also stops a ResizeObserver
   * feedback loop: an unchanged fit writes no style.
   */
  const fittedRef = useRef<RowMetrics[] | null>(null);
  const optionsRef = useRef(options);
  // Refreshed before the fit effect below (effects run in declaration order), so
  // the fit always sees the current options — same pattern as useLongPress.
  useLayoutEffect(() => {
    optionsRef.current = options;
  });

  const fit = useCallback(() => {
    const host = hostRef.current;
    if (!host) return;
    const { rowSelector, enabled = true, minScale = DEFAULT_MIN_SCALE } = optionsRef.current;
    if (!enabled) {
      if (host.style.fontSize) host.style.fontSize = "";
      fittedRef.current = null;
      return;
    }
    const rows = rowSelector ? Array.from(host.querySelectorAll<HTMLElement>(rowSelector)) : [host];
    if (rows.length === 0) return;

    const current = measureRows(rows);
    if (fittedRef.current && sameMetrics(fittedRef.current, current)) return;

    // Always restart from the CSS base so a widening pane grows the strip back.
    host.style.fontSize = "";
    const base = Number.parseFloat(getComputedStyle(host).fontSize);
    if (!Number.isFinite(base) || base <= 0) return;

    let scale = 1;
    for (let pass = 0; pass < MAX_PASSES; pass += 1) {
      const ratio = worstRatio(measureRows(rows));
      if (ratio >= 1) break;
      const next = Math.max(minScale, scale * ratio);
      if (next >= scale) break; // already at minScale — nothing left to give
      scale = next;
      host.style.fontSize = `${(base * scale).toFixed(2)}px`;
    }
    fittedRef.current = measureRows(rows);
  }, [hostRef]);

  // Content changes (a capability-gated button appearing, a transpose value
  // replacing its icon) arrive as a re-render — refit synchronously, before the
  // browser can paint the overflowing strip.
  useLayoutEffect(() => {
    const host = hostRef.current;
    if (host !== observedRef.current) {
      observerRef.current?.disconnect();
      observerRef.current = null;
      observedRef.current = host;
      fittedRef.current = null;
      // The CONTAINER is observed, not the strip: the strip's own height follows
      // the font-size we set, and re-entering on that would be noise.
      if (host && typeof ResizeObserver !== "undefined") {
        const observer = new ResizeObserver(() => fit());
        observer.observe(host.parentElement ?? host);
        observerRef.current = observer;
      }
    }
    fit();
  });

  useLayoutEffect(() => {
    // ResizeObserver covers the container; these catch the environments without
    // it and the WebView's post-rotation viewport settling.
    const onViewportChange = () => fit();
    window.addEventListener("resize", onViewportChange);
    window.addEventListener("orientationchange", onViewportChange);
    return () => {
      window.removeEventListener("resize", onViewportChange);
      window.removeEventListener("orientationchange", onViewportChange);
      observerRef.current?.disconnect();
      observerRef.current = null;
      observedRef.current = null;
    };
  }, [fit]);
}
