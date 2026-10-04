/**
 * Characterization of the legacy client-view keyboard matching (R01, R08): the
 * factory profile, the old logical-key normalizer with its NumLock-dependent
 * numpad meaning, exact modifier matching and the IME guard.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  FACTORY_CLIENT_VIEW_INPUT_PROFILE,
  clientViewInputActionAvailable,
  matchesKeyboardBinding,
  type ClientViewInputContext,
  type ClientViewKeyboardBinding,
} from "../clientViewInput";
import { keyEvent } from "../../../../tests/support/keyEvents";

function resolve(context: ClientViewInputContext, event: KeyboardEvent): string | null {
  const binding = FACTORY_CLIENT_VIEW_INPUT_PROFILE.bindings.find(
    (item) => item.kind === "keyboard" && clientViewInputActionAvailable(item.action, context) && matchesKeyboardBinding(item, event)
  );
  return binding?.action ?? null;
}

const matrix: [string, KeyboardEvent, string | null, string | null][] = [
  ["Home", keyEvent("Home"), "toggle-options", "toggle-options"],
  ["PageUp", keyEvent("PageUp"), "show-previous-song", "select-previous-visible-song"],
  ["PageDown", keyEvent("PageDown"), "show-next-song", "select-next-visible-song"],
  ["Digit7", keyEvent("Digit7"), "cycle-next-main-control", "activate-option-control"],
  ["Digit9", keyEvent("Digit9"), "decrease-main-control", "select-previous-option-control"],
  ["Digit3", keyEvent("Digit3"), "increase-main-control", "select-next-option-control"],
  ["Numpad7 NumLock on", keyEvent("Numpad7", { numLock: true }), "cycle-next-main-control", "activate-option-control"],
  ["Numpad9 NumLock on", keyEvent("Numpad9", { numLock: true }), "decrease-main-control", "select-previous-option-control"],
  ["Numpad3 NumLock on", keyEvent("Numpad3", { numLock: true }), "increase-main-control", "select-next-option-control"],
  ["Numpad7 NumLock off = Home", keyEvent("Numpad7", { numLock: false }), "toggle-options", "toggle-options"],
  ["Numpad9 NumLock off = PageUp", keyEvent("Numpad9", { numLock: false }), "show-previous-song", "select-previous-visible-song"],
  ["Numpad3 NumLock off = PageDown", keyEvent("Numpad3", { numLock: false }), "show-next-song", "select-next-visible-song"],
  ["NumLock turned on", keyEvent("NumLock", { numLock: true }), "select-first-control", "select-first-control"],
  ["NumLock turned off", keyEvent("NumLock", { numLock: false }), "clear-control", "clear-control"],
  ["Ctrl+Home", keyEvent("Home", { ctrl: true }), null, null],
  ["Shift+PageDown", keyEvent("PageDown", { shift: true }), null, null],
  ["Alt+Digit7", keyEvent("Digit7", { alt: true }), null, null],
  ["Meta+Home", keyEvent("Home", { meta: true }), null, null],
  ["IME composition", keyEvent("Home", { isComposing: true }), null, null],
  ["IME keyCode 229", keyEvent("Home", { keyCode: 229 }), null, null],
  ["unbound key", keyEvent("KeyA"), null, null],
  ["ArrowUp", keyEvent("ArrowUp"), null, null],
];

for (const [label, event, songView, options] of matrix) {
  test(`factory profile: ${label}`, () => {
    assert.equal(resolve("song-view", event), songView, "song-view");
    assert.equal(resolve("options", event), options, "options");
  });
}

test("a physical-code binding ignores the layout's logical key but matches modifiers exactly", () => {
  const binding: ClientViewKeyboardBinding = {
    id: "custom",
    kind: "keyboard",
    action: "toggle-options",
    match: "code",
    key: "KeyA",
    ctrl: false,
    alt: false,
    shift: false,
    meta: false,
  };
  assert.equal(matchesKeyboardBinding(binding, keyEvent("KeyA", { key: "q" })), true, "AZERTY 'q' on the KeyA position");
  assert.equal(matchesKeyboardBinding(binding, keyEvent("KeyA", { shift: true })), false);
  assert.equal(matchesKeyboardBinding(binding, keyEvent("KeyQ", { key: "a" })), false);
});

test("legacy-key bindings normalize the old underscore spelling", () => {
  const binding: ClientViewKeyboardBinding = {
    id: "custom",
    kind: "keyboard",
    action: "show-next-song",
    match: "legacy-key",
    key: "PAGEDOWN",
    ctrl: false,
    alt: false,
    shift: false,
    meta: false,
    numLock: "any",
  };
  assert.equal(matchesKeyboardBinding(binding, keyEvent("PageDown")), true);
  assert.equal(matchesKeyboardBinding(binding, keyEvent("Numpad3", { numLock: false })), true);
  assert.equal(matchesKeyboardBinding(binding, keyEvent("Numpad3", { numLock: true })), false);
});
