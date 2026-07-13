import { getKeyCodeString, isNumLockEnabled } from "../../../chordpro/keycodes";

/** Stable commands exposed by the configurable client-view input layer. */
export type ClientViewInputAction =
  | "toggle-options"
  | "show-previous-song"
  | "show-next-song"
  | "select-previous-visible-song"
  | "select-next-visible-song"
  | "select-first-control"
  | "cycle-next-main-control"
  | "select-previous-option-control"
  | "select-next-option-control"
  | "activate-option-control"
  | "decrease-main-control"
  | "increase-main-control"
  | "clear-control";

export type ClientViewInputContext = "song-view" | "options";

export const CLIENT_VIEW_INPUT_ACTIONS: readonly ClientViewInputAction[] = [
  "toggle-options",
  "show-previous-song",
  "show-next-song",
  "select-previous-visible-song",
  "select-next-visible-song",
  "select-first-control",
  "cycle-next-main-control",
  "select-previous-option-control",
  "select-next-option-control",
  "activate-option-control",
  "decrease-main-control",
  "increase-main-control",
  "clear-control",
];

export const CLIENT_VIEW_INPUT_ACTION_CONTEXTS: Record<ClientViewInputAction, readonly ClientViewInputContext[]> = {
  "toggle-options": ["song-view", "options"],
  "show-previous-song": ["song-view"],
  "show-next-song": ["song-view"],
  "select-previous-visible-song": ["options"],
  "select-next-visible-song": ["options"],
  "select-first-control": ["song-view", "options"],
  "cycle-next-main-control": ["song-view"],
  "select-previous-option-control": ["options"],
  "select-next-option-control": ["options"],
  "activate-option-control": ["options"],
  "decrease-main-control": ["song-view"],
  "increase-main-control": ["song-view"],
  "clear-control": ["song-view", "options"],
};

export function clientViewInputActionAvailable(action: ClientViewInputAction, context: ClientViewInputContext): boolean {
  return CLIENT_VIEW_INPUT_ACTION_CONTEXTS[action].includes(context);
}

export function clientViewInputActionsOverlap(left: ClientViewInputAction, right: ClientViewInputAction): boolean {
  return CLIENT_VIEW_INPUT_ACTION_CONTEXTS[left].some((context) => CLIENT_VIEW_INPUT_ACTION_CONTEXTS[right].includes(context));
}

export type KeyboardMatchMode = "code" | "legacy-key";
export type NumLockRequirement = "any" | "on" | "off";

export interface ClientViewKeyboardBinding {
  id: string;
  kind: "keyboard";
  action: ClientViewInputAction;
  /** `code` is physical/layout-independent; `legacy-key` reproduces the old client. */
  match: KeyboardMatchMode;
  key: string;
  ctrl: boolean;
  alt: boolean;
  shift: boolean;
  meta: boolean;
  numLock?: NumLockRequirement;
}

export type ClientViewMidiMessage = "note-on" | "control-change" | "program-change";

export interface ClientViewMidiBinding {
  id: string;
  kind: "midi";
  action: ClientViewInputAction;
  message: ClientViewMidiMessage;
  channel: number | "any";
  /** MIDI note, controller or program number (0..127). */
  number: number;
  /** CC uses this as a minimum value; note-on is always positive velocity. */
  threshold?: number;
}

export type ClientViewInputBinding = ClientViewKeyboardBinding | ClientViewMidiBinding;

export interface ClientViewInputProfile {
  id: string;
  name: string;
  bindings: ClientViewInputBinding[];
}

export const FACTORY_CLIENT_VIEW_INPUT_PROFILE_ID = "factory";

/**
 * The legacy key matching intentionally uses the same normalizer as
 * praiseprojector.ts. In particular, NumLock changes the logical meaning of
 * Numpad 3/7/9, which a physical-code-only profile could not reproduce.
 */
export const FACTORY_CLIENT_VIEW_INPUT_PROFILE: Readonly<ClientViewInputProfile> = {
  id: FACTORY_CLIENT_VIEW_INPUT_PROFILE_ID,
  name: "Gyári (régi kliens kiosztása)",
  bindings: [
    keyboard("factory-home", "toggle-options", "HOME"),
    keyboard("factory-page-up-song", "show-previous-song", "PAGEUP"),
    keyboard("factory-page-up-options", "select-previous-visible-song", "PAGEUP"),
    keyboard("factory-page-down-song", "show-next-song", "PAGEDOWN"),
    keyboard("factory-page-down-options", "select-next-visible-song", "PAGEDOWN"),
    keyboard("factory-seven-song", "cycle-next-main-control", "7"),
    keyboard("factory-seven-options", "activate-option-control", "7"),
    keyboard("factory-nine-song", "decrease-main-control", "9"),
    keyboard("factory-nine-options", "select-previous-option-control", "9"),
    keyboard("factory-three-song", "increase-main-control", "3"),
    keyboard("factory-three-options", "select-next-option-control", "3"),
    keyboard("factory-numlock-on", "select-first-control", "NUMLOCK", "on"),
    keyboard("factory-numlock-off", "clear-control", "NUMLOCK", "off"),
  ],
};

function keyboard(id: string, action: ClientViewInputAction, key: string, numLock: NumLockRequirement = "any"): ClientViewKeyboardBinding {
  return { id, kind: "keyboard", action, match: "legacy-key", key, ctrl: false, alt: false, shift: false, meta: false, numLock };
}

export function resolveClientViewInputProfile(activeId: unknown, customProfiles: unknown): ClientViewInputProfile {
  const profiles = normalizeClientViewInputProfiles(customProfiles);
  if (typeof activeId === "string") {
    const profile = profiles.find((candidate) => candidate.id === activeId);
    if (profile) return profile;
  }
  return FACTORY_CLIENT_VIEW_INPUT_PROFILE;
}

/** Drop malformed persisted items instead of letting a stale localStorage value break input. */
export function normalizeClientViewInputProfiles(value: unknown): ClientViewInputProfile[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((candidate) => {
    if (!candidate || typeof candidate !== "object") return [];
    const source = candidate as Partial<ClientViewInputProfile>;
    if (typeof source.id !== "string" || !source.id || source.id === FACTORY_CLIENT_VIEW_INPUT_PROFILE_ID || typeof source.name !== "string")
      return [];
    const bindings = Array.isArray(source.bindings) ? source.bindings.flatMap(normalizeBinding) : [];
    return [{ id: source.id, name: source.name.trim() || "Névtelen profil", bindings }];
  });
}

const migratedActions: Record<string, readonly ClientViewInputAction[]> = {
  "navigate-previous": ["show-previous-song", "select-previous-visible-song"],
  "navigate-next": ["show-next-song", "select-next-visible-song"],
  "select-previous-control": ["select-previous-option-control"],
  "select-next-control": ["cycle-next-main-control", "select-next-option-control"],
  "activate-control": ["activate-option-control"],
  "decrease-control": ["decrease-main-control"],
  "increase-control": ["increase-main-control"],
  "legacy-primary": ["cycle-next-main-control", "activate-option-control"],
  "legacy-back": ["decrease-main-control", "select-previous-option-control"],
  "legacy-forward": ["increase-main-control", "select-next-option-control"],
};

function normalizeBinding(value: unknown): ClientViewInputBinding[] {
  if (!value || typeof value !== "object") return [];
  const source = value as ClientViewInputBinding & { action?: string };
  if (typeof source.id !== "string" || !source.id) return [];
  const actions = CLIENT_VIEW_INPUT_ACTIONS.includes(source.action as ClientViewInputAction)
    ? [source.action as ClientViewInputAction]
    : (migratedActions[source.action ?? ""] ?? []);
  return actions.flatMap((action, index) => {
    const binding = { ...source, id: index === 0 ? source.id : `${source.id}-${action}`, action } as ClientViewInputBinding;
    return isBinding(binding) ? [binding] : [];
  });
}

function isBinding(value: unknown): value is ClientViewInputBinding {
  if (!value || typeof value !== "object") return false;
  const binding = value as Partial<ClientViewInputBinding>;
  if (typeof binding.id !== "string" || !CLIENT_VIEW_INPUT_ACTIONS.includes(binding.action as ClientViewInputAction)) return false;
  if (binding.kind === "keyboard") {
    const keyboardBinding = binding as Partial<ClientViewKeyboardBinding>;
    return (
      (keyboardBinding.match === "code" || keyboardBinding.match === "legacy-key") &&
      typeof keyboardBinding.key === "string" &&
      typeof keyboardBinding.ctrl === "boolean" &&
      typeof keyboardBinding.alt === "boolean" &&
      typeof keyboardBinding.shift === "boolean" &&
      typeof keyboardBinding.meta === "boolean" &&
      (keyboardBinding.numLock === undefined ||
        keyboardBinding.numLock === "any" ||
        keyboardBinding.numLock === "on" ||
        keyboardBinding.numLock === "off")
    );
  }
  if (binding.kind === "midi") {
    const midiBinding = binding as Partial<ClientViewMidiBinding>;
    return (
      (midiBinding.message === "note-on" || midiBinding.message === "control-change" || midiBinding.message === "program-change") &&
      (midiBinding.channel === "any" || (typeof midiBinding.channel === "number" && midiBinding.channel >= 1 && midiBinding.channel <= 16)) &&
      typeof midiBinding.number === "number" &&
      midiBinding.number >= 0 &&
      midiBinding.number <= 127 &&
      (midiBinding.threshold === undefined ||
        (typeof midiBinding.threshold === "number" && midiBinding.threshold >= 0 && midiBinding.threshold <= 127))
    );
  }
  return false;
}

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

export interface ParsedMidiMessage {
  message: ClientViewMidiMessage;
  channel: number;
  number: number;
  value: number;
}

export function parseMidiMessage(data: ArrayLike<number>): ParsedMidiMessage | null {
  const status = data[0];
  if (typeof status !== "number" || status < 0x80 || status >= 0xf0) return null;
  const type = status & 0xf0;
  const channel = (status & 0x0f) + 1;
  const number = data[1];
  const value = data[2] ?? 0;
  if (typeof number !== "number") return null;
  if (type === 0x90) return value > 0 ? { message: "note-on", channel, number, value } : null;
  if (type === 0xb0) return { message: "control-change", channel, number, value };
  if (type === 0xc0) return { message: "program-change", channel, number, value: 127 };
  return null;
}

export function matchesMidiBinding(binding: ClientViewMidiBinding, message: ParsedMidiMessage): boolean {
  if (binding.message !== message.message || binding.number !== message.number) return false;
  if (binding.channel !== "any" && binding.channel !== message.channel) return false;
  if (message.message === "control-change") return message.value >= (binding.threshold ?? 64);
  return message.value > 0;
}

export function formatKeyboardBinding(binding: ClientViewKeyboardBinding): string {
  const modifiers = [binding.ctrl && "Ctrl", binding.alt && "Alt", binding.shift && "Shift", binding.meta && "Meta"].filter(Boolean);
  const suffix = binding.numLock && binding.numLock !== "any" ? ` (NumLock ${binding.numLock === "on" ? "be" : "ki"})` : "";
  return [...modifiers, binding.key].filter(Boolean).join("+") + suffix;
}

export function formatMidiBinding(binding: ClientViewMidiBinding): string {
  const message = binding.message === "note-on" ? "Note" : binding.message === "control-change" ? "CC" : "Program";
  const channel = binding.channel === "any" ? "bármely csatorna" : `ch. ${binding.channel}`;
  return `${message} ${binding.number} (${channel})`;
}
