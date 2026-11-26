/**
 * LeaderPlaylistControls — the leader + date selectors, the list filter and the
 * replace button for the leader-playlists mode. They live in the search row
 * (#filterRow), in place of the song filter, while the chosen playlist's songs
 * render below in LeaderPlaylistPicker.
 *
 * The leader select groups the user's own synced leaders, the leaders of the
 * user's group circle (every list, read-only) and other leaders' public
 * (read-only) lists; the tree button arranges the latter two by the group tree
 * (useLeaderTreeView, saved in the settings). The playlist select lists the
 * dated playlists and,
 * in a separate group, the leader's named favorites. The filter input searches
 * ALL of the selected leader's playlists; while it is non-empty the date select
 * is hidden (matches span every list) and the picker below shows the matches
 * with their list label. The
 * `:=` button always replaces the LOCAL working playlist with the selected
 * leader playlist — never the other way around — so it stays active while
 * filtering (tapping a match first selects that match's dated list).
 */

import type { LeaderDBProfile } from "../../../common/pp-types";
import { useLeaderTreeView } from "../../hooks/useLeaderTreeView";
import { buildLeaderGroupTree, leaderTreeOptionText, sharesOneGroupPath } from "../../shared/leaderGroupTree";
import { useClientViewState, useClientViewStore } from "../controller/ClientViewContext";
import { icon } from "./assets";

export function LeaderPlaylistControls() {
  const store = useClientViewStore();
  const state = useClientViewState();
  const [treeView, setTreeView] = useLeaderTreeView();

  const profiles = state.leaderProfiles;
  const groups = store.groupedLeaderProfiles();
  const dates = store.leaderPlaylistOptions();
  const entries = store.selectedLeaderEntries();
  const filtering = state.leaderFilterText.trim().length > 0;

  const leaderOptions = (list: LeaderDBProfile[]) =>
    list.map((profile) => (
      <option key={profile.leaderId} value={profile.leaderId}>
        {profile.leaderName}
      </option>
    ));

  // The cloud-listed leaders (group circle and public), flat or by group tree.
  // "My group" stays flat when all its leaders are in the same group.
  const treeItems = (list: LeaderDBProfile[]) => list.map((p) => ({ id: p.leaderId, name: p.leaderName, groupPath: p.groupPath }));
  const listedLeaderOptions = (list: LeaderDBProfile[], flatWhenOnePath = false) =>
    treeView && !(flatWhenOnePath && sharesOneGroupPath(treeItems(list)))
      ? buildLeaderGroupTree(treeItems(list)).map((row) =>
          row.kind === "group" ? (
            <option key={row.key} value="" disabled>
              {leaderTreeOptionText(row)}
            </option>
          ) : (
            <option key={row.id} value={row.id}>
              {leaderTreeOptionText(row)}
            </option>
          )
        )
      : leaderOptions(list);
  const hasListedLeaders = groups.group.length + groups.public.length > 0;

  const playlistOptions = (list: typeof dates) =>
    list.map((d) => (
      <option key={d.label} value={d.label}>
        {d.text}
      </option>
    ));

  return (
    <div className="cv-leaderlists-controls">
      <div className="cv-leaderlists-fields">
        <select
          className="cv-leader-select"
          aria-label="Leader"
          title="Leader"
          value={state.selectedLeaderId ?? ""}
          disabled={state.leaderProfilesLoading || profiles.length === 0}
          onChange={(e) => store.selectLeader(e.target.value)}
        >
          {profiles.length === 0 && <option value="">{state.leaderProfilesLoading ? "Loading…" : "No leaders"}</option>}
          {groups.own.length > 0 && <optgroup label="My leaders">{leaderOptions(groups.own)}</optgroup>}
          {groups.group.length > 0 && <optgroup label="My group">{listedLeaderOptions(groups.group, true)}</optgroup>}
          {groups.public.length > 0 && <optgroup label="Public">{listedLeaderOptions(groups.public)}</optgroup>}
        </select>

        {hasListedLeaders && (
          <button
            type="button"
            className={`cv-leader-tree-btn${treeView ? " cv-leader-tree-on" : ""}`}
            title="Group tree view"
            aria-label="Group tree view"
            aria-pressed={treeView}
            onClick={() => setTreeView(!treeView)}
          >
            <img src={icon("group-tree.svg")} alt="" aria-hidden="true" />
          </button>
        )}

        {!filtering && (
          <select
            className="cv-date-select"
            aria-label="Playlist date"
            title="Playlist date"
            value={state.selectedPlaylistLabel ?? ""}
            disabled={state.leaderProfilesLoading || dates.length === 0}
            onChange={(e) => store.selectLeaderDate(e.target.value)}
          >
            {dates.length === 0 && <option value="">—</option>}
            {dates.some((d) => d.favorite) ? (
              <>
                <optgroup label="Dates">{playlistOptions(dates.filter((d) => !d.favorite))}</optgroup>
                <optgroup label="★ Favorites">{playlistOptions(dates.filter((d) => d.favorite))}</optgroup>
              </>
            ) : (
              playlistOptions(dates)
            )}
          </select>
        )}

        <input
          className="cv-leader-filter"
          type="text"
          aria-label="Search this leader's lists"
          title="Search this leader's lists"
          placeholder="Search lists"
          value={state.leaderFilterText}
          disabled={state.leaderProfilesLoading || profiles.length === 0}
          onChange={(e) => store.setLeaderFilterText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Escape") {
              e.preventDefault();
              e.stopPropagation();
              store.setLeaderFilterText("");
            }
          }}
        />
      </div>

      <button
        type="button"
        className="cv-leader-replace-btn"
        title="Replace current playlist with this list"
        aria-label="Replace current playlist with this list"
        disabled={entries.length === 0}
        onClick={() => void store.replaceWithLeaderPlaylist()}
      >
        :=
      </button>
    </div>
  );
}
