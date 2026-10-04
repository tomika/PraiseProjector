/** Actual input overlap inside one view/profile. Never compare formatted labels. */
import {
  clientRowContexts,
  findRow,
  type ClientCommand,
  type HardwareBinding,
  type HardwareKeyboardBinding,
  type HardwareProfile,
  type HardwareView,
} from "./hardware-input";

export interface HardwareConflict {
  leftId: string;
  rightId: string;
  leftRowId: string;
  rightRowId: string;
  reason: "keyboard-overlap" | "midi-overlap";
}

const fixedCodes: Record<string, readonly string[]> = {
  Home: ["Home"],
  End: ["End"],
  PageUp: ["PageUp"],
  PageDown: ["PageDown"],
  ArrowUp: ["ArrowUp"],
  ArrowDown: ["ArrowDown"],
  ArrowLeft: ["ArrowLeft"],
  ArrowRight: ["ArrowRight"],
  Enter: ["Enter"],
  NumpadEnter: ["Enter"],
  Backspace: ["Backspace"],
  Escape: ["Escape"],
  Space: [" "],
  NumLock: ["NumLock"],
  Delete: ["Delete"],
  Insert: ["Insert"],
  Tab: ["Tab"],
  NumpadAdd: ["+"],
  NumpadSubtract: ["-"],
  NumpadMultiply: ["*"],
  NumpadDivide: ["/"],
};

/** Numpad keys: the characters with NumLock on (the HU decimal key types a comma), the navigation key with NumLock off. */
const numpadKeys: Record<string, readonly [readonly string[], string]> = {
  Numpad0: [["0"], "Insert"],
  Numpad1: [["1"], "End"],
  Numpad2: [["2"], "ArrowDown"],
  Numpad3: [["3"], "PageDown"],
  Numpad4: [["4"], "ArrowLeft"],
  Numpad5: [["5"], "Clear"],
  Numpad6: [["6"], "ArrowRight"],
  Numpad7: [["7"], "Home"],
  Numpad8: [["8"], "ArrowUp"],
  Numpad9: [["9"], "PageUp"],
  NumpadDecimal: [[".", ","], "Delete"],
};

/** Codes whose character depends on the keyboard layout (letters, digits, punctuation, uncommon numpad keys). */
const LAYOUT_CODE =
  /^(Key[A-Z]|Digit\d|Numpad\w+|Backquote|Minus|Equal|BracketLeft|BracketRight|Backslash|Semicolon|Quote|Comma|Period|Slash|IntlBackslash|IntlRo|IntlYen)$/;

/**
 * The character a physical key types in the current keyboard layout with the
 * given Shift/Alt state, when known: from a learning keydown, or from the
 * browser's layout map (unmodified keys only). `undefined` means unknown. The
 * CapsLock state may flip a letter's case; the conflict check allows for both.
 */
export type KeyboardLayout = (code: string, shift: boolean, alt: boolean) => string | undefined;

function legacyLogicalKey(key: string): string {
  const upper = key.toUpperCase();
  const normalized = upper === "DEL" ? "DELETE" : upper === "+" ? "ADD" : upper === "-" ? "SUBTRACT" : upper.replace(/^ARROW/, "");
  return normalized.replace("_", "");
}

/** The printable character a logical binding waits for, or null for a named key. */
function logicalCharacter(logical: HardwareKeyboardBinding): string | null {
  if (logical.match === "legacy-key" && logical.key === "ADD") return "+";
  if (logical.match === "legacy-key" && logical.key === "SUBTRACT") return "-";
  return [...logical.key].length === 1 ? logical.key : null;
}

/** The Shift/Alt state of every keydown both bindings accept, or null when it is not fixed. */
function sharedShiftAlt(left: HardwareKeyboardBinding, right: HardwareKeyboardBinding): { shift: boolean; alt: boolean } | null {
  // Two exact bindings only overlap with identical modifiers, so the first exact one decides.
  const exact = [left, right].find((binding) => (binding.modifiers ?? "exact") === "exact");
  return exact ? { shift: exact.shift, alt: exact.alt } : null;
}

function logicalOverlap(left: HardwareKeyboardBinding, right: HardwareKeyboardBinding, layout?: KeyboardLayout): boolean {
  if (left.match === right.match) return left.key === right.key;
  if (left.match !== "code" && right.match !== "code") {
    const key = left.match === "key" ? left : right;
    const legacy = left.match === "legacy-key" ? left : right;
    return legacyLogicalKey(key.key) === legacy.key;
  }
  const physical = left.match === "code" ? left : right;
  const logical = left.match === "code" ? right : left;
  const produces = (key: string) => (logical.match === "key" ? key : legacyLogicalKey(key)) === logical.key;
  const numpad = numpadKeys[physical.key];
  if (numpad) {
    const numLock = physical.numLock && physical.numLock !== "any" ? physical.numLock : (logical.numLock ?? "any");
    return (numLock !== "off" && numpad[0].some(produces)) || (numLock !== "on" && produces(numpad[1]));
  }
  const fixed = fixedCodes[physical.key];
  if (fixed) return fixed.some(produces);
  const char = logicalCharacter(logical);
  // Named keys (F-keys, media keys, …) are reported under their own name.
  if (char === null || !LAYOUT_CODE.test(physical.key)) return produces(physical.key);
  // A layout key may type any character on some layout (Dvorak types ' on KeyQ,
  // HU AltGr+F types [). Only the actual current layout can rule an overlap out.
  const state = sharedShiftAlt(physical, logical);
  const typed = state ? layout?.(physical.key, state.shift, state.alt) : undefined;
  // No binding depends on CapsLock, and CapsLock flips the case of the letter a
  // key types (with or without Shift), so both cases reach the logical binding.
  return typed === undefined || [typed, typed.toLowerCase(), typed.toUpperCase()].some(produces);
}

export function keyboardBindingsOverlap(left: HardwareKeyboardBinding, right: HardwareKeyboardBinding, layout?: KeyboardLayout): boolean {
  if (left.numLock && right.numLock && left.numLock !== "any" && right.numLock !== "any" && left.numLock !== right.numLock) return false;
  if ((left.modifiers ?? "exact") === "exact" && (right.modifiers ?? "exact") === "exact") {
    if (["ctrl", "alt", "shift", "meta"].some((flag) => left[flag as "ctrl"] !== right[flag as "ctrl"])) return false;
  }
  // Full-view and section-list scopes overlap whenever the list has focus;
  // repeat=ignore and repeat=allow both accept the first non-repeated keydown.
  return logicalOverlap(left, right, layout);
}

export function bindingsOverlap(left: HardwareBinding, right: HardwareBinding, layout?: KeyboardLayout): boolean {
  if (left.kind !== right.kind) return false;
  if (left.kind === "keyboard" && right.kind === "keyboard") return keyboardBindingsOverlap(left, right, layout);
  if (left.kind !== "midi" || right.kind !== "midi") return false;
  return (
    left.message === right.message &&
    left.number === right.number &&
    (left.channel === "any" || right.channel === "any" || left.channel === right.channel)
  );
  // All P0 CC triggers contain the common upper endpoint 127. Different press
  // or release thresholds cannot make them independent consumers of this CC.
}

/** Overlapping binding pairs; without a known layout, layout keys are compared conservatively. */
export function profileConflicts(view: HardwareView, profile: Readonly<HardwareProfile<unknown>>, layout?: KeyboardLayout): HardwareConflict[] {
  const conflicts: HardwareConflict[] = [];
  for (let i = 0; i < profile.bindings.length; i++) {
    const left = profile.bindings[i];
    const leftRow = findRow(view, profile as HardwareProfile<ClientCommand>, left.rowId);
    if (!leftRow) continue;
    for (const right of profile.bindings.slice(i + 1)) {
      const rightRow = findRow(view, profile as HardwareProfile<ClientCommand>, right.rowId);
      if (!rightRow || !bindingsOverlap(left, right, layout)) continue;
      if (
        view === "client-view" &&
        !clientRowContexts(leftRow as { id: string; command: ClientCommand }).some((context) =>
          clientRowContexts(rightRow as { id: string; command: ClientCommand }).includes(context)
        )
      )
        continue;
      conflicts.push({
        leftId: left.id,
        rightId: right.id,
        leftRowId: left.rowId,
        rightRowId: right.rowId,
        reason: left.kind === "keyboard" ? "keyboard-overlap" : "midi-overlap",
      });
    }
  }
  return conflicts;
}
