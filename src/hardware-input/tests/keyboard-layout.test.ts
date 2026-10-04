/**
 * The current keyboard layout for conflict checks: the browser layout map when
 * available (unmodified keys only), the keydowns learned since it was read
 * exactly, and nothing (conservative) when the API is missing or refuses.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { baseRowId, FACTORY_CLIENT_PROFILE, type HardwareKeyboardBinding } from "../../../common/hardware-input";
import { profileConflicts } from "../../../common/hardware-input-conflicts";
import { addLearnedKeydown, loadKeyboardLayout, withLearnedKeys } from "../keyboardLayout";

test("the layout map answers unmodified keys; Shift/Alt layers and unknown keys stay unknown", async () => {
  const dvorak = new Map([
    ["KeyQ", "'"],
    ["KeyA", "a"],
  ]);
  const snapshot = await loadKeyboardLayout({ getLayoutMap: async () => dvorak });
  assert.ok(snapshot);
  const { layout } = snapshot;
  assert.equal(layout("KeyQ", false, false), "'");
  assert.equal(layout("KeyQ", true, false), undefined);
  assert.equal(layout("KeyQ", false, true), undefined);
  assert.equal(layout("KeyZ", false, false), undefined);
});

test("the snapshot signature changes with the layout, not with the order the map lists its keys", async () => {
  const read = async (entries: [string, string][]) => (await loadKeyboardLayout({ getLayoutMap: async () => new Map(entries) }))?.signature;
  const us = await read([
    ["KeyY", "y"],
    ["KeyZ", "z"],
  ]);
  assert.equal(
    await read([
      ["KeyZ", "z"],
      ["KeyY", "y"],
    ]),
    us
  );
  assert.notEqual(
    await read([
      ["KeyY", "z"],
      ["KeyZ", "y"],
    ]),
    us
  );
});

test("a missing or refusing Keyboard API gives no layout", async () => {
  assert.equal(await loadKeyboardLayout(undefined), undefined);
  assert.equal(await loadKeyboardLayout({}), undefined);
  assert.equal(
    await loadKeyboardLayout({
      getLayoutMap: async () => {
        throw new Error("NotAllowedError");
      },
    }),
    undefined
  );
  assert.equal(await loadKeyboardLayout(), undefined, "Node has no navigator.keyboard");
});

test("by default the layout comes from navigator.keyboard; no navigator means no layout", async () => {
  const original = Object.getOwnPropertyDescriptor(globalThis, "navigator");
  try {
    Object.defineProperty(globalThis, "navigator", {
      value: { keyboard: { getLayoutMap: async () => new Map([["KeyQ", "q"]]) } },
      configurable: true,
    });
    assert.equal((await loadKeyboardLayout())?.layout("KeyQ", false, false), "q");
    Object.defineProperty(globalThis, "navigator", { value: undefined, configurable: true });
    assert.equal(await loadKeyboardLayout(), undefined);
  } finally {
    if (original) Object.defineProperty(globalThis, "navigator", original);
    else delete (globalThis as { navigator?: unknown }).navigator;
  }
});

test("learned keydowns are known exactly, including their Shift/Alt state; other keys fall back", () => {
  const base = (code: string, shift: boolean, alt: boolean) => (!shift && !alt && code === "KeyA" ? "a" : undefined);
  const learned = withLearnedKeys([{ code: "KeyF", key: "[", shiftKey: false, altKey: true }], base);
  assert.equal(learned("KeyF", false, true), "[", "HU AltGr+F");
  assert.equal(learned("KeyF", false, false), undefined, "another modifier state of the learned key is not known");
  assert.equal(learned("KeyA", false, false), "a");
  assert.equal(withLearnedKeys([{ code: "KeyQ", key: "'", shiftKey: false, altKey: false }])("KeyA", false, false), undefined);
});

const press = (code: string, key: string, shiftKey = false, altKey = false) => ({ code, key, shiftKey, altKey });
const US_MAP = (code: string, shift: boolean, alt: boolean) =>
  shift || alt ? undefined : ({ KeyY: "y", KeyZ: "z", Digit0: "0" } as Record<string, string>)[code];

test("learned keydowns accumulate, the latest per key and Shift/Alt state; only layout fields are kept", () => {
  let known = addLearnedKeydown([], press("KeyJ", "j"));
  assert.equal(known.layoutChanged, false, "nothing was known about KeyJ");
  known = addLearnedKeydown(known.learned, press("KeyJ", "J", true));
  known = addLearnedKeydown(known.learned, press("KeyJ", "j"));
  assert.equal(known.layoutChanged, false, "the same answer again");
  assert.deepEqual(known.learned, [press("KeyJ", "J", true), press("KeyJ", "j")]);
  const extra = { ...press("KeyK", "k"), repeat: true } as KeyboardEvent;
  assert.deepEqual(addLearnedKeydown([], extra).learned, [press("KeyK", "k")]);
});

test("a keydown that contradicts the map or an earlier learning proves a layout switch: earlier knowledge is dropped", () => {
  const huOnUsMap = addLearnedKeydown([press("KeyF", "[", false, true)], press("KeyY", "z"), US_MAP);
  assert.equal(huOnUsMap.layoutChanged, true, "the map said y");
  assert.deepEqual(huOnUsMap.learned, [press("KeyY", "z")], "the AltGr+F learned before the switch is stale too");
  const relearned = addLearnedKeydown([press("KeyY", "y"), press("KeyQ", "q")], press("KeyY", "z"));
  assert.equal(relearned.layoutChanged, true, "an earlier learning said y");
  assert.deepEqual(relearned.learned, [press("KeyY", "z")]);
});

test("CapsLock (only the case differs) and keys the map does not know are no layout switch", () => {
  const capsLock = addLearnedKeydown([press("KeyQ", "q")], press("KeyY", "Y"), US_MAP);
  assert.equal(capsLock.layoutChanged, false);
  assert.deepEqual(capsLock.learned, [press("KeyQ", "q"), press("KeyY", "Y")]);
  assert.equal(addLearnedKeydown([], press("KeyY", "Z", true), US_MAP).layoutChanged, false, "the map knows no Shift layer");
  assert.equal(addLearnedKeydown([], press("F6", "F6"), US_MAP).layoutChanged, false);
});

test("without a Keyboard Map, the learned letter keeps a factory copy free of conflicts after the save", () => {
  const letterA: HardwareKeyboardBinding = {
    id: "learned-a",
    rowId: baseRowId("client-view", "clear-control"),
    kind: "keyboard",
    match: "code",
    key: "KeyA",
    ctrl: false,
    alt: false,
    shift: false,
    meta: false,
    numLock: "any",
    modifiers: "exact",
    repeat: "ignore",
  };
  const copy = { ...FACTORY_CLIENT_PROFILE, id: "copy", bindings: [...FACTORY_CLIENT_PROFILE.bindings, letterA] };
  assert.ok(profileConflicts("client-view", copy, withLearnedKeys([])).length > 0, "not yet learned: conservative");
  const known = addLearnedKeydown([], press("KeyA", "a"));
  assert.deepEqual(profileConflicts("client-view", copy, withLearnedKeys(known.learned)), []);
});
