/**
 * Static catalog of hardware-assignable commands: which view owns a command
 * family, whether it is a base row, its group, its operations and parameter
 * domains, its localization keys and its priority. The settings picker and the
 * persisted-data validation both read this table; the runtime still checks the
 * live capability before executing anything.
 */
import { CLIENT_VIEW_INPUT_ACTIONS } from "./client-view-input";
import { CAPO_RANGE, SECTION_CONTROL_COMMANDS, TRANSPOSE_RANGE, ZOOM_FONT_RANGE, type HardwareCommand, type HardwareView } from "./hardware-input";

export type HardwarePriority = "P0" | "P1" | "P2";
/** Priorities implemented in this build; later families stay out of the picker. */
export const IMPLEMENTED_PRIORITIES: readonly HardwarePriority[] = ["P0"];

export type CatalogGroup = "navigation" | "chords" | "transpose" | "capo" | "zoom" | "view" | "projection";

export type ParamSpec =
  | { kind: "int"; name: "step" | "value"; min: number; max: number; default: number; nonZero?: boolean }
  | { kind: "enum"; name: "value"; values: readonly (string | number)[]; default: string | number; labelKeys: readonly string[] };

export interface OpSpec {
  op: string;
  labelKey: string;
  param?: ParamSpec;
}

export interface CatalogFamily {
  view: HardwareView;
  action: string;
  group: CatalogGroup;
  labelKey: string;
  priority: HardwarePriority;
  /** Base rows are always listed; other families are added to a profile by hand. */
  base: boolean;
  /** Empty for parameterless base commands. */
  ops: readonly OpSpec[];
}

const TOGGLE_OPS: readonly OpSpec[] = [
  { op: "toggle", labelKey: "HardwareOpToggle" },
  { op: "on", labelKey: "HardwareOpOn" },
  { op: "off", labelKey: "HardwareOpOff" },
];

const cycleOps = (param: Extract<ParamSpec, { kind: "enum" }>): OpSpec[] => [
  { op: "next", labelKey: "HardwareOpNext" },
  { op: "previous", labelKey: "HardwareOpPrevious" },
  { op: "set", labelKey: "HardwareOpSet", param },
];

const intParam = (name: "step" | "value", min: number, max: number, defaultValue: number, nonZero = false): ParamSpec => ({
  kind: "int",
  name,
  min,
  max,
  default: defaultValue,
  ...(nonZero ? { nonZero } : {}),
});

const CLIENT_BASE_LABELS: Record<string, string> = {
  "toggle-options": "ClientViewInputActionToggleOptions",
  "show-previous-song": "ClientViewInputActionShowPreviousSong",
  "show-next-song": "ClientViewInputActionShowNextSong",
  "select-previous-visible-song": "ClientViewInputActionSelectPreviousVisibleSong",
  "select-next-visible-song": "ClientViewInputActionSelectNextVisibleSong",
  "select-first-control": "ClientViewInputActionSelectFirstControl",
  "cycle-next-main-control": "ClientViewInputActionCycleNextMainControl",
  "select-previous-option-control": "ClientViewInputActionSelectPreviousOptionControl",
  "select-next-option-control": "ClientViewInputActionSelectNextOptionControl",
  "activate-option-control": "ClientViewInputActionActivateOptionControl",
  "decrease-main-control": "ClientViewInputActionDecreaseMainControl",
  "increase-main-control": "ClientViewInputActionIncreaseMainControl",
  "clear-control": "ClientViewInputActionClearControl",
};

const FULL_BASE_LABELS: Record<string, string> = {
  "next-first": "HardwareFullNextFirst",
  "next-previous-block": "HardwareFullNextPreviousBlock",
  "next-up": "HardwareFullNextUp",
  "project-current-block-start": "HardwareFullProjectBlockStart",
  "next-last": "HardwareFullNextLast",
  "next-next-block": "HardwareFullNextNextBlock",
  "next-down": "HardwareFullNextDown",
  "project-next-or-repeat": "HardwareFullProjectNext",
};

const CHORD_MODE_PARAM = {
  kind: "enum",
  name: "value",
  values: ["inline", "guitar", "piano", "hidden"],
  default: "guitar",
  labelKeys: ["HardwareChordModeInline", "HardwareChordModeGuitar", "HardwareChordModePiano", "HardwareChordModeHidden"],
} as const;

const MINOR_PARAM = {
  kind: "enum",
  name: "value",
  values: [0, 1, 3],
  default: 0,
  labelKeys: ["HardwareMinorUpper", "HardwareMinorLower", "HardwareMinorLetter"],
} as const;

const NOTE_NAMES_PARAM = {
  kind: "enum",
  name: "value",
  values: ["english", "german"],
  default: "english",
  labelKeys: ["HardwareNoteNamesEnglish", "HardwareNoteNamesGerman"],
} as const;

const ZOOM_MODE_PARAM = {
  kind: "enum",
  name: "value",
  values: ["FIT_PAGE", "FIT_WIDTH", "MANUAL"],
  default: "FIT_PAGE",
  labelKeys: ["HardwareZoomFitPage", "HardwareZoomFitWidth", "HardwareZoomManual"],
} as const;

const toggle = (action: string, group: CatalogGroup, labelKey: string): CatalogFamily => ({
  view: "client-view",
  action,
  group,
  labelKey,
  priority: "P0",
  base: false,
  ops: TOGGLE_OPS,
});

export const HARDWARE_CATALOG: readonly CatalogFamily[] = [
  ...CLIENT_VIEW_INPUT_ACTIONS.map(
    (action): CatalogFamily => ({
      view: "client-view",
      action,
      group: "navigation",
      labelKey: CLIENT_BASE_LABELS[action],
      priority: "P0",
      base: true,
      ops: [],
    })
  ),
  {
    view: "client-view",
    action: "preselected-song",
    group: "navigation",
    labelKey: "HardwareFamilyPreselectedSong",
    priority: "P0",
    base: false,
    ops: [
      { op: "show", labelKey: "HardwareOpShow" },
      { op: "move-up", labelKey: "HardwareOpMoveUp" },
      { op: "move-down", labelKey: "HardwareOpMoveDown" },
      { op: "playlist-add", labelKey: "HardwareOpPlaylistAdd" },
      { op: "playlist-remove", labelKey: "HardwareOpPlaylistRemove" },
      { op: "playlist-toggle", labelKey: "HardwareOpPlaylistToggle" },
    ],
  },
  {
    view: "client-view",
    action: "preselected-transpose",
    group: "navigation",
    labelKey: "HardwareFamilyPreselectedTranspose",
    priority: "P0",
    base: false,
    ops: [
      { op: "step", labelKey: "HardwareOpStep", param: intParam("step", TRANSPOSE_RANGE.min, TRANSPOSE_RANGE.max, 1, true) },
      { op: "set", labelKey: "HardwareOpSet", param: intParam("value", TRANSPOSE_RANGE.min, TRANSPOSE_RANGE.max, 0) },
      { op: "reset", labelKey: "HardwareOpReset" },
    ],
  },
  {
    view: "client-view",
    action: "preselected-capo",
    group: "navigation",
    labelKey: "HardwareFamilyPreselectedCapo",
    priority: "P0",
    base: false,
    ops: [
      { op: "step", labelKey: "HardwareOpStep", param: intParam("step", -12, 12, 1, true) },
      { op: "set", labelKey: "HardwareOpSet", param: intParam("value", CAPO_RANGE.min, CAPO_RANGE.max, 0) },
      { op: "reset", labelKey: "HardwareOpReset" },
    ],
  },
  {
    view: "client-view",
    action: "chord-mode",
    group: "chords",
    labelKey: "HardwareFamilyChordMode",
    priority: "P0",
    base: false,
    ops: cycleOps(CHORD_MODE_PARAM),
  },
  toggle("chord-diagram", "chords", "HardwareFamilyChordDiagram"),
  toggle("chord-visibility", "chords", "HardwareFamilyChordVisibility"),
  {
    view: "client-view",
    action: "minor-notation",
    group: "chords",
    labelKey: "HardwareFamilyMinorNotation",
    priority: "P0",
    base: false,
    ops: cycleOps(MINOR_PARAM),
  },
  toggle("simplified", "chords", "HardwareFamilySimplified"),
  toggle("omit-repeated-chords", "chords", "HardwareFamilyOmitRepeatedChords"),
  toggle("superscript", "chords", "HardwareFamilySuperscript"),
  toggle("auto-tone", "chords", "HardwareFamilyAutoTone"),
  {
    view: "client-view",
    action: "note-names",
    group: "chords",
    labelKey: "HardwareFamilyNoteNames",
    priority: "P0",
    base: false,
    ops: [
      { op: "toggle", labelKey: "HardwareOpSwitch" },
      { op: "set", labelKey: "HardwareOpSet", param: NOTE_NAMES_PARAM },
    ],
  },
  {
    view: "client-view",
    action: "transpose",
    group: "transpose",
    labelKey: "HardwareFamilyTranspose",
    priority: "P0",
    base: false,
    ops: [
      { op: "step", labelKey: "HardwareOpStep", param: intParam("step", TRANSPOSE_RANGE.min, TRANSPOSE_RANGE.max, 1, true) },
      { op: "set", labelKey: "HardwareOpSet", param: intParam("value", TRANSPOSE_RANGE.min, TRANSPOSE_RANGE.max, 0) },
      { op: "reset", labelKey: "HardwareOpReset" },
    ],
  },
  toggle("capo-use", "capo", "HardwareFamilyCapoUse"),
  {
    view: "client-view",
    action: "capo",
    group: "capo",
    labelKey: "HardwareFamilyCapo",
    priority: "P0",
    base: false,
    ops: [
      { op: "step", labelKey: "HardwareOpStep", param: intParam("step", -12, 12, 1, true) },
      { op: "set", labelKey: "HardwareOpSet", param: intParam("value", CAPO_RANGE.min, CAPO_RANGE.max, 0) },
      { op: "reset", labelKey: "HardwareOpReset" },
    ],
  },
  {
    view: "client-view",
    action: "capo-apply",
    group: "capo",
    labelKey: "HardwareFamilyCapoApply",
    priority: "P0",
    base: false,
    ops: [{ op: "apply", labelKey: "HardwareOpApply", param: intParam("value", CAPO_RANGE.min, CAPO_RANGE.max, 2) }],
  },
  toggle("zoom", "zoom", "HardwareFamilyZoom"),
  {
    view: "client-view",
    action: "zoom-mode",
    group: "zoom",
    labelKey: "HardwareFamilyZoomMode",
    priority: "P0",
    base: false,
    ops: cycleOps(ZOOM_MODE_PARAM),
  },
  {
    view: "client-view",
    action: "zoom-font",
    group: "zoom",
    labelKey: "HardwareFamilyZoomFont",
    priority: "P0",
    base: false,
    ops: [
      {
        op: "step",
        labelKey: "HardwareOpStep",
        param: intParam("step", -(ZOOM_FONT_RANGE.max - ZOOM_FONT_RANGE.min), ZOOM_FONT_RANGE.max - ZOOM_FONT_RANGE.min, 1, true),
      },
      { op: "set", labelKey: "HardwareOpSet", param: intParam("value", ZOOM_FONT_RANGE.min, ZOOM_FONT_RANGE.max, 24) },
    ],
  },
  toggle("instructions", "view", "HardwareFamilyInstructions"),
  ...SECTION_CONTROL_COMMANDS.map(
    (action): CatalogFamily => ({
      view: "full-view",
      action,
      group: "projection",
      labelKey: FULL_BASE_LABELS[action],
      priority: "P0",
      base: true,
      ops: [],
    })
  ),
];

export const CATALOG_GROUP_LABELS: Record<CatalogGroup, string> = {
  navigation: "HardwareGroupNavigation",
  chords: "HardwareGroupChords",
  transpose: "HardwareGroupTranspose",
  capo: "HardwareGroupCapo",
  zoom: "HardwareGroupZoom",
  view: "HardwareGroupView",
  projection: "HardwareGroupProjection",
};

export function catalogFamily(view: HardwareView, action: string): CatalogFamily | undefined {
  return HARDWARE_CATALOG.find((family) => family.view === view && family.action === action);
}

/** Families a user may add as extra rows: this view, implemented, not base. */
export function addableFamilies(view: HardwareView): CatalogFamily[] {
  return HARDWARE_CATALOG.filter((family) => family.view === view && !family.base && IMPLEMENTED_PRIORITIES.includes(family.priority));
}

export type CommandValidation<V extends HardwareView> = { ok: true; command: HardwareCommand<V> } | { ok: false; reason: string };

/**
 * Validates an untrusted command for a view and returns a normalized copy that
 * carries only the known keys. The same check gates the settings UI and loading.
 */
export function validateCommand<V extends HardwareView>(view: V, value: unknown): CommandValidation<V> {
  if (!value || typeof value !== "object") return { ok: false, reason: "command-not-object" };
  const source = value as Record<string, unknown>;
  if (typeof source.action !== "string") return { ok: false, reason: "command-without-action" };
  const family = catalogFamily(view, source.action);
  if (!family) {
    const foreign = HARDWARE_CATALOG.some((candidate) => candidate.action === source.action);
    return { ok: false, reason: foreign ? "command-of-other-view" : "unknown-command" };
  }
  if (!IMPLEMENTED_PRIORITIES.includes(family.priority)) return { ok: false, reason: "command-not-implemented" };
  if (family.ops.length === 0) return { ok: true, command: { action: family.action } as HardwareCommand<V> };
  const op = family.action === "capo-apply" ? "apply" : source.op;
  const spec = family.ops.find((candidate) => candidate.op === op);
  if (!spec) return { ok: false, reason: "unknown-operation" };
  const command: Record<string, unknown> = family.action === "capo-apply" ? { action: family.action } : { action: family.action, op: spec.op };
  if (spec.param) {
    const raw = source[spec.param.name];
    const error = paramError(spec.param, raw);
    if (error) return { ok: false, reason: error };
    command[spec.param.name] = raw;
  }
  return { ok: true, command: command as HardwareCommand<V> };
}

export function paramError(spec: ParamSpec, raw: unknown): string | null {
  if (spec.kind === "enum") return spec.values.includes(raw as string | number) ? null : "invalid-enum-value";
  if (typeof raw !== "number" || !Number.isFinite(raw)) return "parameter-not-finite";
  if (!Number.isInteger(raw)) return "parameter-not-integer";
  if (raw < spec.min || raw > spec.max) return "parameter-out-of-range";
  if (spec.nonZero && raw === 0) return "parameter-zero-step";
  return null;
}

/** Stable identity of a command value (same family, operation and parameter). */
export function commandSignature(command: object): string {
  const record = command as Record<string, unknown>;
  return JSON.stringify(
    Object.keys(record)
      .sort()
      .map((key) => [key, record[key]])
  );
}

/** Every localization key the catalog refers to (checked against both languages). */
export function catalogLabelKeys(): string[] {
  const keys = new Set<string>(Object.values(CATALOG_GROUP_LABELS));
  for (const family of HARDWARE_CATALOG) {
    keys.add(family.labelKey);
    for (const op of family.ops) {
      keys.add(op.labelKey);
      if (op.param?.kind === "enum") for (const key of op.param.labelKeys) keys.add(key);
    }
  }
  return [...keys];
}
