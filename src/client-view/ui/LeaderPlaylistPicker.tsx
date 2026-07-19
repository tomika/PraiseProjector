/**
 * LeaderPlaylistPicker — the song-list body of the leader-playlists mode (legacy
 * selPlaylists droplist). The leader + date selectors and the replace button
 * live in the search row (see LeaderPlaylistControls); this renders the chosen
 * playlist's songs as database-style rows ([＋ add] Title [▶ play]), reusing the
 * #list.cv-database look.
 *
 * Pulling the list down from its top (touch or mouse) refreshes the
 * public-leader mirror — the client-view counterpart of the full-view load
 * dialog's 🔄 button — with the same spinner as the main-toolbar pull. The
 * gesture is anchored to the wrapper (so it also works on the empty state)
 * while the top check reads the inner #list, which is the actual scroller.
 */

import { useRef } from "react";
import { useClientViewState, useClientViewStore } from "../controller/ClientViewContext";
import { PullRefreshSpinner } from "./PullRefreshSpinner";
import { usePullToRefresh } from "./usePullToRefresh";

export function LeaderPlaylistPicker() {
  const store = useClientViewStore();
  const state = useClientViewState();
  const listRef = useRef<HTMLTableElement>(null);

  const {
    containerRef: pullRef,
    phase,
    offset,
    progress,
    level,
  } = usePullToRefresh({
    maxLevel: 1,
    onRelease: () => store.refreshLeaderPlaylists(),
    atTop: () => (listRef.current?.scrollTop ?? 0) <= 2,
  });

  const profiles = state.leaderProfiles;
  const filtering = state.leaderFilterText.trim().length > 0;
  // While filtering, the rows are title matches across the selected leader's
  // ALL dated playlists, each tagged with the date it was found in; otherwise
  // the single selected playlist's songs.
  const rows: { entry: (typeof state.playlist)[number]; label?: string }[] = filtering
    ? store.leaderSearchResults()
    : store.selectedLeaderEntries().map((entry) => ({ entry }));
  const inPlaylist = new Set(state.playlist.map((entry) => entry.songId));

  return (
    <div className="cv-leaderlists-body" ref={pullRef}>
      <PullRefreshSpinner phase={phase} offset={offset} progress={progress} level={level} />
      {rows.length === 0 ? (
        <div className="cv-playlist-empty">
          <p className="cv-playlist-empty-title">
            {state.leaderProfilesLoading ? "Loading leader playlists…" : filtering ? "No matches in this leader's lists" : "No songs in this list"}
          </p>
          {!state.leaderProfilesLoading && profiles.length === 0 && (
            <p className="cv-playlist-empty-hint">No shared leader playlists are available.</p>
          )}
        </div>
      ) : (
        <table className="cv-database" id="list" ref={listRef} cellSpacing={0} cellPadding={0}>
          <tbody>
            {rows.map(({ entry, label }, index) => {
              const added = inPlaylist.has(entry.songId);
              return (
                <tr
                  key={`${entry.songId}-${index}`}
                  className={`${state.navigationMode === "archive" && entry.songId === state.display.songId ? "selected" : ""}${state.optionsOpen && entry.songId === state.hotkeySongId ? " cv-hotkey-row" : ""}`}
                  onClick={() => {
                    // A match belongs to a specific dated list — select that list
                    // first so the `:=` replace loads exactly where it was found.
                    if (label) store.selectLeaderDate(label);
                    void store.selectArchiveEntry(entry);
                  }}
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
                      {label && <span className="cv-leader-date-badge">{label}</span>}
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
    </div>
  );
}
