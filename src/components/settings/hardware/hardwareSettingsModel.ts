/**
 * Pure model of the Hardware control settings tab: which actions the "Add
 * action" dialog offers, how its live filter matches, and the short labels of
 * rows and inputs. No React and no DOM, so it is unit-tested directly.
 */
import {
  CATALOG_GROUP_LABELS,
  HARDWARE_CATALOG,
  IMPLEMENTED_PRIORITIES,
  catalogFamily,
  commandSignature,
  validateCommand,
  type CatalogFamily,
  type OpSpec,
} from "../../../../common/hardware-action-catalog";
import {
  addExtraRow,
  baseRowId,
  restoreBaseRow,
  visibleRows,
  type IdFactory,
  type HardwareBinding,
  type HardwareKeyboardBinding,
  type HardwareMidiBinding,
  type HardwareView,
  type ProfileOf,
} from "../../../../common/hardware-input";

export type Translate = (key: string) => string;

/** One pickable line of the "Add action" dialog: an operation of a family, or a removed base row. */
export interface ActionEntry {
  /** `action` for a base row, `action:op` for an operation. */
  key: string;
  family: CatalogFamily;
  op?: OpSpec;
  /** Set when the entry brings back a base row the profile removed. */
  baseRowId?: string;
  label: string;
  groupLabel: string;
  /** A parameterless command that is already a row of the profile. */
  listed: boolean;
}

/** The command an entry adds (the parameter value is only used by operations that have one). */
export function entryCommand(entry: Pick<ActionEntry, "family" | "op">, value?: string | number): Record<string, unknown> {
  const { family, op } = entry;
  if (!op) return { action: family.action };
  const command: Record<string, unknown> = family.action === "capo-apply" ? { action: family.action } : { action: family.action, op: op.op };
  if (op.param) command[op.param.name] = value;
  return command;
}

/** Every action the profile may still add, in catalog (= group) order. */
export function actionEntries<V extends HardwareView>(view: V, profile: Readonly<ProfileOf<V>>, t: Translate): ActionEntry[] {
  const rows = visibleRows(view, profile);
  const signatures = new Set(rows.map((row) => commandSignature(row.command as object)));
  const entries: ActionEntry[] = [];
  for (const family of HARDWARE_CATALOG) {
    if (family.view !== view || !IMPLEMENTED_PRIORITIES.includes(family.priority)) continue;
    const groupLabel = t(CATALOG_GROUP_LABELS[family.group]);
    if (family.base) {
      const id = baseRowId(view, family.action);
      if (!rows.some((row) => row.id === id))
        entries.push({ key: family.action, family, baseRowId: id, label: t(family.labelKey), groupLabel, listed: false });
      continue;
    }
    for (const op of family.ops) {
      entries.push({
        key: `${family.action}:${op.op}`,
        family,
        op,
        label: `${t(family.labelKey)} – ${t(op.labelKey)}`,
        groupLabel,
        listed: !op.param && signatures.has(commandSignature(entryCommand({ family, op }))),
      });
    }
  }
  return entries;
}

const fold = (text: string) => text.normalize("NFD").replace(/[̀-ͯ]/g, "").toLocaleLowerCase();

/** Live filter: every typed word must occur in the label, the group or an enum value label (accents ignored). */
export function filterEntries(entries: readonly ActionEntry[], query: string, t: Translate): ActionEntry[] {
  const words = fold(query).split(/\s+/).filter(Boolean);
  if (!words.length) return [...entries];
  return entries.filter((entry) => {
    const values = entry.op?.param?.kind === "enum" ? entry.op.param.labelKeys.map(t) : [];
    const haystack = fold([entry.label, entry.groupLabel, ...values].join(" "));
    return words.every((word) => haystack.includes(word));
  });
}

/** Row label: family, operation and parameter (`Transzponálás · beállítás · 3`). */
export function commandLabel(view: HardwareView, command: object, t: Translate): string {
  const item = command as { action: string; op?: string; value?: string | number; step?: number };
  const family = catalogFamily(view, item.action);
  if (!family) return item.action;
  const spec = family.action === "capo-apply" ? family.ops[0] : family.ops.find((entry) => entry.op === item.op);
  const value = item.value ?? item.step;
  const valueLabel =
    spec?.param?.kind === "enum" ? t(spec.param.labelKeys[spec.param.values.indexOf(value as string | number)] ?? String(value)) : value;
  return [t(family.labelKey), spec ? t(spec.labelKey) : null, value !== undefined ? String(valueLabel) : null].filter(Boolean).join(" · ");
}

const KEY_NAMES: Record<string, string> = {
  ARROWUP: "↑",
  ARROWDOWN: "↓",
  ARROWLEFT: "←",
  ARROWRIGHT: "→",
  UP: "↑",
  DOWN: "↓",
  LEFT: "←",
  RIGHT: "→",
  PAGEUP: "PgUp",
  PAGEDOWN: "PgDn",
  PAGE_UP: "PgUp",
  PAGE_DOWN: "PgDn",
  HOME: "Home",
  END: "End",
  ENTER: "Enter",
  BACKSPACE: "Backspace",
  ESCAPE: "Esc",
  DELETE: "Del",
  INSERT: "Ins",
  TAB: "Tab",
  " ": "Space",
  SPACE: "Space",
  ADD: "+",
  SUBTRACT: "−",
  MULTIPLY: "*",
  DIVIDE: "/",
};

/** The key itself, readable: `KeyA` → `A`, `Numpad7` → `Num 7`, `PAGEUP` → `PgUp`, `ArrowUp` → `↑`. */
export function keyName(binding: Pick<HardwareKeyboardBinding, "match" | "key">): string {
  let key = binding.key;
  if (binding.match === "code") {
    if (/^Key[A-Z]$/.test(key)) return key.slice(3);
    if (/^Digit\d$/.test(key)) return key.slice(5);
    const numpad = /^Numpad(.+)$/.exec(key);
    if (numpad) return `Num ${KEY_NAMES[numpad[1].toUpperCase()] ?? numpad[1]}`;
  }
  const numpad = /^NUMPAD_?(.+)$/.exec(key);
  if (numpad) return `Num ${numpad[1]}`;
  key = KEY_NAMES[key.toUpperCase()] ?? key;
  return key.length === 1 ? key.toUpperCase() : key;
}

/** Compact chip text of an input; uncommon options are appended. */
export function bindingChipLabel(binding: HardwareBinding, t: Translate): string {
  if (binding.kind === "keyboard") {
    const keys = [binding.ctrl && "Ctrl", binding.alt && "Alt", binding.shift && "Shift", binding.meta && "Meta", keyName(binding)]
      .filter(Boolean)
      .join("+");
    const extras = [
      binding.numLock && binding.numLock !== "any" ? t(`HardwareNumLockShort_${binding.numLock}`) : null,
      binding.scope === "full-view" ? t("HardwareScopeFullShort") : null,
    ].filter(Boolean);
    return [keys, ...extras].join(" · ");
  }
  return midiChipLabel(binding, t);
}

function midiChipLabel(binding: HardwareMidiBinding, t: Translate): string {
  const channel = binding.channel === "any" ? t("HardwareAnyChannelShort") : `${t("HardwareChannelShort")} ${binding.channel}`;
  const parts = [`${t(`HardwareMessageShort_${binding.message}`)} ${binding.number}`, channel];
  if (binding.trigger === "legacy-level") parts.push(t("HardwareTriggerLegacyShort"));
  return parts.join(" · ");
}

/** Full description for the chip tooltip. */
export function bindingDetails(binding: HardwareBinding, t: Translate): string {
  if (binding.kind === "keyboard") {
    const scope = binding.scope ? ` · ${t(binding.scope === "full-view" ? "HardwareScopeFull" : "HardwareScopeSections")}` : "";
    return `${bindingChipLabel(binding, t)} · ${t(`HardwareMatch_${binding.match}`)} · ${t(`HardwareNumLock_${binding.numLock ?? "any"}`)}${scope}`;
  }
  const channel = binding.channel === "any" ? t("HardwareAnyChannel") : `${t("HardwareChannel")} ${binding.channel}`;
  const trigger = t(binding.trigger === "press-edge" ? "HardwareTriggerEdge" : "HardwareTriggerLegacy");
  const thresholds =
    binding.message === "control-change" ? ` · ≥${binding.threshold ?? 64} / ≤${binding.releaseThreshold ?? (binding.threshold ?? 64) - 1}` : "";
  return `${t(`HardwareMessage_${binding.message}`)} · ${channel} · #${binding.number} · ${trigger}${thresholds}`;
}

/** The tick state of a group header over the group's tickable (not yet listed) entries. */
export function groupCheckState(group: readonly ActionEntry[], checked: ReadonlySet<string>): "all" | "some" | "none" {
  const tickable = group.filter((entry) => !entry.listed);
  const ticked = tickable.filter((entry) => checked.has(entry.key)).length;
  return ticked === 0 ? "none" : ticked === tickable.length ? "all" : "some";
}

/** A group header tick: every tickable entry of the group on, or all off when they all were on. */
export function toggleGroup(group: readonly ActionEntry[], checked: ReadonlySet<string>): Set<string> {
  const next = new Set(checked);
  const on = groupCheckState(group, checked) !== "all";
  for (const entry of group) {
    if (entry.listed) continue;
    if (on) next.add(entry.key);
    else next.delete(entry.key);
  }
  return next;
}

export type AddedEntries<V extends HardwareView> =
  | { ok: true; profile: ProfileOf<V>; rowIds: string[] }
  | { ok: false; reason: "invalid" | "duplicate"; entry: ActionEntry };

/**
 * Adds several ticked entries at once — all or none: base rows come back,
 * operations become extra rows. An invalid parameter or a command the profile
 * (or this batch) already has stops the whole batch and names the entry.
 */
export function addActionEntries<V extends HardwareView>(
  view: V,
  profile: Readonly<ProfileOf<V>>,
  items: readonly { entry: ActionEntry; value?: string | number }[],
  createId: IdFactory
): AddedEntries<V> {
  let next = profile as ProfileOf<V>;
  const rowIds: string[] = [];
  for (const { entry, value } of items) {
    if (entry.baseRowId) {
      next = restoreBaseRow(next, entry.baseRowId) as ProfileOf<V>;
      rowIds.push(entry.baseRowId);
      continue;
    }
    const validation = validateCommand(view, entryCommand(entry, value));
    if (!validation.ok) return { ok: false, reason: "invalid", entry };
    const signature = commandSignature(validation.command);
    if (next.extraRows.some((row) => commandSignature(row.command as object) === signature)) return { ok: false, reason: "duplicate", entry };
    const id = createId();
    next = addExtraRow(next, validation.command, () => id) as ProfileOf<V>;
    rowIds.push(id);
  }
  return { ok: true, profile: next, rowIds };
}
