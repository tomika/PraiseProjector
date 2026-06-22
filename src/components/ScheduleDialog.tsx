import React from "react";
import { Leader } from "../../db-common/Leader";
import { useMessageBox } from "../contexts/MessageBoxContext";
import { useLocalization } from "../localization/LocalizationContext";
import { SchedulePicker } from "../shared/SchedulePicker";

interface ScheduleDialogProps {
  leader: Leader;
  mode: "save" | "load";
  onConfirm: (date: Date) => void;
  onCancel: () => void;
  initialDate?: Date | null;
}

/**
 * Desktop GUI date picker. Thin wrapper over the shared {@link SchedulePicker}:
 * sources the leader's already-scheduled dates from the local profile, supplies
 * localized text labels, and wires the overwrite confirmation to the app's
 * MessageBox — mirroring how InstructionsEditorForm wraps the shared editor.
 */
export const ScheduleDialog: React.FC<ScheduleDialogProps> = ({ leader, mode, onConfirm, onCancel, initialDate }) => {
  const { showConfirmAsync } = useMessageBox();
  const { t } = useLocalization();

  return (
    <SchedulePicker
      variant="desktop"
      mode={mode}
      scheduledDates={leader.getSchedule()}
      initialDate={initialDate}
      title={`${mode === "save" ? t("SavePlaylistFor") : t("LoadPlaylistFor")} ${leader.name}`}
      weekdays={[t("WeekdaySun"), t("WeekdayMon"), t("WeekdayTue"), t("WeekdayWed"), t("WeekdayThu"), t("WeekdayFri"), t("WeekdaySat")]}
      todayLabel={t("Today")}
      noSchedulesText={t("NoScheduledPlaylists").replace("{0}", leader.name)}
      action={{ style: "text", okLabel: t("OK"), cancelLabel: t("Cancel") }}
      confirmOverwrite={(date) =>
        showConfirmAsync(t("ConfirmOverwrite"), t("AskOverwriteSchedule").replace("{0}", leader.name).replace("{1}", date.toLocaleDateString()), {
          confirmText: t("OverwriteScheduleConfirm"),
          confirmDanger: true,
        })
      }
      onConfirm={onConfirm}
      onCancel={onCancel}
    />
  );
};
