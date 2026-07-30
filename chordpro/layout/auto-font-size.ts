export interface AutoFontSizeSearchOptions {
  readonly min: number;
  readonly max: number;
  readonly fits: (fontSize: number) => Promise<boolean>;
  readonly isCancelled?: () => boolean;
}

/** Apply the same scale that FIT_WIDTH uses to any logical layout metric. */
export function scaleFitWidthMetric(value: number, paneWidth: number, layoutWidth: number): number {
  return layoutWidth > 0 ? value * (paneWidth / layoutWidth) : Number.POSITIVE_INFINITY;
}

/**
 * Find the largest integer font size that fits. If even the minimum overflows,
 * the minimum is returned so the caller can keep vertical scrolling available.
 */
export async function findLargestFittingFontSize(options: AutoFontSizeSearchOptions): Promise<number | null> {
  let low = Math.ceil(Math.min(options.min, options.max));
  let high = Math.floor(Math.max(options.min, options.max));
  const minimum = low;
  let best = minimum;

  while (low <= high) {
    if (options.isCancelled?.()) return null;
    const candidate = Math.floor((low + high) / 2);
    const fits = await options.fits(candidate);
    if (options.isCancelled?.()) return null;
    if (fits) {
      best = candidate;
      low = candidate + 1;
    } else {
      high = candidate - 1;
    }
  }

  return best;
}

export interface GrowingFontSizeSearchOptions {
  readonly base: number;
  readonly max: number;
  readonly fits: (fontSize: number) => Promise<boolean>;
  readonly isCancelled?: () => boolean;
}

/**
 * Find a larger fitting integer size without ever shrinking below the natural
 * theme size. `null` means that the caller should keep the natural size.
 */
export async function findLargestLargerFittingFontSize(options: GrowingFontSizeSearchOptions): Promise<number | null> {
  const firstLargerSize = Math.floor(options.base) + 1;
  if (firstLargerSize > options.max || options.isCancelled?.()) return null;

  const firstLargerSizeFits = await options.fits(firstLargerSize);
  if (options.isCancelled?.() || !firstLargerSizeFits) return null;

  return findLargestFittingFontSize({
    min: firstLargerSize,
    max: options.max,
    fits: options.fits,
    isCancelled: options.isCancelled,
  });
}
