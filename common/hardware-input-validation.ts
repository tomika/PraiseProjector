/**
 * Validation and normalization of persisted hardware-control data in the current
 * schema. Invalid rows, bindings and profiles are quarantined with a reason
 * instead of being dropped, so the usable part keeps working and the original
 * data never disappears silently.
 */
import { validateCommand } from "./hardware-action-catalog";
import { profileConflicts } from "./hardware-input-conflicts";
import {
  FACTORY_PROFILE_ID,
  HARDWARE_INPUT_SCHEMA_VERSION,
  baseRows,
  defaultHardwareInputSettings,
  isBaseRowId,
  type HardwareActionRow,
  type HardwareBinding,
  type HardwareCommand,
  type HardwareInputSettings,
  type HardwareKeyboardBinding,
  type HardwareMidiBinding,
  type HardwareProfile,
  type HardwareView,
  type QuarantinedItem,
  type ViewInputSettings,
} from "./hardware-input";

export type DiagnosticSeverity = "warning" | "error";

export interface HardwareDiagnostic {
  severity: DiagnosticSeverity;
  code: string;
  view?: HardwareView;
  profileId?: string;
  itemId?: string;
  detail?: string;
}

export type BindingValidation = { ok: true; binding: HardwareBinding } | { ok: false; reason: string };

const isInt = (value: unknown, min: number, max: number): value is number =>
  typeof value === "number" && Number.isInteger(value) && value >= min && value <= max;

export function validateBinding(view: HardwareView, value: unknown): BindingValidation {
  if (!value || typeof value !== "object") return { ok: false, reason: "binding-not-object" };
  const source = value as Record<string, unknown>;
  if (typeof source.id !== "string" || !source.id) return { ok: false, reason: "binding-without-id" };
  if (typeof source.rowId !== "string" || !source.rowId) return { ok: false, reason: "binding-without-row" };
  if (source.kind === "keyboard") return validateKeyboard(view, source);
  if (source.kind === "midi") return validateMidi(source);
  return { ok: false, reason: "unknown-binding-kind" };
}

function validateKeyboard(view: HardwareView, source: Record<string, unknown>): BindingValidation {
  if (source.match !== "code" && source.match !== "legacy-key" && source.match !== "key") return { ok: false, reason: "invalid-key-match" };
  if (typeof source.key !== "string" || !source.key) return { ok: false, reason: "missing-key" };
  for (const flag of ["ctrl", "alt", "shift", "meta"] as const) {
    if (typeof source[flag] !== "boolean") return { ok: false, reason: "invalid-modifier-flag" };
  }
  if (source.numLock !== undefined && source.numLock !== "any" && source.numLock !== "on" && source.numLock !== "off") {
    return { ok: false, reason: "invalid-numlock" };
  }
  if (source.modifiers !== undefined && source.modifiers !== "exact" && source.modifiers !== "ignore")
    return { ok: false, reason: "invalid-modifier-policy" };
  if (source.repeat !== undefined && source.repeat !== "ignore" && source.repeat !== "allow") return { ok: false, reason: "invalid-repeat-policy" };
  if (source.scope !== undefined) {
    if (view !== "full-view") return { ok: false, reason: "scope-outside-full-view" };
    if (source.scope !== "section-list" && source.scope !== "full-view") return { ok: false, reason: "invalid-scope" };
  }
  const binding: HardwareKeyboardBinding = {
    id: source.id as string,
    rowId: source.rowId as string,
    kind: "keyboard",
    match: source.match,
    key: source.key,
    ctrl: source.ctrl as boolean,
    alt: source.alt as boolean,
    shift: source.shift as boolean,
    meta: source.meta as boolean,
  };
  if (source.numLock !== undefined) binding.numLock = source.numLock as HardwareKeyboardBinding["numLock"];
  if (source.modifiers !== undefined) binding.modifiers = source.modifiers as HardwareKeyboardBinding["modifiers"];
  if (source.repeat !== undefined) binding.repeat = source.repeat as HardwareKeyboardBinding["repeat"];
  if (source.scope !== undefined) binding.scope = source.scope as HardwareKeyboardBinding["scope"];
  return { ok: true, binding };
}

function validateMidi(source: Record<string, unknown>): BindingValidation {
  if (source.mode !== undefined && source.mode !== "button") return { ok: false, reason: "midi-mode-not-supported" };
  const trigger = source.trigger ?? "press-edge";
  if (trigger !== "legacy-level" && trigger !== "press-edge") return { ok: false, reason: "invalid-midi-trigger" };
  if (source.message !== "note-on" && source.message !== "control-change" && source.message !== "program-change") {
    return { ok: false, reason: "invalid-midi-message" };
  }
  if (source.channel !== "any" && !isInt(source.channel, 1, 16)) return { ok: false, reason: "invalid-midi-channel" };
  if (!isInt(source.number, 0, 127)) return { ok: false, reason: "invalid-midi-number" };
  if (source.threshold !== undefined && !isInt(source.threshold, trigger === "press-edge" ? 1 : 0, 127)) {
    return { ok: false, reason: "invalid-cc-threshold" };
  }
  const threshold = (source.threshold as number | undefined) ?? 64;
  if (source.releaseThreshold !== undefined && !isInt(source.releaseThreshold, 0, threshold - 1)) {
    return { ok: false, reason: "invalid-cc-release-threshold" };
  }
  const binding: HardwareMidiBinding = {
    id: source.id as string,
    rowId: source.rowId as string,
    kind: "midi",
    mode: "button",
    trigger,
    message: source.message,
    channel: source.channel as number | "any",
    number: source.number as number,
  };
  if (source.threshold !== undefined) binding.threshold = source.threshold as number;
  if (source.releaseThreshold !== undefined) binding.releaseThreshold = source.releaseThreshold as number;
  return { ok: true, binding };
}

export interface NormalizedProfile<V extends HardwareView> {
  profile: HardwareProfile<HardwareCommand<V>> | null;
  quarantined?: QuarantinedItem;
}

/** Normalizes one persisted profile; invalid rows/bindings go to its quarantine. */
export function normalizeProfile<V extends HardwareView>(view: V, value: unknown, diagnostics: HardwareDiagnostic[]): NormalizedProfile<V> {
  if (!value || typeof value !== "object") {
    diagnostics.push({ severity: "error", code: "profile-not-object", view });
    return { profile: null, quarantined: { kind: "profile", reason: "profile-not-object", item: value } };
  }
  const source = value as Record<string, unknown>;
  if (typeof source.id !== "string" || !source.id || source.id === FACTORY_PROFILE_ID) {
    diagnostics.push({ severity: "error", code: "profile-invalid-id", view });
    return { profile: null, quarantined: { kind: "profile", reason: "profile-invalid-id", item: value } };
  }
  const profileId = source.id;
  const quarantine: QuarantinedItem[] = Array.isArray(source.quarantine) ? (source.quarantine as QuarantinedItem[]).filter(isQuarantinedItem) : [];
  const issue = (kind: QuarantinedItem["kind"], reason: string, item: unknown, itemId?: string) => {
    quarantine.push({ kind, reason, item });
    diagnostics.push({ severity: "warning", code: reason, view, profileId, itemId });
  };

  const usedRowIds = new Set(baseRows(view).map((row) => row.id));
  const removedBaseRows: string[] = [];
  for (const raw of Array.isArray(source.removedBaseRows) ? source.removedBaseRows : []) {
    if (typeof raw === "string" && isBaseRowId(view, raw) && !removedBaseRows.includes(raw)) removedBaseRows.push(raw);
    else diagnostics.push({ severity: "warning", code: "invalid-removed-row", view, profileId, detail: String(raw) });
  }
  const extraRows: HardwareActionRow<HardwareCommand<V>>[] = [];
  for (const raw of Array.isArray(source.extraRows) ? source.extraRows : []) {
    const row = raw as Record<string, unknown> | null;
    const rowId = row && typeof row.id === "string" ? row.id : undefined;
    if (!row || !rowId) {
      issue("row", "row-without-id", raw);
      continue;
    }
    if (usedRowIds.has(rowId)) {
      issue("row", "duplicate-row-id", raw, rowId);
      continue;
    }
    const command = validateCommand(view, row.command);
    if (!command.ok) {
      issue("row", command.reason, raw, rowId);
      continue;
    }
    usedRowIds.add(rowId);
    extraRows.push({ id: rowId, command: command.command });
  }

  const bindingIds = new Set<string>();
  const bindings: HardwareBinding[] = [];
  for (const raw of Array.isArray(source.bindings) ? source.bindings : []) {
    const result = validateBinding(view, raw);
    const rawId = raw && typeof raw === "object" ? (raw as { id?: unknown }).id : undefined;
    const itemId = typeof rawId === "string" ? rawId : undefined;
    if (!result.ok) {
      issue("binding", result.reason, raw, itemId);
      continue;
    }
    if (bindingIds.has(result.binding.id)) {
      issue("binding", "duplicate-binding-id", raw, itemId);
      continue;
    }
    if (!usedRowIds.has(result.binding.rowId) || removedBaseRows.includes(result.binding.rowId)) {
      issue("binding", "binding-row-missing", raw, itemId);
      continue;
    }
    bindingIds.add(result.binding.id);
    bindings.push(result.binding);
  }

  const name = typeof source.name === "string" && source.name.trim() ? source.name.trim() : "Névtelen profil";
  const profile: HardwareProfile<HardwareCommand<V>> = { id: profileId, name, extraRows, bindings };
  if (removedBaseRows.length) profile.removedBaseRows = removedBaseRows;
  if (quarantine.length) profile.quarantine = quarantine;
  for (const conflict of profileConflicts(view, profile)) {
    diagnostics.push({ severity: "warning", code: conflict.reason, view, profileId, itemId: conflict.leftId, detail: conflict.rightId });
  }
  return { profile };
}

function isQuarantinedItem(value: unknown): value is QuarantinedItem {
  if (!value || typeof value !== "object") return false;
  const item = value as Partial<QuarantinedItem>;
  return (item.kind === "row" || item.kind === "binding" || item.kind === "profile") && typeof item.reason === "string";
}

export function normalizeViewSettings<V extends HardwareView>(
  view: V,
  value: unknown,
  diagnostics: HardwareDiagnostic[]
): ViewInputSettings<HardwareCommand<V>> {
  const source = value && typeof value === "object" ? (value as Record<string, unknown>) : {};
  if (!value || typeof value !== "object") diagnostics.push({ severity: "warning", code: "view-settings-missing", view });
  const customProfiles: HardwareProfile<HardwareCommand<V>>[] = [];
  const quarantine: QuarantinedItem[] = Array.isArray(source.quarantine) ? (source.quarantine as QuarantinedItem[]).filter(isQuarantinedItem) : [];
  for (const raw of Array.isArray(source.customProfiles) ? source.customProfiles : []) {
    const { profile, quarantined } = normalizeProfile(view, raw, diagnostics);
    if (quarantined) quarantine.push(quarantined);
    if (!profile) continue;
    if (customProfiles.some((candidate) => candidate.id === profile.id)) {
      diagnostics.push({ severity: "error", code: "duplicate-profile-id", view, profileId: profile.id });
      quarantine.push({ kind: "profile", reason: "duplicate-profile-id", item: raw });
      continue;
    }
    customProfiles.push(profile);
  }
  let activeProfileId = typeof source.activeProfileId === "string" ? source.activeProfileId : FACTORY_PROFILE_ID;
  if (activeProfileId !== FACTORY_PROFILE_ID && !customProfiles.some((profile) => profile.id === activeProfileId)) {
    diagnostics.push({ severity: "warning", code: "missing-active-profile", view, profileId: activeProfileId });
    activeProfileId = FACTORY_PROFILE_ID;
  }
  const branch: ViewInputSettings<HardwareCommand<V>> = { activeProfileId, customProfiles };
  if (quarantine.length) branch.quarantine = quarantine;
  return branch;
}

export type HardwareSettingsStatus = "ok" | "future-schema" | "invalid";

export interface NormalizedHardwareSettings {
  settings: HardwareInputSettings;
  diagnostics: HardwareDiagnostic[];
  /** `future-schema`: a newer build wrote this data — use the factory fallback and never overwrite it. */
  status: HardwareSettingsStatus;
}

/** Normalizes data that claims to be in the hardware-input schema. */
export function normalizeHardwareInputSettings(value: unknown): NormalizedHardwareSettings {
  const diagnostics: HardwareDiagnostic[] = [];
  if (!value || typeof value !== "object") {
    diagnostics.push({ severity: "error", code: "hardware-settings-invalid" });
    return { settings: defaultHardwareInputSettings(), diagnostics, status: "invalid" };
  }
  const source = value as Record<string, unknown>;
  if (typeof source.schemaVersion === "number" && source.schemaVersion > HARDWARE_INPUT_SCHEMA_VERSION) {
    diagnostics.push({ severity: "error", code: "future-schema", detail: String(source.schemaVersion) });
    return { settings: defaultHardwareInputSettings(), diagnostics, status: "future-schema" };
  }
  if (source.schemaVersion !== HARDWARE_INPUT_SCHEMA_VERSION) {
    diagnostics.push({ severity: "error", code: "hardware-settings-invalid", detail: String(source.schemaVersion) });
    return { settings: defaultHardwareInputSettings(), diagnostics, status: "invalid" };
  }
  const views = source.views && typeof source.views === "object" ? (source.views as Record<string, unknown>) : {};
  return {
    settings: {
      schemaVersion: HARDWARE_INPUT_SCHEMA_VERSION,
      views: {
        "client-view": normalizeViewSettings("client-view", views["client-view"], diagnostics),
        "full-view": normalizeViewSettings("full-view", views["full-view"], diagnostics),
      },
    },
    diagnostics,
    status: "ok",
  };
}
