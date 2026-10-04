/**
 * Whether a modal dialog of the full application is open. Every dialog of the
 * app renders a backdrop (`modal-backdrop`, `settings-modal-backdrop`,
 * `share-dialog-backdrop`, …), a Bootstrap modal or an overlay (message box,
 * loading, context menu); while one is visible the
 * dialog owns the keyboard and no hardware command may run underneath it.
 */
const MODAL_SELECTOR = [
  "[class*='backdrop']",
  ".modal.d-block",
  ".modal.show",
  "[role='dialog'][aria-modal='true']",
  ".messagebox-overlay",
  ".loading-overlay",
  ".songlist-context-menu-overlay",
].join(", ");

export function isAppModalOpen(root: Pick<Document, "querySelectorAll"> | null = typeof document !== "undefined" ? document : null): boolean {
  if (!root) return false;
  for (const element of Array.from(root.querySelectorAll(MODAL_SELECTOR))) {
    if ((element as HTMLElement).getClientRects?.().length !== 0) return true;
  }
  return false;
}
