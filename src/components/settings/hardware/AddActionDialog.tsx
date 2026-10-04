import { useMemo, useRef, useState, type KeyboardEvent } from "react";
import { validateCommand, type ParamSpec } from "../../../../common/hardware-action-catalog";
import type { HardwareView } from "../../../../common/hardware-input";
import { HardwareDialog } from "./HardwareDialog";
import { entryCommand, filterEntries, groupCheckState, toggleGroup, type ActionEntry, type Translate } from "./hardwareSettingsModel";

export interface ActionChoice {
  entry: ActionEntry;
  value?: string | number;
}

interface Props {
  view: HardwareView;
  /** The entries this profile may add (for editing: without the edited row itself). */
  entries: readonly ActionEntry[];
  /** Editing an extra row: its entry key and parameter value; then exactly one entry is chosen. */
  initial?: { key: string; value?: string | number };
  t: Translate;
  /** Returns an error to show, or null when the rows were saved. */
  onSubmit(choices: ActionChoice[]): string | null;
  onClose(): void;
}

function ParamField({
  param,
  value,
  invalid,
  label,
  t,
  onChange,
}: {
  param: ParamSpec;
  value: string | number | undefined;
  invalid: boolean;
  label: string;
  t: Translate;
  onChange(value: string | number | undefined): void;
}) {
  if (param.kind === "enum") {
    return (
      <select
        className="form-select form-select-sm"
        data-testid="hardware-param"
        aria-label={label}
        value={String(value)}
        onChange={(event) => onChange(param.values.find((item) => String(item) === event.target.value))}
      >
        {param.values.map((item, i) => (
          <option key={item} value={item}>
            {t(param.labelKeys[i])}
          </option>
        ))}
      </select>
    );
  }
  return (
    <span className="hw-param-input">
      <input
        type="number"
        className={`form-control form-control-sm${invalid ? " is-invalid" : ""}`}
        data-testid="hardware-param"
        aria-label={label}
        min={param.min}
        max={param.max}
        step={1}
        value={value ?? ""}
        onChange={(event) => onChange(event.target.value === "" ? undefined : Number(event.target.value))}
      />
      <span className="text-muted small">
        {param.min} … {param.max}
      </span>
    </span>
  );
}

/**
 * Searchable list of every addable action: tick any number of them (a group
 * name ticks its whole group) and add them at once. The filter narrows the
 * visible list while typing; ticks survive it.
 */
export function AddActionDialog({ view, entries, initial, t, onSubmit, onClose }: Props) {
  const editing = !!initial;
  const [query, setQuery] = useState("");
  const [checked, setChecked] = useState<ReadonlySet<string>>(() => new Set(initial ? [initial.key] : []));
  // An entry's parameter is its default until changed; an edited row keeps its own.
  const [values, setValues] = useState<Record<string, string | number | undefined>>(() => (initial ? { [initial.key]: initial.value } : {}));
  const [error, setError] = useState<string | null>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const filtered = useMemo(() => filterEntries(entries, query, t), [entries, query, t]);
  const groups = useMemo(() => {
    const result: { label: string; entries: ActionEntry[] }[] = [];
    for (const entry of filtered) {
      const last = result[result.length - 1];
      if (last?.label === entry.groupLabel) last.entries.push(entry);
      else result.push({ label: entry.groupLabel, entries: [entry] });
    }
    return result;
  }, [filtered]);
  const valueOf = (entry: ActionEntry) => (entry.key in values ? values[entry.key] : entry.op?.param?.default);
  const choices: ActionChoice[] = entries
    .filter((entry) => checked.has(entry.key) && !entry.listed)
    .map((entry) => ({ entry, value: entry.op?.param ? valueOf(entry) : undefined }));
  const invalid = new Set(choices.filter(({ entry, value }) => !validateCommand(view, entryCommand(entry, value)).ok).map(({ entry }) => entry.key));
  const valid = choices.length > 0 && invalid.size === 0;

  const toggle = (entry: ActionEntry) => {
    setError(null);
    setChecked((current) => {
      if (editing) return new Set([entry.key]);
      const next = new Set(current);
      if (next.has(entry.key)) next.delete(entry.key);
      else next.add(entry.key);
      return next;
    });
  };
  const submit = () => {
    if (!valid) return;
    const failure = onSubmit(choices);
    if (failure) setError(failure);
    else onClose();
  };
  /** Arrow keys walk the entries' ticks (above the first one: back to the search). */
  const moveFocus = (from: Element | null, delta: 1 | -1) => {
    const ticks = [...(listRef.current?.querySelectorAll<HTMLInputElement>(".hw-action-tick:not(:disabled)") ?? [])];
    const index = (from ? ticks.indexOf(from as HTMLInputElement) : -1) + delta;
    if (index < 0) searchRef.current?.focus();
    else ticks[Math.min(index, ticks.length - 1)]?.focus();
  };
  const onListKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const target = event.target as HTMLElement;
    if ((event.key === "ArrowDown" || event.key === "ArrowUp") && target.classList.contains("hw-action-tick")) {
      event.preventDefault();
      moveFocus(target, event.key === "ArrowDown" ? 1 : -1);
    } else if (event.key === "Enter" && target.tagName === "INPUT") {
      event.preventDefault();
      submit();
    }
  };

  return (
    <HardwareDialog
      title={t(editing ? "HardwareEditAction" : "HardwareAddAction")}
      closeLabel={t("Cancel")}
      className="hw-action-dialog"
      onClose={onClose}
      footer={
        <>
          <button type="button" className="btn btn-secondary" onClick={onClose}>
            {t("Cancel")}
          </button>
          <button type="button" className="btn btn-primary" data-testid="hardware-save-row" disabled={!valid} onClick={submit}>
            {editing ? t("HardwareSave") : choices.length > 1 ? `${t("HardwareAdd")} (${choices.length})` : t("HardwareAdd")}
          </button>
        </>
      }
    >
      <input
        ref={searchRef}
        type="search"
        className="form-control"
        data-testid="hardware-action-search"
        placeholder={t("HardwareSearch")}
        aria-label={t("HardwareSearch")}
        value={query}
        autoFocus
        onChange={(event) => setQuery(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === "ArrowDown") {
            event.preventDefault();
            moveFocus(null, 1);
          } else if (event.key === "Enter") {
            event.preventDefault();
            const tickable = filtered.filter((entry) => !entry.listed);
            // A search that leaves a single action picks it with Enter.
            if (!choices.length && tickable.length === 1) toggle(tickable[0]);
            else submit();
          }
        }}
      />
      <div className="hw-action-list" ref={listRef} onKeyDown={onListKeyDown}>
        {filtered.length === 0 && <p className="hw-action-empty">{t("HardwareNoMatches")}</p>}
        {groups.map((group) => {
          const state = groupCheckState(group.entries, checked);
          return (
            <div key={group.label} role="group" aria-label={group.label}>
              <label className="hw-action-group">
                {!editing && (
                  <input
                    type="checkbox"
                    className="form-check-input"
                    data-group={group.label}
                    checked={state === "all"}
                    disabled={group.entries.every((entry) => entry.listed)}
                    ref={(element) => {
                      if (element) element.indeterminate = state === "some";
                    }}
                    onChange={() => {
                      setError(null);
                      setChecked((current) => toggleGroup(group.entries, current));
                    }}
                  />
                )}
                <span>{group.label}</span>
              </label>
              {group.entries.map((entry) => {
                const isChecked = checked.has(entry.key) && !entry.listed;
                const param = entry.op?.param;
                return (
                  <div
                    key={entry.key}
                    className={`hw-action-option${isChecked ? " checked" : ""}${entry.listed ? " listed" : ""}`}
                    data-entry={entry.key}
                  >
                    <label className="hw-action-label">
                      <input
                        type={editing ? "radio" : "checkbox"}
                        name={editing ? "hw-action" : undefined}
                        className="form-check-input hw-action-tick"
                        checked={isChecked}
                        disabled={entry.listed}
                        onChange={() => toggle(entry)}
                      />
                      <span>{entry.label}</span>
                      {entry.listed && <small>{t("HardwareAlreadyListed")}</small>}
                    </label>
                    {isChecked && param && (
                      <ParamField
                        param={param}
                        value={valueOf(entry)}
                        invalid={invalid.has(entry.key)}
                        label={entry.label}
                        t={t}
                        onChange={(value) => {
                          setError(null);
                          setValues((current) => ({ ...current, [entry.key]: value }));
                        }}
                      />
                    )}
                  </div>
                );
              })}
            </div>
          );
        })}
      </div>
      <div className="hw-action-status">
        {!choices.length && <span className="text-muted">{t(editing ? "HardwareChooseAction" : "HardwareChooseActions")}</span>}
        {invalid.size > 0 && (
          <span className="text-danger small" role="alert">
            {t("HardwareInvalidInput")}
          </span>
        )}
        {error && (
          <div className="alert alert-warning py-1 px-2 mb-0 mt-2" role="alert">
            {error}
          </div>
        )}
      </div>
    </HardwareDialog>
  );
}
