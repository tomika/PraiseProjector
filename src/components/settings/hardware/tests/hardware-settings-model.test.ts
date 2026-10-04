/**
 * The settings tab's pure model: what "Add action" offers (only addable
 * families, removed base rows, no duplicate parameterless rows), the live
 * accent-insensitive filter, and the compact row / input labels.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import huStrings from "../../../../localization/strings.hu.json";
import {
  FACTORY_FULL_PROFILE,
  addExtraRow,
  baseRowId,
  createProfile,
  removeRow,
  type HardwareKeyboardBinding,
  type HardwareMidiBinding,
} from "../../../../../common/hardware-input";
import { addableFamilies } from "../../../../../common/hardware-action-catalog";
import {
  actionEntries,
  addActionEntries,
  bindingChipLabel,
  bindingDetails,
  commandLabel,
  entryCommand,
  filterEntries,
  groupCheckState,
  keyName,
  toggleGroup,
} from "../hardwareSettingsModel";

const hu = (key: string) => (huStrings as Record<string, string>)[key] ?? key;
const ids = () => {
  let next = 0;
  return () => `id-${++next}`;
};

const key = (overrides: Partial<HardwareKeyboardBinding> = {}): HardwareKeyboardBinding => ({
  id: "k",
  rowId: "r",
  kind: "keyboard",
  match: "code",
  key: "F6",
  ctrl: false,
  alt: false,
  shift: false,
  meta: false,
  ...overrides,
});
const midi = (overrides: Partial<HardwareMidiBinding> = {}): HardwareMidiBinding => ({
  id: "m",
  rowId: "r",
  kind: "midi",
  mode: "button",
  trigger: "press-edge",
  message: "note-on",
  channel: 1,
  number: 36,
  ...overrides,
});

test("Add action offers every operation of every addable family, grouped in catalog order, and no present base row", () => {
  const profile = createProfile<"client-view">("P", ids());
  const entries = actionEntries("client-view", profile, hu);
  const expected = addableFamilies("client-view").flatMap((family) => family.ops.map((op) => `${family.action}:${op.op}`));
  assert.deepEqual(
    entries.map((entry) => entry.key),
    expected
  );
  assert.ok(entries.every((entry) => !entry.baseRowId && !entry.listed));
  assert.equal(entries[0].label, "Előválasztott dal – megjelenítés");
  assert.equal(entries[0].groupLabel, "Navigáció", "the preselected-song actions join the base navigation rows");
  assert.equal(entries.find((entry) => entry.key === "chord-mode:next")?.groupLabel, "Akkordok");
  assert.deepEqual(actionEntries("full-view", FACTORY_FULL_PROFILE, hu), [], "the full view has no extra families in P0");
});

test("a removed base row is offered again; a parameterless command already listed is marked", () => {
  const next = ids();
  let profile = createProfile<"client-view">("P", next);
  profile = removeRow("client-view", profile, baseRowId("client-view", "clear-control"));
  profile = addExtraRow(profile, { action: "instructions", op: "toggle" }, next);
  profile = addExtraRow(profile, { action: "transpose", op: "set", value: 2 }, next);
  const entries = actionEntries("client-view", profile, hu);
  const restored = entries.find((entry) => entry.baseRowId);
  assert.equal(restored?.baseRowId, baseRowId("client-view", "clear-control"));
  assert.equal(restored?.groupLabel, "Navigáció");
  assert.deepEqual(entryCommand(restored!), { action: "clear-control" });
  assert.equal(entries.find((entry) => entry.key === "instructions:toggle")?.listed, true);
  assert.equal(entries.find((entry) => entry.key === "instructions:on")?.listed, false);
  assert.equal(entries.find((entry) => entry.key === "transpose:set")?.listed, false, "parameterized operations stay addable");
  const full = removeRow("full-view", FACTORY_FULL_PROFILE, baseRowId("full-view", "next-down"));
  assert.deepEqual(
    actionEntries("full-view", full, hu).map((entry) => entry.key),
    ["next-down"]
  );
});

test("entry commands carry the operation and parameter; capo-apply has no op field", () => {
  const entries = actionEntries("client-view", createProfile<"client-view">("P", ids()), hu);
  const byKey = (k: string) => entries.find((entry) => entry.key === k)!;
  assert.deepEqual(entryCommand(byKey("transpose:set"), -3), { action: "transpose", op: "set", value: -3 });
  assert.deepEqual(entryCommand(byKey("transpose:step"), 2), { action: "transpose", op: "step", step: 2 });
  assert.deepEqual(entryCommand(byKey("capo-apply:apply"), 4), { action: "capo-apply", value: 4 });
  assert.deepEqual(entryCommand(byKey("zoom:on")), { action: "zoom", op: "on" });
});

test("the live filter ignores case and accents, needs every word and also matches enum value labels", () => {
  const entries = actionEntries("client-view", createProfile<"client-view">("P", ids()), hu);
  assert.equal(filterEntries(entries, "", hu).length, entries.length);
  assert.equal(filterEntries(entries, "   ", hu).length, entries.length);
  assert.deepEqual(
    filterEntries(entries, "TRANSZPONALAS beall", hu).map((entry) => entry.key),
    ["preselected-transpose:set", "transpose:set"]
  );
  assert.deepEqual(
    filterEntries(entries, "elovalasztott transzp beall", hu).map((entry) => entry.key),
    ["preselected-transpose:set"]
  );
  assert.deepEqual(
    filterEntries(entries, "gitár", hu).map((entry) => entry.key),
    ["chord-mode:set"],
    "an enum value label finds its operation"
  );
  assert.ok(
    filterEntries(entries, "capo", hu).every((entry) => entry.groupLabel === "Capo" || entry.family.action === "preselected-capo"),
    "the Capo group, and the preselected song's playlist capo"
  );
  assert.ok(filterEntries(entries, "zoom", hu).length >= 6, "a group name matches the whole group");
  assert.deepEqual(filterEntries(entries, "nincs ilyen művelet", hu), []);
});

test("row labels show family, operation and parameter", () => {
  assert.equal(commandLabel("client-view", { action: "toggle-options" }, hu), "Opciópanel megnyitása / bezárása");
  assert.equal(commandLabel("client-view", { action: "transpose", op: "set", value: -2 }, hu), "Transzponálás · beállítás · -2");
  assert.equal(commandLabel("client-view", { action: "transpose", op: "step", step: 1 }, hu), "Transzponálás · léptetés · 1");
  assert.equal(
    commandLabel("client-view", { action: "chord-mode", op: "set", value: "piano" }, hu),
    "Akkordmegjelenítési mód · beállítás · zongoradiagram"
  );
  assert.equal(commandLabel("client-view", { action: "capo-apply", value: 3 }, hu), "Capo alkalmazása (érték és bekapcsolás) · alkalmazás · 3");
  assert.equal(commandLabel("client-view", { action: "zoom", op: "on" }, hu), "Zoom / maximális szöveg · bekapcsolás");
  assert.equal(commandLabel("client-view", { action: "chord-mode", op: "set", value: "bogus" }, hu), "Akkordmegjelenítési mód · beállítás · bogus");
  assert.equal(
    commandLabel("client-view", { action: "preselected-song", op: "move-down" }, hu),
    "Előválasztott dal · mozgatás lejjebb a lejátszási listában"
  );
  assert.equal(commandLabel("full-view", { action: "next-down" }, hu), "Következő jelzés lefelé");
  assert.equal(commandLabel("full-view", { action: "unknown-action" }, hu), "unknown-action");
});

test("key names are readable for physical, legacy and logical bindings", () => {
  const cases: [HardwareKeyboardBinding["match"], string, string][] = [
    ["code", "KeyA", "A"],
    ["code", "Digit7", "7"],
    ["code", "Numpad7", "Num 7"],
    ["code", "NumpadAdd", "Num +"],
    ["code", "F6", "F6"],
    ["code", "ArrowUp", "↑"],
    ["code", "Space", "Space"],
    ["legacy-key", "PAGEUP", "PgUp"],
    ["legacy-key", "UP", "↑"],
    ["legacy-key", "NUMPAD_7", "Num 7"],
    ["legacy-key", "HOME", "Home"],
    ["key", "PageDown", "PgDn"],
    ["key", " ", "Space"],
    ["key", "a", "A"],
    ["key", "F12", "F12"],
  ];
  for (const [match, value, expected] of cases) assert.equal(keyName({ match, key: value }), expected, `${match}:${value}`);
});

test("input chips are compact; uncommon options are appended; tooltips give the full description", () => {
  assert.equal(bindingChipLabel(key(), hu), "F6");
  assert.equal(bindingChipLabel(key({ ctrl: true, shift: true, key: "KeyP" }), hu), "Ctrl+Shift+P");
  assert.equal(bindingChipLabel(key({ alt: true, meta: true, key: "KeyQ" }), hu), "Alt+Meta+Q");
  assert.equal(bindingChipLabel(key({ match: "legacy-key", key: "NUMPAD7", numLock: "off" }), hu), "Num 7 · NumLock ki");
  assert.equal(bindingChipLabel(key({ numLock: "any", scope: "full-view" }), hu), "F6 · teljes nézet");
  assert.equal(bindingChipLabel(midi(), hu), "Note 36 · csat. 1");
  assert.equal(
    bindingChipLabel(midi({ message: "control-change", channel: "any", number: 64, trigger: "legacy-level" }), hu),
    "CC 64 · bármely csat. · régi"
  );
  assert.equal(bindingChipLabel(midi({ message: "program-change", number: 0 }), hu), "Program 0 · csat. 1");
  assert.equal(
    bindingDetails(key({ match: "legacy-key", key: "HOME", scope: "section-list" }), hu),
    "Home · régi logikai billentyű · Bármely NumLock állapot · Fókuszban lévő szakaszlista"
  );
  assert.equal(
    bindingDetails(key({ numLock: "on", scope: "full-view" }), hu),
    "F6 · NumLock be · teljes nézet · fizikai billentyű · NumLock bekapcsolva · Teljes nézet minden panelje"
  );
  assert.equal(bindingDetails(midi({ channel: "any" }), hu), "Note · Bármely csatorna · #36 · Lenyomásonként egyszer");
  assert.equal(
    bindingDetails(midi({ message: "control-change", number: 64, trigger: "legacy-level", threshold: 70 }), hu),
    "Kontroller (CC) · Csatorna 1 · #64 · Régi ismétlődő aktiválás · ≥70 / ≤69"
  );
  assert.equal(bindingDetails(midi({ message: "control-change", number: 1, threshold: 80, releaseThreshold: 10 }), hu).endsWith("≥80 / ≤10"), true);
  assert.equal(bindingDetails(midi({ message: "control-change", number: 1 }), hu).endsWith("≥64 / ≤63"), true);
});

test("a group header's tick covers the group's tickable entries: all, some or none, and toggles them together", () => {
  let profile = createProfile<"client-view">("P", ids());
  profile = addExtraRow(profile, { action: "instructions", op: "toggle" }, ids());
  const group = actionEntries("client-view", profile, hu).filter((entry) => entry.family.action === "instructions");
  assert.deepEqual(
    group.map((entry) => [entry.key, entry.listed]),
    [
      ["instructions:toggle", true],
      ["instructions:on", false],
      ["instructions:off", false],
    ]
  );
  assert.equal(groupCheckState(group, new Set()), "none");
  const all = toggleGroup(group, new Set(["other"]));
  assert.deepEqual([...all].sort(), ["instructions:off", "instructions:on", "other"], "an already listed entry is never ticked");
  assert.equal(groupCheckState(group, all), "all");
  assert.equal(groupCheckState(group, new Set(["instructions:on"])), "some");
  assert.deepEqual([...toggleGroup(group, new Set(["instructions:on"]))].sort(), ["instructions:off", "instructions:on"], "some → all");
  assert.deepEqual([...toggleGroup(group, all)], ["other"], "all → none, other ticks stay");
});

test("ticked entries are added at once: base rows come back, operations become rows; one bad entry adds nothing", () => {
  const next = ids();
  let profile = createProfile<"client-view">("P", next);
  profile = removeRow("client-view", profile, baseRowId("client-view", "clear-control"));
  profile = addExtraRow(profile, { action: "transpose", op: "set", value: 2 }, next);
  const entries = actionEntries("client-view", profile, hu);
  const byKey = (k: string) => entries.find((entry) => entry.key === k)!;
  const added = addActionEntries(
    "client-view",
    profile,
    [{ entry: byKey("clear-control") }, { entry: byKey("zoom:on") }, { entry: byKey("transpose:set"), value: 5 }],
    () => "new"
  );
  assert.ok(added.ok);
  assert.deepEqual(added.rowIds, [baseRowId("client-view", "clear-control"), "new", "new"]);
  assert.equal(added.profile.removedBaseRows, undefined);
  assert.deepEqual(
    added.profile.extraRows.map((row) => row.command),
    [
      { action: "transpose", op: "set", value: 2 },
      { action: "zoom", op: "on" },
      { action: "transpose", op: "set", value: 5 },
    ]
  );
  const duplicate = addActionEntries("client-view", profile, [{ entry: byKey("zoom:on") }, { entry: byKey("transpose:set"), value: 2 }], next);
  assert.deepEqual(duplicate.ok ? null : [duplicate.reason, duplicate.entry.key], ["duplicate", "transpose:set"]);
  const invalid = addActionEntries("client-view", profile, [{ entry: byKey("zoom:on") }, { entry: byKey("transpose:set"), value: 40 }], next);
  assert.deepEqual(invalid.ok ? null : [invalid.reason, invalid.entry.key], ["invalid", "transpose:set"]);
  assert.equal(profile.extraRows.length, 1, "the profile itself is never changed");
});
