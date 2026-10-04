/**
 * Characterization of the persisted legacy client-view input contract (R01, R02):
 * profile normalization and alias expansion, active-profile resolution, the MIDI
 * byte parser and the legacy (level-triggered) MIDI matcher.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  CLIENT_VIEW_INPUT_ACTIONS,
  FACTORY_CLIENT_VIEW_INPUT_PROFILE,
  formatKeyboardBinding,
  formatMidiBinding,
  matchesMidiBinding,
  normalizeClientViewInputProfiles,
  parseMidiMessage,
  resolveClientViewInputProfile,
  type ClientViewMidiBinding,
} from "../client-view-input";
import { LEGACY_SETTINGS_FIXTURES } from "../../tests/support/legacyProfiles";

test("the 13 legacy actions keep their stable ids and order", () => {
  assert.deepEqual(CLIENT_VIEW_INPUT_ACTIONS, [
    "toggle-options",
    "show-previous-song",
    "show-next-song",
    "select-previous-visible-song",
    "select-next-visible-song",
    "select-first-control",
    "cycle-next-main-control",
    "select-previous-option-control",
    "select-next-option-control",
    "activate-option-control",
    "decrease-main-control",
    "increase-main-control",
    "clear-control",
  ]);
});

test("the factory profile keeps its 13 legacy-key bindings", () => {
  assert.equal(FACTORY_CLIENT_VIEW_INPUT_PROFILE.id, "factory");
  assert.deepEqual(
    FACTORY_CLIENT_VIEW_INPUT_PROFILE.bindings.map((binding) => [binding.id, binding.action, binding.kind === "keyboard" && binding.key]),
    [
      ["factory-home", "toggle-options", "HOME"],
      ["factory-page-up-song", "show-previous-song", "PAGEUP"],
      ["factory-page-up-options", "select-previous-visible-song", "PAGEUP"],
      ["factory-page-down-song", "show-next-song", "PAGEDOWN"],
      ["factory-page-down-options", "select-next-visible-song", "PAGEDOWN"],
      ["factory-seven-song", "cycle-next-main-control", "7"],
      ["factory-seven-options", "activate-option-control", "7"],
      ["factory-nine-song", "decrease-main-control", "9"],
      ["factory-nine-options", "select-previous-option-control", "9"],
      ["factory-three-song", "increase-main-control", "3"],
      ["factory-three-options", "select-next-option-control", "3"],
      ["factory-numlock-on", "select-first-control", "NUMLOCK"],
      ["factory-numlock-off", "clear-control", "NUMLOCK"],
    ]
  );
});

test("legacy action aliases expand into the context-specific actions with derived ids", () => {
  const [profile] = normalizeClientViewInputProfiles(LEGACY_SETTINGS_FIXTURES.aliases.clientViewInputProfiles);
  assert.deepEqual(
    profile.bindings.map((binding) => [binding.id, binding.action]),
    [
      ["k1", "show-previous-song"],
      ["k1-select-previous-visible-song", "select-previous-visible-song"],
      ["m1", "cycle-next-main-control"],
      ["m1-activate-option-control", "activate-option-control"],
      ["m2", "increase-main-control"],
    ]
  );
  assert.deepEqual(normalizeClientViewInputProfiles(LEGACY_SETTINGS_FIXTURES.aliases.clientViewInputProfiles), [profile], "deterministic");
});

test("malformed persisted profiles and bindings are dropped, valid ones kept in order", () => {
  const profiles = normalizeClientViewInputProfiles(LEGACY_SETTINGS_FIXTURES.malformed.clientViewInputProfiles);
  assert.deepEqual(
    profiles.map((profile) => [profile.id, profile.name, profile.bindings.map((binding) => binding.id)]),
    [
      ["p-good", "Good", ["ok-key", "ok-cc"]],
      ["p-blank", "Névtelen profil", []],
    ]
  );
  assert.deepEqual(normalizeClientViewInputProfiles("nope"), []);
  assert.deepEqual(normalizeClientViewInputProfiles(null), []);
});

test("active profile resolution falls back to the factory profile", () => {
  const custom = LEGACY_SETTINGS_FIXTURES.custom;
  assert.equal(resolveClientViewInputProfile(custom.clientViewActiveInputProfileId, custom.clientViewInputProfiles).id, "p-custom");
  assert.equal(resolveClientViewInputProfile("missing", custom.clientViewInputProfiles).id, "factory");
  assert.equal(resolveClientViewInputProfile("factory", custom.clientViewInputProfiles).id, "factory");
  assert.equal(resolveClientViewInputProfile(undefined, undefined).id, "factory");
  const empty = resolveClientViewInputProfile("p-empty", [{ id: "p-empty", name: "Empty", bindings: [] }]);
  assert.deepEqual(empty.bindings, [], "an empty custom profile stays empty");
});

test("MIDI parser: Note On, CC and Program Change; Note Off and velocity 0 are dropped", () => {
  assert.deepEqual(parseMidiMessage([0x90, 36, 100]), { message: "note-on", channel: 1, number: 36, value: 100 });
  assert.deepEqual(parseMidiMessage([0x9f, 127, 1]), { message: "note-on", channel: 16, number: 127, value: 1 });
  assert.equal(parseMidiMessage([0x90, 36, 0]), null);
  assert.equal(parseMidiMessage([0x80, 36, 64]), null);
  assert.deepEqual(parseMidiMessage([0xb0, 20, 0]), { message: "control-change", channel: 1, number: 20, value: 0 });
  assert.deepEqual(parseMidiMessage([0xbf, 0, 127]), { message: "control-change", channel: 16, number: 0, value: 127 });
  assert.deepEqual(parseMidiMessage([0xc0, 0]), { message: "program-change", channel: 1, number: 0, value: 127 });
  assert.deepEqual(parseMidiMessage([0xc3, 127]), { message: "program-change", channel: 4, number: 127, value: 127 });
  assert.equal(parseMidiMessage([0xf8]), null, "system real-time");
  assert.equal(parseMidiMessage([0x40, 1, 2]), null, "data byte as status");
  assert.equal(parseMidiMessage([0xe0, 0, 64]), null, "pitch bend is not supported");
  assert.equal(parseMidiMessage([0xb0]), null, "truncated message");
});

test("legacy MIDI matcher is level-triggered with the CC threshold (default 64)", () => {
  const cc: ClientViewMidiBinding = { id: "c", kind: "midi", action: "show-next-song", message: "control-change", channel: 1, number: 20 };
  const at = (value: number, channel = 1) => matchesMidiBinding(cc, { message: "control-change", channel, number: 20, value });
  assert.deepEqual(
    [0, 63, 64, 100, 127].map((value) => at(value)),
    [false, false, true, true, true]
  );
  assert.equal(at(127, 2), false, "fixed channel");
  assert.equal(matchesMidiBinding({ ...cc, threshold: 100 }, { message: "control-change", channel: 1, number: 20, value: 99 }), false);
  assert.equal(matchesMidiBinding({ ...cc, channel: "any" }, { message: "control-change", channel: 9, number: 20, value: 70 }), true);
  assert.equal(matchesMidiBinding({ ...cc, number: 21 }, { message: "control-change", channel: 1, number: 20, value: 127 }), false);
  const note: ClientViewMidiBinding = { ...cc, message: "note-on", number: 36 };
  assert.equal(matchesMidiBinding(note, { message: "note-on", channel: 1, number: 36, value: 1 }), true);
  assert.equal(matchesMidiBinding(note, { message: "control-change", channel: 1, number: 36, value: 127 }), false);
});

test("binding formatting stays human-readable", () => {
  const [factoryNumLock] = FACTORY_CLIENT_VIEW_INPUT_PROFILE.bindings.filter((binding) => binding.id === "factory-numlock-on");
  assert.equal(factoryNumLock.kind === "keyboard" && formatKeyboardBinding(factoryNumLock), "NUMLOCK (NumLock be)");
  assert.equal(
    formatMidiBinding({ id: "x", kind: "midi", action: "toggle-options", message: "program-change", channel: "any", number: 5 }),
    "Program 5 (bármely csatorna)"
  );
});
