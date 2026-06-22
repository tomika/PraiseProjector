/**
 * Build-time UI switches for the client view. There is no runtime setting for
 * these (yet) — flip the constant and rebuild to change the look.
 */

/**
 * Controls whether the chrome's tappable controls render with a visible border +
 * subtle background (a uniform "button" look) or flat (icon only). It applies to
 * BOTH the main toolbar buttons and the options-panel buttons, so the whole
 * chrome stays consistent either way.
 *
 * Implemented by toggling the `cv-bordered` class on the `#mainView` root; the
 * border styling lives in client-view.css under `#mainView.cv-bordered …`.
 */
export const UNIFORM_BUTTON_BORDERS = false;

/** The controls of the main toolbar, addressed by a stable key. */
export type ToolbarButtonKey =
  | "prev"
  | "next"
  | "home"
  | "options"
  | "instructions"
  | "capo"
  | "transpose"
  | "unhighlight"
  | "netstatus"
  | "fullscreen";

/**
 * Main-toolbar button order, INDEPENDENT per layout — reorder these freely.
 *  - HORIZONTAL = portrait (toolbar is a strip across the top); left → right.
 *  - VERTICAL   = landscape with the options panel closed (toolbar is a column
 *    on the right); top → bottom.
 * Keys omitted from a list are simply not shown in that layout.
 */
export const TOOLBAR_ORDER_HORIZONTAL: ToolbarButtonKey[] = [
  "prev",
  "home",
  "options",
  "instructions",
  "capo",
  "transpose",
  "unhighlight",
  "netstatus",
  "fullscreen",
  "next",
];

export const TOOLBAR_ORDER_VERTICAL: ToolbarButtonKey[] = [
  "fullscreen",
  "options",
  "instructions",
  "prev",
  "next",
  "home",
  "capo",
  "transpose",
  "unhighlight",
  "netstatus",
];
