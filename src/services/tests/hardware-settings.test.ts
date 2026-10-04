/**
 * T14 — persisted settings integration: the one migration entry point (works
 * without SettingsContext), one restore point, durable vs in-memory result,
 * raw-before-merge for the settings draft, future data preserved, and the
 * low-level store keeping its old contract (R02, R16).
 */
import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { installFakeWindow } from "../../../tests/support/browserEnv";
import { LEGACY_SETTINGS_FIXTURES } from "../../../tests/support/legacyProfiles";
import {
  readHardwareLegacyBackup,
  readPersistedSettings,
  writeHardwareLegacyBackup,
  writePersistedSettings,
  writePersistedSettingsResult,
} from "../settingsStore";
import {
  ensureHardwareInputMigrated,
  hardwareInputForLoadedSettings,
  readHardwareInputSettings,
  readHardwareInputState,
} from "../../hardware-input/hardwareInputSettings";
import { FACTORY_PROFILE_ID, defaultHardwareInputSettings, resolveActiveProfile } from "../../../common/hardware-input";

let restore: (() => void) | null = null;
afterEach(() => {
  restore?.();
  restore = null;
});

function env(settings: unknown, options: { failWrites?: boolean; backup?: string } = {}) {
  const storage: Record<string, string> = {};
  if (settings !== undefined) storage["pp-settings"] = JSON.stringify(settings);
  if (options.backup) storage["pp-hardware-input-legacy-backup"] = options.backup;
  const installed = installFakeWindow({ storage, failWrites: options.failWrites });
  restore = installed.restore;
  return installed.window;
}

test("a legacy installation is migrated once: restore point first, then one settings patch", () => {
  const legacy = { ...LEGACY_SETTINGS_FIXTURES.custom, theme: "dark", iWebEnabled: false };
  const window = env(legacy);
  const first = ensureHardwareInputMigrated();
  assert.equal(first.source, "legacy");
  assert.equal(first.persisted, true);
  const stored = readPersistedSettings() as Record<string, unknown>;
  assert.deepEqual(stored.hardwareInput, first.settings);
  assert.equal(stored.theme, "dark", "other settings are kept");
  assert.equal(stored.iWebEnabled, false);
  assert.deepEqual(stored.clientViewInputProfiles, legacy.clientViewInputProfiles, "legacy fields stay as history");
  assert.deepEqual(readHardwareLegacyBackup(), first.backup);
  assert.deepEqual(window.events, ["pp-settings-changed"], "exactly one write notification");

  const second = ensureHardwareInputMigrated();
  assert.equal(second.source, "current");
  assert.equal(second.persisted, null);
  assert.deepEqual(window.events, ["pp-settings-changed"], "a restart writes nothing");
  assert.deepEqual(second.settings, first.settings);
});

test("storage failure: the migrated profiles work in memory but are not reported as durable", () => {
  env(LEGACY_SETTINGS_FIXTURES.custom, { failWrites: true });
  const result = ensureHardwareInputMigrated();
  assert.equal(result.persisted, false);
  assert.equal(resolveActiveProfile(result.settings, "client-view").id, "p-custom");
  const stored = readPersistedSettings() as Record<string, unknown>;
  assert.equal(stored.hardwareInput, undefined, "legacy data stays the stored truth");
  assert.equal(readHardwareLegacyBackup(), null);
});

test("an existing restore point is never replaced", () => {
  env(LEGACY_SETTINGS_FIXTURES.aliases, { backup: JSON.stringify({ original: true }) });
  assert.equal(ensureHardwareInputMigrated().persisted, true);
  assert.deepEqual(readHardwareLegacyBackup(), { original: true });
  assert.equal(writeHardwareLegacyBackup({ other: true }), true);
  assert.deepEqual(readHardwareLegacyBackup(), { original: true });
});

test("fresh installs and future data are left alone", () => {
  const fresh = env(undefined);
  assert.equal(ensureHardwareInputMigrated().persisted, null);
  assert.deepEqual(fresh.events, []);
  restore?.();
  const future = { hardwareInput: { schemaVersion: 7, anything: [1, 2] }, ...LEGACY_SETTINGS_FIXTURES.custom };
  const futureWindow = env(future);
  const result = ensureHardwareInputMigrated();
  assert.equal(result.source, "future-schema");
  assert.equal(result.persisted, null);
  assert.deepEqual(futureWindow.events, []);
  assert.deepEqual(readPersistedSettings(), future);
});

test("the settings draft migrates from the RAW object, not from defaults merged over it", () => {
  const raw = { ...LEGACY_SETTINGS_FIXTURES.custom } as Record<string, unknown>;
  const mergedWithDefaults = {
    clientViewInputProfiles: [],
    clientViewActiveInputProfileId: "factory",
    hardwareInput: defaultHardwareInputSettings(),
    ...raw,
  };
  assert.equal(resolveActiveProfile(hardwareInputForLoadedSettings(raw), "client-view").id, "p-custom");
  assert.equal(
    resolveActiveProfile(hardwareInputForLoadedSettings(mergedWithDefaults), "client-view").id,
    FACTORY_PROFILE_ID,
    "why merge-first would be wrong"
  );
  const future = { schemaVersion: 3, custom: true };
  assert.equal(hardwareInputForLoadedSettings({ hardwareInput: future }), future, "unknown data passes through untouched");
  assert.equal(hardwareInputForLoadedSettings({ hardwareInput: "bad" }), "bad");
});

test("the runtime read is cached per persisted text and never writes", () => {
  const window = env(LEGACY_SETTINGS_FIXTURES.custom);
  const first = readHardwareInputState();
  assert.equal(first.source, "legacy");
  assert.equal(readHardwareInputState(), first, "same text → same object");
  assert.deepEqual(window.events, []);
  writePersistedSettings({ hardwareInput: defaultHardwareInputSettings() });
  assert.equal(resolveActiveProfile(readHardwareInputSettings(), "client-view").id, FACTORY_PROFILE_ID);
});

test("the low-level store keeps its contract and reports durability", () => {
  const window = env({ a: 1 });
  assert.deepEqual(writePersistedSettings({ theme: "light" }), { a: 1, theme: "light" });
  assert.deepEqual(writePersistedSettingsResult({ language: "hu" }), { settings: { a: 1, theme: "light", language: "hu" }, persisted: true });
  window.localStorage.failWrites = true;
  assert.deepEqual(writePersistedSettingsResult({ theme: "dark" }).persisted, false);
  assert.deepEqual(readPersistedSettings(), { a: 1, theme: "light", language: "hu" });
  assert.deepEqual(window.events, ["pp-settings-changed", "pp-settings-changed", "pp-settings-changed"]);
});
