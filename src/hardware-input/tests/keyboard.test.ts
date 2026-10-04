/**
 * T04 — keyboard matching for hardware bindings: the converted client factory
 * profile matches exactly like the legacy matcher (R01), the full-view factory
 * keeps the section list's logical-key / any-modifier / auto-repeat semantics
 * (R07), and protected targets are recognised (R08).
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { FACTORY_CLIENT_VIEW_INPUT_PROFILE, type ClientViewKeyboardBinding } from "../../../common/client-view-input";
import { FACTORY_CLIENT_PROFILE, FACTORY_FULL_PROFILE, type HardwareKeyboardBinding } from "../../../common/hardware-input";
import { matchesKeyboardBinding } from "../../client-view/input/clientViewInput";
import { isEditableTarget, isModifierOnly, keyboardBindingFromEvent, matchesHardwareKey } from "../keyboardInput";
import { keyEvent, type KeyEventOptions } from "../../../tests/support/keyEvents";

const CODES = ["Home", "End", "PageUp", "PageDown", "ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight", "Enter", "Backspace", "Escape", "Space"];
const LEGACY_CODES = [...CODES, "NumLock", "Digit3", "Digit7", "Digit9", "Numpad3", "Numpad7", "Numpad9", "KeyA", "F6", "Tab"];

function* eventMatrix(codes: string[]) {
  const variants: KeyEventOptions[] = [
    {},
    { ctrl: true },
    { alt: true },
    { shift: true },
    { meta: true },
    { numLock: false },
    { repeat: true },
    { isComposing: true },
    { keyCode: 229 },
  ];
  for (const code of codes) for (const options of variants) yield { label: `${code} ${JSON.stringify(options)}`, event: keyEvent(code, options) };
}

test("client factory: the new matcher equals the legacy runtime (which also dropped auto-repeat) on every event", () => {
  FACTORY_CLIENT_VIEW_INPUT_PROFILE.bindings.forEach((legacy, index) => {
    const converted = FACTORY_CLIENT_PROFILE.bindings[index] as HardwareKeyboardBinding;
    for (const { label, event } of eventMatrix(LEGACY_CODES)) {
      const legacyResult = !event.repeat && matchesKeyboardBinding(legacy as ClientViewKeyboardBinding, event);
      assert.equal(matchesHardwareKey(converted, event), legacyResult, `${legacy.id} / ${label}`);
    }
  });
});

function fullFactoryKeys(event: KeyboardEvent): string[] {
  return FACTORY_FULL_PROFILE.bindings
    .filter((binding) => binding.kind === "keyboard" && matchesHardwareKey(binding, event))
    .map((binding) => binding.id);
}

test("full-view factory keeps the section list semantics: logical key, any modifier, auto-repeat runs", () => {
  assert.deepEqual(fullFactoryKeys(keyEvent("Home")), ["factory-home"]);
  assert.deepEqual(fullFactoryKeys(keyEvent("Home", { ctrl: true, shift: true })), ["factory-home"]);
  assert.deepEqual(fullFactoryKeys(keyEvent("ArrowDown", { repeat: true })), ["factory-arrow-down"]);
  assert.deepEqual(fullFactoryKeys(keyEvent("ArrowLeft")), ["factory-arrow-left"]);
  assert.deepEqual(fullFactoryKeys(keyEvent("ArrowRight")), ["factory-arrow-right"]);
  assert.deepEqual(fullFactoryKeys(keyEvent("Numpad7", { numLock: false })), ["factory-home"], "numpad Home reports key=Home");
  assert.deepEqual(fullFactoryKeys(keyEvent("Numpad7", { numLock: true })), []);
  assert.deepEqual(fullFactoryKeys(keyEvent("Space")), [], "Space is not a base row");
  assert.deepEqual(fullFactoryKeys(keyEvent("Escape")), [], "Escape is not a base row");
  assert.deepEqual(fullFactoryKeys(keyEvent("Enter", { isComposing: true })), [], "IME composition is protected");
});

test("full-view factory covers each of the eight base keys exactly once", () => {
  const expected: Record<string, string> = {
    Home: "factory-home",
    PageUp: "factory-page-up",
    ArrowUp: "factory-arrow-up",
    Backspace: "factory-backspace",
    End: "factory-end",
    PageDown: "factory-page-down",
    ArrowDown: "factory-arrow-down",
    Enter: "factory-enter",
  };
  for (const [code, id] of Object.entries(expected)) assert.deepEqual(fullFactoryKeys(keyEvent(code)), [id], code);
});

test("custom bindings: exact modifiers by default, repeat ignored by default, NumLock requirement", () => {
  const binding: HardwareKeyboardBinding = {
    id: "c",
    rowId: "r",
    kind: "keyboard",
    match: "code",
    key: "Numpad3",
    ctrl: true,
    alt: false,
    shift: false,
    meta: false,
    numLock: "on",
  };
  assert.equal(matchesHardwareKey(binding, keyEvent("Numpad3", { ctrl: true })), true);
  assert.equal(matchesHardwareKey(binding, keyEvent("Numpad3")), false);
  assert.equal(matchesHardwareKey(binding, keyEvent("Numpad3", { ctrl: true, shift: true })), false);
  assert.equal(matchesHardwareKey(binding, keyEvent("Numpad3", { ctrl: true, numLock: false })), false);
  assert.equal(matchesHardwareKey(binding, keyEvent("Numpad3", { ctrl: true, repeat: true })), false);
  assert.equal(matchesHardwareKey({ ...binding, repeat: "allow" }, keyEvent("Numpad3", { ctrl: true, repeat: true })), true);
  assert.equal(matchesHardwareKey({ ...binding, modifiers: "ignore" }, keyEvent("Numpad3", { shift: true })), true);
});

test("editable targets are protected, including descendants of contenteditable", () => {
  const element = (matches: boolean) => ({ closest: () => (matches ? {} : null) }) as unknown as EventTarget;
  assert.equal(isEditableTarget(element(true)), true);
  assert.equal(isEditableTarget(element(false)), false);
  assert.equal(isEditableTarget(null), false);
  assert.equal(isEditableTarget({} as EventTarget), false, "non-element targets (window/document)");
});

test("learning: modifiers alone are not a binding; the learned binding is physical and exact", () => {
  assert.equal(isModifierOnly(keyEvent("ShiftLeft", { shift: true })), true);
  assert.equal(keyboardBindingFromEvent(keyEvent("ControlLeft", { ctrl: true }), { id: "n", rowId: "r" }), null);
  assert.equal(keyboardBindingFromEvent(keyEvent("KeyA", { isComposing: true }), { id: "n", rowId: "r" }), null);
  assert.deepEqual(keyboardBindingFromEvent(keyEvent("F6", { alt: true }), { id: "n", rowId: "r" }, "full-view"), {
    id: "n",
    rowId: "r",
    kind: "keyboard",
    match: "code",
    key: "F6",
    ctrl: false,
    alt: true,
    shift: false,
    meta: false,
    numLock: "any",
    scope: "full-view",
  });
});
