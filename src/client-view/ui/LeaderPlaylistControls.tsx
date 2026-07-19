/**
 * LeaderPlaylistControls — the leader + date selectors, the list filter and the
 * replace button for the leader-playlists mode. They live in the search row
 * (#filterRow), in place of the song filter, while the chosen playlist's songs
 * render below in LeaderPlaylistPicker.
 *
 * The leader select groups the user's own synced leaders and other leaders'
 * public (read-only) lists. The filter input searches the selected leader's ALL
 * dated playlists; while it is non-empty the date select is hidden (matches
 * span every date) and the picker below shows the matches with their date. The
 * `:=` button always replaces the LOCAL working playlist with the selected
 * leader playlist — never the other way around — so it stays active while
 * filtering (tapping a match first selects that match's dated list).
 */

import type { LeaderDBProfile } from "../../../common/pp-types";
import { useClientViewState, useClientViewStore } from "../controller/ClientViewContext";

export function LeaderPlaylistControls() {
  const store = useClientViewStore();
  const state = useClientViewState();

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
          {groups.public.length > 0 && <optgroup label="Public">{leaderOptions(groups.public)}</optgroup>}
        </select>

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
            {dates.map((d) => (
              <option key={d.label} value={d.label}>
                {d.label}
              </option>
            ))}
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
