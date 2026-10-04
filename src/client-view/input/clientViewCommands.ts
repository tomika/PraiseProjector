/**
 * Client-view hardware target: which rows may run in the current store state and
 * how they execute. Commands go to the store's semantic methods (and the song
 * view's page-turn navigation) — never to DOM nodes or button labels.
 */
import type { ClientViewInputAction, ClientViewInputContext } from "../../../common/client-view-input";
import { clientRowContexts, isPreselectionCommand, type ClientCommand, type HardwareActionRow } from "../../../common/hardware-input";
import type { ExecutionContext, InputSource, TargetDecision } from "../../hardware-input/hardwareInputRuntime";
import { isAppModalOpen } from "../../hardware-input/modalGuard";
import { isFollowerView, isViewingRemoteDisplay, type ClientViewState, type ClientViewStore } from "../controller/ClientViewStore";
import type { DirectClientCommand } from "../controller/hardwareCommandChanges";
import { preselectionPlan } from "../controller/preselectionCommands";

export interface ClientCommandDeps {
  store: ClientViewStore;
  navigateSong(next: boolean): void;
}

/** Real modal UI: login, confirmations, the sessions dialog, the instructions
 *  editor and the about box own every input while they are open. */
export function clientModalOpen(state: ClientViewState): boolean {
  return (
    !!state.confirmText ||
    state.loginDialogOpen ||
    (state.sessionsDialogOpen && !state.sessionsDialogStartupHidden) ||
    state.instructionsEditorOpen ||
    state.aboutOpen ||
    !!state.confirmAnim
  );
}

/** The zoom / highlight-strength panels block the legacy navigation rows. */
export function clientSettingPanelOpen(state: ClientViewState): boolean {
  return state.zoomDialogOpen || state.highlightOpacityDialogOpen;
}

export function clientContext(state: ClientViewState): ClientViewInputContext {
  return state.optionsOpen ? "options" : "song-view";
}

const LEGACY_ACTIONS = new Set<string>([
  "toggle-options",
  "show-previous-song",
  "show-next-song",
  "select-previous-visible-song",
  "select-next-visible-song",
  "select-first-control",
  "cycle-next-main-control",
  "select-previous-option-control",
  "select-next-option-control",
  "activate-option-control",
  "decrease-main-control",
  "increase-main-control",
  "clear-control",
]);

const SONG_NAVIGATION_ACTIONS = new Set<string>(["show-previous-song", "show-next-song"]);

export function isLegacyClientRow(row: HardwareActionRow<ClientCommand>): boolean {
  return LEGACY_ACTIONS.has(row.command.action);
}

/** `appModalOpen`: a dialog outside the store (e.g. the full app's DB sync or
 *  message box, portaled over the embedded client view) owns the input too. */
export function decideClientRow(
  state: ClientViewState,
  row: HardwareActionRow<ClientCommand>,
  _source: InputSource,
  appModalOpen = isAppModalOpen()
): TargetDecision {
  if (appModalOpen || clientModalOpen(state)) return "protected";
  if (isLegacyClientRow(row)) {
    if (clientSettingPanelOpen(state)) return "protected";
    if (clientRowContexts(row).includes(clientContext(state))) return "yes";
    // On wide screens the options panel stays open beside the song. A key bound to song
    // navigation still turns it, unless the same key has an options-panel role (the
    // factory PageUp/PageDown keep moving the preselection there).
    return SONG_NAVIGATION_ACTIONS.has(row.command.action) && clientContext(state) === "options" ? "fallback" : "no";
  }
  if (isPreselectionCommand(row.command)) {
    if (clientSettingPanelOpen(state)) return "protected";
    // Only with something to do, so a key shared with a song-view row is not swallowed.
    return !isFollowerView(state) && preselectionPlan(state, row.command) ? "yes" : "no";
  }
  if (state.zoomDialogOpen && !["zoom", "zoom-mode", "zoom-font"].includes(row.command.action)) return "protected";
  if (state.highlightOpacityDialogOpen) return "protected";
  if (row.command.action === "transpose" && isViewingRemoteDisplay(state)) return "no";
  return "yes";
}

export function executeClientRow(deps: ClientCommandDeps, row: HardwareActionRow<ClientCommand>, context: ExecutionContext): void | Promise<unknown> {
  const { store, navigateSong } = deps;
  if (!isLegacyClientRow(row)) {
    if (decideClientRow(store.getSnapshot(), row, context.source) !== "yes") return;
    if (isPreselectionCommand(row.command)) return store.executePreselectionCommand(row.command, context.isCurrent);
    return store.executeDirectInputCommand(row.command as DirectClientCommand, context.isCurrent);
  }
  switch (row.command.action as ClientViewInputAction) {
    case "toggle-options":
      return store.hotkeyToggleOptions(context.isCurrent);
    case "show-previous-song":
      return navigateSong(false);
    case "show-next-song":
      return navigateSong(true);
    case "select-previous-visible-song":
      return store.hotkeyMoveSongSelection(false);
    case "select-next-visible-song":
      return store.hotkeyMoveSongSelection(true);
    case "select-first-control":
      return store.hotkeySelectFirstControl();
    case "cycle-next-main-control":
      return store.hotkeySelectControl(true, true);
    case "select-previous-option-control":
      return store.hotkeySelectControl(false);
    case "select-next-option-control":
      return store.hotkeySelectControl(true);
    case "activate-option-control":
      return store.hotkeyChangeControl(0);
    case "decrease-main-control":
      return store.hotkeyChangeControl(-1);
    case "increase-main-control":
      return store.hotkeyChangeControl(1);
    case "clear-control":
      return store.hotkeyClearControl();
  }
}
