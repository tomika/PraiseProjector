/**
 * T02 — legacy → hardware-input migration: ownership rules, aliases, ids/order/
 * selection, legacy trigger, idempotence, damaged data, future and invalid schema.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { migrateHardwareInput } from "../hardware-input-migration";
import { FACTORY_PROFILE_ID, baseRowId, defaultHardwareInputSettings, resolveActiveProfile } from "../hardware-input";
import { LEGACY_SETTINGS_FIXTURES } from "../../tests/support/legacyProfiles";
import { resolveClientViewInputProfile, matchesMidiBinding, parseMidiMessage } from "../client-view-input";

const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

test("rollback backup restores the legacy keyboard/MIDI profile after current profiles were edited", () => {
  const raw = clone(LEGACY_SETTINGS_FIXTURES.custom);
  const migrated = migrateHardwareInput(raw);
  assert.ok(migrated.backup);
  const edited = { ...raw, hardwareInput: defaultHardwareInputSettings(), clientViewInputProfiles: [] };
  const fullExport = JSON.parse(JSON.stringify(edited));
  assert.deepEqual(fullExport.hardwareInput, edited.hardwareInput, "full export retains new-format configuration");
  const restored = { ...edited, ...migrated.backup.fields };
  const old = resolveClientViewInputProfile(raw.clientViewActiveInputProfileId, raw.clientViewInputProfiles);
  const rollback = resolveClientViewInputProfile(restored.clientViewActiveInputProfileId, restored.clientViewInputProfiles);
  assert.deepEqual(rollback, old);
  for (const bytes of [
    [0x90, 36, 127],
    [0xb5, 64, 127],
    [0x90, 40, 100],
    [0x80, 36, 0],
  ]) {
    const event = parseMidiMessage(bytes);
    const actions = (profile: typeof old) =>
      event
        ? profile.bindings.filter((binding) => binding.kind === "midi" && matchesMidiBinding(binding, event)).map((binding) => binding.action)
        : [];
    assert.deepEqual(actions(rollback), actions(old));
  }
  assert.deepEqual(
    migrateHardwareInput({ ...restored, hardwareInput: undefined }).settings,
    migrated.settings,
    "re-upgrade from backup is deterministic"
  );
});

test("a custom legacy profile moves into the client-view branch with ids, names, order and selection", () => {
  const raw = clone(LEGACY_SETTINGS_FIXTURES.custom);
  const result = migrateHardwareInput(raw);
  assert.equal(result.source, "legacy");
  const client = result.settings.views["client-view"];
  assert.equal(client.activeProfileId, "p-custom");
  assert.deepEqual(
    client.customProfiles.map((profile) => [profile.id, profile.name, profile.extraRows.length]),
    [
      ["p-custom", "Pedálok", 0],
      ["p-second", "Második", 0],
    ]
  );
  assert.deepEqual(client.customProfiles[0].bindings, [
    {
      id: "b-key",
      rowId: baseRowId("client-view", "toggle-options"),
      kind: "keyboard",
      match: "code",
      key: "F6",
      ctrl: false,
      alt: false,
      shift: false,
      meta: false,
      numLock: "any",
    },
    {
      id: "b-legacy",
      rowId: baseRowId("client-view", "show-next-song"),
      kind: "keyboard",
      match: "legacy-key",
      key: "PAGEDOWN",
      ctrl: false,
      alt: false,
      shift: false,
      meta: false,
    },
    {
      id: "b-note",
      rowId: baseRowId("client-view", "show-previous-song"),
      kind: "midi",
      mode: "button",
      trigger: "legacy-level",
      message: "note-on",
      channel: 1,
      number: 36,
    },
    {
      id: "b-cc",
      rowId: baseRowId("client-view", "show-next-song"),
      kind: "midi",
      mode: "button",
      trigger: "legacy-level",
      message: "control-change",
      channel: "any",
      number: 64,
      threshold: 64,
    },
    {
      id: "b-pc",
      rowId: baseRowId("client-view", "toggle-options"),
      kind: "midi",
      mode: "button",
      trigger: "legacy-level",
      message: "program-change",
      channel: 2,
      number: 5,
    },
  ]);
  assert.deepEqual(result.settings.views["full-view"], defaultHardwareInputSettings().views["full-view"], "nothing is copied to the full view");
  assert.deepEqual(result.patch, { hardwareInput: result.settings });
  assert.deepEqual(result.backup?.fields, {
    clientViewInputProfiles: raw.clientViewInputProfiles,
    clientViewActiveInputProfileId: "p-custom",
  });
  assert.deepEqual(raw, LEGACY_SETTINGS_FIXTURES.custom, "the input is not mutated");
});

test("legacy action aliases expand exactly like the legacy normalizer, with deterministic ids", () => {
  const result = migrateHardwareInput(clone(LEGACY_SETTINGS_FIXTURES.aliases));
  assert.deepEqual(
    result.settings.views["client-view"].customProfiles[0].bindings.map((binding) => [binding.id, binding.rowId]),
    [
      ["k1", baseRowId("client-view", "show-previous-song")],
      ["k1-select-previous-visible-song", baseRowId("client-view", "select-previous-visible-song")],
      ["m1", baseRowId("client-view", "cycle-next-main-control")],
      ["m1-activate-option-control", baseRowId("client-view", "activate-option-control")],
      ["m2", baseRowId("client-view", "increase-main-control")],
    ]
  );
});

test("migration is idempotent: the stored result migrates to itself without a new write or new ids", () => {
  for (const fixture of Object.values(LEGACY_SETTINGS_FIXTURES)) {
    const first = migrateHardwareInput(clone(fixture));
    const stored = { ...clone(fixture), ...first.patch };
    const second = migrateHardwareInput(stored);
    assert.equal(second.source, "current");
    assert.equal(second.patch, undefined);
    assert.deepEqual(second.settings, first.settings);
    assert.deepEqual(migrateHardwareInput(clone(fixture)).settings, first.settings, "same input → same output");
  }
});

test("damaged legacy data: usable parts survive, the rest is quarantined with diagnostics", () => {
  const result = migrateHardwareInput(clone(LEGACY_SETTINGS_FIXTURES.malformed));
  const client = result.settings.views["client-view"];
  assert.deepEqual(
    client.customProfiles.map((profile) => [profile.id, profile.bindings.map((binding) => binding.id)]),
    [
      ["p-good", ["ok-key", "ok-cc"]],
      ["p-blank", []],
    ]
  );
  assert.deepEqual(
    client.customProfiles[0].quarantine?.map((item) => item.reason),
    ["legacy-binding-invalid", "legacy-binding-invalid", "legacy-binding-invalid", "legacy-binding-invalid", "legacy-binding-invalid"]
  );
  assert.equal(client.quarantine?.length, 4, "factory id, empty id, nameless and non-object profiles are kept aside");
  assert.equal(client.activeProfileId, "p-good");
  assert.ok(result.diagnostics.length >= 9);
});

test("factory, empty and unknown active ids", () => {
  assert.equal(migrateHardwareInput({ clientViewActiveInputProfileId: "factory", clientViewInputProfiles: [] }).source, "default");
  const missing = migrateHardwareInput({ clientViewActiveInputProfileId: "gone", clientViewInputProfiles: [] });
  assert.equal(missing.source, "legacy");
  assert.equal(missing.settings.views["client-view"].activeProfileId, FACTORY_PROFILE_ID);
  assert.ok(missing.diagnostics.some((diagnostic) => diagnostic.code === "missing-active-profile"));
  const empty = migrateHardwareInput({
    clientViewActiveInputProfileId: "p-empty",
    clientViewInputProfiles: [{ id: "p-empty", name: "Üres", bindings: [] }],
  });
  assert.deepEqual(resolveActiveProfile(empty.settings, "client-view").bindings, [], "an empty custom profile does not fall back");
  const factorySelected = migrateHardwareInput({
    clientViewActiveInputProfileId: "factory",
    clientViewInputProfiles: [{ id: "p", name: "P", bindings: [] }],
  });
  assert.equal(factorySelected.settings.views["client-view"].activeProfileId, FACTORY_PROFILE_ID);
});

test("a supported new schema is the only owner; legacy fields cannot override it", () => {
  const hardwareInput = defaultHardwareInputSettings();
  const result = migrateHardwareInput({ ...clone(LEGACY_SETTINGS_FIXTURES.custom), hardwareInput });
  assert.equal(result.source, "current");
  assert.equal(result.patch, undefined);
  assert.deepEqual(result.settings, hardwareInput);
});

test("a newer schema is never rewritten and falls back to the factory profiles in memory", () => {
  const future = { schemaVersion: 9, views: { "client-view": { activeProfileId: "x", customProfiles: [{ id: "x", fancy: true }] } } };
  const result = migrateHardwareInput({ hardwareInput: future, ...clone(LEGACY_SETTINGS_FIXTURES.custom) });
  assert.equal(result.source, "future-schema");
  assert.equal(result.patch, undefined);
  assert.equal(result.backup, undefined);
  assert.equal(resolveActiveProfile(result.settings, "client-view").id, FACTORY_PROFILE_ID);
  assert.ok(result.diagnostics.some((diagnostic) => diagnostic.code === "future-schema"));
});

test("an unreadable new value uses the legacy data in memory but is not overwritten", () => {
  const result = migrateHardwareInput({ hardwareInput: "garbage", ...clone(LEGACY_SETTINGS_FIXTURES.custom) });
  assert.equal(result.source, "invalid");
  assert.equal(result.patch, undefined);
  assert.equal(resolveActiveProfile(result.settings, "client-view").id, "p-custom");
});

test("fresh installs and default-only legacy fields need no write", () => {
  for (const raw of [{}, null, undefined, { clientViewInputProfiles: [], clientViewActiveInputProfileId: "factory" }]) {
    const result = migrateHardwareInput(raw as Record<string, unknown>);
    assert.equal(result.source, "default");
    assert.equal(result.patch, undefined);
    assert.deepEqual(result.settings, defaultHardwareInputSettings());
  }
});

test("a non-array legacy profile value is quarantined, not lost", () => {
  const result = migrateHardwareInput({ clientViewInputProfiles: { broken: true }, clientViewActiveInputProfileId: "p" });
  assert.equal(result.settings.views["client-view"].quarantine?.[0].reason, "legacy-profiles-not-array");
});

test("legacy profiles that only overlap remain usable; duplicates are set aside", () => {
  const conflicting = migrateHardwareInput(clone(LEGACY_SETTINGS_FIXTURES.conflicting));
  assert.equal(conflicting.settings.views["client-view"].customProfiles[0].bindings.length, 2, "order-based legacy behaviour is kept");
  const duplicate = migrateHardwareInput({
    clientViewActiveInputProfileId: "p",
    clientViewInputProfiles: [
      { id: "p", name: "One", bindings: [{ id: "same", kind: "midi", action: "navigate-next", message: "note-on", channel: 1, number: 1 }] },
      { id: "p", name: "Two", bindings: [] },
    ],
  });
  const profile = duplicate.settings.views["client-view"].customProfiles[0];
  assert.deepEqual(
    profile.bindings.map((binding) => binding.id),
    ["same", "same-select-next-visible-song"]
  );
  assert.equal(duplicate.settings.views["client-view"].quarantine?.[0].reason, "duplicate-profile-id");
  const duplicateBinding = migrateHardwareInput({
    clientViewActiveInputProfileId: "p",
    clientViewInputProfiles: [
      {
        id: "p",
        name: "P",
        bindings: [
          { id: "b", kind: "midi", action: "toggle-options", message: "note-on", channel: 1, number: 1 },
          { id: "b", kind: "midi", action: "clear-control", message: "note-on", channel: 1, number: 2 },
        ],
      },
    ],
  });
  assert.equal(duplicateBinding.settings.views["client-view"].customProfiles[0].quarantine?.[0].reason, "duplicate-binding-id");
});
