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
  options: Pick<TutorialStep, "prepare" | "details" | "branches" | "actions"> = {}
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

export function openClientMoreMenu(): void {
  if (!visibleElement(".cv-more-menu")) clickVisible(".cv-more-btn");
}

export function closeClientTutorialPopovers(): void {
  if (visibleElement(".cv-more-menu")) clickVisible(".cv-more-btn");
}
