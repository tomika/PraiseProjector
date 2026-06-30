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

import { useRef } from "react";
import { useClientViewState, useClientViewStore } from "../controller/ClientViewContext";
import { canUseSessions } from "../controller/ClientViewStore";
import { AboutDialog } from "./AboutDialog";
import { ConfirmDialog } from "./ConfirmDialog";
import { InstructionsEditorDialog } from "./InstructionsEditorDialog";
import { LoginDialog } from "./LoginDialog";
import { MainToolbar } from "./MainToolbar";
import { OptionsOverlay } from "./OptionsOverlay";
import { SchedulePickerDialog } from "./SchedulePickerDialog";
import { SessionsDialog } from "./SessionsDialog";
import { SongView, type SongViewHandle } from "./SongView";
import { PullRefreshSpinner } from "./PullRefreshSpinner";
import { usePullToRefresh } from "./usePullToRefresh";
import { UNIFORM_BUTTON_BORDERS } from "./uiConfig";

export function ClientView({ onHome }: { onHome?: () => void }) {
  const state = useClientViewState();
  const store = useClientViewStore();
  // The toolbar Prev/Next buttons drive the same animated page-turn as a swipe,
  // which lives in SongView — reached here through an imperative handle.
  const songViewRef = useRef<SongViewHandle>(null);
  // Pull-down-from-the-toolbar refresh (legacy parity): escalating levels run a
  // silent download-only sync / replace-DB / clear-data, gated by what the backend
  // offers (3 for the Direct embed, 1 = reload for a Rest client).
  const pull = usePullToRefresh({ maxLevel: store.maxPullLevel(), onRelease: (level) => store.pullRefresh(level) });

  // The bordered/flat button look is a single build-time switch (see uiConfig).
  const bordered = UNIFORM_BUTTON_BORDERS ? " cv-bordered" : "";

  return (
    <div id="mainView" className={`split${state.optionsOpen ? " options-open" : ""}${state.isDark ? " dark" : ""}${bordered}`}>
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
      {state.saveDialogOpen && state.capabilities.canPersistPlaylist && <SchedulePickerDialog />}
      {state.instructionsEditorOpen && <InstructionsEditorDialog />}
      {state.aboutOpen && <AboutDialog />}
      {state.confirmAnim && <ConfirmDialog />}
    </div>
  );
}
