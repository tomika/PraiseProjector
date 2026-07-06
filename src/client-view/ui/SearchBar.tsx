/**
 * SearchBar — the filter row inside the options overlay (#filterRow).
 * Database typing debounces a search through the controller; Enter runs it
 * immediately. Playlist typing filters the working list locally.
 *
 * When the working playlist is editable, the leading icon becomes a list-mode
 * toggle (the legacy iconDatabase ↔ iconPlaylist switch): the visible icon is
 * the mode you can switch TO. The filter field shows in every mode EXCEPT
 * leaderlists (which swaps in the leader/date pickers). In playlist mode the
 * field filters the working list locally; Enter or the search button runs the
 * same text against the database.
 */

import { useClientViewState, useClientViewStore } from "../controller/ClientViewContext";
import { LIST_MODES, type ListMode } from "../controller/ClientViewStore";
import { icon } from "./assets";
import { LeaderPlaylistControls } from "./LeaderPlaylistControls";

const LIST_MODE_META: Record<ListMode, { svg: string; label: string }> = {
  database: { svg: "database.svg", label: "song database" },
  playlist: { svg: "playlist.svg", label: "current playlist" },
  leaderlists: { svg: "calendar.svg", label: "leader playlists" },
};

export function SearchBar() {
  const store = useClientViewStore();
  const state = useClientViewState();

  const canEdit = state.capabilities.canEditWorkingPlaylist;
  // While editing, the toggle cycles database → playlist → leaderlists. The
  // filter field shows in database AND playlist; only leaderlists swaps in its
  // own pickers.
  const showSearch = !canEdit || state.listMode !== "leaderlists";
  const playlistMode = canEdit && state.listMode === "playlist";
  const filterText = playlistMode ? state.playlistFilterText : state.searchText;
  const nextMode = LIST_MODES[(LIST_MODES.indexOf(state.listMode) + 1) % LIST_MODES.length];
  const current = LIST_MODE_META[state.listMode];
  const next = LIST_MODE_META[nextMode];
  const setFilterText = (text: string) => {
    if (playlistMode) store.setPlaylistFilterText(text);
    else store.setSearchText(text);
  };
  const submitSearch = () => {
    store.submitSearch(filterText);
  };

  return (
    <form
      id="filterRow"
      className="widthProtect"
      onSubmit={(e) => {
        e.preventDefault();
        submitSearch();
      }}
    >
      {canEdit ? (
        <button
          type="button"
          id="listModeToggle"
          className="cv-listmode-toggle"
          title={`${current.label} — tap to show ${next.label}`}
          aria-label={`${current.label} — tap to show ${next.label}`}
          onClick={() => store.setListMode(nextMode)}
        >
          <img className="btnImg inverted" src={icon(current.svg)} alt="" />
        </button>
      ) : (
        <img id="iconDatabase" className="btnImg inverted" src={icon("database.svg")} alt="Database" />
      )}

      {showSearch ? (
        <>
          <input
            id="filter"
            type="text"
            aria-label={playlistMode ? "Filter playlist" : "Search songs"}
            value={filterText}
            onChange={(e) => setFilterText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Escape") {
                e.preventDefault();
                e.stopPropagation();
                setFilterText("");
              }
            }}
          />
          <button
            type="button"
            id="clear-filter"
            className="cv-search-icon-btn"
            title="Clear filter"
            aria-label="Clear filter"
            onClick={() => setFilterText("")}
          >
            <img className="btnImg" src={icon("cancel.svg")} alt="" />
          </button>
          {playlistMode && (
            <button type="submit" id="playlist-search" className="cv-search-icon-btn" title="Search database" aria-label="Search database">
              <img className="btnImg" src={icon("magnifier.svg")} alt="" />
            </button>
          )}
        </>
      ) : (
        <LeaderPlaylistControls />
      )}
    </form>
  );
}
