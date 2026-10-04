import type { KeyboardLayout } from "../../common/hardware-input-conflicts";

interface KeyboardWithLayoutMap {
  getLayoutMap?(): Promise<{ get(code: string): string | undefined; entries(): Iterable<[string, string]> }>;
}

/** One read of the layout map: the layout and an identity that changes with it. */
export interface KeyboardLayoutSnapshot {
  layout: KeyboardLayout;
  signature: string;
}

/**
 * Browsers announce no layout switch (`layoutchange` was never shipped), so a
 * page that relies on the map reads it again this often while it is shown.
 */
export const LAYOUT_POLL_MS = 1000;

/**
 * The current keyboard layout from the browser's Keyboard Map API (Chromium,
 * Electron): what each physical key types without modifiers. Undefined when the
 * API is missing or refuses; conflict checks then stay conservative.
 */
export async function loadKeyboardLayout(
  keyboard: KeyboardWithLayoutMap | undefined = typeof navigator !== "undefined"
    ? (navigator as { keyboard?: KeyboardWithLayoutMap }).keyboard
    : undefined
): Promise<KeyboardLayoutSnapshot | undefined> {
  if (!keyboard?.getLayoutMap) return undefined;
  try {
    const map = await keyboard.getLayoutMap();
    const signature = JSON.stringify([...map.entries()].map(([code, key]) => `${code}=${key}`).sort());
    return { layout: (code, shift, alt) => (shift || alt ? undefined : map.get(code)), signature };
  } catch {
    return undefined;
  }
}

export type LearnedKeydown = Pick<KeyboardEvent, "code" | "key" | "shiftKey" | "altKey">;

/** A layout that knows the learned keydowns exactly and falls back to `layout` for other keys. */
export function withLearnedKeys(learned: readonly LearnedKeydown[], layout?: KeyboardLayout): KeyboardLayout {
  return (code, shift, alt) => {
    const known = learned.find((item) => item.code === code && item.shiftKey === shift && item.altKey === alt);
    return known ? known.key : layout?.(code, shift, alt);
  };
}

/**
 * Adds a learning keydown to the keys learned since the layout map was read
 * (the latest one per key and Shift/Alt state wins). A keydown that contradicts
 * what was known — case aside, that is CapsLock — proves a layout switch: all
 * earlier knowledge is stale, only this key is kept and the map must be re-read.
 */
export function addLearnedKeydown(
  learned: readonly LearnedKeydown[],
  event: LearnedKeydown,
  layoutMap?: KeyboardLayout
): { learned: readonly LearnedKeydown[]; layoutChanged: boolean } {
  const { code, key, shiftKey, altKey } = event;
  const known = withLearnedKeys(learned, layoutMap)(code, shiftKey, altKey);
  const layoutChanged = known !== undefined && known.toLowerCase() !== key.toLowerCase();
  const kept = layoutChanged ? [] : learned.filter((item) => item.code !== code || item.shiftKey !== shiftKey || item.altKey !== altKey);
  return { learned: [...kept, { code, key, shiftKey, altKey }], layoutChanged };
}
