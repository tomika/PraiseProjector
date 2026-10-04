import { getKeyCodeString, isNumLockEnabled } from "../../chordpro/keycodes";
import type { HardwareKeyboardBinding } from "../../common/hardware-input";

/**
 * Keyboard side of the hardware bindings: matching a DOM keydown against a
 * binding, recognising protected (editable / composing) targets, and turning a
 * learned keydown into a new binding.
 */

const MODIFIER_CODES = new Set(["ControlLeft", "ControlRight", "AltLeft", "AltRight", "ShiftLeft", "ShiftRight", "MetaLeft", "MetaRight"]);

/** IME composition never produces a hardware command. */
export function isComposingKey(event: KeyboardEvent): boolean {
  return event.isComposing || event.keyCode === 229;
}

/** Text entry and other editable elements keep their keys. */
export function isEditableTarget(target: EventTarget | null): boolean {
  const element = target as Element | null;
  if (!element || typeof element.closest !== "function") return false;
  return !!element.closest("input, textarea, select, [contenteditable='true'], [contenteditable='']");
}

export function matchesHardwareKey(binding: HardwareKeyboardBinding, event: KeyboardEvent): boolean {
  if (isComposingKey(event)) return false;
  if (event.repeat && (binding.repeat ?? "ignore") === "ignore") return false;
  if ((binding.modifiers ?? "exact") === "exact") {
    if (binding.ctrl !== event.ctrlKey || binding.alt !== event.altKey || binding.shift !== event.shiftKey || binding.meta !== event.metaKey) {
      return false;
    }
  }
  if (binding.numLock && binding.numLock !== "any") {
    if ((binding.numLock === "on") !== isNumLockEnabled(event)) return false;
  }
  return observedKey(binding.match, event) === binding.key;
}

function observedKey(match: HardwareKeyboardBinding["match"], event: KeyboardEvent): string {
  if (match === "code") return event.code;
  if (match === "key") return event.key;
  return getKeyCodeString(event).replace("_", "").toUpperCase();
}

/** A modifier key alone is never a finished binding. */
export function isModifierOnly(event: KeyboardEvent): boolean {
  return !event.code || MODIFIER_CODES.has(event.code);
}

/** Builds a physical-key binding from a learned keydown (null while only a modifier is held). */
export function keyboardBindingFromEvent(
  event: KeyboardEvent,
  ids: { id: string; rowId: string },
  scope?: HardwareKeyboardBinding["scope"]
): HardwareKeyboardBinding | null {
  if (isComposingKey(event) || isModifierOnly(event)) return null;
  return {
    id: ids.id,
    rowId: ids.rowId,
    kind: "keyboard",
    match: "code",
    key: event.code,
    ctrl: event.ctrlKey,
    alt: event.altKey,
    shift: event.shiftKey,
    meta: event.metaKey,
    numLock: "any",
    ...(scope ? { scope } : {}),
  };
}
