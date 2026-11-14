import React, { useState } from "react";
import { Leader } from "../../db-common/Leader";
import { formatLocalDateLabel } from "../../common/date-only";
import { FAVORITE_NAME_MAX_LENGTH, favoriteNameFromLabel, isFavoriteScheduleDate } from "../../common/favorite-playlists";
import { useMessageBox } from "../contexts/MessageBoxContext";
import { useLocalization } from "../localization/LocalizationContext";
import { SchedulePicker, type ScheduleFavoriteItem } from "../shared/SchedulePicker";
import { getAssetPath } from "../utils/assetPath";

interface ScheduleDialogProps {
  leader: Leader;
  mode: "save" | "load";
  /** `favoriteName` is set when a favorite is saved (see common/favorite-playlists). */
  onConfirm: (date: Date, leader: Leader, shareAfterSave: boolean, favoriteName?: string) => void;
  /** Deletes a playlist of an own leader (already confirmed by the dialog). */
  onDeletePlaylist?: (date: Date, leader: Leader) => void;
  /** Renames a favorite of an own leader. */
  onRenameFavorite?: (date: Date, leader: Leader, name: string) => void;
  onShare: (date: Date, leader: Leader) => void | Promise<void>;
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
  onDeletePlaylist,
  onRenameFavorite,
  onShare,
  onCancel,
  initialDate,
  ownLeaders = [],
  publicLeaders = [],
  onRefreshPublic,
}) => {
  const { showConfirmAsync } = useMessageBox();
  const { t } = useLocalization();
  const [activeLeaderId, setActiveLeaderId] = useState(leader.id);
  const [refreshing, setRefreshing] = useState(false);
  // Bumped after a rename/delete, which change the leader in place.
  const [, setRevision] = useState(0);

  const findLeader = (id: string) => ownLeaders.find((l) => l.id === id) ?? publicLeaders.find((l) => l.id === id);

  // After a refresh the leader lists are rebuilt with fresh instances — follow
  // the active id to the new instance so the schedule reflects the fetch.
  const matchingLeader = findLeader(activeLeaderId);
  const fallbackLeader = ownLeaders[0] ?? publicLeaders[0];
  const activeLeader = matchingLeader ?? fallbackLeader ?? leader;

  // Save mode always targets the own selected leader; in load mode only the own
  // leaders' playlists can be renamed or deleted, public ones are read-only.
  const canEdit = mode === "save" || ownLeaders.some((l) => l.id === activeLeader.id);

  const schedule = activeLeader.getSchedule();
  const datedSchedule = schedule.filter((date) => !isFavoriteScheduleDate(date));
  const favoriteItems: ScheduleFavoriteItem[] = schedule
    .filter((date) => isFavoriteScheduleDate(date))
    .map((date) => {
      const name = favoriteNameFromLabel(activeLeader.getPlaylist(date)?.name);
      return name ? { date, name } : { date, name: t("UnnamedFavorite").replace("{0}", formatLocalDateLabel(date)), unnamed: true };
    })
    .sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: "base" }));

  const describePlaylist = (date: Date) =>
    isFavoriteScheduleDate(date)
      ? `★ ${favoriteItems.find((item) => item.date.getTime() === date.getTime())?.name ?? ""}`
      : date.toLocaleDateString();

  const handleDelete = async (date: Date) => {
    if (!onDeletePlaylist) return;
    const confirmed = await showConfirmAsync(
      t("DeletePlaylistTitle"),
      t("AskDeletePlaylist").replace("{0}", activeLeader.name).replace("{1}", describePlaylist(date)),
      { confirmText: t("Delete"), confirmDanger: true }
    );
    if (!confirmed) return;
    onDeletePlaylist(date, activeLeader);
    setRevision((value) => value + 1);
  };

  const handleRename = (date: Date, name: string) => {
    if (!onRenameFavorite) return;
    onRenameFavorite(date, activeLeader, name);
    setRevision((value) => value + 1);
  };

  const showSwitcher = mode === "load" && ownLeaders.length + publicLeaders.length > 0;
  // The public mirror follows server/database order. Keep its dropdown group
  // predictable and easy to scan without mutating the source list.
  const sortedPublicLeaders = [...publicLeaders].sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: "base" }));

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
          if (next) setActiveLeaderId(next.id);
        }}
      >
        {ownLeaders.length > 0 && <optgroup label={t("MyLeaders")}>{leaderOptions(ownLeaders)}</optgroup>}
        {sortedPublicLeaders.length > 0 && <optgroup label={t("PublicLeaders")}>{leaderOptions(sortedPublicLeaders)}</optgroup>}
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
      scheduledDates={datedSchedule}
      initialDate={initialDate}
      title={`${mode === "save" ? t("SavePlaylistFor") : t("LoadPlaylistFor")} ${activeLeader.name}`}
      weekdays={[t("WeekdaySun"), t("WeekdayMon"), t("WeekdayTue"), t("WeekdayWed"), t("WeekdayThu"), t("WeekdayFri"), t("WeekdaySat")]}
      todayLabel={t("Today")}
      noSchedulesText={t("NoScheduledPlaylists").replace("{0}", activeLeader.name)}
      action={{ style: "text", okLabel: mode === "save" ? t("Save") : t("Load"), cancelLabel: t("Cancel") }}
      shareAction={{
        icon: getAssetPath("images/share.svg"),
        title: t("SharePlaylist"),
        afterSaveLabel: t("ShareAfterSave"),
        onShare: (date) => onShare(date, activeLeader),
      }}
      deleteAction={
        canEdit && onDeletePlaylist
          ? { icon: getAssetPath("images/trashcan.svg"), title: t("DeletePlaylistTitle"), onDelete: handleDelete }
          : undefined
      }
      favorites={{
        items: favoriteItems,
        labels: {
          datesTab: t("PlaylistTabDates"),
          favoritesTab: t("PlaylistTabFavorites"),
          nameLabel: t("FavoriteName"),
          namePlaceholder: t("FavoriteNamePlaceholder"),
          existingHeading: t("ExistingFavorites"),
          emptyText: t("NoFavoritePlaylists").replace("{0}", activeLeader.name),
          filterPlaceholder: t("FilterFavorites"),
          renameTitle: t("RenameFavorite"),
          renameSave: t("Save"),
          renameCancel: t("Cancel"),
          willOverwrite: t("FavoriteWillOverwrite"),
          duplicate: t("FavoriteNameDuplicate"),
          noFreeSlot: t("FavoriteNoFreeSlot"),
          errors: {
            empty: t("FavoriteNameEmpty"),
            slash: t("FavoriteNameSlash"),
            tooLong: t("FavoriteNameTooLong").replace("{0}", String(FAVORITE_NAME_MAX_LENGTH)),
          },
        },
        confirmOverwrite: (item) =>
          showConfirmAsync(t("ConfirmOverwrite"), t("AskOverwriteFavorite").replace("{0}", activeLeader.name).replace("{1}", item.name), {
            confirmText: t("OverwriteFavoriteConfirm"),
            confirmDanger: true,
          }),
        onRename: canEdit && onRenameFavorite ? handleRename : undefined,
      }}
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
      onConfirm={(date, options) => onConfirm(date, activeLeader, options.shareAfterSave, options.favoriteName)}
      onCancel={onCancel}
    />
  );
};
