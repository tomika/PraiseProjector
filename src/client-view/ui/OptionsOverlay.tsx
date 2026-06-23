/**
 * OptionsOverlay — the slide-in panel (#options.overlay) holding the chord
 * options, search bar and song list. Visibility is driven by the controller's
 * `optionsOpen` flag (legacy openOptions/closeOptions). The close button and
 * picking a song both return to the song view.
 */

import { useClientViewState, useClientViewStore } from "../controller/ClientViewContext";
import { isFollowerView } from "../controller/ClientViewStore";
import { icon } from "./assets";
import { LeaderPlaylistPicker } from "./LeaderPlaylistPicker";
import { OptionsBar } from "./OptionsBar";
import { PlaylistEditor } from "./PlaylistEditor";
import { SearchBar } from "./SearchBar";
import { SongList } from "./SongList";

export function OptionsOverlay() {
  const store = useClientViewStore();
  const state = useClientViewState();

  // Follower (Client mode, no control): no song browser — only the chord options
  // above and a single netdisplay button (legacy setLeader(false)).
  const follower = isFollowerView(state);
  // App mode while watching a session is also view-only (legacy ppdWatchMode): hide
  // the browser, but offer a Stop-following button instead of netdisplay (the cloud
  // App has no host /netdisplay route — that button is Client/host-served only).
  const appWatching = state.mode === "App" && state.network.status === "watching";
  const viewer = follower || appWatching;
  const canEdit = state.capabilities.canEditWorkingPlaylist;
  const editingPlaylist = canEdit && state.listMode === "playlist";
  const leaderLists = canEdit && state.listMode === "leaderlists";

  return (
    <div id="options" className={`overlay${state.optionsOpen ? " open" : ""}`}>
      <div className="overlay-content">
        <div className="options">
          {/* OptionsBar holds the chord controls plus the panel chrome: close ends
              its first row, the more-menu ends its second row. */}
          <div className="cv-options-header">
            <OptionsBar />
          </div>
          {!viewer && <SearchBar />}
        </div>
        {follower ? (
          <div className="cv-netdisplay-wrap">
            <button type="button" className="cv-netdisplay-btn" title="Open net display" onClick={() => store.openNetDisplay()}>
              <img className="cv-netdisplay-icon" src={icon("netdisplay.png")} alt="" />
              <span>Net display</span>
            </button>
          </div>
        ) : appWatching ? (
          <div className="cv-netdisplay-wrap">
            <button type="button" className="cv-netdisplay-btn" title="Stop following" onClick={() => void store.stopWatching()}>
              <img className="cv-netdisplay-icon" src={icon("stop.svg")} alt="" />
              <span>Stop following</span>
            </button>
          </div>
        ) : editingPlaylist ? (
          <PlaylistEditor />
        ) : leaderLists ? (
          <LeaderPlaylistPicker />
        ) : (
          <SongList />
        )}
      </div>
    </div>
  );
}
