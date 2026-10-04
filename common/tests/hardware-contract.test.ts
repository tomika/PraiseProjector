/**
 * T01 — the view-bound command contract: catalog domains, runtime parameter
 * validation, foreign-view rejection, binding validation and the factory
 * definitions of both views.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import {
  HARDWARE_CATALOG,
  addableFamilies,
  catalogFamily,
  catalogLabelKeys,
  commandSignature,
  paramError,
  validateCommand,
} from "../hardware-action-catalog";
import {
  CLIENT_BASE_ROWS,
  FACTORY_CLIENT_PROFILE,
  FACTORY_FULL_PROFILE,
  FULL_BASE_ROWS,
  SECTION_CONTROL_COMMANDS,
  baseRowId,
  factoryProfile,
} from "../hardware-input";
import { CLIENT_VIEW_INPUT_ACTIONS, FACTORY_CLIENT_VIEW_INPUT_PROFILE } from "../client-view-input";
import { validateBinding } from "../hardware-input-validation";

const range = (min: number, max: number) => Array.from({ length: max - min + 1 }, (_, i) => min + i);

test("every transpose value −11…+11 is a valid fixed command (23 values) and nothing beyond", () => {
  const valid = range(-11, 11).filter((value) => validateCommand("client-view", { action: "transpose", op: "set", value }).ok);
  assert.equal(valid.length, 23);
  for (const value of [-12, 12, 0.5, Number.NaN, Infinity, "3", null]) {
    assert.equal(validateCommand("client-view", { action: "transpose", op: "set", value }).ok, false, String(value));
  }
});

test("every capo value −1…11 is valid for set and apply (13 values)", () => {
  for (const action of ["capo", "capo-apply"]) {
    const valid = range(-1, 11).filter((value) => validateCommand("client-view", { action, op: "set", value }).ok);
    assert.equal(valid.length, 13, action);
    assert.equal(validateCommand("client-view", { action, op: "set", value: -2 }).ok, false);
    assert.equal(validateCommand("client-view", { action, op: "set", value: 12 }).ok, false);
  }
});

test("manual font size 10…64 px and non-zero integer steps", () => {
  assert.equal(
    range(10, 64).every((value) => validateCommand("client-view", { action: "zoom-font", op: "set", value }).ok),
    true
  );
  for (const value of [9, 65, 20.5]) assert.equal(validateCommand("client-view", { action: "zoom-font", op: "set", value }).ok, false);
  assert.equal(validateCommand("client-view", { action: "zoom-font", op: "step", step: 0 }).ok, false);
  assert.equal(validateCommand("client-view", { action: "zoom-font", op: "step", step: -2 }).ok, true);
  assert.equal(validateCommand("client-view", { action: "zoom-font", op: "reset" }).ok, false, "zoom-font has no reset");
});

test("transpose and capo steps are non-zero integers within the domain width", () => {
  assert.equal(validateCommand("client-view", { action: "transpose", op: "step", step: 1 }).ok, true);
  assert.equal(validateCommand("client-view", { action: "transpose", op: "step", step: -11 }).ok, true);
  assert.equal(validateCommand("client-view", { action: "transpose", op: "step", step: 0 }).ok, false);
  assert.equal(validateCommand("client-view", { action: "transpose", op: "step", step: 12 }).ok, false);
  assert.equal(validateCommand("client-view", { action: "capo", op: "step", step: 12 }).ok, true);
  assert.equal(validateCommand("client-view", { action: "capo", op: "reset" }).ok, true);
  assert.equal(validateCommand("client-view", { action: "transpose", op: "reset" }).ok, true);
});

test("enum parameters accept exactly their known values", () => {
  const cases: [string, unknown[], unknown[]][] = [
    ["chord-mode", ["inline", "guitar", "piano", "hidden"], ["GUITAR", "", "none"]],
    ["minor-notation", [0, 1, 3], [2, "0", 4]],
    ["zoom-mode", ["FIT_PAGE", "FIT_WIDTH", "MANUAL"], ["AUTO_HEIGHT", "fit_page"]],
    ["note-names", ["english", "german"], ["B", "H"]],
  ];
  for (const [action, good, bad] of cases) {
    for (const value of good) assert.equal(validateCommand("client-view", { action, op: "set", value }).ok, true, `${action}=${String(value)}`);
    for (const value of bad) assert.equal(validateCommand("client-view", { action, op: "set", value }).ok, false, `${action}=${String(value)}`);
  }
});

test("toggle families accept toggle/on/off only", () => {
  const toggles = HARDWARE_CATALOG.filter((family) => family.ops.length === 3 && family.ops[0].op === "toggle");
  assert.deepEqual(toggles.map((family) => family.action).sort(), [
    "auto-tone",
    "capo-use",
    "chord-diagram",
    "chord-visibility",
    "instructions",
    "omit-repeated-chords",
    "simplified",
    "superscript",
    "zoom",
  ]);
  for (const family of toggles) {
    for (const op of ["toggle", "on", "off"]) assert.equal(validateCommand("client-view", { action: family.action, op }).ok, true);
    assert.equal(validateCommand("client-view", { action: family.action, op: "next" }).ok, false);
  }
});

test("validation normalizes away unknown keys and rejects malformed or foreign commands", () => {
  assert.deepEqual(validateCommand("client-view", { action: "transpose", op: "set", value: 3, extra: true }), {
    ok: true,
    command: { action: "transpose", op: "set", value: 3 },
  });
  assert.deepEqual(validateCommand("client-view", { action: "toggle-options", op: "ignored" }), { ok: true, command: { action: "toggle-options" } });
  assert.deepEqual(validateCommand("client-view", { action: "next-first" }), { ok: false, reason: "command-of-other-view" });
  assert.deepEqual(validateCommand("full-view", { action: "transpose", op: "set", value: 1 }), { ok: false, reason: "command-of-other-view" });
  assert.deepEqual(validateCommand("full-view", { action: "toggle-options" }), { ok: false, reason: "command-of-other-view" });
  assert.deepEqual(validateCommand("client-view", { action: "launch" }), { ok: false, reason: "unknown-command" });
  assert.deepEqual(validateCommand("client-view", null), { ok: false, reason: "command-not-object" });
  assert.deepEqual(validateCommand("client-view", {}), { ok: false, reason: "command-without-action" });
  assert.deepEqual(validateCommand("client-view", { action: "transpose", op: "multiply" }), { ok: false, reason: "unknown-operation" });
  assert.deepEqual(validateCommand("client-view", { action: "capo-apply", value: 3 }), { ok: true, command: { action: "capo-apply", value: 3 } });
});

test("paramError reports the precise reason", () => {
  const spec = { kind: "int", name: "value", min: 0, max: 5, default: 0 } as const;
  assert.equal(paramError(spec, Number.NaN), "parameter-not-finite");
  assert.equal(paramError(spec, 1.5), "parameter-not-integer");
  assert.equal(paramError(spec, 6), "parameter-out-of-range");
  assert.equal(paramError({ ...spec, nonZero: true }, 0), "parameter-zero-step");
  assert.equal(paramError(spec, 5), null);
});

test("the catalog splits by view: 13 client base rows, 8 full-view base rows, extras client-only in P0", () => {
  assert.equal(HARDWARE_CATALOG.filter((family) => family.view === "client-view" && family.base).length, 13);
  assert.equal(HARDWARE_CATALOG.filter((family) => family.view === "full-view" && family.base).length, 8);
  assert.deepEqual(addableFamilies("full-view"), []);
  assert.equal(addableFamilies("client-view").length, 20);
  assert.ok(addableFamilies("client-view").every((family) => !family.base && family.priority === "P0"));
  assert.equal(catalogFamily("client-view", "next-first"), undefined);
});

test("every catalog label exists in both languages", () => {
  for (const language of ["en", "hu"]) {
    const strings = JSON.parse(readFileSync(new URL(`../../src/localization/strings.${language}.json`, import.meta.url), "utf8")) as Record<
      string,
      string
    >;
    const missing = catalogLabelKeys().filter((key) => typeof strings[key] !== "string" || !strings[key]);
    assert.deepEqual(missing, [], language);
  }
});

test("commandSignature is key-order independent and parameter sensitive", () => {
  assert.equal(commandSignature({ action: "transpose", op: "set", value: 2 }), commandSignature({ value: 2, op: "set", action: "transpose" }));
  assert.notEqual(commandSignature({ action: "transpose", op: "set", value: 2 }), commandSignature({ action: "transpose", op: "set", value: -2 }));
});

test("client factory profile = the legacy factory bindings re-pointed at base rows", () => {
  assert.equal(FACTORY_CLIENT_PROFILE.bindings.length, 13);
  FACTORY_CLIENT_VIEW_INPUT_PROFILE.bindings.forEach((legacy, index) => {
    const binding = FACTORY_CLIENT_PROFILE.bindings[index];
    const { action, ...rest } = legacy;
    assert.deepEqual(binding, { ...rest, rowId: baseRowId("client-view", action) });
  });
  assert.deepEqual(
    CLIENT_BASE_ROWS.map((row) => row.command.action),
    CLIENT_VIEW_INPUT_ACTIONS
  );
  assert.equal(factoryProfile("client-view"), FACTORY_CLIENT_PROFILE);
});

test("full-view factory: the existing section-list keys on the 8 base rows, Left/Right as extra keys", () => {
  assert.deepEqual(
    FULL_BASE_ROWS.map((row) => row.command.action),
    SECTION_CONTROL_COMMANDS
  );
  const byRow = new Map<string, string[]>();
  for (const binding of FACTORY_FULL_PROFILE.bindings) {
    assert.equal(binding.kind, "keyboard");
    if (binding.kind !== "keyboard") continue;
    assert.equal(binding.match, "key");
    assert.equal(binding.modifiers, "ignore");
    assert.equal(binding.repeat, "allow");
    assert.equal(binding.scope, "section-list");
    byRow.set(binding.rowId, [...(byRow.get(binding.rowId) ?? []), binding.key]);
  }
  assert.deepEqual(Object.fromEntries(byRow), {
    [baseRowId("full-view", "next-first")]: ["Home"],
    [baseRowId("full-view", "next-previous-block")]: ["PageUp"],
    [baseRowId("full-view", "next-up")]: ["ArrowUp", "ArrowLeft"],
    [baseRowId("full-view", "project-current-block-start")]: ["Backspace"],
    [baseRowId("full-view", "next-last")]: ["End"],
    [baseRowId("full-view", "next-next-block")]: ["PageDown"],
    [baseRowId("full-view", "next-down")]: ["ArrowDown", "ArrowRight"],
    [baseRowId("full-view", "project-next-or-repeat")]: ["Enter"],
  });
  assert.equal(FACTORY_FULL_PROFILE.extraRows.length, 0);
});

test("binding validation: keyboard fields, scope only in the full view, MIDI ranges", () => {
  const key = { id: "k", rowId: "r", kind: "keyboard", match: "code", key: "F6", ctrl: false, alt: false, shift: false, meta: false };
  assert.equal(validateBinding("client-view", key).ok, true);
  assert.deepEqual(validateBinding("client-view", { ...key, scope: "full-view" }), { ok: false, reason: "scope-outside-full-view" });
  assert.equal(validateBinding("full-view", { ...key, scope: "full-view" }).ok, true);
  assert.deepEqual(validateBinding("full-view", { ...key, numLock: "off", modifiers: "ignore", repeat: "allow", scope: "section-list" }), {
    ok: true,
    binding: { ...key, numLock: "off", modifiers: "ignore", repeat: "allow", scope: "section-list" },
  });
  assert.deepEqual(validateBinding("full-view", { ...key, scope: "everywhere" }), { ok: false, reason: "invalid-scope" });
  assert.deepEqual(validateBinding("client-view", { ...key, match: "regex" }), { ok: false, reason: "invalid-key-match" });
  assert.deepEqual(validateBinding("client-view", { ...key, key: "" }), { ok: false, reason: "missing-key" });
  assert.deepEqual(validateBinding("client-view", { ...key, alt: "no" }), { ok: false, reason: "invalid-modifier-flag" });
  assert.deepEqual(validateBinding("client-view", { ...key, numLock: "maybe" }), { ok: false, reason: "invalid-numlock" });
  assert.deepEqual(validateBinding("client-view", { ...key, modifiers: "some" }), { ok: false, reason: "invalid-modifier-policy" });
  assert.deepEqual(validateBinding("client-view", { ...key, repeat: "twice" }), { ok: false, reason: "invalid-repeat-policy" });
  assert.deepEqual(validateBinding("client-view", { ...key, rowId: "" }), { ok: false, reason: "binding-without-row" });
  assert.deepEqual(validateBinding("client-view", { ...key, id: 3 }), { ok: false, reason: "binding-without-id" });
  assert.deepEqual(validateBinding("client-view", { ...key, kind: "gamepad" }), { ok: false, reason: "unknown-binding-kind" });
  assert.deepEqual(validateBinding("client-view", "x"), { ok: false, reason: "binding-not-object" });

  const midi = { id: "m", rowId: "r", kind: "midi", mode: "button", trigger: "press-edge", message: "control-change", channel: 1, number: 20 };
  assert.equal(validateBinding("full-view", midi).ok, true);
  for (const channel of [1, 16, "any"]) assert.equal(validateBinding("client-view", { ...midi, channel }).ok, true, String(channel));
  for (const channel of [0, 17, 1.5, "1"])
    assert.deepEqual(validateBinding("client-view", { ...midi, channel }), { ok: false, reason: "invalid-midi-channel" });
  for (const number of [0, 127]) assert.equal(validateBinding("client-view", { ...midi, number }).ok, true);
  for (const number of [-1, 128, 2.2])
    assert.deepEqual(validateBinding("client-view", { ...midi, number }), { ok: false, reason: "invalid-midi-number" });
  assert.deepEqual(validateBinding("client-view", { ...midi, message: "pitch-bend" }), { ok: false, reason: "invalid-midi-message" });
  assert.deepEqual(validateBinding("client-view", { ...midi, mode: "absolute" }), { ok: false, reason: "midi-mode-not-supported" });
  assert.deepEqual(validateBinding("client-view", { ...midi, trigger: "always" }), { ok: false, reason: "invalid-midi-trigger" });
  assert.deepEqual(validateBinding("client-view", { ...midi, threshold: 0 }), { ok: false, reason: "invalid-cc-threshold" });
  assert.equal(validateBinding("client-view", { ...midi, trigger: "legacy-level", threshold: 0 }).ok, true);
  assert.deepEqual(validateBinding("client-view", { ...midi, threshold: 64, releaseThreshold: 64 }), {
    ok: false,
    reason: "invalid-cc-release-threshold",
  });
  assert.equal(validateBinding("client-view", { ...midi, threshold: 64, releaseThreshold: 40 }).ok, true);
  const withoutTrigger = validateBinding("client-view", { ...midi, trigger: undefined, mode: undefined });
  assert.equal(withoutTrigger.ok && withoutTrigger.binding.kind === "midi" && withoutTrigger.binding.trigger, "press-edge");
});

test("the common hardware contract stays DOM-, React-, Electron- and adapter-free", () => {
  for (const file of ["hardware-input.ts", "hardware-action-catalog.ts", "hardware-input-validation.ts"]) {
    const source = readFileSync(new URL(`../${file}`, import.meta.url), "utf8");
    const code = source.replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, "");
    for (const forbidden of [
      /\bwindow\./,
      /\bdocument\./,
      /\bnavigator\./,
      /\bKeyboardEvent\b/,
      /\bHTMLElement\b/,
      /from "react/,
      /electron/,
      /from "\.\.\/src\//,
    ]) {
      assert.doesNotMatch(code, forbidden, `${file} must not use ${forbidden}`);
    }
  }
});
