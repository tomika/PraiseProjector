/**
 * SongList — the database/search table (#list). Shows search results while
 * filtering, the full database otherwise. Mirrors the legacy search-result row:
 *
 *   [✓ add]  Title (matching excerpt…)  [found-type marker]  [▶ play]
 *
 *  - the add CHECKBOX toggles the working playlist (when editable);
 *  - a TITLE match renders the highlighted snippet as the title; any other match
 *    (lyrics/meta/header/words) shows the plain title PLUS the matching excerpt,
 *    so a hit outside the title is still visible (was missing before);
 *  - the found-type MARKER (found_<type>[_words].svg) shows WHERE it matched;
 *  - clicking the row projects it in database/filter navigation mode;
 *  - the ▶ PLAY button adds the song (if editable) and projects it in playlist-navigation mode.
 */

import { useClientViewState, useClientViewStore } from "../controller/ClientViewContext";
import { notPhraseFoundAdditionalCost } from "../../../common/pp-utils";
import type { SongEntry, SongFound } from "../api/ClientApi";
import { icon } from "./assets";

type Found = SongFound["found"];

const foundOf = (entry: SongEntry | SongFound): Found | undefined => ("found" in entry ? entry.found : undefined);

/** Background for the found-type marker cell: found_<type>[_words].svg, where the
 *  `_words` variant marks a non-phrase (per-word) match. Mirrors praiseprojector.ts. */
export function markerStyle(found: Found | undefined): React.CSSProperties | undefined {
  if (!found || found.cost < 0 || found.type === "NONE") return undefined;
  const words = found.cost >= notPhraseFoundAdditionalCost ? "_words" : "";
  return { backgroundImage: `url("${icon(`found_${found.type.toLowerCase()}${words}.svg`)}")` };
}

/** The title cell content: the highlighted snippet for a title match, otherwise
 *  the plain title plus the matching excerpt in parentheses. The snippet carries
 *  server `<mark>` highlights, rendered as HTML like the desktop SongListPanel. */
const stripTags = (html: string) => html.replace(/<[^>]*>/g, "");
const normalize = (text: string) => text.replace(/\s+/g, " ").trim().toLowerCase();

export function TitleCell({ entry }: { entry: SongEntry | SongFound }) {
  const found = foundOf(entry);
  const snippet = found?.snippet;
  // Render the (highlighted) snippet AS the title when it is a title match — OR
  // when the snippet is merely the title again (some backends return the title as
  // the snippet for non-title hits; showing it in parens just duplicated it). Any
  // genuine excerpt (lyrics/meta/header), i.e. text other than the title, is shown
  // after the plain title so a hit outside the title stays visible.
  const snippetIsTitle = !!snippet && normalize(stripTags(snippet)) === normalize(entry.title);
  if (snippet && (found.type === "TITLE" || snippetIsTitle)) {
    return <span className="cv-song-label cv-title" dangerouslySetInnerHTML={{ __html: snippet }} />;
  }
  return (
    <span className="cv-song-label">
      <span className="cv-title">{entry.title}</span>
      {snippet && (
        <span className="cv-snippet">
          {" ("}
          <span dangerouslySetInnerHTML={{ __html: snippet }} />
          {")"}
        </span>
      )}
    </span>
  );
}

export function SongList() {
  const store = useClientViewStore();
  const state = useClientViewState();

  const usingSearch = state.searchText.trim().length > 0;
  const rows: Array<SongEntry | SongFound> = usingSearch
    ? state.searching && state.searchResults.length === 0
      ? state.songs
      : state.searchResults
    : state.songs;
  const canEdit = state.capabilities.canEditWorkingPlaylist;
  const inPlaylist = new Set(state.playlist.map((entry) => entry.songId));
  const columnCount = 2 + (canEdit ? 1 : 0) + (usingSearch ? 1 : 0);

  return (
    <div className="cv-list-wrap">
      <table className="cv-database" id="list" cellSpacing={0} cellPadding={0}>
        <tbody>
          {usingSearch && !state.searching && rows.length === 0 && (
            <tr className="cv-list-status-row">
              <td colSpan={columnCount}>No matching songs</td>
            </tr>
          )}
          {rows.map((entry) => {
            const added = inPlaylist.has(entry.songId);
            const selectedMode = usingSearch ? "filter" : "database";
            return (
              <tr
                key={entry.songId}
                className={`${state.navigationMode === selectedMode && entry.songId === state.display.songId ? "selected" : ""}${state.optionsOpen && entry.songId === state.hotkeySongId ? " cv-hotkey-row" : ""}`}
                onClick={() => void (usingSearch ? store.selectFilteredSong(entry.songId) : store.selectDatabaseSong(entry.songId))}
              >
                {canEdit && (
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
                )}
                <td className="cv-song-title">
                  <TitleCell entry={entry} />
                </td>
                {usingSearch && <td className="cv-found-marker" style={markerStyle(foundOf(entry))} title={foundOf(entry)?.type} />}
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
      {usingSearch && state.searching && (
        <div className="cv-list-search-overlay" role="status" aria-label="Searching">
          <span className="cv-list-search-spinner" aria-hidden="true" />
        </div>
      )}
    </div>
  );
}
