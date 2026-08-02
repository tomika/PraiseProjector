import type { LocalizedTutorialLabel, LocalizedTutorialText, TutorialStep } from "./tutorialTypes";

export function tutorialText(huTitle: string, huBody: string, enTitle: string, enBody: string): LocalizedTutorialText {
  return {
    hu: { title: huTitle, body: huBody },
    en: { title: enTitle, body: enBody },
  };
}

export function tutorialLabel(hu: string, en: string): LocalizedTutorialLabel {
  return { hu, en };
}

export function tutorialStep(
  id: string,
  target: TutorialStep["target"],
  text: LocalizedTutorialText,
  options: Pick<TutorialStep, "highlightTargets" | "prepare" | "details" | "branches" | "actions"> = {}
): TutorialStep {
  return { id, target, text, ...options };
}

function visibleElement(selector: string): HTMLElement | null {
  return Array.from(document.querySelectorAll<HTMLElement>(selector)).find((element) => element.getClientRects().length > 0) ?? null;
}

export function clickVisible(selector: string): void {
  visibleElement(selector)?.click();
}

export function activateFullPanel(panel: "side" | "editor" | "preview"): void {
  const buttons = Array.from(document.querySelectorAll<HTMLButtonElement>(".main-paging-buttons button"));
  const index = panel === "side" ? 0 : panel === "editor" ? 1 : 2;
  const button = buttons[index];
  if (button?.getClientRects().length && !button.classList.contains("btn-primary")) button.click();
}

export function closeFullTutorialPopovers(): void {
  if (visibleElement(".sync-dropdown-menu")) clickVisible(".sync-menu-toggle");
}

export function activatePreviewTab(index: number): void {
  const tabs = Array.from(document.querySelectorAll<HTMLAnchorElement>(".projecting-tabs-row .nav-link"));
  const tab = tabs[index];
  if (tab?.getClientRects().length && !tab.classList.contains("active")) tab.click();
}

export function activateEditorTab(index: number): void {
  const tabs = Array.from(document.querySelectorAll<HTMLAnchorElement>(".editor-tabs-header .nav-link"));
  const tab = tabs[index];
  if (tab && !tab.classList.contains("active")) tab.click();
}

export function ensureClientOptions(open: boolean): void {
  const overlay = document.querySelector<HTMLElement>("#options");
  if (!overlay) return;
  const isOpen = overlay.classList.contains("open");
  if (isOpen !== open) clickVisible(open ? "#btnOptions" : "#closeOptions");
}

const CLIENT_LIST_MODE_CYCLE_LENGTH = 3;
const LIST_MODE_COMMIT_MAX_IDLE_FRAMES = 8;

export function ensureClientListMode(mode: "database" | "playlist" | "leaderlists"): () => void {
  let frame: number | null = null;
  let cancelled = false;
  let clicksRemaining = CLIENT_LIST_MODE_CYCLE_LENGTH;
  let idleFrames = 0;
  let awaitingChangeFrom: string | null = null;

  const applyMode = () => {
    frame = null;
    if (cancelled) return;
    const current = document.querySelector<HTMLElement>("#options")?.dataset.listMode;
    if (!current || current === mode) return;
    const toggle = visibleElement("#listModeToggle");
    if (!toggle || clicksRemaining <= 0) return;

    // React has not committed the previous click yet. Wait for the DOM state to
    // change instead of clicking the same mode again and overshooting the cycle.
    if (awaitingChangeFrom === current) {
      idleFrames += 1;
      if (idleFrames > LIST_MODE_COMMIT_MAX_IDLE_FRAMES) return;
      frame = requestAnimationFrame(applyMode);
      return;
    }

    idleFrames = 0;
    awaitingChangeFrom = current;
    clicksRemaining -= 1;
    toggle.click();
    frame = requestAnimationFrame(applyMode);
  };

  frame = requestAnimationFrame(applyMode);
  return () => {
    cancelled = true;
    if (frame !== null) cancelAnimationFrame(frame);
  };
}

export function openClientZoomPanel(): void {
  if (visibleElement(".cv-zoom-panel")) return;
  const button = visibleElement(".cv-zoom-btn");
  button?.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true, view: window }));
}

export function closeClientZoomPanel(): void {
  if (!visibleElement(".cv-zoom-panel")) return;
  const outside = visibleElement("#filterRow") ?? visibleElement("#options");
  if (outside && typeof PointerEvent !== "undefined") {
    outside.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, cancelable: true, pointerType: "mouse" }));
  }
}

export function openClientTutorialValuePicker(): () => void {
  if (!visibleElement(".cv-wheel")) clickVisible("#transpose");
  return () => {
    if (!visibleElement(".cv-wheel")) return;
    // Follow the picker's normal outside-dismiss path: restore its opening value,
    // run onClose and consume the synthetic closing interaction.
    //
    // CAUTION: this dismissal arms WheelPicker's armPostCloseEventFence(), a
    // document-level CAPTURE fence that swallows every pointer/mouse/touch/click
    // event for POST_CLOSE_EVENT_FENCE_MS (500 ms) — synthetic .click() calls
    // included. TutorialHost runs this cleanup immediately before the next step's
    // prepare(), so a prepare that clicks (ensureClientOptions, openClientMoreMenu,
    // ensureClientListMode, activatePreviewTab, …) would silently do nothing when
    // it follows this step closely. Harmless today because the steps around
    // `toolbar-picker` share the `toolbar` primary, whose prepare is a no-op with
    // the options panel already closed. If a clicking prepare ever lands next to
    // this step, dismiss the wheel with Escape instead (no fence) rather than
    // adding a delay.
    document.body.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true, view: window }));
  };
}

export function openClientMoreMenu(): void {
  if (!visibleElement(".cv-more-menu")) clickVisible(".cv-more-btn");
}

export function closeClientTutorialPopovers(): void {
  if (visibleElement(".cv-more-menu")) clickVisible(".cv-more-btn");
}
