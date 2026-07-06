/**
 * PlaylistEditor — the working-playlist editor shown in the options panel when
 * list mode is "playlist" (and the working playlist is editable). It reuses the
 * dark `#list` table look but makes the rows the editable working list:
 *
 *   - drag a row to REORDER it (native HTML5 DnD, like legacy updateTableFromEntries);
 *   - drag a row onto the trash bar to REMOVE it (legacy #trashCan droptarget);
 *   - tap a row to project that song;
 *   - double-click the title to edit it inline;
 *   - edit row transpose/capo with legacy-style select cells.
 *
 * Songs are ADDED from the database (SongList's add toggle); this component is
 * the reorder/remove half of the same working playlist. Native DnD matches the
 * legacy behaviour and keeps the heavyweight react-dnd library out of this
 * bundle (a Phase-C bundle-diet constraint).
 */

import { useRef, useState, type MouseEvent as ReactMouseEvent, type TouchEvent as ReactTouchEvent } from "react";
import type { SongFound } from "../api/ClientApi";
import { useClientViewState, useClientViewStore } from "../controller/ClientViewContext";
import { icon } from "./assets";
import { markerStyle, TitleCell } from "./SongList";

const SHARP = "♯";
const FLAT = "♭";
const TRANSPOSE_RANGE = Array.from({ length: 23 }, (_, i) => i - 11);
const CAPO_RANGE = Array.from({ length: 13 }, (_, i) => i - 1);
const SINGLE_CLICK_DELAY_MS = 250;

const transposeOption = (v: number) => (v === 0 ? "0" : v < 0 ? `${Math.abs(v)}${FLAT}` : `${v}${SHARP}`);
const transposeLabel = (v: number | undefined) => {
  const value = v ?? 0;
  return value === 0 ? "" : value < 0 ? `${Math.abs(value)}${FLAT}` : `${value}${SHARP}`;
};
const capoOption = (v: number) => (v >= 0 ? String(v) : "");
const capoLabel = (v: number | undefined) => {
  if (v == null) return "";
  const value = v;
  return value >= 0 ? String(value) : "";
};
export function PlaylistEditor() {
  const store = useClientViewStore();
  const state = useClientViewState();
  const playlist = state.playlist;
  const playlistFilter = state.playlistFilterText.trim();
  const playlistSearchById = new Map(state.playlistSearchResults.map((entry) => [entry.songId, entry]));
  const visibleRows = playlist
    .map((entry, index) => ({ entry, index, found: playlistSearchById.get(entry.songId) }))
    .filter(({ found }) => !playlistFilter || found);

  // Native-DnD scratch state. dragIndex is the row being dragged; overIndex
  // drives the insertion indicator; overTrash flags the trash drop target.
  const [dragIndex, setDragIndex] = useState<number | null>(null);
  const [overIndex, setOverIndex] = useState<number | null>(null);
  const [overTrash, setOverTrash] = useState(false);
  const [editingIndex, setEditingIndex] = useState<number | null>(null);
  const [editingTitle, setEditingTitle] = useState("");
  const clickTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const suppressNextRowClickRef = useRef(false);
  const selectorChangedRef = useRef(false);
  const dragging = dragIndex !== null;

  const clearClickTimer = () => {
    if (clickTimerRef.current) {
      clearTimeout(clickTimerRef.current);
      clickTimerRef.current = null;
    }
  };

  const startTitleEdit = (index: number) => {
    setEditingIndex(index);
    setEditingTitle(playlist[index]?.title ?? "");
  };

  const cancelTitleEdit = () => {
    setEditingIndex(null);
  };

  const commitTitleEdit = () => {
    if (editingIndex == null) return;
    const current = playlist[editingIndex];
    const nextTitle = editingTitle.trim();
    setEditingIndex(null);
    if (!current || !nextTitle || nextTitle === current.title) return;
    void store.updatePlaylistEntry(editingIndex, { title: nextTitle });
  };

  const reset = () => {
    setDragIndex(null);
    setOverIndex(null);
    setOverTrash(false);
  };

  // Explicit target args (not the async state) so the drop acts on what was
  // actually under the pointer at release.
  const finishDrop = (toTrash: boolean, dropIndex: number | null) => {
    if (dragIndex !== null) {
      if (toTrash) void store.removeFromPlaylist(dragIndex);
      else if (dropIndex !== null && dropIndex !== dragIndex) void store.reorderPlaylist(dragIndex, dropIndex);
    }
    reset();
  };

  const stopRowClick = (e: ReactMouseEvent | ReactTouchEvent) => {
    e.stopPropagation();
  };

  const suppressRowClickOnce = () => {
    suppressNextRowClickRef.current = true;
    window.setTimeout(() => {
      suppressNextRowClickRef.current = false;
    }, 400);
  };

  const onSelectorFocus = () => {
    selectorChangedRef.current = false;
  };

  const onSelectorBlur = () => {
    if (selectorChangedRef.current) {
      suppressNextRowClickRef.current = false;
      return;
    }
    suppressRowClickOnce();
  };

  const onSelectorPointerDown = (e: ReactMouseEvent<HTMLSelectElement>) => {
    clearClickTimer();
    e.stopPropagation();
  };

  const onSelectorClick = (e: ReactMouseEvent<HTMLSelectElement>) => {
    clearClickTimer();
    e.stopPropagation();
  };

  const onSelectorTouchEnd = (e: ReactTouchEvent<HTMLElement>) => {
    const path = e.nativeEvent.composedPath?.() || [];
    const usesNativeSelect =
      e.target instanceof HTMLSelectElement ||
      e.target instanceof HTMLOptionElement ||
      path.some((el) => el instanceof HTMLElement && (el.tagName === "SELECT" || el.tagName === "OPTION"));
    if (!usesNativeSelect) {
      // Keep row/cell touch behavior while never blocking native select opening.
      e.preventDefault();
      e.stopPropagation();
    }
  };

  if (playlist.length === 0) {
    return (
      <div className="cv-playlist-empty">
        <p className="cv-playlist-empty-title">Current playlist is empty</p>
        <p className="cv-playlist-empty-hint">Switch to the database and tap ＋ to add songs.</p>
      </div>
    );
  }

  if (visibleRows.length === 0) {
    return (
      <div className="cv-playlist-empty">
        <p className="cv-playlist-empty-title">{state.playlistSearching ? "Searching..." : "No matching songs"}</p>
        <p className="cv-playlist-empty-hint">
          {state.playlistSearching ? "Searching the current playlist." : "Clear the filter to show the full playlist."}
        </p>
      </div>
    );
  }

  return (
    <>
      <table
        className="flexy cv-playlist"
        id="list"
        cellSpacing={0}
        cellPadding={0}
        // Dragging over the empty area below the rows drops at the end.
        onDragOver={(e) => {
          if (dragging) {
            e.preventDefault();
            setOverIndex(visibleRows[visibleRows.length - 1]?.index ?? playlist.length - 1);
            setOverTrash(false);
          }
        }}
        onDrop={(e) => {
          e.preventDefault();
          finishDrop(false, visibleRows[visibleRows.length - 1]?.index ?? playlist.length - 1);
        }}
      >
        <tbody>
          {visibleRows.map(({ entry, index, found }) => {
            const transposeValue = entry.transpose ?? 0;
            const titleEntry: SongFound | typeof entry = found ? { ...entry, title: found.title || entry.title, found: found.found } : entry;
            const rowClass = [
              state.navigationMode === "playlist" && entry.songId === state.display.songId ? "selected" : "",
              index === dragIndex ? "cv-dragging" : "",
              dragging && index === overIndex && index !== dragIndex ? "cv-drag-over" : "",
            ]
              .filter(Boolean)
              .join(" ");
            return (
              <tr
                key={`${entry.songId}-${index}`}
                draggable={editingIndex == null}
                className={rowClass}
                onClick={() => {
                  if (editingIndex != null) return;
                  if (suppressNextRowClickRef.current) {
                    suppressNextRowClickRef.current = false;
                    clearClickTimer();
                    return;
                  }
                  clearClickTimer();
                  clickTimerRef.current = setTimeout(() => {
                    void store.selectPlaylistEntry(entry);
                    clickTimerRef.current = null;
                  }, SINGLE_CLICK_DELAY_MS);
                }}
                onDragStart={(e) => {
                  if (editingIndex != null) {
                    e.preventDefault();
                    return;
                  }
                  setDragIndex(index);
                  e.dataTransfer.effectAllowed = "move";
                  e.dataTransfer.setData("text/plain", String(index));
                }}
                onDragOver={(e) => {
                  if (dragging) {
                    e.preventDefault();
                    e.stopPropagation();
                    setOverIndex(index);
                    setOverTrash(false);
                  }
                }}
                onDrop={(e) => {
                  e.preventDefault();
                  e.stopPropagation();
                  finishDrop(false, index);
                }}
                onDragEnd={reset}
              >
                <td
                  className="cv-song-title"
                  onDoubleClick={(e) => {
                    e.preventDefault();
                    e.stopPropagation();
                    clearClickTimer();
                    startTitleEdit(index);
                  }}
                >
                  {editingIndex === index ? (
                    <input
                      className="cv-pl-title-edit"
                      autoFocus
                      aria-label="Edit song title"
                      value={editingTitle}
                      onChange={(e) => setEditingTitle(e.target.value)}
                      onClick={stopRowClick}
                      onDoubleClick={(e) => {
                        e.preventDefault();
                        e.stopPropagation();
                      }}
                      onBlur={commitTitleEdit}
                      onKeyDown={(e) => {
                        if (e.key === "Enter") {
                          e.preventDefault();
                          commitTitleEdit();
                        } else if (e.key === "Escape") {
                          e.preventDefault();
                          cancelTitleEdit();
                        }
                      }}
                    />
                  ) : (
                    <TitleCell entry={titleEntry} />
                  )}
                </td>
                {playlistFilter ? (
                  <td className="cv-found-marker" style={markerStyle(found?.found)} title={found?.found.type} />
                ) : (
                  <>
                    <td className="transposeColumn" onTouchEnd={onSelectorTouchEnd} onClick={stopRowClick}>
                      <span>{transposeLabel(entry.transpose)}</span>
                      {transposeValue === 0 ? <img className="cv-pl-select-icon btnImg" src={icon("transpose.svg")} alt="Transpose" /> : null}
                      <select
                        title="Transpose"
                        value={transposeValue}
                        onFocus={onSelectorFocus}
                        onBlur={onSelectorBlur}
                        onMouseDown={onSelectorPointerDown}
                        onClick={onSelectorClick}
                        onChange={(e) => {
                          selectorChangedRef.current = true;
                          suppressNextRowClickRef.current = false;
                          void store.updatePlaylistEntry(index, { transpose: Number(e.target.value) });
                        }}
                      >
                        {TRANSPOSE_RANGE.map((value) => (
                          <option key={value} value={value}>
                            {transposeOption(value)}
                          </option>
                        ))}
                      </select>
                    </td>
                    <td className="capoColumn" onTouchEnd={onSelectorTouchEnd} onClick={stopRowClick}>
                      <span>{capoLabel(entry.capo)}</span>
                      <img className="cv-pl-select-icon btnImg" src={icon("capo.svg")} alt="Capo" />
                      <select
                        title="Capo"
                        value={entry.capo ?? 0}
                        onFocus={onSelectorFocus}
                        onBlur={onSelectorBlur}
                        onMouseDown={onSelectorPointerDown}
                        onClick={onSelectorClick}
                        onChange={(e) => {
                          selectorChangedRef.current = true;
                          suppressNextRowClickRef.current = false;
                          void store.updatePlaylistEntry(index, { capo: Number(e.target.value) });
                        }}
                      >
                        {CAPO_RANGE.map((value) => (
                          <option key={value} value={value}>
                            {capoOption(value)}
                          </option>
                        ))}
                      </select>
                    </td>
                  </>
                )}
              </tr>
            );
          })}
        </tbody>
      </table>

      <div
        id="trashCan"
        className={`${dragging ? "" : "hidden"}${overTrash ? " droptarget" : ""}`}
        onDragOver={(e) => {
          if (dragging) {
            e.preventDefault();
            setOverTrash(true);
          }
        }}
        onDragEnter={() => {
          if (dragging) setOverTrash(true);
        }}
        onDragLeave={() => setOverTrash(false)}
        onDrop={(e) => {
          e.preventDefault();
          finishDrop(true, null);
        }}
      >
        <img src={icon("trashcan.svg")} alt="Remove from list" />
      </div>
    </>
  );
}
