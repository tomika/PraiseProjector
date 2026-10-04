/**
 * Hardware control contract shared by the renderer, the standalone client and the
 * persisted `Settings`: views, view-bound commands, profile rows and bindings, the
 * factory profiles and the pure profile operations.
 *
 * Two independent configuration branches exist — `client-view` and `full-view` —
 * each with its own profiles and active profile. A profile lists only the view's
 * fixed base rows plus the extra rows a user added by hand; bindings point at a
 * row id, so a row survives without any binding and the same command family can
 * be added several times with different parameters.
 *
 * Nothing here may touch the DOM, React, Electron or an adapter.
 */
import {
  CLIENT_VIEW_INPUT_ACTIONS,
  CLIENT_VIEW_INPUT_ACTION_CONTEXTS,
  FACTORY_CLIENT_VIEW_INPUT_PROFILE,
  type ClientViewInputAction,
  type ClientViewInputContext,
  type NumLockRequirement,
} from "./client-view-input";

export const HARDWARE_INPUT_SCHEMA_VERSION = 1;

export type HardwareView = "client-view" | "full-view";
export const HARDWARE_VIEWS: readonly HardwareView[] = ["client-view", "full-view"];

// ── commands ────────────────────────────────────────────────────────────────────

export type ToggleOp = { op: "toggle" } | { op: "on" } | { op: "off" };
export type CycleOp<V> = { op: "next" } | { op: "previous" } | { op: "set"; value: V };
export type NumberOp = { op: "step"; step: number } | { op: "set"; value: number } | { op: "reset" };

export type ClientToggleFamily =
  | "chord-diagram"
  | "chord-visibility"
  | "simplified"
  | "omit-repeated-chords"
  | "superscript"
  | "auto-tone"
  | "capo-use"
  | "zoom"
  | "instructions";

/** Chord display modes as the user names them; mapped onto `chordBoxType`. */
export type ChordDisplayMode = "inline" | "guitar" | "piano" | "hidden";
/** Minor chord notation: 0 = Am, 1 = am, 3 = a (the `chordMode` values). */
export type MinorNotation = 0 | 1 | 3;
/** `english` = B/B♭ (`bb` on), `german` = H/B (`bb` off). */
export type NoteNames = "english" | "german";
export type ZoomMode = "FIT_PAGE" | "FIT_WIDTH" | "MANUAL";

/** What the preselected song of the options panel's list can do (see {@link PreselectionCommand}). */
export type PreselectedSongOp = "show" | "move-up" | "move-down" | "playlist-add" | "playlist-remove" | "playlist-toggle";

/**
 * Commands on the song preselected in the options panel's visible list — the
 * cursor the legacy PageUp/PageDown rows move: show it, move it in the working
 * playlist, add it there or remove it, set its playlist transpose/capo.
 */
export type PreselectionCommand =
  | { action: "preselected-song"; op: PreselectedSongOp }
  | ({ action: "preselected-transpose" } & NumberOp)
  | ({ action: "preselected-capo" } & NumberOp);

export const PRESELECTION_ACTIONS: readonly PreselectionCommand["action"][] = ["preselected-song", "preselected-transpose", "preselected-capo"];

export function isPreselectionCommand(command: { action: string }): command is PreselectionCommand {
  return (PRESELECTION_ACTIONS as readonly string[]).includes(command.action);
}

export type ClientCommand =
  | { action: ClientViewInputAction }
  | PreselectionCommand
  | ({ action: ClientToggleFamily } & ToggleOp)
  | ({ action: "chord-mode" } & CycleOp<ChordDisplayMode>)
  | ({ action: "minor-notation" } & CycleOp<MinorNotation>)
  | ({ action: "note-names" } & ({ op: "toggle" } | { op: "set"; value: NoteNames }))
  | ({ action: "zoom-mode" } & CycleOp<ZoomMode>)
  | ({ action: "transpose" } & NumberOp)
  | ({ action: "capo" } & NumberOp)
  | ({ action: "zoom-font" } & ({ op: "step"; step: number } | { op: "set"; value: number }))
  | { action: "capo-apply"; value: number };

/** The full view's eight section-control commands (Preview "Controls" tab). */
export type SectionControlCommand =
  | "next-first"
  | "next-previous-block"
  | "next-up"
  | "project-current-block-start"
  | "next-last"
  | "next-next-block"
  | "next-down"
  | "project-next-or-repeat";

export const SECTION_CONTROL_COMMANDS: readonly SectionControlCommand[] = [
  "next-first",
  "next-previous-block",
  "next-up",
  "project-current-block-start",
  "next-last",
  "next-next-block",
  "next-down",
  "project-next-or-repeat",
];

export type FullViewCommand = { action: SectionControlCommand };

export type HardwareCommand<V extends HardwareView = HardwareView> = V extends "client-view" ? ClientCommand : FullViewCommand;

export const TRANSPOSE_RANGE = { min: -11, max: 11, reset: 0 } as const;
export const CAPO_RANGE = { min: -1, max: 11, reset: 0 } as const;
export const ZOOM_FONT_RANGE = { min: 10, max: 64 } as const;

// ── bindings ────────────────────────────────────────────────────────────────────

/**
 * `code` = physical key (layout independent); `legacy-key` = the old client's
 * logical normalizer (NumLock-dependent numpad meaning); `key` = the exact
 * `KeyboardEvent.key` value, as the full view's section list always matched.
 */
export type HardwareKeyMatch = "code" | "legacy-key" | "key";

/** Where a full-view keyboard binding applies. */
export type HardwareKeyScope = "section-list" | "full-view";

export interface HardwareKeyboardBinding {
  id: string;
  rowId: string;
  kind: "keyboard";
  match: HardwareKeyMatch;
  key: string;
  ctrl: boolean;
  alt: boolean;
  shift: boolean;
  meta: boolean;
  numLock?: NumLockRequirement;
  /** `exact` (default) requires the stored modifiers; `ignore` matches any. */
  modifiers?: "exact" | "ignore";
  /** `ignore` (default) skips auto-repeated keydowns; `allow` runs them too. */
  repeat?: "ignore" | "allow";
  /** Full view only; defaults to the section list. */
  scope?: HardwareKeyScope;
}

export type HardwareMidiMessage = "note-on" | "control-change" | "program-change";

/**
 * `legacy-level`: the pre-hardware-tab behaviour kept for migrated bindings — a
 * CC fires on every sample at/above the threshold, with an 80 ms repeat guard.
 * `press-edge`: fires once per press; a Note re-arms on release, a CC re-arms
 * at/below `releaseThreshold`. Program Change fires once per message.
 */
export type HardwareMidiTrigger = "legacy-level" | "press-edge";

export interface HardwareMidiBinding {
  id: string;
  rowId: string;
  kind: "midi";
  mode: "button";
  trigger: HardwareMidiTrigger;
  message: HardwareMidiMessage;
  channel: number | "any";
  /** Note, controller or program number (0..127). */
  number: number;
  /** CC press threshold (default 64). */
  threshold?: number;
  /** CC re-arm threshold for press-edge (default threshold - 1). */
  releaseThreshold?: number;
}

export type HardwareBinding = HardwareKeyboardBinding | HardwareMidiBinding;

export const DEFAULT_CC_THRESHOLD = 64;
export const LEGACY_MIDI_REPEAT_GUARD_MS = 80;

// ── rows, profiles, settings ────────────────────────────────────────────────────

export interface HardwareActionRow<C> {
  id: string;
  command: C;
}

/** Persisted data that failed validation; kept so nothing disappears silently. */
export interface QuarantinedItem {
  kind: "row" | "binding" | "profile";
  reason: string;
  item: unknown;
}

export interface HardwareProfile<C> {
  id: string;
  name: string;
  extraRows: HardwareActionRow<C>[];
  bindings: HardwareBinding[];
  /** Base rows the user removed from this profile; they can be added back. */
  removedBaseRows?: string[];
  quarantine?: QuarantinedItem[];
}

export interface ViewInputSettings<C> {
  activeProfileId: string;
  customProfiles: HardwareProfile<C>[];
  /** Persisted profiles that could not be loaded at all. */
  quarantine?: QuarantinedItem[];
}

export interface HardwareInputSettings {
  schemaVersion: typeof HARDWARE_INPUT_SCHEMA_VERSION;
  views: {
    "client-view": ViewInputSettings<ClientCommand>;
    "full-view": ViewInputSettings<FullViewCommand>;
  };
}

export type ProfileOf<V extends HardwareView> = HardwareProfile<HardwareCommand<V>>;
export type RowOf<V extends HardwareView> = HardwareActionRow<HardwareCommand<V>>;

export const FACTORY_PROFILE_ID = "factory";

// ── base rows and factory profiles ──────────────────────────────────────────────

export function baseRowId(view: HardwareView, action: string): string {
  return `base:${view === "client-view" ? "cv" : "fv"}:${action}`;
}

export const CLIENT_BASE_ROWS: readonly HardwareActionRow<ClientCommand>[] = CLIENT_VIEW_INPUT_ACTIONS.map((action) => ({
  id: baseRowId("client-view", action),
  command: { action },
}));

export const FULL_BASE_ROWS: readonly HardwareActionRow<FullViewCommand>[] = SECTION_CONTROL_COMMANDS.map((action) => ({
  id: baseRowId("full-view", action),
  command: { action },
}));

export function baseRows<V extends HardwareView>(view: V): readonly RowOf<V>[] {
  return (view === "client-view" ? CLIENT_BASE_ROWS : FULL_BASE_ROWS) as readonly RowOf<V>[];
}

export function isBaseRowId(view: HardwareView, rowId: string): boolean {
  return baseRows(view).some((row) => row.id === rowId);
}

/** The legacy factory bindings, re-pointed at the client base rows. */
export const FACTORY_CLIENT_PROFILE: Readonly<HardwareProfile<ClientCommand>> = {
  id: FACTORY_PROFILE_ID,
  name: FACTORY_CLIENT_VIEW_INPUT_PROFILE.name,
  extraRows: [],
  // The legacy factory profile is keyboard-only (legacy-key bindings).
  bindings: FACTORY_CLIENT_VIEW_INPUT_PROFILE.bindings.map(
    ({ action, ...rest }) => ({ ...rest, rowId: baseRowId("client-view", action) }) as HardwareKeyboardBinding
  ),
};

function fullKey(id: string, action: SectionControlCommand, key: string): HardwareKeyboardBinding {
  return {
    id,
    rowId: baseRowId("full-view", action),
    kind: "keyboard",
    match: "key",
    key,
    ctrl: false,
    alt: false,
    shift: false,
    meta: false,
    modifiers: "ignore",
    repeat: "allow",
    scope: "section-list",
  };
}

/**
 * The full view's existing section-list keys. They keep the old handler's
 * semantics: logical `event.key`, any modifier, auto-repeat allowed, active only
 * while the section list has focus. Left/Right are extra keys of Up/Down.
 */
export const FACTORY_FULL_PROFILE: Readonly<HardwareProfile<FullViewCommand>> = {
  id: FACTORY_PROFILE_ID,
  name: "Gyári (szakaszlista billentyűi)",
  extraRows: [],
  bindings: [
    fullKey("factory-home", "next-first", "Home"),
    fullKey("factory-page-up", "next-previous-block", "PageUp"),
    fullKey("factory-arrow-up", "next-up", "ArrowUp"),
    fullKey("factory-arrow-left", "next-up", "ArrowLeft"),
    fullKey("factory-backspace", "project-current-block-start", "Backspace"),
    fullKey("factory-end", "next-last", "End"),
    fullKey("factory-page-down", "next-next-block", "PageDown"),
    fullKey("factory-arrow-down", "next-down", "ArrowDown"),
    fullKey("factory-arrow-right", "next-down", "ArrowRight"),
    fullKey("factory-enter", "project-next-or-repeat", "Enter"),
  ],
};

export function factoryProfile<V extends HardwareView>(view: V): Readonly<ProfileOf<V>> {
  return (view === "client-view" ? FACTORY_CLIENT_PROFILE : FACTORY_FULL_PROFILE) as unknown as Readonly<ProfileOf<V>>;
}

export function defaultHardwareInputSettings(): HardwareInputSettings {
  return {
    schemaVersion: HARDWARE_INPUT_SCHEMA_VERSION,
    views: {
      "client-view": { activeProfileId: FACTORY_PROFILE_ID, customProfiles: [] },
      "full-view": { activeProfileId: FACTORY_PROFILE_ID, customProfiles: [] },
    },
  };
}

// ── profile resolution and editing (pure; ids are injected) ─────────────────────

export type IdFactory = () => string;

/** The active profile of a view; a missing id falls back to that view's factory profile.
 *  An existing but empty custom profile stays empty. */
export function resolveActiveProfile<V extends HardwareView>(settings: HardwareInputSettings, view: V): Readonly<ProfileOf<V>> {
  const branch = settings.views[view] as unknown as ViewInputSettings<HardwareCommand<V>>;
  return branch.customProfiles.find((profile) => profile.id === branch.activeProfileId) ?? factoryProfile(view);
}

/** Base rows first (fixed order, minus the ones removed from the profile), then its extra rows. */
export function visibleRows<V extends HardwareView>(view: V, profile: Readonly<ProfileOf<V>>): RowOf<V>[] {
  const removed = profile.removedBaseRows ?? [];
  return [...baseRows(view).filter((row) => !removed.includes(row.id)), ...profile.extraRows];
}

export function findRow<V extends HardwareView>(view: V, profile: Readonly<ProfileOf<V>>, rowId: string): RowOf<V> | undefined {
  return visibleRows(view, profile).find((row) => row.id === rowId);
}

/** Legacy song-view/options contexts of a client base row; direct commands work in both. */
export function clientRowContexts(row: HardwareActionRow<ClientCommand>): readonly ClientViewInputContext[] {
  const command = row.command as { action: string };
  // The preselection exists only while the options panel is open.
  if (isPreselectionCommand(command)) return ["options"];
  return (CLIENT_VIEW_INPUT_ACTION_CONTEXTS as Record<string, readonly ClientViewInputContext[]>)[command.action] ?? ["song-view", "options"];
}

export function createProfile<V extends HardwareView>(name: string, createId: IdFactory): ProfileOf<V> {
  return { id: createId(), name, extraRows: [], bindings: [] } as ProfileOf<V>;
}

/** Copies a profile with fresh profile/row/binding ids; bindings follow their re-mapped rows. */
export function copyProfile<C>(profile: Readonly<HardwareProfile<C>>, name: string, createId: IdFactory): HardwareProfile<C> {
  const rowIds = new Map<string, string>();
  const extraRows = profile.extraRows.map((row) => {
    const id = createId();
    rowIds.set(row.id, id);
    return { id, command: structuredCloneCommand(row.command) };
  });
  const bindings = profile.bindings.map((binding) => ({ ...binding, id: createId(), rowId: rowIds.get(binding.rowId) ?? binding.rowId }));
  return {
    id: createId(),
    name,
    extraRows,
    bindings,
    ...(profile.removedBaseRows?.length ? { removedBaseRows: [...profile.removedBaseRows] } : {}),
    ...(profile.quarantine?.length ? { quarantine: [...profile.quarantine] } : {}),
  };
}

function structuredCloneCommand<C>(command: C): C {
  return JSON.parse(JSON.stringify(command)) as C;
}

export function addExtraRow<C>(profile: Readonly<HardwareProfile<C>>, command: C, createId: IdFactory): HardwareProfile<C> {
  return { ...profile, extraRows: [...profile.extraRows, { id: createId(), command }] };
}

/** Removing an extra row also removes its bindings. Base rows cannot be removed. */
export function removeExtraRow<C>(profile: Readonly<HardwareProfile<C>>, rowId: string): HardwareProfile<C> {
  if (!profile.extraRows.some((row) => row.id === rowId)) return { ...profile };
  return {
    ...profile,
    extraRows: profile.extraRows.filter((row) => row.id !== rowId),
    bindings: profile.bindings.filter((binding) => binding.rowId !== rowId),
  };
}

/** Removes any visible row with its bindings. A base row is only hidden, so it can be added back. */
export function removeRow<C>(view: HardwareView, profile: Readonly<HardwareProfile<C>>, rowId: string): HardwareProfile<C> {
  if (!isBaseRowId(view, rowId)) return removeExtraRow(profile, rowId);
  const removed = profile.removedBaseRows ?? [];
  return {
    ...profile,
    removedBaseRows: removed.includes(rowId) ? [...removed] : [...removed, rowId],
    bindings: profile.bindings.filter((binding) => binding.rowId !== rowId),
  };
}

/** Shows a removed base row again (without bindings; they were removed with the row). */
export function restoreBaseRow<C>(profile: Readonly<HardwareProfile<C>>, rowId: string): HardwareProfile<C> {
  const { removedBaseRows, ...rest } = profile;
  const remaining = (removedBaseRows ?? []).filter((id) => id !== rowId);
  return remaining.length ? { ...rest, removedBaseRows: remaining } : rest;
}

export function addBinding<C>(profile: Readonly<HardwareProfile<C>>, binding: HardwareBinding): HardwareProfile<C> {
  return { ...profile, bindings: [...profile.bindings, binding] };
}

/** Removing a binding keeps its row. */
export function removeBinding<C>(profile: Readonly<HardwareProfile<C>>, bindingId: string): HardwareProfile<C> {
  return { ...profile, bindings: profile.bindings.filter((binding) => binding.id !== bindingId) };
}

export function bindingsForRow(profile: Readonly<HardwareProfile<unknown>>, rowId: string): HardwareBinding[] {
  return profile.bindings.filter((binding) => binding.rowId === rowId);
}

/** Replaces one view branch and leaves the other one untouched (same object). */
export function withView<V extends HardwareView>(
  settings: HardwareInputSettings,
  view: V,
  change: (branch: ViewInputSettings<HardwareCommand<V>>) => ViewInputSettings<HardwareCommand<V>>
): HardwareInputSettings {
  const branch = settings.views[view] as unknown as ViewInputSettings<HardwareCommand<V>>;
  return { ...settings, views: { ...settings.views, [view]: change(branch) } };
}

export function upsertProfile<V extends HardwareView>(
  settings: HardwareInputSettings,
  view: V,
  profile: ProfileOf<V>,
  activate = false
): HardwareInputSettings {
  return withView(settings, view, (branch) => {
    const exists = branch.customProfiles.some((candidate) => candidate.id === profile.id);
    const customProfiles = exists
      ? branch.customProfiles.map((candidate) => (candidate.id === profile.id ? profile : candidate))
      : [...branch.customProfiles, profile];
    return { ...branch, activeProfileId: activate ? profile.id : branch.activeProfileId, customProfiles };
  });
}

/** Deletes a custom profile; if it was active, the view falls back to its factory profile. */
export function deleteProfile(settings: HardwareInputSettings, view: HardwareView, profileId: string): HardwareInputSettings {
  if (profileId === FACTORY_PROFILE_ID) return settings;
  return withView(settings, view, (branch) => ({
    ...branch,
    activeProfileId: branch.activeProfileId === profileId ? FACTORY_PROFILE_ID : branch.activeProfileId,
    customProfiles: branch.customProfiles.filter((profile) => profile.id !== profileId),
  }));
}

export function setActiveProfile(settings: HardwareInputSettings, view: HardwareView, profileId: string): HardwareInputSettings {
  return withView(settings, view, (branch) => ({ ...branch, activeProfileId: profileId }));
}
