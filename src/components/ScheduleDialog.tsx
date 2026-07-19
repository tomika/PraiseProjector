import React, { useEffect, useState } from "react";
import { Leader } from "../../db-common/Leader";
import { useMessageBox } from "../contexts/MessageBoxContext";
import { useLocalization } from "../localization/LocalizationContext";
import { SchedulePicker } from "../shared/SchedulePicker";

interface ScheduleDialogProps {
  leader: Leader;
  mode: "save" | "load";
  onConfirm: (date: Date, leader: Leader) => void;
  onCancel: () => void;
  initialDate?: Date | null;
  /** Load mode only: the user's own (synced) leaders selectable in the dialog. */
  ownLeaders?: Leader[];
  /** Load mode only: other leaders' read-only public lists. */
  publicLeaders?: Leader[];
  /** Load mode only: re-fetch the public-leader mirror on demand (the 🔄 button). */
  onRefreshPublic?: () => Promise<void>;
}

/**
 * Desktop GUI date picker. Thin wrapper over the shared {@link SchedulePicker}:
 * sources the leader's already-scheduled dates from the local profile, supplies
 * localized text labels, and wires the overwrite confirmation to the app's
 * MessageBox — mirroring how InstructionsEditorForm wraps the shared editor.
 *
 * In load mode the header slot carries a leader switcher (own + public groups)
 * and a refresh button, so any leader's list can be loaded without leaving the
 * dialog. Save mode has no switcher — saving always targets the own leader.
 */
export const ScheduleDialog: React.FC<ScheduleDialogProps> = ({
  leader,
  mode,
  onConfirm,
  onCancel,
  initialDate,
  ownLeaders = [],
  publicLeaders = [],
  onRefreshPublic,
}) => {
  const { showConfirmAsync } = useMessageBox();
  const { t } = useLocalization();
  const [activeLeader, setActiveLeader] = useState<Leader>(leader);
  const [refreshing, setRefreshing] = useState(false);

  const findLeader = (id: string) => ownLeaders.find((l) => l.id === id) ?? publicLeaders.find((l) => l.id === id);

  // After a refresh the leader lists are rebuilt with fresh instances — follow
  // the active id to the new instance so the schedule reflects the fetch.
  useEffect(() => {
    const fresh = ownLeaders.find((l) => l.id === activeLeader.id) ?? publicLeaders.find((l) => l.id === activeLeader.id);
    if (fresh && fresh !== activeLeader) setActiveLeader(fresh);
  }, [ownLeaders, publicLeaders, activeLeader]);

  const showSwitcher = mode === "load" && ownLeaders.length + publicLeaders.length > 0;

  const leaderOptions = (list: Leader[]) =>
    list.map((l) => (
      <option key={l.id} value={l.id}>
        {l.name}
      </option>
    ));

  const headerSlot = showSwitcher ? (
    <div className="schedule-leader-row">
      <select
        className="form-select form-select-sm schedule-leader-select"
        aria-label={t("Leader")}
        value={activeLeader.id}
        onChange={(e) => {
          const next = findLeader(e.target.value);
          if (next) setActiveLeader(next);
        }}
      >
        {!findLeader(activeLeader.id) && <option value={activeLeader.id}>{activeLeader.name}</option>}
        {ownLeaders.length > 0 && <optgroup label={t("MyLeaders")}>{leaderOptions(ownLeaders)}</optgroup>}
        {publicLeaders.length > 0 && <optgroup label={t("PublicLeaders")}>{leaderOptions(publicLeaders)}</optgroup>}
      </select>
      {onRefreshPublic && (
        <button
          type="button"
          className="btn btn-sm btn-outline-secondary schedule-refresh-btn"
          title={t("RefreshLeaderLists")}
          aria-label={t("RefreshLeaderLists")}
          disabled={refreshing}
          onClick={() => {
            setRefreshing(true);
            void onRefreshPublic().finally(() => setRefreshing(false));
          }}
        >
          🔄
        </button>
      )}
    </div>
  ) : undefined;

  return (
    <SchedulePicker
      key={activeLeader.id}
      variant="desktop"
      mode={mode}
      scheduledDates={activeLeader.getSchedule()}
      initialDate={initialDate}
      title={`${mode === "save" ? t("SavePlaylistFor") : t("LoadPlaylistFor")} ${activeLeader.name}`}
      weekdays={[t("WeekdaySun"), t("WeekdayMon"), t("WeekdayTue"), t("WeekdayWed"), t("WeekdayThu"), t("WeekdayFri"), t("WeekdaySat")]}
      todayLabel={t("Today")}
      noSchedulesText={t("NoScheduledPlaylists").replace("{0}", activeLeader.name)}
      action={{ style: "text", okLabel: t("OK"), cancelLabel: t("Cancel") }}
      confirmOverwrite={(date) =>
        showConfirmAsync(
          t("ConfirmOverwrite"),
          t("AskOverwriteSchedule").replace("{0}", activeLeader.name).replace("{1}", date.toLocaleDateString()),
          {
            confirmText: t("OverwriteScheduleConfirm"),
            confirmDanger: true,
          }
        )
      }
      headerSlot={headerSlot}
      onConfirm={(date) => onConfirm(date, activeLeader)}
      onCancel={onCancel}
    />
  );
};
