const PAGING_LAYOUT_WIDTH_THRESHOLD = 768;

export type Orientation = "portrait" | "landscape";

export function shouldUsePagingLayout(width: number, height: number): boolean {
  return height > width || width < PAGING_LAYOUT_WIDTH_THRESHOLD;
}

export function shouldUsePagingLayoutForOrientation(width: number, orientation: Orientation): boolean {
  return orientation === "portrait" || width < PAGING_LAYOUT_WIDTH_THRESHOLD;
}

export function orientationOf(width: number, height: number): Orientation {
  return height > width ? "portrait" : "landscape";
}

/**
 * A soft keyboard that resizes the window (Android WebView with IME insets)
 * shrinks only the height. Treating that as a rotation would swap the layout
 * and remount the editor under the user's caret, so a height-only resize while
 * editing on a touch device keeps the previous orientation. Real rotations
 * always change the width.
 */
export function nextOrientation(
  previous: Orientation,
  previousWidth: number,
  width: number,
  height: number,
  softKeyboardLikely: boolean
): Orientation {
  if (softKeyboardLikely && width === previousWidth) return previous;
  return orientationOf(width, height);
}

/**
 * Tracks the last seen width across resize events and returns a state updater
 * per event. React may run an updater after later events have already been
 * tracked, so each updater closes over the values captured for its own event.
 */
export function createOrientationResizeTracker(initialWidth: number) {
  let lastWidth = initialWidth;
  return (width: number, height: number, softKeyboardLikely: boolean) => {
    const previousWidth = lastWidth;
    lastWidth = width;
    return (previous: Orientation) => nextOrientation(previous, previousWidth, width, height, softKeyboardLikely);
  };
}
