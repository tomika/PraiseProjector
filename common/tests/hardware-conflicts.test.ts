import assert from "node:assert/strict";
import { test } from "node:test";
import { bindingsOverlap, keyboardBindingsOverlap, profileConflicts, type KeyboardLayout } from "../hardware-input-conflicts";
import { baseRowId, FACTORY_CLIENT_PROFILE, FACTORY_FULL_PROFILE, type HardwareKeyboardBinding, type HardwareMidiBinding } from "../hardware-input";

const key = (overrides: Partial<HardwareKeyboardBinding> = {}): HardwareKeyboardBinding => ({
  id: "a",
  rowId: baseRowId("client-view", "show-next-song"),
  kind: "keyboard",
  match: "code",
  key: "PageDown",
  ctrl: false,
  alt: false,
  shift: false,
  meta: false,
  ...overrides,
});
const midi = (overrides: Partial<HardwareMidiBinding> = {}): HardwareMidiBinding => ({
  id: "a",
  rowId: baseRowId("client-view", "show-next-song"),
  kind: "midi",
  mode: "button",
  trigger: "press-edge",
  message: "control-change",
  channel: "any",
  number: 21,
  ...overrides,
});

test("both factory profiles have no conflicts (context-dependent keys are allowed)", () => {
  assert.deepEqual(profileConflicts("client-view", FACTORY_CLIENT_PROFILE), []);
  assert.deepEqual(profileConflicts("full-view", FACTORY_FULL_PROFILE), []);
});
test("keyboard overlap uses actual match, NumLock and modifier policies, symmetrically", () => {
  const pairs: [HardwareKeyboardBinding, HardwareKeyboardBinding, boolean][] = [
    [key(), key(), true],
    [key(), key({ key: "Home" }), false],
    [key({ numLock: "on" }), key({ numLock: "off" }), false],
    [key({ numLock: "on" }), key({ numLock: "any" }), true],
    [key(), key({ ctrl: true }), false],
    [key({ modifiers: "ignore" }), key({ ctrl: true }), true],
    [key({ repeat: "ignore", scope: "section-list" }), key({ repeat: "allow", scope: "full-view" }), true],
    [key({ match: "key", key: "ArrowDown" }), key({ match: "legacy-key", key: "DOWN" }), true],
    [key({ match: "key", key: "+" }), key({ match: "legacy-key", key: "ADD" }), true],
    [key({ match: "key", key: "-" }), key({ match: "legacy-key", key: "SUBTRACT" }), true],
    [key({ match: "key", key: "Del" }), key({ match: "legacy-key", key: "DELETE" }), true],
    [key({ match: "key", key: "Home" }), key({ match: "legacy-key", key: "END" }), false],
    [key({ key: "Numpad7" }), key({ match: "legacy-key", key: "HOME" }), true],
    [key({ key: "Numpad7" }), key({ match: "key", key: "7" }), true],
    [key({ key: "Numpad7" }), key({ match: "key", key: "End" }), false],
    [key({ key: "KeyY" }), key({ match: "key", key: "z" }), true],
    [key({ key: "KeyY" }), key({ match: "key", key: "Home" }), false],
    [key({ key: "F6" }), key({ match: "legacy-key", key: "F6" }), true],
    [key({ key: "F6" }), key({ match: "key", key: "F7" }), false],
    // Without a known layout a layout key may type any character (Dvorak KeyQ → ', HU Backquote → 0, AltGr+F → [).
    [key({ key: "KeyA" }), key({ match: "legacy-key", key: "7" }), true],
    [key({ key: "KeyQ" }), key({ match: "legacy-key", key: "'" }), true],
    [key({ key: "Digit7" }), key({ match: "key", key: "a" }), true],
    [key({ key: "KeyF", ctrl: true, alt: true }), key({ match: "legacy-key", key: "[", ctrl: true, alt: true }), true],
    [key({ key: "NumpadEqual" }), key({ match: "key", key: "=" }), true],
    [key({ key: "KeyA" }), key({ match: "legacy-key", key: "HOME" }), false],
    [key({ key: "Space" }), key({ match: "key", key: " " }), true],
    [key({ key: "MediaPlayPause", ctrl: true, alt: true }), key({ match: "key", key: "[", ctrl: true, alt: true }), false],
    // Numpad meaning follows the NumLock condition of either side.
    [key({ key: "Numpad7", numLock: "off" }), key({ match: "legacy-key", key: "7" }), false],
    [key({ key: "Numpad7", numLock: "on" }), key({ match: "legacy-key", key: "HOME" }), false],
    [key({ key: "Numpad7" }), key({ match: "legacy-key", key: "7", numLock: "off" }), false],
    [key({ key: "NumpadDecimal", numLock: "on" }), key({ match: "key", key: "," }), true],
    [key({ key: "NumpadDecimal" }), key({ match: "legacy-key", key: "DELETE" }), true],
    // Named keys only meet the same name.
    [key({ key: "MediaPlayPause" }), key({ match: "key", key: "MediaPlayPause" }), true],
    [key({ key: "MediaPlayPause" }), key({ match: "legacy-key", key: "7" }), false],
  ];
  for (const [a, b, expected] of pairs) {
    assert.equal(keyboardBindingsOverlap(a, b), expected, JSON.stringify([a, b]));
    assert.equal(keyboardBindingsOverlap(b, a), expected);
  }
});
const LETTERS = "ABCDEFGHIJKLMNOPQRSTUVWXYZ".split("");
/** A fake current layout: unmodified and (optionally) Shift layers; Alt layers are unknown. */
const layoutOf =
  (base: Record<string, string>, shifted: Record<string, string> = {}): KeyboardLayout =>
  (code, shift, alt) =>
    alt ? undefined : (shift ? shifted : base)[code];
const US = layoutOf(
  { ...Object.fromEntries(LETTERS.map((letter) => [`Key${letter}`, letter.toLowerCase()])), Digit7: "7", Backquote: "`", Equal: "=" },
  { KeyA: "A", Digit7: "&", Equal: "+" }
);
const HU = layoutOf({ KeyA: "a", KeyY: "z", KeyZ: "y", Digit7: "7", Digit0: "ö", Backquote: "0" });
const DVORAK = layoutOf({ KeyQ: "'", KeyW: ",", KeyA: "a", KeyS: "o", Digit7: "7" });

test("with the current layout known, layout keys compare exactly; unknown Shift/Alt states stay conservative", () => {
  const cases: [KeyboardLayout, HardwareKeyboardBinding, HardwareKeyboardBinding, boolean][] = [
    [US, key({ key: "KeyA" }), key({ match: "legacy-key", key: "7" }), false],
    [US, key({ key: "KeyA" }), key({ match: "key", key: "a" }), true],
    [US, key({ key: "KeyA" }), key({ match: "legacy-key", key: "A" }), true],
    [US, key({ key: "KeyQ" }), key({ match: "legacy-key", key: "'" }), false],
    [DVORAK, key({ key: "KeyQ" }), key({ match: "legacy-key", key: "'" }), true],
    [DVORAK, key({ key: "KeyQ" }), key({ match: "key", key: "q" }), false],
    [HU, key({ key: "Backquote" }), key({ match: "legacy-key", key: "0" }), true],
    [HU, key({ key: "Digit0" }), key({ match: "legacy-key", key: "0" }), false],
    [HU, key({ key: "KeyZ" }), key({ match: "key", key: "y" }), true],
    [HU, key({ key: "KeyY" }), key({ match: "key", key: "y" }), false],
    [US, key({ key: "Equal", shift: true }), key({ match: "legacy-key", key: "ADD", shift: true }), true],
    [US, key({ key: "Digit7", shift: true }), key({ match: "key", key: "7", shift: true }), false],
    [US, key({ key: "KeyF", ctrl: true, alt: true }), key({ match: "legacy-key", key: "[", ctrl: true, alt: true }), true],
    [US, key({ key: "KeyA", modifiers: "ignore" }), key({ match: "legacy-key", key: "7", modifiers: "ignore" }), true],
    [US, key({ key: "KeyA" }), key({ match: "legacy-key", key: "7", modifiers: "ignore" }), false],
    [HU, key({ key: "KeyM" }), key({ match: "legacy-key", key: "7" }), true],
    // CapsLock is no binding condition and flips a letter's case, with or without Shift.
    [US, key({ key: "KeyA" }), key({ match: "key", key: "A" }), true],
    [US, key({ key: "KeyA", shift: true }), key({ match: "key", key: "a", shift: true }), true],
    [HU, key({ key: "Digit0" }), key({ match: "key", key: "Ö" }), true],
    [US, key({ key: "KeyA" }), key({ match: "key", key: "B" }), false],
    [US, key({ key: "Digit7" }), key({ match: "key", key: "&" }), false],
  ];
  for (const [layout, a, b, expected] of cases) {
    assert.equal(keyboardBindingsOverlap(a, b, layout), expected, JSON.stringify([a, b]));
    assert.equal(keyboardBindingsOverlap(b, a, layout), expected);
  }
});

test("a copy of the factory client profile: letter keys are free on the actual layout, conservative without it", () => {
  for (const letter of LETTERS) {
    const profile = { ...FACTORY_CLIENT_PROFILE, bindings: [...FACTORY_CLIENT_PROFILE.bindings, key({ id: "new", key: `Key${letter}` })] };
    assert.deepEqual(profileConflicts("client-view", profile, US), [], `Key${letter}`);
  }
  const letterA = { ...FACTORY_CLIENT_PROFILE, bindings: [...FACTORY_CLIENT_PROFILE.bindings, key({ id: "new", key: "KeyA" })] };
  assert.ok(profileConflicts("client-view", letterA).length > 0, "an unknown layout cannot rule out a digit on KeyA");
  const digit = { ...FACTORY_CLIENT_PROFILE, bindings: [...FACTORY_CLIENT_PROFILE.bindings, key({ id: "new", key: "Digit7" })] };
  assert.ok(profileConflicts("client-view", digit, US).length > 0, "the main-keyboard 7 collides with the legacy 7 rows");
});
test("MIDI wildcard/number/type and different CC thresholds", () => {
  for (const [a, b, expected] of [
    [midi(), midi({ channel: 1 }), true],
    [midi({ channel: 1 }), midi({ channel: 2 }), false],
    [midi(), midi({ number: 22 }), false],
    [midi(), midi({ message: "note-on" }), false],
    [midi({ threshold: 64 }), midi({ threshold: 100, trigger: "legacy-level" }), true],
    [key(), midi(), false],
  ] as const) {
    assert.equal(bindingsOverlap(a, b), expected);
    assert.equal(bindingsOverlap(b, a), expected);
  }
});
test("profile collisions name both rows; missing rows are ignored; direct rows overlap both contexts", () => {
  const profile = {
    id: "p",
    name: "P",
    extraRows: [{ id: "extra", command: { action: "transpose", op: "set", value: 3 } }],
    bindings: [
      key(),
      key({ id: "b", rowId: baseRowId("client-view", "select-next-visible-song") }),
      key({ id: "c", rowId: "extra" }),
      key({ id: "missing", rowId: "missing" }),
    ],
  };
  assert.deepEqual(
    profileConflicts("client-view", profile).map((c) => [c.leftId, c.rightId]),
    [
      ["a", "c"],
      ["b", "c"],
    ]
  );
  const same = { ...profile, bindings: [key(), key({ id: "duplicate-input" })] };
  assert.equal(profileConflicts("client-view", same).length, 1);
  assert.equal(
    profileConflicts("full-view", {
      ...profile,
      bindings: [key({ rowId: baseRowId("full-view", "next-down") }), key({ id: "b", rowId: baseRowId("full-view", "next-up") })],
    }).length,
    1
  );
});
