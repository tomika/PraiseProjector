import { useState } from "react";
import type { HardwareBinding, HardwareView } from "../../../../common/hardware-input";
import { validateBinding } from "../../../../common/hardware-input-validation";
import { HardwareDialog } from "./HardwareDialog";
import { bindingChipLabel, type Translate } from "./hardwareSettingsModel";

interface Props {
  view: HardwareView;
  binding: HardwareBinding;
  isNew: boolean;
  /** The row the input belongs to, shown as context. */
  rowLabel: string;
  t: Translate;
  /** Returns an error to show, or null when saved. */
  onSave(binding: HardwareBinding): string | null;
  onDelete(): void;
  onClose(): void;
}

const MIDI_MESSAGES = ["note-on", "control-change", "program-change"] as const;

/** Options of one keyboard or MIDI input (opened from its chip or for a manual MIDI input). */
export function BindingDialog({ view, binding, isNew, rowLabel, t, onSave, onDelete, onClose }: Props) {
  const [draft, setDraft] = useState<HardwareBinding>(binding);
  const [error, setError] = useState<string | null>(null);
  const validation = validateBinding(view, draft);
  const update = (patch: Partial<HardwareBinding>) => {
    setError(null);
    setDraft({ ...draft, ...patch } as HardwareBinding);
  };
  const numberValue = (value: number | undefined, fallback: number) => (value === undefined ? fallback : Number.isNaN(value) ? "" : value);
  const parseNumber = (text: string) => (text === "" ? NaN : Number(text));
  const save = () => {
    if (!validation.ok) return;
    const failure = onSave(validation.binding);
    if (failure) setError(failure);
    else onClose();
  };

  return (
    <HardwareDialog
      title={t(isNew ? "HardwareNewMidiInput" : "HardwareBindingOptions")}
      closeLabel={t("Cancel")}
      className="hw-binding-dialog"
      onClose={onClose}
      footer={
        <>
          {!isNew && (
            <button type="button" className="btn btn-outline-danger me-auto" data-testid="hardware-delete-binding" onClick={onDelete}>
              {t("HardwareRemoveBinding")}
            </button>
          )}
          <button type="button" className="btn btn-secondary" onClick={onClose}>
            {t("Cancel")}
          </button>
          <button type="button" className="btn btn-primary" data-testid="hardware-save-binding" disabled={!validation.ok} onClick={save}>
            {t("HardwareSave")}
          </button>
        </>
      }
    >
      <p className="hw-binding-context">
        <span className="text-muted">{t("HardwareAction")}:</span> {rowLabel}
      </p>
      <form
        className="hw-binding-form"
        onSubmit={(event) => {
          event.preventDefault();
          save();
        }}
      >
        {draft.kind === "keyboard" ? (
          <>
            <div className="hw-field">
              <span className="form-label">{t("HardwareKey")}</span>
              <span className="hw-chip hw-chip-static">{bindingChipLabel(draft, t)}</span>
            </div>
            <label className="hw-field">
              <span className="form-label">{t("HardwareModifiers")}</span>
              <select
                id="hw-key-modifiers"
                className="form-select form-select-sm"
                autoFocus
                value={draft.modifiers ?? "exact"}
                onChange={(event) => update({ modifiers: event.target.value as "exact" | "ignore" })}
              >
                <option value="exact">{t("HardwareModifiersExact")}</option>
                <option value="ignore">{t("HardwareModifiersIgnore")}</option>
              </select>
            </label>
            <label className="hw-field">
              <span className="form-label">{t("HardwareRepeat")}</span>
              <select
                id="hw-key-repeat"
                className="form-select form-select-sm"
                value={draft.repeat ?? "ignore"}
                onChange={(event) => update({ repeat: event.target.value as "ignore" | "allow" })}
              >
                <option value="ignore">{t("HardwareRepeatIgnore")}</option>
                <option value="allow">{t("HardwareRepeatAllow")}</option>
              </select>
            </label>
            <label className="hw-field">
              <span className="form-label">NumLock</span>
              <select
                id="hw-key-numlock"
                className="form-select form-select-sm"
                value={draft.numLock ?? "any"}
                onChange={(event) => update({ numLock: event.target.value as "any" | "on" | "off" })}
              >
                {(["any", "on", "off"] as const).map((value) => (
                  <option key={value} value={value}>
                    {t(`HardwareNumLock_${value}`)}
                  </option>
                ))}
              </select>
            </label>
            {view === "full-view" && (
              <label className="hw-field">
                <span className="form-label">{t("HardwareScope")}</span>
                <select
                  id="hw-key-scope"
                  className="form-select form-select-sm"
                  value={draft.scope ?? "section-list"}
                  onChange={(event) => update({ scope: event.target.value as "section-list" | "full-view" })}
                >
                  <option value="section-list">{t("HardwareScopeSections")}</option>
                  <option value="full-view">{t("HardwareScopeFull")}</option>
                </select>
              </label>
            )}
          </>
        ) : (
          <>
            <label className="hw-field">
              <span className="form-label">{t("HardwareMidiMessage")}</span>
              <select
                id="hw-midi-message"
                className="form-select form-select-sm"
                autoFocus
                value={draft.message}
                onChange={(event) => update({ message: event.target.value as (typeof MIDI_MESSAGES)[number] })}
              >
                {MIDI_MESSAGES.map((value) => (
                  <option key={value} value={value}>
                    {t(`HardwareMessage_${value}`)}
                  </option>
                ))}
              </select>
            </label>
            <label className="hw-field">
              <span className="form-label">{t("HardwareMidiNumber")}</span>
              <input
                id="hw-midi-number"
                className="form-control form-control-sm"
                type="number"
                min={0}
                max={127}
                value={numberValue(draft.number, 0)}
                onChange={(event) => update({ number: parseNumber(event.target.value) })}
              />
            </label>
            <label className="hw-field">
              <span className="form-label">{t("HardwareChannel")}</span>
              <select
                id="hw-midi-channel"
                className="form-select form-select-sm"
                value={draft.channel}
                onChange={(event) => update({ channel: event.target.value === "any" ? "any" : Number(event.target.value) })}
              >
                <option value="any">{t("HardwareAnyChannel")}</option>
                {Array.from({ length: 16 }, (_, i) => (
                  <option key={i} value={i + 1}>
                    {i + 1}
                  </option>
                ))}
              </select>
            </label>
            <label className="hw-field">
              <span className="form-label">{t("HardwareTrigger")}</span>
              <select
                id="hw-midi-trigger"
                className="form-select form-select-sm"
                value={draft.trigger}
                onChange={(event) => update({ trigger: event.target.value as "press-edge" | "legacy-level" })}
              >
                <option value="press-edge">{t("HardwareTriggerEdge")}</option>
                <option value="legacy-level">{t("HardwareTriggerLegacy")}</option>
              </select>
            </label>
            {draft.message === "control-change" && (
              <>
                <label className="hw-field">
                  <span className="form-label">{t("HardwareThreshold")}</span>
                  <input
                    id="hw-cc-threshold"
                    className="form-control form-control-sm"
                    type="number"
                    min={0}
                    max={127}
                    value={numberValue(draft.threshold, 64)}
                    onChange={(event) => update({ threshold: parseNumber(event.target.value) })}
                  />
                </label>
                <label className="hw-field">
                  <span className="form-label">{t("HardwareReleaseThreshold")}</span>
                  <input
                    id="hw-cc-release"
                    className="form-control form-control-sm"
                    type="number"
                    min={0}
                    max={127}
                    value={numberValue(draft.releaseThreshold, (draft.threshold ?? 64) - 1)}
                    onChange={(event) => update({ releaseThreshold: parseNumber(event.target.value) })}
                  />
                </label>
              </>
            )}
          </>
        )}
        <button type="submit" hidden />
      </form>
      {!validation.ok && (
        <p className="text-danger small mb-0" role="alert">
          {t("HardwareInvalidInput")}
        </p>
      )}
      {error && (
        <div className="alert alert-warning py-1 px-2 mb-0 mt-2" role="alert">
          {error}
        </div>
      )}
    </HardwareDialog>
  );
}
