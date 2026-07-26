/**
 * Read-only mirror of the playlist embedded in a followed remote display.
 * Following must not expose any local edit/project actions, but keeping the list
 * visible gives the viewer context around the currently projected song.
 */

import { useClientViewState } from "../controller/ClientViewContext";

export function ReadonlyPlaylist() {
  const state = useClientViewState();
  const playlist = state.playlist;
  const selectedIndex = playlist.findIndex((entry) => entry.songId === state.display.songId);

  if (playlist.length === 0) {
    return (
      <div className="cv-playlist-empty cv-readonly-playlist-empty">
        <p className="cv-playlist-empty-title">Remote playlist is empty</p>
      </div>
    );
  }

  return (
    <div className="cv-list-wrap cv-readonly-playlist-wrap" data-cv-list-scroll-host>
      <table className="flexy cv-playlist cv-readonly-playlist" id="list" cellSpacing={0} cellPadding={0} aria-label="Remote session playlist">
        <tbody>
          {playlist.map((entry, index) => {
            const selected = index === selectedIndex;
            return (
              <tr key={`${entry.songId}-${index}`} className={selected ? "selected" : ""} aria-current={selected ? "true" : undefined}>
                <td className="cv-song-title">
                  <span className="cv-song-label">
                    <span className="cv-title">{entry.title}</span>
                  </span>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
