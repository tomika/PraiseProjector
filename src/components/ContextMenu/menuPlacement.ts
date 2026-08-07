import { useCallback, useEffect, useLayoutEffect, useRef, useState, type CSSProperties } from "react";

/**
 * Shared placement logic for popup/context menus.
 *
 * Two rules, applied to every menu that uses it:
 *  - the menu is moved so that it stays completely inside the app client area
 *    (the window viewport), so every item stays reachable;
 *  - when the menu is still wider or taller than the client area, it is capped
 *    to the available space and gets its own scrollbar instead of spilling out.
 */

export interface MenuAnchor {
  /** Preferred left edge (a click point, or a parent item's right edge for submenus). */
  x: number;
  /** Preferred top edge. */
  y: number;
  /** Where the menu's right edge lands when it has to open leftwards. Defaults to `x`. */
  flipX?: number;
  /** Where the menu's bottom edge lands when it has to open upwards. Defaults to `y`. */
  flipY?: number;
}

export interface MenuFitLimits {
  /** Caller cap; always additionally clamped to the client area. */
  maxWidth?: number;
  /** Caller cap; always additionally clamped to the client area. */
  maxHeight?: number;
  /** Gap kept between the menu and the client-area edges. */
  edgePadding?: number;
  minWidth?: number;
  minHeight?: number;
}

export interface MenuFit {
  left: number;
  top: number;
  /** Width to pin the menu to; only meaningful together with `scrollY` (see `useMenuViewportFit`). */
  width: number;
  maxWidth: number;
  maxHeight: number;
  /** The natural content is wider than the space it can get, so it needs a horizontal scrollbar. */
  scrollX: boolean;
  /** The natural content is taller than the space it can get, so it needs a vertical scrollbar. */
  scrollY: boolean;
}

export interface MenuSize {
  width: number;
  height: number;
}

const DEFAULT_EDGE_PADDING = 4;
const DEFAULT_MIN_WIDTH = 140;
const DEFAULT_MIN_HEIGHT = 60;

interface AxisFit {
  start: number;
  size: number;
  maxSize: number;
  scroll: boolean;
}

function fitAxis(
  anchorStart: number,
  flipEnd: number,
  naturalSize: number,
  clientSize: number,
  cap: number | undefined,
  edge: number,
  minSize: number
): AxisFit {
  const available = Math.max(minSize, clientSize - edge * 2);
  const maxSize = Math.max(minSize, Math.min(cap ?? available, available));
  const size = Math.min(naturalSize, maxSize);

  let start = anchorStart;
  if (start + size > clientSize - edge) {
    // Does not fit in the preferred direction: open towards the other side of
    // the anchor, and only if that does not fit either, push it against the edge.
    const flipped = flipEnd - size;
    start = flipped >= edge ? flipped : clientSize - edge - size;
  }

  const maxStart = Math.max(edge, clientSize - edge - size);
  return { start: Math.min(Math.max(start, edge), maxStart), size, maxSize, scroll: naturalSize > maxSize + 0.5 };
}

/** Pure placement calculation — kept side-effect free so it can be reasoned about and tested on its own. */
export function fitMenuInClientArea(anchor: MenuAnchor, natural: MenuSize, clientArea: MenuSize, limits: MenuFitLimits = {}): MenuFit {
  const edge = limits.edgePadding ?? DEFAULT_EDGE_PADDING;

  const horizontal = fitAxis(
    anchor.x,
    anchor.flipX ?? anchor.x,
    natural.width,
    clientArea.width,
    limits.maxWidth,
    edge,
    limits.minWidth ?? DEFAULT_MIN_WIDTH
  );
  const vertical = fitAxis(
    anchor.y,
    anchor.flipY ?? anchor.y,
    natural.height,
    clientArea.height,
    limits.maxHeight,
    edge,
    limits.minHeight ?? DEFAULT_MIN_HEIGHT
  );

  return {
    left: horizontal.start,
    top: vertical.start,
    width: Math.ceil(horizontal.size),
    maxWidth: horizontal.maxSize,
    maxHeight: vertical.maxSize,
    scrollX: horizontal.scroll,
    scrollY: vertical.scroll,
  };
}

function isSameFit(a: MenuFit, b: MenuFit): boolean {
  return (
    Math.abs(a.left - b.left) < 0.5 &&
    Math.abs(a.top - b.top) < 0.5 &&
    Math.abs(a.width - b.width) < 0.5 &&
    Math.abs(a.maxWidth - b.maxWidth) < 0.5 &&
    Math.abs(a.maxHeight - b.maxHeight) < 0.5 &&
    a.scrollX === b.scrollX &&
    a.scrollY === b.scrollY
  );
}

/**
 * Measures the menu element and returns the ref + inline style that keep it
 * inside the client area, scrolling when it cannot fit.
 *
 * Attach `ref` and `style` to the menu's outermost box; render the items as
 * usual. The first render already uses the raw anchor, and the measured
 * correction is applied in a layout effect, so nothing is painted off-screen.
 */
export function useMenuViewportFit<T extends HTMLElement = HTMLDivElement>(anchor: MenuAnchor, limits: MenuFitLimits = {}) {
  const ref = useRef<T>(null);
  const [fit, setFit] = useState<MenuFit | null>(null);

  const { x, y, flipX, flipY } = anchor;
  const { maxWidth, maxHeight, edgePadding, minWidth, minHeight } = limits;

  const measure = useCallback(() => {
    const menu = ref.current;
    if (!menu) return;

    // Natural size = what the menu wants, regardless of the caps we apply below.
    // scrollWidth/scrollHeight ignore max-width/max-height, and the offset/client
    // delta adds the borders plus any scrollbar gutter already taken.
    const natural: MenuSize = {
      width: menu.scrollWidth + (menu.offsetWidth - menu.clientWidth),
      height: menu.scrollHeight + (menu.offsetHeight - menu.clientHeight),
    };
    const clientArea: MenuSize = { width: window.innerWidth, height: window.innerHeight };
    const next = fitMenuInClientArea({ x, y, flipX, flipY }, natural, clientArea, { maxWidth, maxHeight, edgePadding, minWidth, minHeight });

    // Derived purely from DOM measurements and guarded against no-op updates, so
    // this settles after one extra pass instead of looping.
    setFit((prev) => (prev && isSameFit(prev, next) ? prev : next));
  }, [x, y, flipX, flipY, maxWidth, maxHeight, edgePadding, minWidth, minHeight]);

  // Deliberately without a dependency array: the menu content can change while
  // it is open (submenus, conditional items, i18n), and re-measuring is only a
  // couple of layout reads.
  useLayoutEffect(() => {
    measure();
  });

  useEffect(() => {
    window.addEventListener("resize", measure);
    window.addEventListener("orientationchange", measure);
    return () => {
      window.removeEventListener("resize", measure);
      window.removeEventListener("orientationchange", measure);
    };
  }, [measure]);

  const style: CSSProperties = {
    position: "fixed",
    left: `${fit ? fit.left : x}px`,
    top: `${fit ? fit.top : y}px`,
    maxWidth: `${fit ? fit.maxWidth : (maxWidth ?? window.innerWidth - (edgePadding ?? DEFAULT_EDGE_PADDING) * 2)}px`,
    maxHeight: `${fit ? fit.maxHeight : (maxHeight ?? window.innerHeight - (edgePadding ?? DEFAULT_EDGE_PADDING) * 2)}px`,
    overflowX: "auto",
    overflowY: "auto",
    // A vertical scrollbar eats into the content box and would push the (nowrap)
    // labels into a needless horizontal scrollbar; pinning the measured width
    // gives the scrollbar its own space instead.
    ...(fit?.scrollY ? { width: `${fit.width}px` } : {}),
  };

  return { ref, style, fit };
}
