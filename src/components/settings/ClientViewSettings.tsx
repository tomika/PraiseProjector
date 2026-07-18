import { useEffect, useMemo, useState } from "react";
import { v4 as uuidv4 } from "uuid";
import type { Settings } from "../../types";
import {
  CLIENT_VIEW_INPUT_ACTIONS,
  CLIENT_VIEW_INPUT_ACTION_CONTEXTS,
  FACTORY_CLIENT_VIEW_INPUT_PROFILE,
  FACTORY_CLIENT_VIEW_INPUT_PROFILE_ID,
  formatKeyboardBinding,
  formatMidiBinding,
  clientViewInputActionsOverlap,
  normalizeClientViewInputProfiles,
  resolveClientViewInputProfile,
  type ClientViewInputAction,
  type ClientViewInputBinding,
  type ClientViewInputProfile,
  type ClientViewKeyboardBinding,
  type ClientViewMidiBinding,
} from "../../client-view/input/clientViewInput";
import { learnMidiMessage, midiInputNames, midiSupported, requestMidiAccess } from "../../client-view/input/midiInput";
import { useLocalization } from "../../localization/LocalizationContext";
import { useMessageBox } from "../../contexts/MessageBoxContext";
import "./ClientViewSettings.css";

interface Props {
  settings: Settings;
  updateSetting: <K extends keyof Settings>(key: K, value: Settings[K]) => void;
}

const actionLabelKey: Record<ClientViewInputAction, string> = {
  "toggle-options": "ClientViewInputActionToggleOptions",
  "show-previous-song": "ClientViewInputActionShowPreviousSong",
  "show-next-song": "ClientViewInputActionShowNextSong",
  "select-previous-visible-song": "ClientViewInputActionSelectPreviousVisibleSong",
  "select-next-visible-song": "ClientViewInputActionSelectNextVisibleSong",
  "select-first-control": "ClientViewInputActionSelectFirstControl",
  "cycle-next-main-control": "ClientViewInputActionCycleNextMainControl",
  "select-previous-option-control": "ClientViewInputActionSelectPreviousOptionControl",
  "select-next-option-control": "ClientViewInputActionSelectNextOptionControl",
  "activate-option-control": "ClientViewInputActionActivateOptionControl",
  "decrease-main-control": "ClientViewInputActionDecreaseMainControl",
  "increase-main-control": "ClientViewInputActionIncreaseMainControl",
  "clear-control": "ClientViewInputActionClearControl",
};

function bindingIdentity(binding: ClientViewInputBinding): string {
  if (binding.kind === "keyboard") {
    return [binding.kind, binding.match, binding.key, binding.ctrl, binding.alt, binding.shift, binding.meta, binding.numLock ?? "any"].join(":");
  }
  return [binding.kind, binding.message, binding.channel, binding.number, binding.threshold ?? 64].join(":");
}

function cloneFactoryProfile(): ClientViewInputProfile {
  return {
    id: uuidv4(),
    name: "Gyári kiosztás másolata",
    bindings: FACTORY_CLIENT_VIEW_INPUT_PROFILE.bindings.map((binding) => ({ ...binding, id: uuidv4() })),
  };
}

export default function ClientViewSettings({ settings, updateSetting }: Props) {
  const { t } = useLocalization();
  const { showConfirm } = useMessageBox();
  const profiles = useMemo(() => normalizeClientViewInputProfiles(settings.clientViewInputProfiles), [settings.clientViewInputProfiles]);
  const activeProfile = resolveClientViewInputProfile(settings.clientViewActiveInputProfileId, profiles);
  const editable = activeProfile.id !== FACTORY_CLIENT_VIEW_INPUT_PROFILE_ID;
  const [capturingKeyboardAction, setCapturingKeyboardAction] = useState<ClientViewInputAction | null>(null);
  const [learningMidiAction, setLearningMidiAction] = useState<ClientViewInputAction | null>(null);
  const [midiStatus, setMidiStatus] = useState(() => (midiSupported() ? t("ClientViewMidiReady") : t("ClientViewMidiUnsupported")));

  const saveProfiles = (nextProfiles: ClientViewInputProfile[], activeId = settings.clientViewActiveInputProfileId) => {
    updateSetting("clientViewInputProfiles", nextProfiles);
    updateSetting("clientViewActiveInputProfileId", activeId);
  };

  const updateActiveProfile = (change: (profile: ClientViewInputProfile) => ClientViewInputProfile) => {
    if (!editable) return;
    saveProfiles(profiles.map((profile) => (profile.id === activeProfile.id ? change(profile) : profile)));
  };

  const addBinding = (binding: ClientViewInputBinding) => {
    if (!editable) return;
    const conflict = activeProfile.bindings.find(
      (item) => bindingIdentity(item) === bindingIdentity(binding) && clientViewInputActionsOverlap(item.action, binding.action)
    );
    if (conflict) {
      setMidiStatus(t("ClientViewInputConflict"));
      return;
    }
    updateActiveProfile((profile) => ({ ...profile, bindings: [...profile.bindings, binding] }));
  };

  useEffect(() => {
    if (!capturingKeyboardAction) return;
    const onKeyDown = (event: KeyboardEvent) => {
      event.preventDefault();
      event.stopPropagation();
      if (event.key === "Escape") {
        setCapturingKeyboardAction(null);
        return;
      }
      if (
        !event.code ||
        ["ControlLeft", "ControlRight", "AltLeft", "AltRight", "ShiftLeft", "ShiftRight", "MetaLeft", "MetaRight"].includes(event.code)
      )
        return;
      addBinding({
        id: uuidv4(),
        kind: "keyboard",
        action: capturingKeyboardAction,
        match: "code",
        key: event.code,
        ctrl: event.ctrlKey,
        alt: event.altKey,
        shift: event.shiftKey,
        meta: event.metaKey,
        numLock: "any",
      });
      setCapturingKeyboardAction(null);
    };
    document.addEventListener("keydown", onKeyDown, true);
    return () => document.removeEventListener("keydown", onKeyDown, true);
    // addBinding is intentionally omitted: it is re-created every render, so
    // including it would re-register the keydown listener on every render. The
    // capture listener only needs to re-arm when capture starts/stops or the
    // active profile changes (activeProfile.id / profiles).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [capturingKeyboardAction, activeProfile.id, profiles]);

  const learnMidi = async (action: ClientViewInputAction) => {
    if (!editable) return;
    if (!midiSupported()) {
      setMidiStatus(t("ClientViewMidiUnsupported"));
      return;
    }
    setLearningMidiAction(action);
    setMidiStatus(t("ClientViewMidiLearning"));
    try {
      const message = await learnMidiMessage();
      addBinding({
        id: uuidv4(),
        kind: "midi",
        action,
        message: message.message,
        channel: message.channel,
        number: message.number,
        threshold: message.message === "control-change" ? 64 : undefined,
      });
      setMidiStatus(t("ClientViewMidiLearned"));
    } catch (error) {
      setMidiStatus(error instanceof Error ? error.message : t("ClientViewMidiError"));
    } finally {
      setLearningMidiAction(null);
    }
  };

  const inspectMidi = async () => {
    if (!midiSupported()) return setMidiStatus(t("ClientViewMidiUnsupported"));
    try {
      const access = await requestMidiAccess();
      const names = midiInputNames(access);
      setMidiStatus(names.length ? `${t("ClientViewMidiConnected")}: ${names.join(", ")}` : t("ClientViewMidiNoInputs"));
    } catch (error) {
      setMidiStatus(error instanceof Error ? error.message : t("ClientViewMidiError"));
    }
  };

  const newProfile = () => {
    const profile: ClientViewInputProfile = { id: uuidv4(), name: t("ClientViewInputNewProfile"), bindings: [] };
    saveProfiles([...profiles, profile], profile.id);
  };

  const duplicateProfile = () => {
    const profile: ClientViewInputProfile =
      activeProfile.id === FACTORY_CLIENT_VIEW_INPUT_PROFILE_ID
        ? cloneFactoryProfile()
        : {
            ...activeProfile,
            id: uuidv4(),
            name: `${activeProfile.name} másolata`,
            bindings: activeProfile.bindings.map((binding) => ({ ...binding, id: uuidv4() })),
          };
    saveProfiles([...profiles, profile], profile.id);
  };

  const renameProfile = () => {
    if (!editable) return;
    const name = window.prompt(t("ClientViewInputRenamePrompt"), activeProfile.name)?.trim();
    if (name) updateActiveProfile((profile) => ({ ...profile, name }));
  };

  const deleteProfile = () => {
    if (!editable) return;
    showConfirm(t("Confirm"), t("ClientViewInputDeleteConfirm"), () => {
      saveProfiles(
        profiles.filter((profile) => profile.id !== activeProfile.id),
        FACTORY_CLIENT_VIEW_INPUT_PROFILE_ID
      );
    });
  };

  const bindingsFor = (action: ClientViewInputAction, kind: ClientViewInputBinding["kind"]) =>
    activeProfile.bindings.filter((binding) => binding.action === action && binding.kind === kind);

  return (
    <div className="client-view-settings">
      <div className="form-group">
        <label htmlFor="automaticViewSwitch">{t("SettingsAutomaticViewSwitch")}</label>
        <select
          id="automaticViewSwitch"
          className="form-control"
          value={settings.automaticViewSwitch}
          onChange={(e) => updateSetting("automaticViewSwitch", e.target.value as Settings["automaticViewSwitch"])}
        >
          <option value="none">{t("SettingsAutomaticViewSwitchNone")}</option>
          <option value="portraitToClient">{t("SettingsAutomaticViewSwitchPortraitToClient")}</option>
          <option value="orientation">{t("SettingsAutomaticViewSwitchOrientation")}</option>
        </select>
        <small className="form-text text-muted">{t("SettingsAutomaticViewSwitchDescription")}</small>
      </div>

      <hr />
      <h6>{t("ClientViewSessionSettings")}</h6>
      <div className="form-group mt-2">
        <label htmlFor="clientViewAutoScanSessions">{t("SettingsClientViewAutoScanSessions")}</label>
        <select
          id="clientViewAutoScanSessions"
          className="form-control"
          value={settings.clientViewAutoScanSessions}
          onChange={(event) => updateSetting("clientViewAutoScanSessions", event.target.value as Settings["clientViewAutoScanSessions"])}
        >
          <option value="off">{t("SettingsClientViewAutoScanSessionsOff")}</option>
          <option value="web">{t("SettingsClientViewAutoScanSessionsWeb")}</option>
          <option value="local">{t("SettingsClientViewAutoScanSessionsLocal")}</option>
          <option value="both">{t("SettingsClientViewAutoScanSessionsBoth")}</option>
        </select>
        <small className="form-text text-muted">{t("SettingsClientViewAutoScanSessionsDescription")}</small>
      </div>
      <div className="form-group mt-2">
        <label htmlFor="clientViewSessionsFoundPopup">{t("SettingsClientViewSessionsFoundPopup")}</label>
        <select
          id="clientViewSessionsFoundPopup"
          className="form-control"
          value={settings.clientViewSessionsFoundPopup}
          onChange={(event) => updateSetting("clientViewSessionsFoundPopup", event.target.value as Settings["clientViewSessionsFoundPopup"])}
        >
          <option value="off">{t("SettingsClientViewAutoScanSessionsOff")}</option>
          <option value="web">{t("SettingsClientViewAutoScanSessionsWeb")}</option>
          <option value="local">{t("SettingsClientViewAutoScanSessionsLocal")}</option>
          <option value="both">{t("SettingsClientViewAutoScanSessionsBoth")}</option>
        </select>
        <small className="form-text text-muted">{t("SettingsClientViewSessionsFoundPopupDescription")}</small>
      </div>

      <hr />
      <h6>{t("ClientViewInputProfiles")}</h6>
      <div className="client-view-profile-toolbar">
        <select
          className="form-select form-select-sm"
          value={activeProfile.id}
          onChange={(event) => updateSetting("clientViewActiveInputProfileId", event.target.value)}
          aria-label={t("ClientViewInputProfiles")}
        >
          <option value={FACTORY_CLIENT_VIEW_INPUT_PROFILE_ID}>{t("ClientViewInputFactoryProfile")}</option>
          {profiles.map((profile) => (
            <option key={profile.id} value={profile.id}>
              {profile.name}
            </option>
          ))}
        </select>
        <button type="button" className="btn btn-sm btn-outline-primary" onClick={newProfile}>
          {t("ClientViewInputNew")}
        </button>
        <button type="button" className="btn btn-sm btn-outline-secondary" onClick={duplicateProfile}>
          {t("ClientViewInputDuplicate")}
        </button>
        <button type="button" className="btn btn-sm btn-outline-secondary" onClick={renameProfile} disabled={!editable}>
          {t("ClientViewInputRename")}
        </button>
        <button type="button" className="btn btn-sm btn-outline-danger" onClick={deleteProfile} disabled={!editable}>
          {t("ClientViewInputDelete")}
        </button>
      </div>
      {!editable && <small className="form-text text-muted">{t("ClientViewInputFactoryHint")}</small>}

      <div className="client-view-midi-status">
        <span>{midiStatus}</span>
        <button type="button" className="btn btn-sm btn-outline-secondary" onClick={() => void inspectMidi()} disabled={!midiSupported()}>
          {t("ClientViewMidiCheck")}
        </button>
      </div>

      <div className="client-view-hotkey-grid-wrap">
        <table className="table table-sm client-view-hotkey-grid">
          <thead>
            <tr>
              <th>{t("ClientViewInputAction")}</th>
              <th>{t("ClientViewInputContext")}</th>
              <th>{t("ClientViewInputKeyboard")}</th>
              <th>{t("ClientViewInputMidi")}</th>
            </tr>
          </thead>
          <tbody>
            {CLIENT_VIEW_INPUT_ACTIONS.map((action) => (
              <tr key={action}>
                <th scope="row">{t(actionLabelKey[action] as never)}</th>
                <td>
                  {CLIENT_VIEW_INPUT_ACTION_CONTEXTS[action]
                    .map((context) => t((context === "song-view" ? "ClientViewInputContextSongView" : "ClientViewInputContextOptions") as never))
                    .join(", ")}
                </td>
                <td>
                  <div className="client-view-binding-list">
                    {bindingsFor(action, "keyboard").map((binding) => (
                      <button
                        key={binding.id}
                        type="button"
                        className="badge text-bg-secondary client-view-binding"
                        disabled={!editable}
                        title={editable ? t("ClientViewInputRemoveBinding") : undefined}
                        onClick={() =>
                          updateActiveProfile((profile) => ({ ...profile, bindings: profile.bindings.filter((item) => item.id !== binding.id) }))
                        }
                      >
                        {formatKeyboardBinding(binding as ClientViewKeyboardBinding)}
                      </button>
                    ))}
                    {editable && (
                      <button type="button" className="btn btn-sm btn-outline-secondary" onClick={() => setCapturingKeyboardAction(action)}>
                        {capturingKeyboardAction === action ? t("ClientViewInputPressKey") : t("ClientViewInputAddKeyboard")}
                      </button>
                    )}
                  </div>
                </td>
                <td>
                  <div className="client-view-binding-list">
                    {bindingsFor(action, "midi").map((binding) => (
                      <button
                        key={binding.id}
                        type="button"
                        className="badge text-bg-info client-view-binding"
                        disabled={!editable}
                        title={editable ? t("ClientViewInputRemoveBinding") : undefined}
                        onClick={() =>
                          updateActiveProfile((profile) => ({ ...profile, bindings: profile.bindings.filter((item) => item.id !== binding.id) }))
                        }
                      >
                        {formatMidiBinding(binding as ClientViewMidiBinding)}
                      </button>
                    ))}
                    {editable && (
                      <button
                        type="button"
                        className="btn btn-sm btn-outline-secondary"
                        onClick={() => void learnMidi(action)}
                        disabled={learningMidiAction !== null}
                      >
                        {learningMidiAction === action ? t("ClientViewMidiLearning") : t("ClientViewInputLearnMidi")}
                      </button>
                    )}
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
