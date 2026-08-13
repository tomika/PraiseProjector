import { getKeyCodeString, isNumLockEnabled } from "../../../chordpro/keycodes";
import type { ClientViewKeyboardBinding } from "../../../common/client-view-input";

/**
 * The input contract and its pure logic live in `common/client-view-input` because the
 * binding profile is persisted as part of `Settings` and crosses into the Electron main
 * process. Only the DOM-bound keyboard matcher belongs here — it needs `KeyboardEvent` and
 * the `chordpro/keycodes` normalizer, neither of which may reach the main process program.
 */
export * from "../../../common/client-view-input";

export function matchesKeyboardBinding(binding: ClientViewKeyboardBinding, event: KeyboardEvent): boolean {
  if (event.isComposing || event.keyCode === 229) return false;
  if (binding.ctrl !== event.ctrlKey || binding.alt !== event.altKey || binding.shift !== event.shiftKey || binding.meta !== event.metaKey)
    return false;
  if (binding.numLock && binding.numLock !== "any") {
    const enabled = isNumLockEnabled(event);
    if ((binding.numLock === "on") !== enabled) return false;
  }
  const observed = binding.match === "code" ? event.code : normalizeLegacyKey(getKeyCodeString(event));
  return observed === binding.key;
}

function normalizeLegacyKey(key: string): string {
  return key.replace("_", "").toUpperCase();
}
