/**
 * LeaderPlaylistControls — the leader + date selectors and the replace button
 * for the leader-playlists mode. They live in the search row (#filterRow), in
 * place of the song filter, while the chosen playlist's songs render below in
 * LeaderPlaylistPicker.
 *
 * The legacy single "leaderName — date" droplist is split, per the product
 * change, into a LEADER select + a DATE select (the chosen leader's dated
 * playlists, newest first); the `:=` button replaces the whole working list.
 */

import { useClientViewState, useClientViewStore } from "../controller/ClientViewContext";

export function LeaderPlaylistControls() {
  const store = useClientViewStore();
  const state = useClientViewState();

  const profiles = state.leaderProfiles;
  const dates = store.leaderPlaylistOptions();
  const entries = store.selectedLeaderEntries();

  return (
    <div className="cv-leaderlists-controls">
      <select
        className="cv-leader-select"
        aria-label="Leader"
        title="Leader"
        value={state.selectedLeaderId ?? ""}
        disabled={state.leaderProfilesLoading || profiles.length === 0}
        onChange={(e) => store.selectLeader(e.target.value)}
      >
        {profiles.length === 0 && <option value="">{state.leaderProfilesLoading ? "Loading…" : "No leaders"}</option>}
        {profiles.map((profile) => (
          <option key={profile.leaderId} value={profile.leaderId}>
            {profile.leaderName}
          </option>
        ))}
      </select>

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
