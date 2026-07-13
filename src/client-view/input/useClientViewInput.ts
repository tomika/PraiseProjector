import { useCallback, useEffect, useState } from "react";
import { readPersistedSettings } from "../../services/settingsStore";
import type { ClientViewStore } from "../controller/ClientViewStore";
import {
  clientViewInputActionAvailable,
  matchesKeyboardBinding,
  matchesMidiBinding,
  resolveClientViewInputProfile,
  type ClientViewInputAction,
  type ClientViewInputProfile,
} from "./clientViewInput";
import { requestMidiAccess, subscribeMidiMessages } from "./midiInput";

function readProfile(): ClientViewInputProfile {
  const settings = readPersistedSettings();
  return resolveClientViewInputProfile(settings.clientViewActiveInputProfileId, settings.clientViewInputProfiles);
}

function editableTarget(target: EventTarget | null): boolean {
  const element = target instanceof Element ? target : null;
  return !!element?.closest("input, textarea, select, [contenteditable='true'], [contenteditable='']");
}

function inputBlocked(store: ClientViewStore): boolean {
  const state = store.getSnapshot();
  return (
    state.loginDialogOpen ||
    (state.sessionsDialogOpen && !state.sessionsDialogStartupHidden) ||
    state.instructionsEditorOpen ||
    state.aboutOpen ||
    !!state.confirmAnim ||
    state.zoomDialogOpen ||
    state.highlightOpacityDialogOpen
  );
}

/**
 * Installs keyboard and Web MIDI listeners for a mounted client view. Both
 * sources dispatch into the same semantic command layer, never to DOM nodes.
 */
export function useClientViewInput(store: ClientViewStore, navigateSong: (next: boolean) => void) {
  const [profile, setProfile] = useState<ClientViewInputProfile>(readProfile);

  useEffect(() => {
    const reload = () => setProfile(readProfile());
    window.addEventListener("pp-settings-changed", reload);
    return () => window.removeEventListener("pp-settings-changed", reload);
  }, []);

  const dispatch = useCallback(
    (action: ClientViewInputAction) => {
      if (inputBlocked(store)) return;
      switch (action) {
        case "toggle-options":
          void store.hotkeyToggleOptions();
          break;
        case "show-previous-song":
          navigateSong(false);
          break;
        case "show-next-song":
          navigateSong(true);
          break;
        case "select-previous-visible-song":
          store.hotkeyMoveSongSelection(false);
          break;
        case "select-next-visible-song":
          store.hotkeyMoveSongSelection(true);
          break;
        case "select-first-control":
          store.hotkeySelectFirstControl();
          break;
        case "cycle-next-main-control":
          store.hotkeySelectControl(true, true);
          break;
        case "select-previous-option-control":
          store.hotkeySelectControl(false);
          break;
        case "select-next-option-control":
          store.hotkeySelectControl(true);
          break;
        case "activate-option-control":
          store.hotkeyChangeControl(0);
          break;
        case "decrease-main-control":
          store.hotkeyChangeControl(-1);
          break;
        case "increase-main-control":
          store.hotkeyChangeControl(1);
          break;
        case "clear-control":
          store.hotkeyClearControl();
          break;
      }
    },
    [navigateSong, store]
  );

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.repeat || editableTarget(event.target) || inputBlocked(store)) return;
      const context = store.getSnapshot().optionsOpen ? "options" : "song-view";
      const binding = profile.bindings.find(
        (item) => item.kind === "keyboard" && clientViewInputActionAvailable(item.action, context) && matchesKeyboardBinding(item, event)
      );
      if (!binding) return;
      event.preventDefault();
      dispatch(binding.action);
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [dispatch, profile, store]);

  useEffect(() => {
    if (!profile.bindings.some((binding) => binding.kind === "midi")) return;
    let active = true;
    let unsubscribe = () => {};
    const lastTrigger = new Map<string, number>();
    void requestMidiAccess()
      .then((access) => {
        if (!active) return;
        unsubscribe = subscribeMidiMessages(access, (message) => {
          if (inputBlocked(store)) return;
          const context = store.getSnapshot().optionsOpen ? "options" : "song-view";
          const binding = profile.bindings.find(
            (item) => item.kind === "midi" && clientViewInputActionAvailable(item.action, context) && matchesMidiBinding(item, message)
          );
          if (!binding) return;
          const key = `${binding.id}:${message.channel}:${message.number}`;
          const now = Date.now();
          if ((lastTrigger.get(key) ?? 0) + 80 > now) return;
          lastTrigger.set(key, now);
          dispatch(binding.action);
        });
      })
      .catch(() => {
        // Permission/support is surfaced in Settings; input must remain optional.
      });
    return () => {
      active = false;
      unsubscribe();
    };
  }, [dispatch, profile, store]);
}
