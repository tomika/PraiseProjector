/**
 * SearchBar — the filter row inside the options overlay (#filterRow).
 * Typing debounces a search through the controller; the magnifier / Enter runs
 * it immediately.
 *
 * When the working playlist is editable, the leading icon becomes a list-mode
 * toggle (the legacy iconDatabase ↔ iconPlaylist switch): the visible icon is
 * the mode you can switch TO. The filter field shows in every mode EXCEPT
 * leaderlists (which swaps in the leader/date pickers); typing a query returns
 * the list to the searchable database (see ClientViewStore.setSearchText).
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
  // filter field shows in database AND playlist (typing in playlist switches
  // back to the database); only leaderlists swaps in its own pickers.
  const showSearch = !canEdit || state.listMode !== "leaderlists";
  const nextMode = LIST_MODES[(LIST_MODES.indexOf(state.listMode) + 1) % LIST_MODES.length];
  const current = LIST_MODE_META[state.listMode];
  const next = LIST_MODE_META[nextMode];

  return (
    <form
      id="filterRow"
      className="widthProtect"
      onSubmit={(e) => {
        e.preventDefault();
        void store.runSearch(state.searchText);
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
          <input id="filter" type="text" aria-label="Search songs" value={state.searchText} onChange={(e) => store.setSearchText(e.target.value)} />
          <img id="apply-filter" className="btnImg" src={icon("magnifier.svg")} alt="Search" onClick={() => void store.runSearch(state.searchText)} />
        </>
      ) : (
        <LeaderPlaylistControls />
      )}
    </form>
  );
}
