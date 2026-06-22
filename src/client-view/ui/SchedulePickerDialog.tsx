/**
 * SchedulePickerDialog — client-view host for the shared <SchedulePicker>.
 *
 * Renders the save-playlist date picker with the client-view skin (dark, icon
 * OK/Cancel buttons). The "signed" days — the dates the current leader already
 * has a saved playlist for — come from the store (fetched in openSaveDialog);
 * picking a date persists the working list via the controller, which handles the
 * overwrite confirmation through the upload response.
 */

import { useClientViewState, useClientViewStore } from "../controller/ClientViewContext";
import { SchedulePicker } from "../../shared/SchedulePicker";
import { icon } from "./assets";

const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

export function SchedulePickerDialog() {
  const store = useClientViewStore();
  const state = useClientViewState();

  return (
    <SchedulePicker
      variant="cv"
      mode="save"
      scheduledDates={state.saveScheduledDates}
      title={state.leader ? `Save playlist for ${state.leader.name}` : "Save playlist"}
      weekdays={WEEKDAYS}
      todayLabel="Today"
      action={{
        style: "icon",
        okIcon: icon("ok.svg"),
        cancelIcon: icon("cancel.svg"),
        okTitle: "Save",
        cancelTitle: "Cancel",
      }}
      onConfirm={(date) => void store.confirmSave(date)}
      onCancel={() => store.closeSaveDialog()}
    />
  );
}
