/**
 * Persisted `pp-settings` fragments in the pre-hardware-tab format. They are the
 * migration and regression reference: what existing installations have on disk.
 */
export const LEGACY_SETTINGS_FIXTURES = {
  /** A custom profile with keyboard + MIDI bindings selected as active. */
  custom: {
    clientViewActiveInputProfileId: "p-custom",
    clientViewInputProfiles: [
      {
        id: "p-custom",
        name: "Pedálok",
        bindings: [
          {
            id: "b-key",
            kind: "keyboard",
            action: "toggle-options",
            match: "code",
            key: "F6",
            ctrl: false,
            alt: false,
            shift: false,
            meta: false,
            numLock: "any",
          },
          {
            id: "b-legacy",
            kind: "keyboard",
            action: "show-next-song",
            match: "legacy-key",
            key: "PAGEDOWN",
            ctrl: false,
            alt: false,
            shift: false,
            meta: false,
          },
          { id: "b-note", kind: "midi", action: "show-previous-song", message: "note-on", channel: 1, number: 36 },
          { id: "b-cc", kind: "midi", action: "show-next-song", message: "control-change", channel: "any", number: 64, threshold: 64 },
          { id: "b-pc", kind: "midi", action: "toggle-options", message: "program-change", channel: 2, number: 5 },
        ],
      },
      { id: "p-second", name: "Második", bindings: [] },
    ],
  },
  /** Bindings saved with the pre-split action names. */
  aliases: {
    clientViewActiveInputProfileId: "p-alias",
    clientViewInputProfiles: [
      {
        id: "p-alias",
        name: "Régi nevek",
        bindings: [
          { id: "k1", kind: "keyboard", action: "navigate-previous", match: "code", key: "KeyA", ctrl: false, alt: false, shift: false, meta: false },
          { id: "m1", kind: "midi", action: "legacy-primary", message: "note-on", channel: 1, number: 40 },
          { id: "m2", kind: "midi", action: "increase-control", message: "control-change", channel: 1, number: 7, threshold: 100 },
        ],
      },
    ],
  },
  /** Partly corrupt data: only the valid parts may survive. */
  malformed: {
    clientViewActiveInputProfileId: "p-good",
    clientViewInputProfiles: [
      {
        id: "p-good",
        name: "Good",
        bindings: [
          {
            id: "ok-key",
            kind: "keyboard",
            action: "toggle-options",
            match: "code",
            key: "KeyX",
            ctrl: false,
            alt: false,
            shift: false,
            meta: false,
          },
          {
            id: "bad-match",
            kind: "keyboard",
            action: "toggle-options",
            match: "regex",
            key: "KeyY",
            ctrl: false,
            alt: false,
            shift: false,
            meta: false,
          },
          { id: "bad-channel", kind: "midi", action: "toggle-options", message: "note-on", channel: 17, number: 1 },
          { id: "bad-action", kind: "midi", action: "launch-rockets", message: "note-on", channel: 1, number: 2 },
          { kind: "midi", action: "toggle-options", message: "note-on", channel: 1, number: 3 },
          { id: "ok-cc", kind: "midi", action: "clear-control", message: "control-change", channel: 3, number: 11, threshold: 10 },
          "garbage",
        ],
      },
      { id: "factory", name: "Hijacked factory", bindings: [] },
      { id: "", name: "No id", bindings: [] },
      { id: "p-noname", bindings: [] },
      { id: "p-blank", name: "   ", bindings: "not-an-array" },
      42,
    ],
  },
  /** A legacy profile with two overlapping MIDI bindings (wildcard vs concrete channel). */
  conflicting: {
    clientViewActiveInputProfileId: "p-conflict",
    clientViewInputProfiles: [
      {
        id: "p-conflict",
        name: "Ütköző",
        bindings: [
          { id: "any-ch", kind: "midi", action: "show-next-song", message: "control-change", channel: "any", number: 64, threshold: 64 },
          { id: "ch1", kind: "midi", action: "toggle-options", message: "control-change", channel: 1, number: 64, threshold: 100 },
        ],
      },
    ],
  },
};
