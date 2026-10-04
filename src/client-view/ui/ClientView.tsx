/**
 * ClientView — root composition of the client view, mirroring the legacy
 * index.html layout (#mainView.split → options overlay + main table).
 *
 * Presentational only: it reads reactive state and composes the panels. All
 * behaviour lives in the controller; all data behind the ClientApi.
 *
 * `onHome` is supplied when the view is embedded in the desktop app so the
 * upper-left home button can switch back to the main UI.
 */

import { useCallback, useRef } from "react";
import { useClientViewState, useClientViewStore } from "../controller/ClientViewContext";
import { canUseSessions } from "../controller/ClientViewStore";
import { AboutDialog } from "./AboutDialog";
import { ConfirmDialog } from "./ConfirmDialog";
import { TextConfirmDialog } from "./TextConfirmDialog";
import { InstructionsEditorDialog } from "./InstructionsEditorDialog";
import { LoginDialog } from "./LoginDialog";
import { MainToolbar } from "./MainToolbar";
import { OptionsOverlay } from "./OptionsOverlay";
import { SessionsDialog } from "./SessionsDialog";
import { SongView, type SongViewHandle } from "./SongView";
import { StartupScanIndicator } from "./StartupScanIndicator";
import { PullRefreshSpinner } from "../../shared/PullRefreshSpinner";
import { usePullToRefresh } from "../../shared/usePullToRefresh";
import { UNIFORM_BUTTON_BORDERS } from "./uiConfig";
import { useClientViewHardwareTarget } from "../input/useClientViewHardwareTarget";
import { TutorialHost } from "../../tutorial/TutorialHost";
import type { TutorialCommand } from "../../tutorial/tutorialTypes";
import { catalogFamily } from "../../../common/hardware-action-catalog";
import { useLocalization } from "../../localization/LocalizationContext";

export function ClientView({ onHome }: { onHome?: () => void }) {
  const state = useClientViewState();
  const store = useClientViewStore();
  // The toolbar Prev/Next buttons drive the same animated page-turn as a swipe,
  // which lives in SongView — reached here through an imperative handle.
  const songViewRef = useRef<SongViewHandle>(null);
  const navigateSong = useCallback((next: boolean) => songViewRef.current?.navigate(next), []);
  const feedback = useClientViewHardwareTarget(store, navigateSong);
  const { t } = useLocalization();
  const feedbackValues: Record<string, unknown> = {
    "chord-mode": t(
      (
        {
          "": "HardwareChordModeInline",
          GUITAR: "HardwareChordModeGuitar",
          PIANO: "HardwareChordModePiano",
          NO_CHORDS: "HardwareChordModeHidden",
        } as const
      )[state.displaySettings.chordBoxType]
    ),
    "chord-diagram": t(
      (
        {
          "": "HardwareChordModeInline",
          GUITAR: "HardwareChordModeGuitar",
          PIANO: "HardwareChordModePiano",
          NO_CHORDS: "HardwareChordModeHidden",
        } as const
      )[state.displaySettings.chordBoxType]
    ),
    "chord-visibility": t(
      (
        {
          "": "HardwareChordModeInline",
          GUITAR: "HardwareChordModeGuitar",
          PIANO: "HardwareChordModePiano",
          NO_CHORDS: "HardwareChordModeHidden",
        } as const
      )[state.displaySettings.chordBoxType]
    ),
    simplified: state.displaySettings.simplified,
    "omit-repeated-chords": state.displaySettings.noSecChordDup,
    superscript: state.displaySettings.subscript,
    "minor-notation": t(({ 0: "HardwareMinorUpper", 1: "HardwareMinorLower", 3: "HardwareMinorLetter" } as const)[state.displaySettings.chordMode]),
    "note-names": t(state.displaySettings.bb ? "HardwareNoteNamesEnglish" : "HardwareNoteNamesGerman"),
    "auto-tone": state.displaySettings.autoTone,
    transpose: state.transpose,
    capo: state.capo,
    "capo-apply": state.capo,
    "capo-use": state.displaySettings.useCapo,
    zoom: state.displaySettings.maxText,
    "zoom-mode": state.displaySettings.maxText
      ? t(
          ({ FIT_PAGE: "HardwareZoomFitPage", FIT_WIDTH: "HardwareZoomFitWidth", MANUAL: "HardwareZoomManual" } as const)[
            state.displaySettings.zoomSizingMode
          ]
        )
      : false,
    "zoom-font": state.displaySettings.zoomFontSize,
    instructions: state.showInstructions,
  };
  const feedbackValue = feedback ? (feedback.value ?? feedbackValues[feedback.command.action]) : null;
  // A playlist add/remove reports whether the song is in the playlist now.
  const feedbackText =
    typeof feedbackValue !== "boolean"
      ? String(feedbackValue)
      : feedback?.command.action === "preselected-song"
        ? t(feedbackValue ? "HardwarePreselectedAdded" : "HardwarePreselectedRemoved")
        : t(feedbackValue ? "HardwareOpOn" : "HardwareOpOff");
  const prepareClientTutorial = useCallback(() => {
    const previousOptionsOpen = state.optionsOpen;
    const previousListViewState = {
      listMode: state.listMode,
      navigationMode: state.navigationMode,
      leaderFilterText: state.leaderFilterText,
      selectedLeaderId: state.selectedLeaderId,
      selectedPlaylistLabel: state.selectedPlaylistLabel,
    };
    const previousZoomOpen = state.zoomDialogOpen;
    store.closeAbout();
    store.closeInstructionsEditor();
    store.closeLoginDialog();
    store.closeSessionsDialog();
    store.closeZoomDialog();
    store.toggleOptions(false);
    return () => {
      store.restoreListViewState(previousListViewState);
      store.toggleOptions(previousOptionsOpen);
      if (previousZoomOpen) store.openZoomDialog();
      else store.closeZoomDialog();
    };
  }, [
    state.leaderFilterText,
    state.listMode,
    state.navigationMode,
    state.optionsOpen,
    state.selectedLeaderId,
    state.selectedPlaylistLabel,
    state.zoomDialogOpen,
    store,
  ]);
  const handleTutorialCommand = useCallback(
    (command: TutorialCommand) => {
      if (command !== "switch-full") return;
      if (onHome) {
        store.syncHostSelectionToFullView();
        onHome();
      } else {
        store.openFullEditor();
      }
    },
    [onHome, store]
  );
  // Pull-down-from-the-toolbar refresh: a released pull just reloads the page
  // (database synchronization is a full-view-only concern now — see ClientViewStore
  // pullRefresh). A single level, so no escalation.
  const pull = usePullToRefresh({ maxLevel: store.maxPullLevel(), onRelease: (level) => store.pullRefresh(level) });

  // The bordered/flat button look is a single build-time switch (see uiConfig).
  const bordered = UNIFORM_BUTTON_BORDERS ? " cv-bordered" : "";

  return (
    <div
      id="mainView"
      aria-busy={!state.ready}
      className={`split${state.optionsOpen ? " options-open" : ""}${state.isDark ? " dark" : ""}${bordered}`}
    >
      <TutorialHost view="client" onBeforeStart={prepareClientTutorial} onCommand={handleTutorialCommand} />
      {feedback && (
        <div className="cv-hardware-feedback" role="status">
          {t(catalogFamily("client-view", feedback.command.action)!.labelKey as never)}: {feedbackText}
        </div>
      )}
      <OptionsOverlay onHome={onHome} />
      <div className="mainTable">
        <MainToolbar
          pullRef={pull.containerRef}
          onPrev={() => songViewRef.current?.navigate(false)}
          onNext={() => songViewRef.current?.navigate(true)}
        />
        <PullRefreshSpinner phase={pull.phase} offset={pull.offset} progress={pull.progress} level={pull.level} />
        <SongView ref={songViewRef} display={state.display} settings={state.displaySettings} dark={state.isDark} />
      </div>
      {state.loginDialogOpen && state.capabilities.canLogin && <LoginDialog />}
      {state.sessionsDialogOpen && canUseSessions(state) && <SessionsDialog />}
      {state.instructionsEditorOpen && <InstructionsEditorDialog />}
      {state.aboutOpen && <AboutDialog />}
      {state.confirmAnim && <ConfirmDialog />}
      {state.confirmText && <TextConfirmDialog />}
      {state.startupSessionScan && <StartupScanIndicator address={state.startupSessionScan.address} />}
    </div>
  );
}
