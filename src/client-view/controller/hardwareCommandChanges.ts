/** Pure P0 direct-command state changes, shared invariants with screen controls. */
import type { ClientCommand, ClientToggleFamily, PreselectionCommand } from "../../../common/hardware-input";
import type { ClientViewInputAction } from "../../../common/client-view-input";
import type { ChordBoxKind, ClientViewState, DisplaySettings } from "./ClientViewStore";

export type DirectClientCommand = Exclude<ClientCommand, { action: ClientViewInputAction } | PreselectionCommand>;
export type DirectChange = Partial<Pick<ClientViewState, "displaySettings" | "transpose" | "capo" | "showInstructions">>;

export function chordSettings(settings: DisplaySettings, mode: ChordBoxKind): DisplaySettings {
  if (settings.chordBoxType === mode) return settings;
  return {
    ...settings,
    chordBoxType: mode,
    ...(mode !== "NO_CHORDS" ? { lastVisibleChordMode: mode } : {}),
    ...(mode === "GUITAR" || mode === "PIANO" ? { lastDiagramType: mode } : {}),
  };
}

const boolFields: Partial<Record<ClientToggleFamily, keyof DisplaySettings>> = {
  simplified: "simplified",
  "omit-repeated-chords": "noSecChordDup",
  superscript: "subscript",
  "auto-tone": "autoTone",
  "capo-use": "useCapo",
  zoom: "maxText",
};
const toggle = (current: boolean, op: "toggle" | "on" | "off") => (op === "toggle" ? !current : op === "on");
const clamp = (value: number, min: number, max: number) => Math.max(min, Math.min(max, value));
function cycle<T>(order: readonly T[], value: T, previous: boolean): T {
  return order[(Math.max(0, order.indexOf(value)) + (previous ? order.length - 1 : 1)) % order.length];
}

export function directCommandChange(state: ClientViewState, command: DirectClientCommand): DirectChange {
  let settings = state.displaySettings;
  const change: DirectChange = {};
  switch (command.action) {
    case "chord-mode": {
      const modes: ChordBoxKind[] = ["", "GUITAR", "PIANO", "NO_CHORDS"];
      const selected: Record<string, ChordBoxKind> = { inline: "", guitar: "GUITAR", piano: "PIANO", hidden: "NO_CHORDS" };
      settings = chordSettings(
        settings,
        command.op === "set" ? selected[command.value] : cycle(modes, settings.chordBoxType, command.op === "previous")
      );
      break;
    }
    case "chord-diagram": {
      const on = settings.chordBoxType === "GUITAR" || settings.chordBoxType === "PIANO";
      settings = chordSettings(settings, toggle(on, command.op) ? (on ? settings.chordBoxType : (settings.lastDiagramType ?? "GUITAR")) : "");
      break;
    }
    case "chord-visibility":
      settings = chordSettings(
        settings,
        toggle(settings.chordBoxType !== "NO_CHORDS", command.op)
          ? settings.chordBoxType !== "NO_CHORDS"
            ? settings.chordBoxType
            : (settings.lastVisibleChordMode ?? "")
          : "NO_CHORDS"
      );
      break;
    case "minor-notation":
      settings = {
        ...settings,
        chordMode: command.op === "set" ? command.value : cycle([0, 1, 3] as const, settings.chordMode, command.op === "previous"),
      };
      break;
    case "note-names":
      settings = { ...settings, bb: command.op === "toggle" ? !settings.bb : command.value === "english" };
      break;
    case "instructions":
      change.showInstructions = toggle(state.showInstructions, command.op);
      break;
    case "transpose":
      change.transpose = command.op === "step" ? clamp(state.transpose + command.step, -11, 11) : command.op === "reset" ? 0 : command.value;
      break;
    case "capo":
      change.capo = command.op === "step" ? clamp(state.capo + command.step, -1, 11) : command.op === "reset" ? 0 : command.value;
      break;
    case "capo-apply":
      change.capo = command.value;
      settings = { ...settings, useCapo: true };
      break;
    case "zoom-mode": {
      const current = settings.maxText ? settings.zoomSizingMode : null;
      const mode =
        command.op === "set" ? command.value : cycle([null, "FIT_PAGE", "FIT_WIDTH", "MANUAL"] as const, current, command.op === "previous");
      settings = { ...settings, maxText: mode !== null, ...(mode !== null ? { zoomSizingMode: mode } : {}) };
      break;
    }
    case "zoom-font":
      settings = {
        ...settings,
        maxText: true,
        zoomSizingMode: "MANUAL",
        zoomFontSize: command.op === "set" ? command.value : clamp(settings.zoomFontSize + command.step, 10, 64),
      };
      break;
    default: {
      const field = boolFields[command.action];
      if (field) settings = { ...settings, [field]: toggle(!!settings[field], command.op) };
    }
  }
  if (JSON.stringify(settings) !== JSON.stringify(state.displaySettings)) change.displaySettings = settings;
  if (change.transpose === state.transpose) delete change.transpose;
  if (change.capo === state.capo) delete change.capo;
  if (change.showInstructions === state.showInstructions) delete change.showInstructions;
  return change;
}
