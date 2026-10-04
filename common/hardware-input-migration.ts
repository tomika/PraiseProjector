/**
 * Pure migration of the persisted hardware-control configuration.
 *
 * Input is the RAW persisted settings object (before any merge with defaults),
 * so a default-created empty configuration can never hide saved legacy profiles.
 * The function decides which data owns the configuration:
 *   - a supported `hardwareInput` schema is the only owner; legacy fields are ignored;
 *   - a newer (unknown) schema is never rewritten: the factory profiles are used
 *     in memory and the stored data is left untouched;
 *   - otherwise the legacy client-view fields are converted into the client-view
 *     branch (ids, names, order and selection kept; full view gets its factory).
 *
 * The conversion is deterministic and idempotent: no ids are generated, alias
 * expansion reuses the legacy normalizer, and migrating the result again yields
 * the same configuration. It never writes storage; callers persist `patch`.
 */
import { normalizeClientViewInputProfiles } from "./client-view-input";
import { profileConflicts } from "./hardware-input-conflicts";
import {
  FACTORY_PROFILE_ID,
  baseRowId,
  defaultHardwareInputSettings,
  type ClientCommand,
  type HardwareBinding,
  type HardwareInputSettings,
  type HardwareProfile,
  type QuarantinedItem,
} from "./hardware-input";
import { normalizeHardwareInputSettings, type HardwareDiagnostic } from "./hardware-input-validation";

export type MigrationSource = "current" | "legacy" | "default" | "future-schema" | "invalid";

export const LEGACY_BACKUP_SCHEMA = "pp-hardware-input-legacy-backup";

/** One-time restore point of the legacy fields a migration read. */
export interface LegacyHardwareBackup {
  schema: typeof LEGACY_BACKUP_SCHEMA;
  version: 1;
  fields: { clientViewInputProfiles?: unknown; clientViewActiveInputProfileId?: unknown };
}

export interface HardwareMigrationResult {
  /** The configuration to use now (in memory). */
  settings: HardwareInputSettings;
  source: MigrationSource;
  diagnostics: HardwareDiagnostic[];
  /** Settings patch that makes the migration durable; absent when nothing must be written. */
  patch?: { hardwareInput: HardwareInputSettings };
  /** Restore point to store before `patch` (legacy migrations only). */
  backup?: LegacyHardwareBackup;
}

export function migrateHardwareInput(raw: Record<string, unknown> | null | undefined): HardwareMigrationResult {
  const source = raw ?? {};
  if (source.hardwareInput !== undefined) {
    const normalized = normalizeHardwareInputSettings(source.hardwareInput);
    if (normalized.status === "ok") return { settings: normalized.settings, source: "current", diagnostics: normalized.diagnostics };
    if (normalized.status === "future-schema") return { settings: normalized.settings, source: "future-schema", diagnostics: normalized.diagnostics };
    // Unreadable data in the new key: use what the legacy fields still describe,
    // but never overwrite the stored value automatically.
    const fallback = convertLegacy(source);
    return { settings: fallback.settings, source: "invalid", diagnostics: [...normalized.diagnostics, ...fallback.diagnostics] };
  }
  if (!hasLegacyData(source)) return { settings: defaultHardwareInputSettings(), source: "default", diagnostics: [] };
  const converted = convertLegacy(source);
  return {
    settings: converted.settings,
    source: "legacy",
    diagnostics: converted.diagnostics,
    patch: { hardwareInput: converted.settings },
    backup: {
      schema: LEGACY_BACKUP_SCHEMA,
      version: 1,
      fields: {
        clientViewInputProfiles: source.clientViewInputProfiles,
        clientViewActiveInputProfileId: source.clientViewActiveInputProfileId,
      },
    },
  };
}

/** Legacy data that differs from what a fresh install (or the old defaults) holds. */
function hasLegacyData(source: Record<string, unknown>): boolean {
  const profiles = source.clientViewInputProfiles;
  const active = source.clientViewActiveInputProfileId;
  return (Array.isArray(profiles) && profiles.length > 0) || (typeof active === "string" && active !== FACTORY_PROFILE_ID);
}

function convertLegacy(source: Record<string, unknown>): { settings: HardwareInputSettings; diagnostics: HardwareDiagnostic[] } {
  const diagnostics: HardwareDiagnostic[] = [];
  const settings = defaultHardwareInputSettings();
  const branch = settings.views["client-view"];
  const viewQuarantine: QuarantinedItem[] = [];
  const rawProfiles = Array.isArray(source.clientViewInputProfiles) ? source.clientViewInputProfiles : [];
  if (source.clientViewInputProfiles !== undefined && !Array.isArray(source.clientViewInputProfiles)) {
    diagnostics.push({ severity: "error", code: "legacy-profiles-not-array", view: "client-view" });
    viewQuarantine.push({ kind: "profile", reason: "legacy-profiles-not-array", item: source.clientViewInputProfiles });
  }

  for (const rawProfile of rawProfiles) {
    const [legacy] = normalizeClientViewInputProfiles([rawProfile]);
    if (!legacy) {
      diagnostics.push({ severity: "error", code: "legacy-profile-invalid", view: "client-view" });
      viewQuarantine.push({ kind: "profile", reason: "legacy-profile-invalid", item: rawProfile });
      continue;
    }
    if (branch.customProfiles.some((profile) => profile.id === legacy.id)) {
      diagnostics.push({ severity: "error", code: "duplicate-profile-id", view: "client-view", profileId: legacy.id });
      viewQuarantine.push({ kind: "profile", reason: "duplicate-profile-id", item: rawProfile });
      continue;
    }
    const profile: HardwareProfile<ClientCommand> = { id: legacy.id, name: legacy.name, extraRows: [], bindings: [] };
    const quarantine: QuarantinedItem[] = [];
    const rawBindings = Array.isArray((rawProfile as { bindings?: unknown }).bindings)
      ? ((rawProfile as { bindings: unknown[] }).bindings ?? [])
      : [];
    for (const rawBinding of rawBindings) {
      // Run each binding through the legacy normalizer on its own, so a dropped
      // binding can be reported and quarantined instead of silently vanishing.
      const [single] = normalizeClientViewInputProfiles([{ id: legacy.id, name: legacy.name, bindings: [rawBinding] }]);
      const expanded = single?.bindings ?? [];
      if (expanded.length === 0) {
        const id = rawBinding && typeof rawBinding === "object" ? (rawBinding as { id?: unknown }).id : undefined;
        quarantine.push({ kind: "binding", reason: "legacy-binding-invalid", item: rawBinding });
        diagnostics.push({
          severity: "warning",
          code: "legacy-binding-invalid",
          view: "client-view",
          profileId: legacy.id,
          itemId: typeof id === "string" ? id : undefined,
        });
        continue;
      }
      for (const binding of expanded) {
        if (profile.bindings.some((existing) => existing.id === binding.id)) {
          quarantine.push({ kind: "binding", reason: "duplicate-binding-id", item: rawBinding });
          diagnostics.push({ severity: "warning", code: "duplicate-binding-id", view: "client-view", profileId: legacy.id, itemId: binding.id });
          continue;
        }
        profile.bindings.push(convertBinding(binding));
      }
    }
    if (quarantine.length) profile.quarantine = quarantine;
    branch.customProfiles.push(profile);
  }

  const active = source.clientViewActiveInputProfileId;
  if (typeof active === "string" && branch.customProfiles.some((profile) => profile.id === active)) branch.activeProfileId = active;
  else if (typeof active === "string" && active !== FACTORY_PROFILE_ID) {
    diagnostics.push({ severity: "warning", code: "missing-active-profile", view: "client-view", profileId: active });
  }
  if (viewQuarantine.length) branch.quarantine = viewQuarantine;
  for (const profile of branch.customProfiles) {
    for (const conflict of profileConflicts("client-view", profile)) {
      diagnostics.push({
        severity: "warning",
        code: conflict.reason,
        view: "client-view",
        profileId: profile.id,
        itemId: conflict.leftId,
        detail: conflict.rightId,
      });
    }
  }
  return { settings, diagnostics };
}

type LegacyBinding = ReturnType<typeof normalizeClientViewInputProfiles>[number]["bindings"][number];

/** Same matching as before: keyboard keeps its fields (exact modifiers, repeat ignored);
 *  MIDI keeps its message match and the level trigger with the 80 ms guard. */
function convertBinding(binding: LegacyBinding): HardwareBinding {
  const rowId = baseRowId("client-view", binding.action);
  if (binding.kind === "keyboard") {
    const converted: HardwareBinding = {
      id: binding.id,
      rowId,
      kind: "keyboard",
      match: binding.match,
      key: binding.key,
      ctrl: binding.ctrl,
      alt: binding.alt,
      shift: binding.shift,
      meta: binding.meta,
    };
    if (binding.numLock !== undefined) converted.numLock = binding.numLock;
    return converted;
  }
  const converted: HardwareBinding = {
    id: binding.id,
    rowId,
    kind: "midi",
    mode: "button",
    trigger: "legacy-level",
    message: binding.message,
    channel: binding.channel,
    number: binding.number,
  };
  if (binding.threshold !== undefined) converted.threshold = binding.threshold;
  return converted;
}
