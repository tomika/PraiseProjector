import { Fragment, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { v4 as uuid } from "uuid";
import type { Settings } from "../../types";
import { useLocalization, type StringKey } from "../../localization/LocalizationContext";
import { useMessageBox } from "../../contexts/MessageBoxContext";
import { commandSignature, validateCommand } from "../../../common/hardware-action-catalog";
import {
  FACTORY_PROFILE_ID,
  addBinding,
  bindingsForRow,
  copyProfile,
  createProfile,
  deleteProfile,
  isBaseRowId,
  removeBinding,
  removeRow,
  resolveActiveProfile,
  setActiveProfile,
  upsertProfile,
  visibleRows,
  type HardwareBinding,
  type HardwareCommand,
  type HardwareKeyboardBinding,
  type HardwareMidiBinding,
  type HardwareProfile,
  type HardwareView,
} from "../../../common/hardware-input";
import { profileConflicts, type HardwareConflict, type KeyboardLayout } from "../../../common/hardware-input-conflicts";
import { normalizeHardwareInputSettings, validateBinding } from "../../../common/hardware-input-validation";
import { getHardwareInputRuntime } from "../../hardware-input/hardwareInputRuntime";
import { getMidiInputService } from "../../hardware-input/midiInputService";
import { keyboardBindingFromEvent } from "../../hardware-input/keyboardInput";
import {
  LAYOUT_POLL_MS,
  addLearnedKeydown,
  loadKeyboardLayout,
  withLearnedKeys,
  type KeyboardLayoutSnapshot,
  type LearnedKeydown,
} from "../../hardware-input/keyboardLayout";
import { isNumLockEnabled } from "../../../chordpro/keycodes";
import { AddActionDialog, type ActionChoice } from "./hardware/AddActionDialog";
import { BindingDialog } from "./hardware/BindingDialog";
import { actionEntries, addActionEntries, bindingChipLabel, bindingDetails, commandLabel, entryCommand } from "./hardware/hardwareSettingsModel";
import "./HardwareControlSettings.css";

interface Props {
  settings: Settings;
  updateSetting: <K extends keyof Settings>(key: K, value: Settings[K]) => void;
  isActive: boolean;
}

type Profile = HardwareProfile<HardwareCommand>;
type InputKind = "keyboard" | "midi";
const INPUT_KINDS: readonly InputKind[] = ["keyboard", "midi"];
const VIEWS: readonly HardwareView[] = ["client-view", "full-view"];
const pairKey = (conflict: HardwareConflict) => [conflict.leftId, conflict.rightId].sort().join("|");

function TrashIcon() {
  return (
    <svg viewBox="0 0 16 16" width="15" height="15" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round">
      <path d="M2.5 4h11M6.5 4V2.5h3V4M4 4l.7 9.5h6.6L12 4M6.8 6.5v5M9.2 6.5v5" />
    </svg>
  );
}

function PencilIcon() {
  return (
    <svg viewBox="0 0 16 16" width="15" height="15" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinejoin="round">
      <path d="M10.8 2.7l2.5 2.5L6 12.5 3 13l.5-3 7.3-7.3zM9.5 4l2.5 2.5" />
    </svg>
  );
}

export default function HardwareControlSettings({ settings, updateSetting, isActive }: Props) {
  const { t } = useLocalization();
  const label = (key: string) => t(key as StringKey);
  const { showConfirm } = useMessageBox();
  const [view, setView] = useState<HardwareView>("client-view");
  const normalized = useMemo(() => normalizeHardwareInputSettings(settings.hardwareInput), [settings.hardwareInput]);
  const config = normalized.settings;
  const supported = normalized.status === "ok";
  const profile = resolveActiveProfile(config, view) as Profile;
  const editable = supported && profile.id !== FACTORY_PROFILE_ID;
  const rows = visibleRows(view, profile);
  // The actual keyboard layout decides what a layout key types; unknown → conservative conflicts.
  // The map is re-read while the tab is shown, since the layout may be switched at any time.
  const [layoutMap, setLayoutMap] = useState<KeyboardLayoutSnapshot | undefined>(undefined);
  // Keys learned since the map last changed are known exactly (also without the API, and with
  // Shift/AltGr), so the list shows the conflicts their save was checked against.
  const [learnedKeys, setLearnedKeys] = useState<readonly LearnedKeydown[]>([]);
  const layout = withLearnedKeys(learnedKeys, layoutMap?.layout);
  const layoutRead = useRef(0);
  const conflicts = profileConflicts(view, profile, layout);
  const conflictIds = new Set(conflicts.flatMap((conflict) => [conflict.leftId, conflict.rightId]));
  const [learning, setLearning] = useState<{ rowId: string; kind: InputKind; error?: string } | null>(null);
  const [notice, setNotice] = useState<{ rowId?: string; text: string } | null>(null);
  const [actionDialog, setActionDialog] = useState<{ editRowId?: string } | null>(null);
  const [bindingDialog, setBindingDialog] = useState<{ binding: HardwareBinding; isNew: boolean } | null>(null);
  // Inline, not window.prompt: Electron does not support prompt().
  const [renaming, setRenaming] = useState<string | null>(null);
  const [highlightRowId, setHighlightRowId] = useState<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const releaseRef = useRef<(() => void) | null>(null);
  const focusAfterRender = useRef<string | null>(null);
  const midi = getMidiInputService();
  const midiState = useSyncExternalStore(midi.subscribeStatus, midi.getSnapshot);
  const latest = useRef({ config, view, profile, editable, isActive, layout, layoutMap, learnedKeys });
  latest.current = { config, view, profile, editable, isActive, layout, layoutMap, learnedKeys };

  const rowText = (rowView: HardwareView, source: Profile, rowId: string) => {
    const row = visibleRows(rowView, source).find((item) => item.id === rowId);
    return row ? commandLabel(rowView, row.command, label) : rowId;
  };

  const endLearning = (focus?: { rowId: string; kind: InputKind }) => {
    abortRef.current?.abort();
    abortRef.current = null;
    releaseRef.current?.();
    releaseRef.current = null;
    setLearning(null);
    if (focus) focusAfterRender.current = `.hw-table [data-row-id="${focus.rowId}"] [data-hw-add="${focus.kind}"]`;
  };
  useEffect(() => {
    abortRef.current?.abort();
    releaseRef.current?.();
    abortRef.current = null;
    releaseRef.current = null;
    setLearning(null);
    setNotice(null);
    setActionDialog(null);
    setBindingDialog(null);
    setRenaming(null);
    return () => {
      abortRef.current?.abort();
      releaseRef.current?.();
    };
  }, [isActive, view, profile.id]);
  /**
   * Reads the layout map afresh; only the latest read of the visible tab counts.
   * A changed map is a layout switch: the keys learned before this read are stale.
   */
  const readLayoutMap = () => {
    const read = ++layoutRead.current;
    const learnedBefore = latest.current.learnedKeys;
    void loadKeyboardLayout().then((loaded) => {
      const current = latest.current;
      if (read !== layoutRead.current || !current.isActive || loaded?.signature === current.layoutMap?.signature) return;
      setLayoutMap(loaded);
      setLearnedKeys((learned) => learned.filter((item) => !learnedBefore.includes(item)));
    });
  };
  useEffect(() => {
    if (!isActive) return;
    readLayoutMap();
    // No browser announces a layout switch: poll while the tab is shown, and check at
    // once when the window gets the focus back (e.g. after the language bar was used).
    const timer = window.setInterval(readLayoutMap, LAYOUT_POLL_MS);
    window.addEventListener("focus", readLayoutMap);
    return () => {
      window.clearInterval(timer);
      window.removeEventListener("focus", readLayoutMap);
      // The next visit starts unknown and reads the map again.
      setLayoutMap(undefined);
      setLearnedKeys([]);
    };
  }, [isActive]);
  useEffect(() => {
    if (!focusAfterRender.current) return;
    document.querySelector<HTMLElement>(focusAfterRender.current)?.focus();
    focusAfterRender.current = null;
  });
  useEffect(() => {
    if (!highlightRowId) return;
    document.querySelector(`.hw-table [data-row-id="${highlightRowId}"]`)?.scrollIntoView({ block: "nearest" });
    const timer = setTimeout(() => setHighlightRowId(null), 1600);
    return () => clearTimeout(timer);
  }, [highlightRowId]);

  /** Saves the edited profile into the settings draft, unless it would add a new conflicting pair. */
  const trySave = (next: Profile, keyboardLayout?: KeyboardLayout): string | null => {
    const current = latest.current;
    if (!current.editable) return t("HardwareFactoryHint");
    const known = keyboardLayout ?? current.layout;
    const old = new Set(profileConflicts(current.view, current.profile, known).map(pairKey));
    const conflict = profileConflicts(current.view, next, known).find((item) => !old.has(pairKey(item)));
    if (conflict) {
      if (conflict.leftRowId === conflict.rightRowId) return t("HardwareDuplicateInput");
      return `${t("ClientViewInputConflict")} (${rowText(current.view, next, conflict.leftRowId)} / ${rowText(current.view, next, conflict.rightRowId)})`;
    }
    updateSetting("hardwareInput", upsertProfile(current.config, current.view, next));
    return null;
  };
  const saveInput = (candidate: HardwareBinding, keyboardLayout?: KeyboardLayout): string | null => {
    const current = latest.current;
    const valid = validateBinding(current.view, candidate);
    if (!valid.ok) return `${t("HardwareInvalidInput")}: ${valid.reason}`;
    const exists = current.profile.bindings.some((item) => item.id === candidate.id);
    return trySave(
      exists
        ? { ...current.profile, bindings: current.profile.bindings.map((item) => (item.id === candidate.id ? valid.binding : item)) }
        : addBinding(current.profile, valid.binding),
      keyboardLayout
    );
  };
  const removeInput = (binding: HardwareBinding) => {
    const error = trySave(removeBinding(latest.current.profile, binding.id));
    if (error) setNotice({ rowId: binding.rowId, text: error });
  };

  const startLearning = (rowId: string, kind: InputKind) => {
    endLearning();
    const captured = latest.current;
    if (!captured.editable || !isActive) return;
    setNotice(null);
    releaseRef.current = getHardwareInputRuntime().beginLearning();
    const abort = new AbortController();
    abortRef.current = abort;
    setLearning({ rowId, kind });
    if (kind !== "midi") return;
    void midi
      .learn(abort.signal)
      .then(({ event }) => {
        if (abort.signal.aborted || latest.current.view !== captured.view || latest.current.profile.id !== captured.profile.id) return;
        const error = saveInput({
          id: uuid(),
          rowId,
          kind: "midi",
          mode: "button",
          trigger: "press-edge",
          message: event.kind as HardwareMidiBinding["message"],
          channel: event.channel,
          number: event.number,
          ...(event.kind === "control-change" ? { threshold: 64, releaseThreshold: 63 } : {}),
        });
        endLearning({ rowId, kind });
        if (error) setNotice({ rowId, text: error });
      })
      .catch((error) => {
        if (abort.signal.aborted) return;
        // Keep the cell open with the reason and the manual alternative.
        releaseRef.current?.();
        releaseRef.current = null;
        abortRef.current = null;
        setLearning({ rowId, kind, error: error instanceof Error ? error.message : t("ClientViewMidiError") });
      });
  };
  useEffect(() => {
    if (!learning || !isActive) return;
    const handler = (event: KeyboardEvent) => {
      // A dialog owns its keys; learning never swallows them.
      if ((event.target as Element | null)?.closest?.(".hw-dialog-backdrop, .messagebox-overlay")) return;
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopImmediatePropagation();
        endLearning({ rowId: learning.rowId, kind: learning.kind });
        return;
      }
      if (learning.kind !== "keyboard") return;
      event.preventDefault();
      event.stopImmediatePropagation();
      if (event.repeat) return;
      const candidate = keyboardBindingFromEvent(
        event,
        { id: uuid(), rowId: learning.rowId },
        latest.current.view === "full-view" ? "section-list" : undefined
      );
      if (!candidate) return;
      const learned: HardwareKeyboardBinding = { ...candidate, modifiers: "exact", repeat: "ignore" };
      // The learning keydown shows exactly what this key types on the current layout.
      // One that contradicts what was known proves a layout switch: the save trusts
      // only this key. Any learning (even F6) is also a moment to re-read the map.
      const known = addLearnedKeydown(latest.current.learnedKeys, event, latest.current.layoutMap?.layout);
      setLearnedKeys(known.learned);
      readLayoutMap();
      const learnedLayout = withLearnedKeys(known.learned, known.layoutChanged ? undefined : latest.current.layoutMap?.layout);
      let error = saveInput(learned, learnedLayout);
      // The key may already serve another row under the other NumLock state:
      // then learn it for the state it was pressed in.
      if (error) error = saveInput({ ...learned, numLock: isNumLockEnabled(event) ? "on" : "off" }, learnedLayout);
      endLearning({ rowId: learning.rowId, kind: "keyboard" });
      if (error) setNotice({ rowId: learning.rowId, text: error });
    };
    // Any click outside the learning cell (another control, a dialog opener, a tab) ends learning.
    const cancelOutside = (event: PointerEvent) => {
      if (!(event.target as Element | null)?.closest?.(".hw-learning")) endLearning();
    };
    document.addEventListener("keydown", handler, true);
    document.addEventListener("pointerdown", cancelOutside, true);
    return () => {
      document.removeEventListener("keydown", handler, true);
      document.removeEventListener("pointerdown", cancelOutside, true);
    };
    // The latest draft is read through `latest`; the session owns its target row.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [learning, isActive]);

  const openActionDialog = (editRowId?: string) => {
    endLearning();
    setActionDialog(editRowId ? { editRowId } : {});
  };
  const openBindingDialog = (binding: HardwareBinding) => {
    endLearning();
    setBindingDialog({ binding, isNew: false });
  };
  const openManualMidi = (rowId: string) => {
    endLearning();
    setBindingDialog({
      binding: { id: uuid(), rowId, kind: "midi", mode: "button", trigger: "press-edge", message: "note-on", channel: "any", number: 36 },
      isNew: true,
    });
  };
  /** Adds every ticked action at once (all or none), or replaces the edited row's command. */
  const submitActions = (choices: readonly ActionChoice[]): string | null => {
    const current = latest.current;
    const editRowId = actionDialog?.editRowId;
    if (!editRowId || choices[0].entry.baseRowId) {
      const added = addActionEntries(current.view, current.profile, choices, uuid);
      if (!added.ok) return `${t(added.reason === "duplicate" ? "HardwareDuplicateAction" : "HardwareInvalidInput")} (${added.entry.label})`;
      const error = trySave(added.profile);
      if (!error) setHighlightRowId(added.rowIds[0]);
      return error;
    }
    const [{ entry, value }] = choices;
    const validation = validateCommand(current.view, entryCommand(entry, value));
    if (!validation.ok) return t("HardwareInvalidInput");
    const signature = commandSignature(validation.command);
    if (current.profile.extraRows.some((row) => row.id !== editRowId && commandSignature(row.command) === signature))
      return t("HardwareDuplicateAction");
    const error = trySave({
      ...current.profile,
      extraRows: current.profile.extraRows.map((row) => (row.id === editRowId ? { ...row, command: validation.command } : row)),
    });
    if (!error) setHighlightRowId(editRowId);
    return error;
  };

  const chip = (binding: HardwareBinding) => {
    const text = bindingChipLabel(binding, label);
    const details = bindingDetails(binding, label);
    const className = `hw-chip${conflictIds.has(binding.id) ? " hw-chip-conflict" : ""}`;
    if (!editable) {
      return (
        <span key={binding.id} className={`${className} hw-chip-static`} title={details}>
          {text}
        </span>
      );
    }
    return (
      <span key={binding.id} className={className} title={details}>
        <button
          type="button"
          className="hw-chip-label"
          aria-label={`${t("HardwareEditInput")}: ${details}`}
          onClick={() => openBindingDialog(binding)}
        >
          {text}
        </button>
        <button type="button" className="hw-chip-remove" aria-label={`${t("HardwareRemoveBinding")}: ${text}`} onClick={() => removeInput(binding)}>
          ×
        </button>
      </span>
    );
  };
  const inputControl = (rowId: string, kind: InputKind) => {
    if (!editable) return null;
    if (learning?.rowId === rowId && learning.kind === kind) {
      return (
        <span
          className={`hw-learning${learning.error ? " hw-learning-error" : ""}`}
          role="status"
          title={kind === "keyboard" ? t("HardwareLearningKeyboard") : undefined}
        >
          <span>{learning.error ?? t(kind === "keyboard" ? "HardwareLearningKeyboardShort" : "HardwareLearningMidiShort")}</span>
          {kind === "midi" && (
            <button type="button" className="btn btn-link btn-sm p-0" data-hw-manual onClick={() => openManualMidi(rowId)}>
              {t("HardwareManualEntry")}
            </button>
          )}
          <button type="button" className="hw-chip-remove" data-hw-cancel aria-label={t("Cancel")} onClick={() => endLearning({ rowId, kind })}>
            ×
          </button>
        </span>
      );
    }
    const title = kind === "keyboard" ? t("ClientViewInputAddKeyboard") : t("ClientViewInputLearnMidi");
    return (
      <button
        type="button"
        className="hw-add"
        data-hw-add={kind}
        disabled={!!learning}
        title={title}
        aria-label={title}
        onClick={() => startLearning(rowId, kind)}
      >
        +
      </button>
    );
  };

  const editedRow = actionDialog?.editRowId ? profile.extraRows.find((row) => row.id === actionDialog.editRowId) : undefined;
  const dialogEntries = actionDialog
    ? editedRow
      ? actionEntries(view, { ...profile, extraRows: profile.extraRows.filter((row) => row.id !== editedRow.id) }, label).filter(
          (entry) => !entry.baseRowId
        )
      : actionEntries(view, profile, label)
    : [];
  const editedCommand = editedRow?.command as { action: string; op?: string; value?: string | number; step?: number } | undefined;
  const otherDiagnostics = normalized.diagnostics.filter(
    (item) => (!item.view || item.view === view) && (!item.profileId || item.profileId === profile.id) && !item.code.endsWith("-overlap")
  );
  const columns = editable ? 4 : 3;

  return (
    <section className="hardware-control-settings">
      {!supported && (
        <div role="alert" className="alert alert-warning py-2">
          {t("HardwareUnsupportedConfig")}
        </div>
      )}
      <div className="hw-toolbar">
        <div className="btn-group btn-group-sm" role="group" aria-label={t("HardwareConfiguredView")}>
          {VIEWS.map((item) => (
            <button
              key={item}
              type="button"
              className={`btn ${view === item ? "btn-primary" : "btn-outline-secondary"}`}
              aria-pressed={view === item}
              data-hw-view={item}
              onClick={() => setView(item)}
            >
              {item === "client-view" ? t("SettingsPageClientView") : t("HardwareFullView")}
            </button>
          ))}
        </div>
        {renaming === null ? (
          <select
            aria-label={t("ClientViewInputProfiles")}
            className="form-select form-select-sm hw-profile-select"
            value={profile.id}
            disabled={!supported}
            onChange={(event) => updateSetting("hardwareInput", setActiveProfile(config, view, event.target.value))}
          >
            <option value={FACTORY_PROFILE_ID}>{t("ClientViewInputFactoryProfile")}</option>
            {config.views[view].customProfiles.map((item) => (
              <option key={item.id} value={item.id}>
                {item.name}
              </option>
            ))}
          </select>
        ) : (
          <form
            className="hw-rename"
            onSubmit={(event) => {
              event.preventDefault();
              const name = renaming.trim();
              if (name && !trySave({ ...latest.current.profile, name })) setRenaming(null);
            }}
          >
            <input
              id="hardware-profile-name"
              className="form-control form-control-sm"
              aria-label={t("ClientViewInputRenamePrompt")}
              value={renaming}
              autoFocus
              onChange={(event) => setRenaming(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Escape") {
                  event.preventDefault();
                  setRenaming(null);
                }
              }}
            />
            <button type="submit" className="btn btn-sm btn-primary" disabled={!renaming.trim()}>
              {t("HardwareSave")}
            </button>
            <button type="button" className="btn btn-sm btn-outline-secondary" onClick={() => setRenaming(null)}>
              {t("Cancel")}
            </button>
          </form>
        )}
        {renaming === null && (
          <>
            <button
              type="button"
              className="btn btn-sm btn-outline-secondary"
              disabled={!supported}
              onClick={() => updateSetting("hardwareInput", upsertProfile(config, view, createProfile(t("ClientViewInputNewProfile"), uuid), true))}
            >
              {t("ClientViewInputNew")}
            </button>
            <button
              type="button"
              className="btn btn-sm btn-outline-secondary"
              disabled={!supported}
              onClick={() =>
                updateSetting(
                  "hardwareInput",
                  upsertProfile(config, view, copyProfile(profile, `${profile.name} ${t("HardwareCopySuffix")}`, uuid), true)
                )
              }
            >
              {t("ClientViewInputDuplicate")}
            </button>
            {editable && (
              <>
                <button
                  type="button"
                  className="btn btn-sm btn-outline-secondary hw-toolbar-icon"
                  data-testid="hardware-rename-profile"
                  title={t("ClientViewInputRename")}
                  aria-label={t("ClientViewInputRename")}
                  onClick={() => {
                    endLearning();
                    setRenaming(profile.name);
                  }}
                >
                  <PencilIcon />
                </button>
                <button
                  type="button"
                  className="btn btn-sm btn-outline-danger hw-toolbar-icon"
                  data-testid="hardware-delete-profile"
                  title={t("ClientViewInputDelete")}
                  aria-label={t("ClientViewInputDelete")}
                  onClick={() => {
                    endLearning();
                    const captured = { view, id: profile.id };
                    showConfirm(t("Confirm"), t("ClientViewInputDeleteConfirm"), () => {
                      if (latest.current.view === captured.view && latest.current.profile.id === captured.id)
                        updateSetting("hardwareInput", deleteProfile(latest.current.config, captured.view, captured.id));
                    });
                  }}
                >
                  <TrashIcon />
                </button>
              </>
            )}
          </>
        )}
      </div>
      <div className="hw-subbar">
        {editable ? (
          <button type="button" className="btn btn-sm btn-primary" data-testid="hardware-add-action" onClick={() => openActionDialog()}>
            + {t("HardwareAddAction")}
          </button>
        ) : (
          <span className="hw-hint">{supported ? t("HardwareFactoryHint") : null}</span>
        )}
        <span className="hw-midi" role="status">
          {t("HardwareMidiStatus")}: {label(`HardwareMidi_${midiState.status}`)}
          {midiState.inputs.length ? ` (${midiState.inputs.map((item) => item.name).join(", ")})` : ""}
          <button type="button" className="btn btn-link btn-sm p-0 ms-2 align-baseline" onClick={() => void midi.inspect()}>
            {t("ClientViewMidiCheck")}
          </button>
        </span>
      </div>
      {(conflicts.length > 0 || otherDiagnostics.length > 0 || !!profile.quarantine?.length) && (
        <ul className="hw-warnings">
          {conflicts.map((conflict) => (
            <li key={pairKey(conflict)}>
              {t("HardwareLegacyConflict")} ({rowText(view, profile, conflict.leftRowId)} / {rowText(view, profile, conflict.rightRowId)})
            </li>
          ))}
          {otherDiagnostics.map((item, i) => (
            <li key={`d${i}`}>
              {t("HardwareDiagnostic")}: {item.code}
              {item.detail ? ` ${item.detail}` : ""}
            </li>
          ))}
          {!!profile.quarantine?.length && (
            <li>
              {t("HardwareQuarantined")}: {profile.quarantine.length}
            </li>
          )}
        </ul>
      )}
      {notice && !notice.rowId && (
        <div className="hw-notice" role="alert">
          {notice.text}
        </div>
      )}
      <table className="table table-sm hw-table">
        <thead>
          <tr>
            <th scope="col">{t("HardwareAction")}</th>
            <th scope="col">{t("ClientViewInputKeyboard")}</th>
            <th scope="col">MIDI</th>
            {editable && (
              <th scope="col" className="hw-row-actions">
                <span className="visually-hidden">{t("HardwareRemoveRow")}</span>
              </th>
            )}
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => {
            const text = commandLabel(view, row.command, label);
            const extra = !isBaseRowId(view, row.id);
            const inputs = bindingsForRow(profile, row.id);
            return (
              <Fragment key={row.id}>
                <tr data-row-id={row.id} className={highlightRowId === row.id ? "hw-row-new" : undefined}>
                  <th scope="row" className="hw-row-name">
                    {editable && extra ? (
                      <button
                        type="button"
                        className="btn btn-link p-0 text-start hw-row-edit"
                        data-hw-edit-row
                        title={t("HardwareEditAction")}
                        onClick={() => openActionDialog(row.id)}
                      >
                        {text}
                      </button>
                    ) : (
                      text
                    )}
                  </th>
                  {INPUT_KINDS.map((kind) => {
                    const own = inputs.filter((item) => item.kind === kind);
                    return (
                      <td key={kind} data-label={kind === "keyboard" ? "⌨" : "MIDI"} className={`hw-cell-${kind}`}>
                        <div className="hw-inputs">
                          {own.map(chip)}
                          {inputControl(row.id, kind)}
                          {!editable && own.length === 0 && <span className="hw-none">–</span>}
                        </div>
                      </td>
                    );
                  })}
                  {editable && (
                    <td className="hw-row-actions">
                      <button
                        type="button"
                        className="hw-icon-btn"
                        data-hw-remove-row
                        aria-label={`${t("HardwareRemoveRow")}: ${text}`}
                        title={t("HardwareRemoveRowHint")}
                        onClick={() => {
                          if (learning?.rowId === row.id) endLearning();
                          const error = trySave(removeRow(view, latest.current.profile, row.id));
                          if (error) setNotice({ text: error });
                        }}
                      >
                        <TrashIcon />
                      </button>
                    </td>
                  )}
                </tr>
                {notice?.rowId === row.id && (
                  <tr className="hw-notice-row">
                    <td colSpan={columns}>
                      <div className="hw-notice" role="alert">
                        <span>{notice.text}</span>
                        <button type="button" className="hw-chip-remove" aria-label={t("Cancel")} onClick={() => setNotice(null)}>
                          ×
                        </button>
                      </div>
                    </td>
                  </tr>
                )}
              </Fragment>
            );
          })}
        </tbody>
      </table>
      {rows.length === 0 && <p className="hw-hint">{t("HardwareNoRows")}</p>}
      <p className="hw-hint hw-footnote">{t("HardwareSettingsHint")}</p>
      {actionDialog && (
        <AddActionDialog
          view={view}
          entries={dialogEntries}
          initial={
            editedCommand
              ? {
                  key: `${editedCommand.action}:${editedCommand.op ?? "apply"}`,
                  value: editedCommand.value ?? editedCommand.step,
                }
              : undefined
          }
          t={label}
          onSubmit={submitActions}
          onClose={() => setActionDialog(null)}
        />
      )}
      {bindingDialog && (
        <BindingDialog
          view={view}
          binding={bindingDialog.binding}
          isNew={bindingDialog.isNew}
          rowLabel={rowText(view, profile, bindingDialog.binding.rowId)}
          t={label}
          onSave={saveInput}
          onDelete={() => {
            removeInput(bindingDialog.binding);
            setBindingDialog(null);
          }}
          onClose={() => setBindingDialog(null)}
        />
      )}
    </section>
  );
}
