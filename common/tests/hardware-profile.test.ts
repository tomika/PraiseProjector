/**
 * T03 — profiles and rows: 13/8 base rows, extra rows only by hand, input-less
 * rows, several parameterized rows of one family, copy/remap/delete, and the two
 * view branches staying independent (R03, R04).
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  FACTORY_PROFILE_ID,
  addBinding,
  addExtraRow,
  baseRowId,
  bindingsForRow,
  copyProfile,
  createProfile,
  defaultHardwareInputSettings,
  deleteProfile,
  findRow,
  isBaseRowId,
  removeBinding,
  removeExtraRow,
  removeRow,
  resolveActiveProfile,
  restoreBaseRow,
  setActiveProfile,
  upsertProfile,
  visibleRows,
  type ClientCommand,
  type HardwareBinding,
  type HardwareInputSettings,
  type HardwareProfile,
} from "../hardware-input";
import { normalizeHardwareInputSettings } from "../hardware-input-validation";

function ids(prefix = "id") {
  let next = 0;
  return () => `${prefix}-${++next}`;
}

const keyBinding = (id: string, rowId: string, key = "F6"): HardwareBinding => ({
  id,
  rowId,
  kind: "keyboard",
  match: "code",
  key,
  ctrl: false,
  alt: false,
  shift: false,
  meta: false,
});

test("fresh settings show exactly 13 client and 8 full-view base rows", () => {
  const settings = defaultHardwareInputSettings();
  const client = resolveActiveProfile(settings, "client-view");
  const full = resolveActiveProfile(settings, "full-view");
  assert.equal(client.id, FACTORY_PROFILE_ID);
  assert.equal(full.id, FACTORY_PROFILE_ID);
  assert.equal(visibleRows("client-view", client).length, 13);
  assert.equal(visibleRows("full-view", full).length, 8);
});

test("a new empty profile lists the base rows with no binding", () => {
  const profile = createProfile<"client-view">("Új", ids());
  const rows = visibleRows("client-view", profile);
  assert.equal(rows.length, 13);
  assert.ok(rows.every((row) => bindingsForRow(profile, row.id).length === 0));
  assert.ok(rows.every((row) => isBaseRowId("client-view", row.id)));
});

test("extra rows are added by hand, may stay unbound and may repeat a family with other parameters", () => {
  const next = ids();
  let profile = createProfile<"client-view">("Pedálok", next);
  profile = addExtraRow(profile, { action: "transpose", op: "set", value: -2 }, next);
  profile = addExtraRow(profile, { action: "transpose", op: "set", value: 3 }, next);
  profile = addExtraRow(profile, { action: "capo-apply", value: 2 }, next);
  const rows = visibleRows("client-view", profile);
  assert.equal(rows.length, 16);
  assert.deepEqual(
    rows.slice(13).map((row) => row.command),
    [
      { action: "transpose", op: "set", value: -2 },
      { action: "transpose", op: "set", value: 3 },
      { action: "capo-apply", value: 2 },
    ]
  );
  assert.equal(profile.bindings.length, 0, "rows exist without any input");
  assert.deepEqual(findRow("client-view", profile, profile.extraRows[1].id)?.command, { action: "transpose", op: "set", value: 3 });
});

test("removing a binding keeps its row; removing an extra row removes its bindings", () => {
  const next = ids();
  let profile = createProfile<"client-view">("P", next);
  profile = addExtraRow(profile, { action: "chord-diagram", op: "toggle" }, next);
  const rowId = profile.extraRows[0].id;
  profile = addBinding(profile, keyBinding("b1", rowId));
  profile = addBinding(profile, keyBinding("b2", rowId, "F7"));
  profile = addBinding(profile, keyBinding("b3", baseRowId("client-view", "toggle-options"), "F8"));
  profile = removeBinding(profile, "b1");
  assert.equal(profile.extraRows.length, 1);
  assert.deepEqual(
    bindingsForRow(profile, rowId).map((binding) => binding.id),
    ["b2"]
  );
  profile = removeExtraRow(profile, rowId);
  assert.equal(profile.extraRows.length, 0);
  assert.deepEqual(
    profile.bindings.map((binding) => binding.id),
    ["b3"],
    "base-row bindings stay"
  );
  assert.equal(
    removeExtraRow(profile, baseRowId("client-view", "toggle-options")).bindings.length,
    1,
    "a base row is not removable and keeps its bindings"
  );
  assert.equal(visibleRows("client-view", removeExtraRow(profile, baseRowId("client-view", "toggle-options"))).length, 13);
});

test("removeRow hides a base row with its bindings; it can be added back without them; copy and load keep it", () => {
  const next = ids();
  const options = baseRowId("client-view", "toggle-options");
  let profile = createProfile<"client-view">("P", next);
  profile = addExtraRow(profile, { action: "instructions", op: "toggle" }, next);
  const extraId = profile.extraRows[0].id;
  profile = addBinding(profile, keyBinding("b1", options));
  profile = addBinding(profile, keyBinding("b2", extraId, "F7"));
  profile = removeRow("client-view", profile, options);
  profile = removeRow("client-view", profile, options);
  assert.deepEqual(profile.removedBaseRows, [options], "removing twice records the row once");
  assert.equal(visibleRows("client-view", profile).length, 13, "12 base rows + 1 extra row");
  assert.equal(findRow("client-view", profile, options), undefined);
  assert.deepEqual(
    profile.bindings.map((binding) => binding.id),
    ["b2"]
  );
  const copy = copyProfile(profile, "Másolat", ids("copy"));
  assert.deepEqual(copy.removedBaseRows, [options]);
  const loaded = normalizeHardwareInputSettings(upsertProfile(defaultHardwareInputSettings(), "client-view", profile, true));
  assert.deepEqual(loaded.settings.views["client-view"].customProfiles[0].removedBaseRows, [options]);
  const restored = restoreBaseRow(profile, options);
  assert.equal("removedBaseRows" in restored, false, "an empty list is not stored");
  assert.deepEqual(
    visibleRows("client-view", restored).map((row) => row.id),
    [...visibleRows("client-view", createProfile<"client-view">("x", next)).map((row) => row.id), extraId],
    "the base row returns to its fixed position"
  );
  assert.equal(bindingsForRow(restored, options).length, 0);
  profile = removeRow("client-view", profile, extraId);
  assert.equal(profile.extraRows.length, 0);
  assert.equal(profile.bindings.length, 0);
  const keep = restoreBaseRow(removeRow("client-view", profile, baseRowId("client-view", "clear-control")), options);
  assert.deepEqual(keep.removedBaseRows, [baseRowId("client-view", "clear-control")]);
});

test("loading keeps only valid removed base rows of the view and never revives their bindings", () => {
  const options = baseRowId("client-view", "toggle-options");
  const raw = {
    schemaVersion: 1,
    views: {
      "client-view": {
        activeProfileId: "p",
        customProfiles: [
          {
            id: "p",
            name: "P",
            extraRows: [],
            removedBaseRows: [options, options, baseRowId("full-view", "next-down"), 7],
            bindings: [keyBinding("stale", options)],
          },
        ],
      },
      "full-view": { activeProfileId: FACTORY_PROFILE_ID, customProfiles: [] },
    },
  };
  const result = normalizeHardwareInputSettings(raw);
  const profile = result.settings.views["client-view"].customProfiles[0];
  assert.deepEqual(profile.removedBaseRows, [options]);
  assert.equal(profile.bindings.length, 0);
  assert.equal(profile.quarantine?.[0].reason, "binding-row-missing", "the stale binding is preserved, not silently dropped");
  assert.equal(result.diagnostics.filter((item) => item.code === "invalid-removed-row").length, 3);
});

test("copying keeps every extra row, parameter and trigger option with new ids and remapped rows", () => {
  const next = ids("orig");
  let profile = createProfile<"client-view">("Eredeti", next);
  profile = addExtraRow(profile, { action: "zoom-mode", op: "set", value: "FIT_WIDTH" }, next);
  const extraId = profile.extraRows[0].id;
  profile = addBinding(profile, {
    id: "midi-1",
    rowId: extraId,
    kind: "midi",
    mode: "button",
    trigger: "press-edge",
    message: "control-change",
    channel: 2,
    number: 20,
    threshold: 70,
    releaseThreshold: 50,
  });
  profile = addBinding(profile, keyBinding("key-1", baseRowId("client-view", "show-next-song")));
  const copy = copyProfile(profile, "Másolat", ids("copy"));
  assert.notEqual(copy.id, profile.id);
  assert.equal(copy.name, "Másolat");
  assert.deepEqual(copy.extraRows[0].command, profile.extraRows[0].command);
  assert.notEqual(copy.extraRows[0].id, extraId);
  const [midi, key] = copy.bindings;
  assert.equal(midi.rowId, copy.extraRows[0].id, "binding follows its copied row");
  assert.equal(key.rowId, baseRowId("client-view", "show-next-song"), "base-row references are unchanged");
  assert.ok(copy.bindings.every((binding) => !profile.bindings.some((original) => original.id === binding.id)));
  assert.deepEqual({ ...midi, id: "x", rowId: "y" }, { ...profile.bindings[0], id: "x", rowId: "y" });
  copy.extraRows[0].command = { action: "zoom", op: "on" };
  assert.deepEqual(profile.extraRows[0].command, { action: "zoom-mode", op: "set", value: "FIT_WIDTH" }, "no shared command objects");
});

test("copying the factory profile yields an editable profile with the same bindings", () => {
  const settings = defaultHardwareInputSettings();
  const copy = copyProfile(resolveActiveProfile(settings, "full-view"), "Gyári másolata", ids());
  assert.equal(copy.bindings.length, 10);
  assert.notEqual(copy.id, FACTORY_PROFILE_ID);
});

test("profile operations change only their own view branch", () => {
  const next = ids();
  const base = defaultHardwareInputSettings();
  const fullBefore = base.views["full-view"];
  let settings: HardwareInputSettings = upsertProfile(base, "client-view", createProfile("Kliens", next), true);
  settings = upsertProfile(settings, "client-view", createProfile("Kliens 2", next));
  assert.equal(settings.views["full-view"], fullBefore, "full-view branch is the very same object");
  const clientBefore = settings.views["client-view"];
  settings = upsertProfile(settings, "full-view", createProfile("Kliens", next), true);
  assert.equal(settings.views["client-view"], clientBefore);
  assert.equal(settings.views["full-view"].customProfiles[0].name, "Kliens", "the same name is allowed in the other view");
  settings = setActiveProfile(settings, "full-view", FACTORY_PROFILE_ID);
  assert.equal(settings.views["client-view"], clientBefore);
  settings = deleteProfile(settings, "full-view", settings.views["full-view"].customProfiles[0].id);
  assert.equal(settings.views["client-view"], clientBefore);
  assert.equal(settings.views["full-view"].customProfiles.length, 0);
});

test("deleting the active profile falls back to that view's factory profile; the factory cannot be deleted", () => {
  const next = ids();
  const profile = createProfile<"client-view">("Törlendő", next);
  let settings = upsertProfile(defaultHardwareInputSettings(), "client-view", profile, true);
  assert.equal(resolveActiveProfile(settings, "client-view").id, profile.id);
  assert.equal(deleteProfile(settings, "client-view", FACTORY_PROFILE_ID), settings);
  settings = deleteProfile(settings, "client-view", profile.id);
  assert.equal(settings.views["client-view"].activeProfileId, FACTORY_PROFILE_ID);
  assert.equal(resolveActiveProfile(settings, "client-view").id, FACTORY_PROFILE_ID);
});

test("an empty custom profile really has no bindings (no factory fallback)", () => {
  const profile = createProfile<"full-view">("Üres", ids());
  const settings = upsertProfile(defaultHardwareInputSettings(), "full-view", profile, true);
  assert.deepEqual(resolveActiveProfile(settings, "full-view").bindings, []);
});

test("a stale active profile id resolves to the factory profile", () => {
  const settings = setActiveProfile(defaultHardwareInputSettings(), "client-view", "gone");
  assert.equal(resolveActiveProfile(settings, "client-view").id, FACTORY_PROFILE_ID);
});

test("loading quarantines broken rows and bindings but keeps the usable ones", () => {
  const raw = {
    schemaVersion: 1,
    views: {
      "client-view": {
        activeProfileId: "p1",
        customProfiles: [
          {
            id: "p1",
            name: " Saját ",
            extraRows: [
              { id: "r-ok", command: { action: "transpose", op: "set", value: 3 } },
              { id: "r-bad", command: { action: "transpose", op: "set", value: 30 } },
              { id: "r-foreign", command: { action: "next-first" } },
              { id: "r-ok", command: { action: "zoom", op: "on" } },
              { id: baseRowId("client-view", "toggle-options"), command: { action: "zoom", op: "on" } },
              { command: { action: "zoom", op: "on" } },
            ],
            bindings: [
              keyBinding("b-ok", "r-ok"),
              keyBinding("b-orphan", "r-bad"),
              keyBinding("b-ok", baseRowId("client-view", "show-next-song")),
              { id: "b-broken", rowId: "r-ok", kind: "midi", message: "note-on", channel: 99, number: 1 },
            ],
          },
          { id: "p1", name: "Duplicate", extraRows: [], bindings: [] },
          { id: "factory", name: "Hijack", extraRows: [], bindings: [] },
        ],
      },
      "full-view": { activeProfileId: "missing", customProfiles: [] },
    },
  };
  const { settings, diagnostics, status } = normalizeHardwareInputSettings(raw);
  assert.equal(status, "ok");
  const profile = settings.views["client-view"].customProfiles[0] as HardwareProfile<ClientCommand>;
  assert.equal(settings.views["client-view"].customProfiles.length, 1);
  assert.equal(profile.name, "Saját");
  assert.deepEqual(
    profile.extraRows.map((row) => row.id),
    ["r-ok"]
  );
  assert.deepEqual(
    profile.bindings.map((binding) => binding.id),
    ["b-ok"]
  );
  assert.deepEqual(
    profile.quarantine?.map((item) => item.reason),
    [
      "parameter-out-of-range",
      "command-of-other-view",
      "duplicate-row-id",
      "duplicate-row-id",
      "row-without-id",
      "binding-row-missing",
      "duplicate-binding-id",
      "invalid-midi-channel",
    ]
  );
  assert.deepEqual(
    settings.views["client-view"].quarantine?.map((item) => item.reason),
    ["duplicate-profile-id", "profile-invalid-id"]
  );
  assert.equal(settings.views["full-view"].activeProfileId, FACTORY_PROFILE_ID);
  assert.ok(diagnostics.some((diagnostic) => diagnostic.code === "missing-active-profile" && diagnostic.view === "full-view"));
  const again = normalizeHardwareInputSettings(settings);
  assert.deepEqual(again.settings, settings, "normalization is idempotent and keeps the quarantine");
});

test("future schema versions are not interpreted and are flagged for preservation", () => {
  const result = normalizeHardwareInputSettings({ schemaVersion: 2, views: {} });
  assert.equal(result.status, "future-schema");
  assert.equal(resolveActiveProfile(result.settings, "client-view").id, FACTORY_PROFILE_ID);
  assert.equal(normalizeHardwareInputSettings({ schemaVersion: 0 }).status, "invalid");
  assert.equal(normalizeHardwareInputSettings("x").status, "invalid");
});

test("copying keeps quarantined data and upsert replaces an existing profile in place", () => {
  const next = ids();
  const profile: HardwareProfile<ClientCommand> = {
    ...createProfile<"client-view">("Q", next),
    quarantine: [{ kind: "row", reason: "parameter-out-of-range", item: { id: "x" } }],
  };
  assert.deepEqual(copyProfile(profile, "Q2", next).quarantine, profile.quarantine);
  let settings = upsertProfile(defaultHardwareInputSettings(), "client-view", profile, true);
  settings = upsertProfile(settings, "client-view", { ...profile, name: "Renamed" });
  assert.equal(settings.views["client-view"].customProfiles.length, 1);
  assert.equal(settings.views["client-view"].customProfiles[0].name, "Renamed");
  assert.equal(settings.views["client-view"].activeProfileId, profile.id);
});

test("loading tolerates missing or malformed containers at every level", () => {
  const { settings, diagnostics } = normalizeHardwareInputSettings({
    schemaVersion: 1,
    views: {
      "client-view": {
        activeProfileId: 7,
        customProfiles: [
          "not-a-profile",
          { id: "p-min" },
          {
            id: "p-mixed",
            name: 5,
            extraRows: "nope",
            bindings: [null, { id: 3, rowId: "x", kind: "keyboard" }],
            quarantine: [{ kind: "row", reason: "kept", item: 1 }, { kind: "bogus" }, null],
          },
        ],
      },
    },
  });
  const client = settings.views["client-view"];
  assert.equal(client.activeProfileId, FACTORY_PROFILE_ID);
  assert.deepEqual(
    client.customProfiles.map((profile) => [profile.id, profile.name, profile.extraRows.length, profile.bindings.length]),
    [
      ["p-min", "Névtelen profil", 0, 0],
      ["p-mixed", "Névtelen profil", 0, 0],
    ]
  );
  assert.deepEqual(
    client.customProfiles[1].quarantine?.map((item) => item.reason),
    ["kept", "binding-not-object", "binding-without-id"]
  );
  assert.deepEqual(
    client.quarantine?.map((item) => item.reason),
    ["profile-not-object"]
  );
  assert.deepEqual(settings.views["full-view"], { activeProfileId: FACTORY_PROFILE_ID, customProfiles: [] });
  assert.ok(diagnostics.some((diagnostic) => diagnostic.code === "view-settings-missing" && diagnostic.view === "full-view"));
  const noViews = normalizeHardwareInputSettings({ schemaVersion: 1 });
  assert.equal(noViews.status, "ok");
  assert.equal(noViews.settings.views["client-view"].customProfiles.length, 0);
  const listless = normalizeHardwareInputSettings({ schemaVersion: 1, views: { "client-view": { customProfiles: "x" }, "full-view": "y" } });
  assert.deepEqual(listless.settings.views["client-view"].customProfiles, []);
});
