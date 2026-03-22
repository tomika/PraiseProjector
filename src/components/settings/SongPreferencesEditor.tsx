import React, { useState, useEffect, useImperativeHandle, forwardRef, useCallback } from "react";
import { Leader, SongPreference } from "../../classes";
import { Song } from "../../classes/Song";
import { Database } from "../../classes/Database";
import InstructionsEditorForm from "../InstructionsEditorForm";
import { useLocalization } from "../../localization/LocalizationContext";
import { Icon, IconType } from "../../services/IconService";
import { ContextMenu, ContextMenuItem } from "../ContextMenu/ContextMenu";
import "./SongPreferencesEditor.css";

interface SongPreferencesEditorProps {
  leader: Leader | null | undefined;
  /** Optional remote leader for merge mode - shows only differing preferences with checkboxes */
  remote?: Leader | null;
}

/** Handle exposed by SongPreferencesEditor for merge operations */
export interface SongPreferencesEditorHandle {
  /** Merge checked preferences from remote to local leader */
  merge: () => void;
}

interface PreferenceRow {
  songId: string;
  song: Song;
  preference: SongPreference;
  /** In merge mode: the remote preference (if different) */
  remotePreference?: SongPreference;
  /** In merge mode: whether to use remote preference */
  checked?: boolean;
}

/**
 * If the preference's custom title is identical to the original song title it carries
 * no information — treat it as unset (empty string) for both display and saving.
 */
function normalizeTitlePref(pref: SongPreference, song: Song): SongPreference {
  if (pref.title && pref.title === song.Title) {
    const normalized = pref.clone();
    normalized.title = "";
    return normalized;
  }
  return pref;
}

const SongPreferencesEditor = forwardRef<SongPreferencesEditorHandle, SongPreferencesEditorProps>(({ leader, remote }, ref) => {
  const { t } = useLocalization();
  const [showAllSongs, setShowAllSongs] = useState(false);
  const [songFilter, setSongFilter] = useState("");
  const [rows, setRows] = useState<PreferenceRow[]>([]);
  const [selectedIndex, setSelectedIndex] = useState<number | null>(null);
  const [editingIndex, setEditingIndex] = useState<number | null>(null);
  const [editValue, setEditValue] = useState("");
  const [showInstructionsEditor, setShowInstructionsEditor] = useState(false);
  const [editingInstructions, setEditingInstructions] = useState<{
    row: PreferenceRow;
    index: number;
  } | null>(null);
  const [contextMenu, setContextMenu] = useState<{ position: { x: number; y: number }; targetIndex: number } | null>(null);

  // Merge mode state
  const isMergeMode = !!remote;

  // Expose merge function via ref
  useImperativeHandle(ref, () => ({
    merge: () => {
      if (!leader || !remote) return;
      const db = Database.getInstance();
      for (const row of rows) {
        if (row.checked && row.remotePreference) {
          const rp = row.remotePreference;
          leader.updatePreference(
            row.songId,
            { title: rp.title, transpose: rp.transpose, capo: rp.capo, type: rp.type, instructions: rp.instructions },
            db
          );
        }
      }
    },
  }));

  const updateView = useCallback(async () => {
    if (!leader) {
      setRows([]);
      return;
    }

    const db = Database.getInstance();
    const newRows: PreferenceRow[] = [];

    // Merge mode: show only preferences that differ between local and remote
    if (isMergeMode && remote) {
      const songs = db.getSongs();
      const songMap = new Map(songs.map((s) => [s.Id, s]));
      const processedIds = new Set<string>();

      // Check all preferences in both local and remote
      const checkPreference = (songId: string) => {
        if (processedIds.has(songId)) return;
        processedIds.add(songId);

        const song = songMap.get(songId);
        if (!song) return;

        const localPref = leader.getPreference(songId);
        const remotePref = remote.getPreference(songId);
        const emptyPref = new SongPreference(songId);

        const effectiveLocal = normalizeTitlePref(localPref || emptyPref, song);
        const effectiveRemote = normalizeTitlePref(remotePref || emptyPref, song);

        // Only show if they differ
        if (!effectiveLocal.equals(effectiveRemote)) {
          newRows.push({
            songId,
            song,
            preference: effectiveLocal,
            remotePreference: effectiveRemote,
            // Default: check if local is empty (take remote)
            checked: !localPref,
          });
        }
      };

      // Check preferences from both leaders
      leader.forAllSongPreference((songId) => {
        checkPreference(songId);
        return true;
      });
      remote.forAllSongPreference((songId) => {
        checkPreference(songId);
        return true;
      });

      // Sort by song title
      newRows.sort((a, b) => a.song.Title.localeCompare(b.song.Title));
      setRows(newRows);
      return;
    }

    // Normal mode
    if (showAllSongs) {
      // Show all songs with their preferences (or default empty preference)
      const filteredSongs = await db.filter(songFilter.trim(), null, true, true, true, 0);
      for (const sf of filteredSongs) {
        const raw = leader.getPreference(sf.song.Id) || new SongPreference(sf.song.Id);
        const pref = normalizeTitlePref(raw, sf.song);
        newRows.push({
          songId: sf.song.Id,
          song: sf.song,
          preference: pref,
        });
      }
    } else {
      // Show only songs that have preferences
      const songs = db.getSongs();
      const songMap = new Map(songs.map((s) => [s.Id, s]));

      leader.forAllSongPreference((songId, pref) => {
        const song = songMap.get(songId);
        if (song) {
          const normalized = normalizeTitlePref(pref, song);
          // Skip rows that only had a title identical to the original (now inactive after normalization)
          if (!normalized.isActive) return true;
          if (
            !songFilter.trim() ||
            song.Title.toLowerCase().includes(songFilter.toLowerCase()) ||
            normalized.title.toLowerCase().includes(songFilter.toLowerCase())
          ) {
            newRows.push({ songId, song, preference: normalized });
          }
        }
        return true;
      });

      // Sort by original song title
      newRows.sort((a, b) => a.song.Title.localeCompare(b.song.Title));
    }

    setRows(newRows);
  }, [leader, remote, isMergeMode, showAllSongs, songFilter]);

  // Update view when dependencies change - using a scheduled callback to avoid synchronous setState warning
  useEffect(() => {
    const timerId = setTimeout(() => {
      updateView();
    }, 0);
    return () => clearTimeout(timerId);
  }, [updateView]);

  const modifyPreference = (column: number, down: boolean, overrideIndex?: number) => {
    const idx = overrideIndex ?? selectedIndex;
    if (idx === null || !leader) return;

    const row = rows[idx];
    const pref = row.preference.clone();

    switch (column) {
      case 2: // Transpose
        pref.transpose += down ? -1 : 1;
        pref.transpose = Math.min(Math.max(-11, pref.transpose), 11);
        break;
      case 3: // Capo
        {
          // When capo is -1 (no preference / "use song default"), start from the song's
          // actual capo value so the increment doesn't collide with the normalization
          // in Leader.updatePreference (which resets capo to -1 when it matches the song default).
          let currentCapo = pref.capo;
          if (currentCapo < 0) {
            currentCapo = row.song.Capo;
          }
          currentCapo += down ? -1 : 1;
          pref.capo = Math.min(Math.max(-1, currentCapo), 11);
        }
        break;
    }

    const db = Database.getInstance();
    leader.updatePreference(
      row.songId,
      { title: pref.title, transpose: pref.transpose, capo: pref.capo, type: pref.type, instructions: pref.instructions },
      db
    );
    // Update in place so the row stays visible even when the preference temporarily
    // becomes inactive (e.g. clearing capo before setting transpose).
    setRows((prev) => {
      const next = [...prev];
      next[idx] = { ...next[idx], preference: pref };
      return next;
    });
  };

  const handleDelete = (overrideIndex?: number) => {
    const idx = overrideIndex ?? selectedIndex;
    if (idx === null || !leader) return;

    const row = rows[idx];
    const db = Database.getInstance();
    leader.updatePreference(row.songId, { title: "", transpose: 0, capo: -1, type: "", instructions: "" }, db);
    updateView();
  };

  const handleTitleEdit = (index: number, newTitle: string) => {
    if (!leader) return;

    const row = rows[index];
    const db = Database.getInstance();
    const trimmedTitle = newTitle.trim();
    // Don't store a custom title that is identical to the original song title
    const normalizedTitle = trimmedTitle === row.song.Title ? "" : trimmedTitle;
    leader.updatePreference(row.songId, { title: normalizedTitle }, db);
    const pref = row.preference.clone();
    pref.title = normalizedTitle;
    setRows((prev) => {
      const next = [...prev];
      next[index] = { ...next[index], preference: pref };
      return next;
    });
    setEditingIndex(null);
  };

  const handleInstructionsSave = (instructions: string, _storeInProfile: boolean) => {
    if (!leader || !editingInstructions) return;

    const { row, index } = editingInstructions;
    const db = Database.getInstance();

    // Always store in profile when editing from preferences editor
    leader.updatePreference(row.songId, { title: row.preference.title, instructions }, db);
    const pref = row.preference.clone();
    pref.instructions = instructions;
    setRows((prev) => {
      const next = [...prev];
      next[index] = { ...next[index], preference: pref };
      return next;
    });
    setShowInstructionsEditor(false);
    setEditingInstructions(null);
  };

  const handleInstructionsClose = () => {
    setShowInstructionsEditor(false);
    setEditingInstructions(null);
  };

  const handleContextMenu = (index: number, event: React.MouseEvent) => {
    if (isMergeMode) return;
    event.preventDefault();
    event.stopPropagation();

    const viewportHeight = window.innerHeight;
    const viewportWidth = window.innerWidth;
    const menuHeight = 280;
    const menuWidth = 260;

    let x = event.clientX;
    let y = event.clientY;

    if (y + menuHeight > viewportHeight) {
      y = Math.max(0, viewportHeight - menuHeight);
    }
    if (x + menuWidth > viewportWidth) {
      x = Math.max(0, viewportWidth - menuWidth);
    }

    setSelectedIndex(index);
    setContextMenu({ position: { x, y }, targetIndex: index });
  };

  const hideContextMenu = () => {
    setContextMenu(null);
  };

  const contextMenuItems: ContextMenuItem[] = contextMenu
    ? (() => {
        const idx = contextMenu.targetIndex;
        const currentTranspose = rows[idx]?.preference.transpose ?? 0;
        const currentCapo = rows[idx]?.preference.capo ?? -1;
        return [
          {
            label: "",
            value: "_transpose",
            customContent: (
              <>
                <i className="context-menu-icon fa fa-music" aria-hidden="true"></i>
                {t("Transpose")}
                <select
                  className="context-menu-select"
                  title="Transpose"
                  value={currentTranspose}
                  onClick={(e) => e.stopPropagation()}
                  onChange={(e) => {
                    const val = parseInt(e.target.value, 10);
                    setPreferenceField(idx, "transpose", val);
                    hideContextMenu();
                  }}
                >
                  {Array.from({ length: 23 }, (_, i) => {
                    const val = 11 - i;
                    const label = val > 0 ? `#${val}` : val < 0 ? `b${Math.abs(val)}` : "0";
                    return (
                      <option key={val} value={val}>
                        {label}
                      </option>
                    );
                  })}
                </select>
              </>
            ),
          },
          {
            label: "",
            value: "_capo",
            customContent: (
              <>
                <i className="context-menu-icon fa fa-caret-up" aria-hidden="true"></i>
                {t("Capo")}
                <select
                  className="context-menu-select"
                  title="Capo"
                  value={currentCapo}
                  onClick={(e) => e.stopPropagation()}
                  onChange={(e) => {
                    const val = parseInt(e.target.value, 10);
                    setPreferenceField(idx, "capo", val);
                    hideContextMenu();
                  }}
                >
                  <option value={-1}>-</option>
                  {Array.from({ length: 12 }, (_, i) => (
                    <option key={i} value={i}>
                      {i}
                    </option>
                  ))}
                </select>
              </>
            ),
          },
          { label: t("PlaylistEditTitle"), value: "edit", iconClass: "fa fa-pencil" },
          { label: t("PlaylistEditInstructions"), value: "instructions", iconClass: "fa fa-sticky-note-o" },
          {
            label: "",
            value: "_type_picker",
            customContent: (() => {
              const currentType = rows[contextMenu.targetIndex]?.preference.type;
              const idx = contextMenu.targetIndex;
              return (
                <>
                  <i className="context-menu-icon fa fa-heart context-menu-heart-icon" aria-hidden="true"></i>
                  <div className="context-menu-type-picker" onClick={(e) => e.stopPropagation()}>
                    <span
                      className={`type-pick${!currentType ? " active" : ""}`}
                      title="Neutral"
                      onClick={() => {
                        setPreferenceType(idx, "");
                        hideContextMenu();
                      }}
                    >
                      <Icon type={IconType.HEART_EMPTY} />
                    </span>
                    <span
                      className={`type-pick${currentType === "Preferred" ? " active" : ""}`}
                      title="Preferred"
                      onClick={() => {
                        setPreferenceType(idx, "Preferred");
                        hideContextMenu();
                      }}
                    >
                      <Icon type={IconType.HEART_FILLED} />
                    </span>
                    <span
                      className={`type-pick${currentType === "Ignore" ? " active" : ""}`}
                      title="Ignore"
                      onClick={() => {
                        setPreferenceType(idx, "Ignore");
                        hideContextMenu();
                      }}
                    >
                      <Icon type={IconType.HEART_IGNORED} />
                    </span>
                  </div>
                </>
              );
            })(),
          },
          { label: t("PlaylistRemove"), value: "delete", iconClass: "fa fa-trash" },
        ];
      })()
    : [];

  const handlePreferFromPlaylists = () => {
    if (!leader) return;
    const db = Database.getInstance();
    const scheduleDates = leader.getSchedule();
    const songIds = new Set<string>();

    for (const date of scheduleDates) {
      const playlist = leader.getPlaylist(date);
      if (playlist) {
        for (const item of playlist.items) {
          if (item.songId) songIds.add(item.songId);
        }
      }
    }

    for (const songId of songIds) {
      const pref = leader.getPreference(songId);
      if (pref?.type !== "Preferred") {
        leader.updatePreference(songId, { type: "Preferred" }, db);
      }
    }

    updateView();
  };

  const setPreferenceField = (index: number, field: "transpose" | "capo", value: number) => {
    if (!leader) return;
    const row = rows[index];
    const pref = row.preference.clone();
    if (field === "transpose") {
      pref.transpose = Math.min(Math.max(-11, value), 11);
    } else {
      pref.capo = Math.min(Math.max(-1, value), 11);
    }
    const db = Database.getInstance();
    leader.updatePreference(
      row.songId,
      { title: pref.title, transpose: pref.transpose, capo: pref.capo, type: pref.type, instructions: pref.instructions },
      db
    );
    setRows((prev) => {
      const next = [...prev];
      next[index] = { ...next[index], preference: pref };
      return next;
    });
  };

  const setPreferenceType = (index: number, newType: "Preferred" | "Ignore" | "") => {
    if (!leader) return;
    const row = rows[index];
    const pref = row.preference.clone();
    pref.type = newType || undefined;
    const db = Database.getInstance();
    leader.updatePreference(
      row.songId,
      { title: pref.title, transpose: pref.transpose, capo: pref.capo, type: newType, instructions: pref.instructions },
      db
    );
    setRows((prev) => {
      const next = [...prev];
      next[index] = { ...next[index], preference: pref };
      return next;
    });
  };

  const cyclePreferenceType = (index: number) => {
    const row = rows[index];
    const newType: "Preferred" | "Ignore" | "" = row.preference.type === "Preferred" ? "Ignore" : row.preference.type === "Ignore" ? "" : "Preferred";
    setPreferenceType(index, newType);
  };

  const getRowClassName = (pref: SongPreference): string => {
    return pref.isActive ? "" : "text-muted";
  };

  // Handle checkbox change in merge mode
  const handleMergeCheckChange = (index: number, checked: boolean) => {
    setRows((prevRows) => {
      const newRows = [...prevRows];
      newRows[index] = { ...newRows[index], checked };
      // Update displayed preference based on checked state
      if (checked && newRows[index].remotePreference) {
        newRows[index].preference = newRows[index].remotePreference!;
      } else if (!checked && leader) {
        const localPref = leader.getPreference(newRows[index].songId);
        newRows[index].preference = localPref || new SongPreference(newRows[index].songId);
      }
      return newRows;
    });
  };

  // Format preference summary for merge mode display
  const formatPreferenceSummary = (pref: SongPreference): string => {
    const parts: string[] = [];
    if (pref.title) parts.push(`"${pref.title}"`);
    if (pref.transpose !== 0) parts.push(`Tr:${pref.formatTranspose()}`);
    if (pref.capo >= 0) parts.push(`Capo:${pref.capo}`);
    if (pref.type != null) parts.push(`Type:${pref.type}`);
    if (pref.instructions) parts.push("📋");
    return parts.length > 0 ? parts.join(" ") : "(empty)";
  };

  return (
    <fieldset className="border p-2 mt-3" disabled={!leader}>
      {leader ? (
        <div className="d-flex flex-column flex-grow-1 song-preferences-inner">
          {/* Hide filter controls in merge mode - matching C# behavior */}
          {!isMergeMode && (
            <>
              <div className="d-flex align-items-center mb-1 flex-nowrap justify-content-between">
                <div className="form-check mr-2">
                  <input
                    className="form-check-input"
                    type="checkbox"
                    id="showAllSongs"
                    checked={showAllSongs}
                    onChange={(e) => setShowAllSongs(e.target.checked)}
                  />
                  <label className="form-check-label" htmlFor="showAllSongs">
                    {t("ShowAllSongs")}
                  </label>
                </div>
                <button
                  className="btn btn-outline-danger btn-xs pref-from-playlist-btn"
                  onClick={handlePreferFromPlaylists}
                  title="Mark all songs from playlists as preferred"
                >
                  &#x2764; {t("PreferFromPlaylists")}
                </button>
              </div>
              <div className="d-flex align-items-center mb-2">
                <label htmlFor="songFilter" className="mr-2">
                  {t("Filter")}
                </label>
                <input
                  type="text"
                  className="form-control flex-grow-1"
                  id="songFilter"
                  value={songFilter}
                  onChange={(e) => setSongFilter(e.target.value)}
                />
                <button className="btn btn-outline-secondary ml-2" onClick={() => setSongFilter("")}>
                  ✕
                </button>
              </div>
            </>
          )}
          <div className="d-flex flex-row flex-grow-1 song-preferences-editor-container">
            {/* Hide edit buttons in merge mode - matching C# behavior */}
            {!isMergeMode && (
              <div className="btn-group-vertical song-pref-buttons mr-2">
                <button
                  className="btn btn-light"
                  title="Edit Title"
                  disabled={selectedIndex === null}
                  onClick={() => {
                    if (selectedIndex !== null) {
                      setEditingIndex(selectedIndex);
                      setEditValue(rows[selectedIndex].preference.title);
                    }
                  }}
                >
                  <Icon type={IconType.EDIT} />
                </button>
                <button
                  className="btn btn-light"
                  title="Transpose Up (Ctrl+T)"
                  disabled={selectedIndex === null}
                  onClick={() => modifyPreference(2, false)}
                >
                  <Icon type={IconType.TRANSPOSE_UP} />
                </button>
                <button
                  className="btn btn-light"
                  title="Transpose Down (Ctrl+Shift+T)"
                  disabled={selectedIndex === null}
                  onClick={() => modifyPreference(2, true)}
                >
                  <Icon type={IconType.TRANSPOSE_DOWN} />
                </button>
                <button
                  className="btn btn-light"
                  title="Capo Up (Ctrl+C)"
                  disabled={selectedIndex === null}
                  onClick={() => modifyPreference(3, false)}
                >
                  <Icon type={IconType.CAPO_UP} />
                </button>
                <button
                  className="btn btn-light"
                  title="Capo Down (Ctrl+Shift+C)"
                  disabled={selectedIndex === null}
                  onClick={() => modifyPreference(3, true)}
                >
                  <Icon type={IconType.CAPO_DOWN} />
                </button>
                <button className="btn btn-light" title="Delete Preference" disabled={selectedIndex === null} onClick={() => handleDelete()}>
                  <Icon type={IconType.REMOVE} />
                </button>
              </div>
            )}
            <div className="flex-grow-1 overflow-auto song-preferences-table-container">
              <table className="table table-sm table-hover song-preferences-table">
                <thead>
                  <tr>
                    {isMergeMode && <th className="merge-checkbox-col"></th>}
                    <th>{t("Title")}</th>
                    <th>{t("OriginalTitle")}</th>
                    <th>{t("TransposeShort")}</th>
                    <th>{t("CapoShort")}</th>
                    <th className="text-center">{t("InstructionsShort")}</th>
                    <th className="text-center">♥️</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((row, index) => (
                    <tr
                      key={row.songId}
                      className={`${selectedIndex === index ? "table-active" : ""} ${getRowClassName(row.preference)}`}
                      onClick={() => setSelectedIndex(index)}
                      onContextMenu={(e) => handleContextMenu(index, e)}
                    >
                      {isMergeMode && (
                        <td>
                          <input
                            type="checkbox"
                            checked={row.checked || false}
                            onChange={(e) => handleMergeCheckChange(index, e.target.checked)}
                            onClick={(e) => e.stopPropagation()}
                            title={`Local: ${formatPreferenceSummary(leader.getPreference(row.songId) || new SongPreference(row.songId))}\nRemote: ${formatPreferenceSummary(row.remotePreference || new SongPreference(row.songId))}`}
                          />
                        </td>
                      )}
                      <td
                        onDoubleClick={() => {
                          if (!isMergeMode) {
                            setEditingIndex(index);
                            setEditValue(row.preference.title);
                          }
                        }}
                      >
                        {editingIndex === index && !isMergeMode ? (
                          <input
                            type="text"
                            className="form-control form-control-sm"
                            value={editValue}
                            onChange={(e) => setEditValue(e.target.value)}
                            onBlur={() => handleTitleEdit(index, editValue)}
                            onKeyDown={(e) => {
                              if (e.key === "Enter") {
                                handleTitleEdit(index, editValue);
                              } else if (e.key === "Escape") {
                                setEditingIndex(null);
                              }
                            }}
                            autoFocus
                            aria-label="Song Title"
                          />
                        ) : (
                          row.preference.title || ""
                        )}
                      </td>
                      <td>{row.song.Title}</td>
                      <td>{row.preference.formatTranspose()}</td>
                      <td>{row.preference.formatCapo()}</td>
                      <td
                        className="instructions-cell"
                        onDoubleClick={(e) => {
                          e.stopPropagation();
                          if (!isMergeMode) {
                            setEditingInstructions({ row, index });
                            setShowInstructionsEditor(true);
                          }
                        }}
                      >
                        {row.preference.instructions ? "🗹" : ""}
                      </td>
                      <td
                        className={isMergeMode ? "pref-mode-cell-readonly" : "pref-mode-cell"}
                        title={isMergeMode ? undefined : "Click to cycle: Neutral → Preferred → Ignore"}
                        onClick={(e) => {
                          e.stopPropagation();
                          if (!isMergeMode) cyclePreferenceType(index);
                        }}
                      >
                        <Icon
                          type={
                            row.preference.type === "Preferred"
                              ? IconType.HEART_FILLED
                              : row.preference.type === "Ignore"
                                ? IconType.HEART_IGNORED
                                : IconType.HEART_EMPTY
                          }
                        />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        </div>
      ) : (
        <p>{t("SelectLeaderToEditPreferences")}</p>
      )}
      {contextMenu && (
        <ContextMenu
          items={contextMenuItems}
          position={contextMenu.position}
          onSelect={(value) => {
            const idx = contextMenu.targetIndex;
            setSelectedIndex(idx);
            if (value.startsWith("transpose_set:")) {
              const newVal = parseInt(value.split(":")[1], 10);
              setPreferenceField(idx, "transpose", newVal);
            } else if (value.startsWith("capo_set:")) {
              const newVal = parseInt(value.split(":")[1], 10);
              setPreferenceField(idx, "capo", newVal);
            } else
              switch (value) {
                case "edit":
                  setEditingIndex(idx);
                  setEditValue(rows[idx].preference.title);
                  break;
                case "instructions":
                  setEditingInstructions({ row: rows[idx], index: idx });
                  setShowInstructionsEditor(true);
                  break;
                case "delete":
                  handleDelete(idx);
                  break;
              }
          }}
          onClose={hideContextMenu}
        />
      )}
      {showInstructionsEditor && editingInstructions && (
        <InstructionsEditorForm
          song={editingInstructions.row.song}
          initialInstructions={editingInstructions.row.preference.instructions}
          isInProfile={true}
          onSave={handleInstructionsSave}
          onClose={handleInstructionsClose}
        />
      )}
    </fieldset>
  );
});

SongPreferencesEditor.displayName = "SongPreferencesEditor";

export default SongPreferencesEditor;
