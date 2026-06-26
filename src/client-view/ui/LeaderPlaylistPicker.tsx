/**
 * LeaderPlaylistPicker — the song-list body of the leader-playlists mode (legacy
 * selPlaylists droplist). The leader + date selectors and the replace button
 * live in the search row (see LeaderPlaylistControls); this renders the chosen
 * playlist's songs as database-style rows ([＋ add] Title [▶ play]), reusing the
 * #list.cv-database look.
 */

import { useClientViewState, useClientViewStore } from "../controller/ClientViewContext";

export function LeaderPlaylistPicker() {
  const store = useClientViewStore();
  const state = useClientViewState();

  const profiles = state.leaderProfiles;
  const entries = store.selectedLeaderEntries();
  const inPlaylist = new Set(state.playlist.map((entry) => entry.songId));

  return (
    <>
      {entries.length === 0 ? (
        <div className="cv-playlist-empty">
          <p className="cv-playlist-empty-title">{state.leaderProfilesLoading ? "Loading leader playlists…" : "No songs in this list"}</p>
          {!state.leaderProfilesLoading && profiles.length === 0 && (
            <p className="cv-playlist-empty-hint">No shared leader playlists are available.</p>
          )}
        </div>
      ) : (
        <table className="cv-database" id="list" cellSpacing={0} cellPadding={0}>
          <tbody>
            {entries.map((entry, index) => {
              const added = inPlaylist.has(entry.songId);
              return (
                <tr
                  key={`${entry.songId}-${index}`}
                  className={state.navigationMode === "archive" && entry.songId === state.display.songId ? "selected" : ""}
                  onClick={() => void store.selectArchiveEntry(entry)}
                >
                  <td className="cv-add-col">
                    <button
                      type="button"
                      className={`cv-add-btn${added ? " in" : ""}`}
                      title={added ? "Remove from current playlist" : "Add to current playlist"}
                      aria-label={added ? "Remove from current playlist" : "Add to current playlist"}
                      onClick={(e) => {
                        e.stopPropagation();
                        void store.togglePlaylistEntry(entry);
                      }}
                    >
                      {added ? "✓" : "+"}
                    </button>
                  </td>
                  <td className="cv-song-title">
                    <span className="cv-song-label">
                      <span className="cv-title">{entry.title}</span>
                    </span>
                  </td>
                  <td className="cv-play-col">
                    <button
                      type="button"
                      className="cv-play-btn"
                      title="Project this song"
                      aria-label="Project this song"
                      onClick={(e) => {
                        e.stopPropagation();
                        void store.playSong(entry);
                      }}
                    >
                      ▶
                    </button>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
    </>
  );
}
