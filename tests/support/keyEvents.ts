/**
 * Plain KeyboardEvent-shaped objects for unit tests. Values mirror what Chromium
 * reports on a US layout; the numpad keys report navigation keys when NumLock is
 * off, exactly like the browser.
 */
interface KeyDef {
  key: string;
  keyCode: number;
  location?: number;
  /** Logical key reported with NumLock off (numpad only). */
  numLockOffKey?: string;
}

const KEYS: Record<string, KeyDef> = {
  Home: { key: "Home", keyCode: 36 },
  End: { key: "End", keyCode: 35 },
  PageUp: { key: "PageUp", keyCode: 33 },
  PageDown: { key: "PageDown", keyCode: 34 },
  ArrowUp: { key: "ArrowUp", keyCode: 38 },
  ArrowDown: { key: "ArrowDown", keyCode: 40 },
  ArrowLeft: { key: "ArrowLeft", keyCode: 37 },
  ArrowRight: { key: "ArrowRight", keyCode: 39 },
  Enter: { key: "Enter", keyCode: 13 },
  Backspace: { key: "Backspace", keyCode: 8 },
  Escape: { key: "Escape", keyCode: 27 },
  Space: { key: " ", keyCode: 32 },
  Tab: { key: "Tab", keyCode: 9 },
  NumLock: { key: "NumLock", keyCode: 144 },
  F6: { key: "F6", keyCode: 117 },
  F7: { key: "F7", keyCode: 118 },
  Digit3: { key: "3", keyCode: 51 },
  Digit7: { key: "7", keyCode: 55 },
  Digit9: { key: "9", keyCode: 57 },
  Numpad3: { key: "3", keyCode: 99, location: 3, numLockOffKey: "PageDown" },
  Numpad7: { key: "7", keyCode: 103, location: 3, numLockOffKey: "Home" },
  Numpad9: { key: "9", keyCode: 105, location: 3, numLockOffKey: "PageUp" },
  KeyA: { key: "a", keyCode: 65 },
  KeyQ: { key: "q", keyCode: 81 },
  KeyX: { key: "x", keyCode: 88 },
  ShiftLeft: { key: "Shift", keyCode: 16, location: 1 },
  ControlLeft: { key: "Control", keyCode: 17, location: 1 },
};

export interface KeyEventOptions {
  key?: string;
  keyCode?: number;
  ctrl?: boolean;
  alt?: boolean;
  shift?: boolean;
  meta?: boolean;
  repeat?: boolean;
  isComposing?: boolean;
  /** NumLock state reported by getModifierState (default on). */
  numLock?: boolean;
  target?: unknown;
}

export interface TestKeyEvent extends KeyboardEvent {
  defaultPrevented: boolean;
  propagationStopped: boolean;
}

export function keyEvent(code: string, options: KeyEventOptions = {}): TestKeyEvent {
  const def = KEYS[code];
  if (!def) throw new Error(`unknown test key ${code}`);
  const numLock = options.numLock ?? true;
  const key = options.key ?? (!numLock && def.numLockOffKey ? def.numLockOffKey : def.key);
  const event = {
    type: "keydown",
    key,
    code,
    keyCode: options.keyCode ?? def.keyCode,
    which: options.keyCode ?? def.keyCode,
    location: def.location ?? 0,
    ctrlKey: !!options.ctrl,
    altKey: !!options.alt,
    shiftKey: !!options.shift,
    metaKey: !!options.meta,
    repeat: !!options.repeat,
    isComposing: !!options.isComposing,
    target: options.target ?? null,
    defaultPrevented: false,
    propagationStopped: false,
    getModifierState: (name: string) => (name === "NumLock" ? numLock : false),
    preventDefault() {
      event.defaultPrevented = true;
    },
    stopPropagation() {
      event.propagationStopped = true;
    },
  };
  return event as unknown as TestKeyEvent;
}
