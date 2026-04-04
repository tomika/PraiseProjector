import React, { useState, useEffect, useRef } from "react";
import { Leader } from "../../db-common/Leader";
import { SongPreference } from "../../db-common/SongPreference";
import { Playlist } from "../../db-common/Playlist";
import { PlaylistEntry } from "../../db-common/PlaylistEntry";
import { Database } from "../../db-common/Database";
import { Icon, IconType } from "../services/IconService";
import { useLocalization } from "../localization/LocalizationContext";
import "./LeaderDataMergeDialog.css";

interface PreferenceConflict {
  songId: string;
  songTitle: string;
  localPref: SongPreference | null;
  remotePref: SongPreference | null;
  useRemote: boolean;
}

interface ScheduleConflict {
  date: Date;
  localPlaylist: Playlist | null;
  remotePlaylist: Playlist | null;
  useRemote: boolean;
}

interface LeaderDataMergeDialogProps {
  localLeader: Leader;
  remoteLeader: Leader;
  onSave: (mergedLeader: Leader) => void;
  onCancel: () => void;
  /** Custom label for the "local" side (defaults to localized "Local") */
  localLabel?: string;
  /** Custom label for the "remote" side (defaults to localized "Remote") */
  remoteLabel?: string;
  /** Read-only compare mode: hides decision actions and save button */
  readOnly?: boolean;
  /** Optional default side for conflicts: when true, preselect remote side. */
  preferRemoteByDefault?: boolean;
}

// Interface for hover popup state
interface HoverPopupState {
  conflictIndex: number;
  x: number;
  y: number;
}

const LeaderDataMergeDialog: React.FC<LeaderDataMergeDialogProps> = ({
  localLeader,
  remoteLeader,
  onSave,
  onCancel,
  localLabel,
  remoteLabel,
  readOnly = false,
  preferRemoteByDefault = false,
}) => {
  const { t } = useLocalization();
  const effectiveLocalLabel = localLabel || t("LeaderMergeLocal");
  const effectiveRemoteLabel = remoteLabel || t("LeaderMergeRemote");
  const dialogRef = useRef<HTMLDivElement>(null);
  const [preferenceConflicts, setPreferenceConflicts] = useState<PreferenceConflict[]>([]);
  const [scheduleConflicts, setScheduleConflicts] = useState<ScheduleConflict[]>([]);
  const [isDragging, setIsDragging] = useState(false);
  const [dragOffset, setDragOffset] = useState({ x: 0, y: 0 });
  const [isMobile, setIsMobile] = useState(false);
  const [isMaximized, setIsMaximized] = useState(false);

  // Track single expanded schedule conflict (by date timestamp, null = none expanded)
  const [expandedSchedule, setExpandedSchedule] = useState<number | null>(null);

  // Track hover popup for schedule conflicts
  const [hoverPopup, setHoverPopup] = useState<HoverPopupState | null>(null);
  const hoverTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    const checkMobile = () => {
      setIsMobile(window.innerWidth <= 768);
    };

    checkMobile();
    window.addEventListener("resize", checkMobile);

    return () => window.removeEventListener("resize", checkMobile);
  }, []);

  useEffect(() => {
    if (!dialogRef.current || isMobile || isMaximized) return;

    const centerDialog = () => {
      const dialog = dialogRef.current;
      if (!dialog) return;

      const windowWidth = window.innerWidth;
      const windowHeight = window.innerHeight;
      const dialogWidth = dialog.offsetWidth;
      const dialogHeight = dialog.offsetHeight;

      dialog.style.left = `${Math.max(0, (windowWidth - dialogWidth) / 2)}px`;
      dialog.style.top = `${Math.max(0, (windowHeight - dialogHeight) / 2)}px`;
    };

    centerDialog();
    window.addEventListener("resize", centerDialog);

    return () => window.removeEventListener("resize", centerDialog);
  }, [isMobile, isMaximized]);

  const handleMouseDown = (e: React.MouseEvent) => {
    if (isMobile || isMaximized || !dialogRef.current) return;

    const rect = dialogRef.current.getBoundingClientRect();
    setDragOffset({
      x: e.clientX - rect.left,
      y: e.clientY - rect.top,
    });
    setIsDragging(true);
  };

  useEffect(() => {
    if (!isDragging || isMobile || isMaximized) return;

    const handleMouseMove = (e: MouseEvent) => {
      if (!dialogRef.current) return;

      const newLeft = e.clientX - dragOffset.x;
      const newTop = e.clientY - dragOffset.y;

      const maxLeft = window.innerWidth - dialogRef.current.offsetWidth;
      const maxTop = window.innerHeight - dialogRef.current.offsetHeight;

      dialogRef.current.style.left = `${Math.max(0, Math.min(maxLeft, newLeft))}px`;
      dialogRef.current.style.top = `${Math.max(0, Math.min(maxTop, newTop))}px`;
    };

    const handleMouseUp = () => {
      setIsDragging(false);
    };

    document.addEventListener("mousemove", handleMouseMove);
    document.addEventListener("mouseup", handleMouseUp);

    return () => {
      document.removeEventListener("mousemove", handleMouseMove);
      document.removeEventListener("mouseup", handleMouseUp);
    };
  }, [isDragging, dragOffset, isMobile, isMaximized]);

  const toggleScheduleExpanded = (dateTs: number) => {
    setExpandedSchedule((prev) => (prev === dateTs ? null : dateTs));
  };

  const isScheduleExpanded = (dateTs: number) => {
    return expandedSchedule === dateTs;
  };

  // Initialize conflicts on mount
  useEffect(() => {
    const initConflicts = async () => {
      const db = Database.getInstance();

      // Find preference conflicts
      const prefConflicts: PreferenceConflict[] = [];
      const processedSongIds = new Set<string>();

      // Check local preferences
      localLeader.forAllSongPreference((songId, localPref) => {
        processedSongIds.add(songId);
        const remotePref = remoteLeader.getPreference(songId);

        // Only add if there's a difference
        if (!remotePref || !localPref.equals(remotePref)) {
          const song = db.getSong(songId);
          prefConflicts.push({
            songId,
            songTitle: song?.Title || songId,
            localPref: localPref.clone(),
            remotePref: remotePref?.clone() || null,
            useRemote: preferRemoteByDefault,
          });
        }
        return true;
      });

      // Check remote preferences not in local
      remoteLeader.forAllSongPreference((songId, remotePref) => {
        if (!processedSongIds.has(songId)) {
          const song = db.getSong(songId);
          prefConflicts.push({
            songId,
            songTitle: song?.Title || songId,
            localPref: null,
            remotePref: remotePref.clone(),
            useRemote: true, // Default to remote if local doesn't have it
          });
        }
        return true;
      });

      // Sort by song title
      prefConflicts.sort((a, b) => a.songTitle.localeCompare(b.songTitle));
      setPreferenceConflicts(prefConflicts);

      // Find schedule conflicts
      const schedConflicts: ScheduleConflict[] = [];
      const processedDates = new Set<number>();

      const localDates = localLeader.getSchedule();
      const remoteDates = remoteLeader.getSchedule();

      // Build a map of remote dates by timestamp for efficient lookup
      const remoteDateMap = new Map<number, Date>();
      for (const rd of remoteDates) {
        remoteDateMap.set(rd.getTime(), rd);
      }

      for (const date of localDates) {
        processedDates.add(date.getTime());
        const localPlaylist = localLeader.getPlaylist(date);

        // Find matching remote date by timestamp, then get playlist
        const matchingRemoteDate = remoteDateMap.get(date.getTime());
        const remotePlaylist = matchingRemoteDate ? remoteLeader.getPlaylist(matchingRemoteDate) : null;

        // Check if playlists differ
        const localStr = localPlaylist?.toString() || "";
        const remoteStr = remotePlaylist?.toString() || "";

        if (localStr !== remoteStr) {
          schedConflicts.push({
            date,
            localPlaylist: localPlaylist?.clone() || null,
            remotePlaylist: remotePlaylist?.clone() || null,
            useRemote: preferRemoteByDefault,
          });
        }
      }

      // Check remote dates not in local
      for (const date of remoteDates) {
        if (!processedDates.has(date.getTime())) {
          const remotePlaylist = remoteLeader.getPlaylist(date);
          schedConflicts.push({
            date,
            localPlaylist: null,
            remotePlaylist: remotePlaylist?.clone() || null,
            useRemote: true,
          });
        }
      }

      // Sort by date
      schedConflicts.sort((a, b) => a.date.getTime() - b.date.getTime());
      setScheduleConflicts(schedConflicts);
    };

    initConflicts();
  }, [localLeader, remoteLeader, preferRemoteByDefault]);

  const handlePreferenceToggle = (index: number) => {
    setPreferenceConflicts((prev) => {
      const updated = [...prev];
      updated[index] = { ...updated[index], useRemote: !updated[index].useRemote };
      return updated;
    });
  };

  const handleScheduleToggle = (index: number) => {
    setScheduleConflicts((prev) => {
      const updated = [...prev];
      updated[index] = { ...updated[index], useRemote: !updated[index].useRemote };
      return updated;
    });
  };

  const handleSelectAllLocal = () => {
    setPreferenceConflicts((prev) => prev.map((c) => ({ ...c, useRemote: false })));
    setScheduleConflicts((prev) => prev.map((c) => ({ ...c, useRemote: false })));
  };

  const handleSelectAllRemote = () => {
    setPreferenceConflicts((prev) => prev.map((c) => ({ ...c, useRemote: true })));
    setScheduleConflicts((prev) => prev.map((c) => ({ ...c, useRemote: true })));
  };

  const handleSave = async () => {
    const db = Database.getInstance();

    // Clone local leader and apply selected changes
    const mergedLeader = localLeader.clone();

    // Apply preference changes
    for (const conflict of preferenceConflicts) {
      if (conflict.useRemote && conflict.remotePref) {
        mergedLeader.updatePreference(
          conflict.songId,
          {
            title: conflict.remotePref.title,
            transpose: conflict.remotePref.transpose,
            capo: conflict.remotePref.capo,
            type: conflict.remotePref.type,
            instructions: conflict.remotePref.instructions,
          },
          db
        );
      }
    }

    // Apply schedule changes
    for (const conflict of scheduleConflicts) {
      if (conflict.useRemote && conflict.remotePlaylist) {
        mergedLeader.addPlaylist(conflict.date, conflict.remotePlaylist, false, db);
      }
    }

    // Update version if all remote is selected
    const allPrefsRemote = preferenceConflicts.every((c) => c.useRemote);
    const allSchedRemote = scheduleConflicts.every((c) => c.useRemote);
    if (allPrefsRemote && allSchedRemote) {
      mergedLeader.version = remoteLeader.version;
    }

    onSave(mergedLeader);
  };

  const renderPreferenceValueCells = (pref: SongPreference | null, beginStyle: string, endStyle: string): React.ReactNode => {
    if (!pref) {
      return (
        <>
          <td className={`col-pref-value ${beginStyle}`}>—</td>
          <td className="col-pref-value">—</td>
          <td className="col-pref-value">—</td>
          <td className="col-pref-value">—</td>
          <td className={`col-pref-value ${endStyle}`}>—</td>
        </>
      );
    }

    return (
      <>
        <td className={`col-pref-value col-pref-title ${beginStyle}`} title={pref.title || undefined}>
          {pref.title || "—"}
        </td>
        <td className="col-pref-value">{pref.formatTranspose() || "—"}</td>
        <td className="col-pref-value">{pref.formatCapo() || "—"}</td>
        <td className="col-pref-value">{pref.type || "—"}</td>
        <td className={`col-pref-value ${endStyle}`}>{pref.instructions ? <Icon type={IconType.CHECKBOX_CHECKED} /> : "—"}</td>
      </>
    );
  };

  // Get indices of rows that are different between two playlists (max 3, plus hasMore flag)
  const getDifferentIndices = (localPlaylist: Playlist | null, remotePlaylist: Playlist | null): { indices: number[]; hasMore: boolean } => {
    const localItems = localPlaylist?.items || [];
    const remoteItems = remotePlaylist?.items || [];
    const maxLen = Math.max(localItems.length, remoteItems.length);
    const differentIndices: number[] = [];

    for (let idx = 0; idx < maxLen; idx++) {
      const localEntry = localItems[idx];
      const remoteEntry = remoteItems[idx];

      // Check if row is different
      if (!localEntry || !remoteEntry) {
        // One side doesn't have this row
        differentIndices.push(idx);
      } else if (localEntry.songId !== remoteEntry.songId) {
        // Different songs at same position
        differentIndices.push(idx);
      } else if (
        localEntry.transpose !== remoteEntry.transpose ||
        localEntry.capo !== remoteEntry.capo ||
        (localEntry.instructions || "") !== (remoteEntry.instructions || "")
      ) {
        // Same song but different settings
        differentIndices.push(idx);
      }

      if (differentIndices.length > 3) break;
    }

    const hasMore = differentIndices.length > 3;
    return {
      indices: differentIndices.slice(0, 3),
      hasMore,
    };
  };

  // Handle mouse enter on schedule row - show popup after delay
  const handleRowMouseEnter = (index: number, event: React.MouseEvent<HTMLTableRowElement>) => {
    // Don't show popup if row is expanded
    const conflict = scheduleConflicts[index];
    if (conflict && isScheduleExpanded(conflict.date.getTime())) return;

    // Clear any existing timeout
    if (hoverTimeoutRef.current) {
      clearTimeout(hoverTimeoutRef.current);
    }

    const rect = event.currentTarget.getBoundingClientRect();
    hoverTimeoutRef.current = setTimeout(() => {
      setHoverPopup({
        conflictIndex: index,
        x: rect.left,
        y: rect.bottom + 4,
      });
    }, 400); // 400ms delay before showing popup
  };

  // Handle mouse leave on schedule row - hide popup
  const handleRowMouseLeave = () => {
    if (hoverTimeoutRef.current) {
      clearTimeout(hoverTimeoutRef.current);
      hoverTimeoutRef.current = null;
    }
    setHoverPopup(null);
  };

  // Render the hover popup with side-by-side diff view
  const renderHoverPopup = (): React.ReactNode => {
    if (!hoverPopup) return null;

    const conflict = scheduleConflicts[hoverPopup.conflictIndex];
    if (!conflict) return null;

    const localItems = conflict.localPlaylist?.items || [];
    const remoteItems = conflict.remotePlaylist?.items || [];
    const { indices, hasMore } = getDifferentIndices(conflict.localPlaylist, conflict.remotePlaylist);

    if (indices.length === 0) return null;

    // Match SongPreference.formatTranspose() - use # for sharp, b for flat
    const formatTranspose = (val: number) => {
      if (val === 0) return "—";
      return val > 0 ? `#${val}` : `b${Math.abs(val)}`;
    };
    const formatCapo = (val: number) => (val >= 0 ? `${val}` : "—");

    return (
      <div
        className="playlist-hover-popup"
        style={{ left: hoverPopup.x, top: hoverPopup.y }}
        onMouseEnter={() => {
          // Keep popup visible when mouse enters it
          if (hoverTimeoutRef.current) {
            clearTimeout(hoverTimeoutRef.current);
            hoverTimeoutRef.current = null;
          }
        }}
        onMouseLeave={handleRowMouseLeave}
      >
        <div className="playlist-comparison playlist-comparison-popup">
          <div className="playlist-comparison-header">
            <div className="playlist-comparison-side">{effectiveLocalLabel}</div>
            <div className="playlist-comparison-side">{effectiveRemoteLabel}</div>
          </div>
          <div className="playlist-comparison-body">
            {/* Local side */}
            <div className="playlist-comparison-panel">
              <table className="table table-sm playlist-entries-table mb-0">
                <tbody>
                  {indices.map((idx) => {
                    const entry = localItems[idx];
                    if (!entry) {
                      return (
                        <tr key={idx} className="entry-diff-not-exists">
                          <td className="col-entry-num">{idx + 1}</td>
                          <td className="col-entry-title">—</td>
                          <td className="col-entry-transpose">—</td>
                          <td className="col-entry-capo">—</td>
                          <td className="col-entry-instr">—</td>
                        </tr>
                      );
                    }
                    const diffStatus = getEntryDiffStatus(entry, idx, remoteItems);
                    const fieldDiff = getFieldDiffClasses(entry, idx, remoteItems);
                    return (
                      <tr key={idx} className={`entry-diff-${diffStatus}`}>
                        <td className="col-entry-num">{idx + 1}</td>
                        <td className="col-entry-title" title={entry.title}>
                          {entry.title || entry.songId}
                        </td>
                        <td className={`col-entry-transpose ${fieldDiff.transpose}`}>{formatTranspose(entry.transpose)}</td>
                        <td className={`col-entry-capo ${fieldDiff.capo}`}>{formatCapo(entry.capo)}</td>
                        <td className={`col-entry-instr ${fieldDiff.instructions}`}>
                          {entry.instructions ? <Icon type={IconType.CHECKBOX_CHECKED} /> : "—"}
                        </td>
                      </tr>
                    );
                  })}
                  {hasMore && (
                    <tr className="more-rows-indicator">
                      <td colSpan={5} className="text-center text-muted">
                        ...
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
            {/* Remote side */}
            <div className="playlist-comparison-panel">
              <table className="table table-sm playlist-entries-table mb-0">
                <tbody>
                  {indices.map((idx) => {
                    const entry = remoteItems[idx];
                    if (!entry) {
                      return (
                        <tr key={idx} className="entry-diff-not-exists">
                          <td className="col-entry-num">{idx + 1}</td>
                          <td className="col-entry-title">—</td>
                          <td className="col-entry-transpose">—</td>
                          <td className="col-entry-capo">—</td>
                          <td className="col-entry-instr">—</td>
                        </tr>
                      );
                    }
                    const diffStatus = getEntryDiffStatus(entry, idx, localItems);
                    const fieldDiff = getFieldDiffClasses(entry, idx, localItems);
                    return (
                      <tr key={idx} className={`entry-diff-${diffStatus}`}>
                        <td className="col-entry-num">{idx + 1}</td>
                        <td className="col-entry-title" title={entry.title}>
                          {entry.title || entry.songId}
                        </td>
                        <td className={`col-entry-transpose ${fieldDiff.transpose}`}>{formatTranspose(entry.transpose)}</td>
                        <td className={`col-entry-capo ${fieldDiff.capo}`}>{formatCapo(entry.capo)}</td>
                        <td className={`col-entry-instr ${fieldDiff.instructions}`}>
                          {entry.instructions ? <Icon type={IconType.CHECKBOX_CHECKED} /> : "—"}
                        </td>
                      </tr>
                    );
                  })}
                  {hasMore && (
                    <tr className="more-rows-indicator">
                      <td colSpan={5} className="text-center text-muted">
                        ...
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
          </div>
        </div>
      </div>
    );
  };

  // Render playlist song count (without expand button)
  const renderPlaylistCount = (playlist: Playlist | null, isSelected: boolean): React.ReactNode => {
    if (!playlist) {
      return <span className={`merge-value ${isSelected ? "selected" : "unselected"}`}>—</span>;
    }

    return (
      <span className={`merge-value ${isSelected ? "selected" : "unselected"}`}>
        {playlist.items.length} {t("LeaderMergeSongCount").toLowerCase()}
      </span>
    );
  };

  // Determine the difference status of a playlist entry compared to the other side
  type EntryDiffStatus = "same" | "not-exists" | "different-position" | "different-settings";

  const getEntryDiffStatus = (entry: PlaylistEntry, index: number, otherItems: PlaylistEntry[]): EntryDiffStatus => {
    // Check if same song exists at same position with same settings
    const otherAtSameIndex = otherItems[index];
    if (otherAtSameIndex && otherAtSameIndex.songId === entry.songId) {
      // Same position - check if settings differ
      if (
        otherAtSameIndex.transpose !== entry.transpose ||
        otherAtSameIndex.capo !== entry.capo ||
        (otherAtSameIndex.instructions || "") !== (entry.instructions || "")
      ) {
        return "different-settings";
      }
      return "same";
    }

    // Check if song exists anywhere else in the other list
    const existsElsewhere = otherItems.some((other) => other.songId === entry.songId);
    if (existsElsewhere) {
      return "different-position";
    }

    // Song doesn't exist on the other side
    return "not-exists";
  };

  // Get field-level diff classes for a playlist entry compared to the matching entry on the other side
  const getFieldDiffClasses = (
    entry: PlaylistEntry,
    index: number,
    otherItems: PlaylistEntry[]
  ): { transpose: string; capo: string; instructions: string } => {
    const result = { transpose: "", capo: "", instructions: "" };

    // Find the matching entry (same song at same position)
    const otherAtSameIndex = otherItems[index];
    if (otherAtSameIndex && otherAtSameIndex.songId === entry.songId) {
      // Compare individual fields
      if (otherAtSameIndex.transpose !== entry.transpose) {
        result.transpose = "field-diff";
      }
      if (otherAtSameIndex.capo !== entry.capo) {
        result.capo = "field-diff";
      }
      if ((otherAtSameIndex.instructions || "") !== (entry.instructions || "")) {
        result.instructions = "field-diff";
      }
    }

    return result;
  };

  // Render expanded playlist items for both local and remote side by side
  const renderExpandedPlaylistsRow = (
    localPlaylist: Playlist | null,
    remotePlaylist: Playlist | null,
    isLocalSelected: boolean,
    isRemoteSelected: boolean
  ): React.ReactNode => {
    // Determine max items to show
    const localItems = localPlaylist?.items || [];
    const remoteItems = remotePlaylist?.items || [];
    const maxItems = Math.max(localItems.length, remoteItems.length);

    if (maxItems === 0) return null;

    // Match SongPreference.formatTranspose() - use # for sharp, b for flat
    const formatTranspose = (val: number) => {
      if (val === 0) return "—";
      return val > 0 ? `#${val}` : `b${Math.abs(val)}`;
    };
    // Match SongPreference.formatCapo() - show number or dash if unset (-1)
    const formatCapo = (val: number) => (val >= 0 ? `${val}` : "—");

    return (
      <div className="playlist-comparison">
        <div className="playlist-comparison-header">
          <div className="playlist-comparison-side">{effectiveLocalLabel}</div>
          <div className="playlist-comparison-side">{effectiveRemoteLabel}</div>
        </div>
        <div className="playlist-comparison-body">
          {/* Local side */}
          <div className={`playlist-comparison-panel ${isLocalSelected ? "selected" : "unselected"}`}>
            {localItems.length === 0 ? (
              <div className="playlist-empty">—</div>
            ) : (
              <table className="table table-sm playlist-entries-table mb-0">
                <thead>
                  <tr>
                    <th className="col-entry-num">#</th>
                    <th className="col-entry-title">{t("Title")}</th>
                    <th className="col-entry-transpose">{t("LeaderMergeTranspose")}</th>
                    <th className="col-entry-capo">{t("LeaderMergeCapo")}</th>
                    <th className="col-entry-instr">{t("LeaderMergeInstructions")}</th>
                  </tr>
                </thead>
                <tbody>
                  {localItems.map((entry, idx) => {
                    const diffStatus = getEntryDiffStatus(entry, idx, remoteItems);
                    const fieldDiff = getFieldDiffClasses(entry, idx, remoteItems);
                    return (
                      <tr key={idx} className={`entry-diff-${diffStatus}`}>
                        <td className="col-entry-num">{idx + 1}</td>
                        <td className="col-entry-title" title={entry.title}>
                          {entry.title || entry.songId}
                        </td>
                        <td className={`col-entry-transpose ${fieldDiff.transpose}`}>{formatTranspose(entry.transpose)}</td>
                        <td className={`col-entry-capo ${fieldDiff.capo}`}>{formatCapo(entry.capo)}</td>
                        <td className={`col-entry-instr ${fieldDiff.instructions}`}>
                          {entry.instructions ? <Icon type={IconType.CHECKBOX_CHECKED} /> : "—"}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            )}
          </div>
          {/* Remote side */}
          <div className={`playlist-comparison-panel ${isRemoteSelected ? "selected" : "unselected"}`}>
            {remoteItems.length === 0 ? (
              <div className="playlist-empty">—</div>
            ) : (
              <table className="table table-sm playlist-entries-table mb-0">
                <thead>
                  <tr>
                    <th className="col-entry-num">#</th>
                    <th className="col-entry-title">{t("Title")}</th>
                    <th className="col-entry-transpose">{t("LeaderMergeTranspose")}</th>
                    <th className="col-entry-capo">{t("LeaderMergeCapo")}</th>
                    <th className="col-entry-instr">{t("LeaderMergeInstructions")}</th>
                  </tr>
                </thead>
                <tbody>
                  {remoteItems.map((entry, idx) => {
                    const diffStatus = getEntryDiffStatus(entry, idx, localItems);
                    const fieldDiff = getFieldDiffClasses(entry, idx, localItems);
                    return (
                      <tr key={idx} className={`entry-diff-${diffStatus}`}>
                        <td className="col-entry-num">{idx + 1}</td>
                        <td className="col-entry-title" title={entry.title}>
                          {entry.title || entry.songId}
                        </td>
                        <td className={`col-entry-transpose ${fieldDiff.transpose}`}>{formatTranspose(entry.transpose)}</td>
                        <td className={`col-entry-capo ${fieldDiff.capo}`}>{formatCapo(entry.capo)}</td>
                        <td className={`col-entry-instr ${fieldDiff.instructions}`}>
                          {entry.instructions ? <Icon type={IconType.CHECKBOX_CHECKED} /> : "—"}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            )}
          </div>
        </div>
      </div>
    );
  };

  return (
    <div className="modal-backdrop show leader-merge-dialog-backdrop">
      <div className="modal d-block">
        <div ref={dialogRef} className={`leader-merge-modal-dialog${isMaximized ? " maximized" : ""}`} onClick={(e) => e.stopPropagation()}>
          <div className="modal-content">
            <div className="modal-header" onMouseDown={handleMouseDown}>
              <h5 className="modal-title">{t("LeaderMergeTitle")}</h5>
              <div className="settings-header-buttons">
                {!isMobile && (
                  <button
                    type="button"
                    className={`btn-header-maximize${isMaximized ? " active" : ""}`}
                    onClick={() => setIsMaximized(!isMaximized)}
                    aria-label={isMaximized ? "Restore" : "Maximize"}
                    title={isMaximized ? "Restore" : "Maximize"}
                  >
                    <i className={`fa ${isMaximized ? "fa-window-restore" : "fa-window-maximize"}`}></i>
                  </button>
                )}
                <button type="button" className="btn-close" onClick={onCancel} title={t("CloseDialog")} aria-label={t("Close")}></button>
              </div>
            </div>
            <div className="modal-body leader-merge-body">
              {!readOnly && (
                <div className="merge-quick-actions mb-3">
                  <button type="button" className="btn btn-outline-primary me-2" onClick={handleSelectAllLocal}>
                    {t("LeaderMergeSelectAll") || "Select All"} {effectiveLocalLabel}
                  </button>
                  <button type="button" className="btn btn-outline-primary" onClick={handleSelectAllRemote}>
                    {t("LeaderMergeSelectAll") || "Select All"} {effectiveRemoteLabel}
                  </button>
                </div>
              )}

              {/* Song Preferences Section */}
              <div className="merge-section">
                <h6 className="merge-section-title">{t("LeaderMergeSongPreferences")}</h6>
                {preferenceConflicts.length === 0 ? (
                  <p className="text-muted">{t("LeaderMergeNoConflicts")}</p>
                ) : (
                  <div className="merge-table-container">
                    <table className="table table-sm merge-table merge-table-stacked">
                      <thead>
                        <tr>
                          <th className="col-song">{t("LeaderMergeSongTitle")}</th>
                          <th className="col-source" colSpan={2}>
                            {effectiveLocalLabel}
                          </th>
                          <th className="col-pref-heading">{t("Title")}</th>
                          <th className="col-pref-heading">{t("LeaderMergeTranspose")}</th>
                          <th className="col-pref-heading">{t("LeaderMergeCapo")}</th>
                          <th className="col-pref-heading">{t("LeaderMergeMode")}</th>
                          <th className="col-pref-heading">{t("LeaderMergeInstructions")}</th>
                          <th className="col-source" colSpan={2}>
                            {effectiveRemoteLabel}
                          </th>
                        </tr>
                      </thead>
                      <tbody>
                        {preferenceConflicts.map((conflict, index) => {
                          const localSelected = !conflict.useRemote;
                          return (
                            <React.Fragment key={conflict.songId}>
                              <tr className={`merge-row merge-row-top ${localSelected ? "merge-row-selected" : "merge-row-unselected"}`}>
                                <td className="col-song" rowSpan={2} title={conflict.songTitle}>
                                  {conflict.songTitle}
                                </td>
                                <td className={`col-source-half col-source-top col-source-left`}>
                                  <button
                                    type="button"
                                    className={`btn btn-sm merge-source-btn merge-source-btn-left ${localSelected ? "btn-primary" : "btn-outline-secondary"}`}
                                    onClick={() => handlePreferenceToggle(index)}
                                    title={effectiveLocalLabel}
                                    disabled={readOnly}
                                  >
                                    {localSelected ? "✓" : ""}
                                  </button>
                                </td>
                                <td className={`col-source-half col-source-top col-source-left${localSelected ? " source-half-selected" : ""}`}></td>
                                {renderPreferenceValueCells(conflict.localPref, "", localSelected ? "col-source-right source-half-selected" : "")}
                                <td></td>
                                <td className="col-source-half col-source-top col-source-right">
                                  <button
                                    type="button"
                                    className={`btn btn-sm merge-source-btn merge-source-btn-right ${!localSelected ? "btn-primary" : "btn-outline-secondary"}`}
                                    onClick={() => handlePreferenceToggle(index)}
                                    title={effectiveRemoteLabel}
                                    disabled={readOnly}
                                  >
                                    {!localSelected ? "✓" : ""}
                                  </button>
                                </td>
                              </tr>
                              <tr className={`merge-row merge-row-bottom ${!localSelected ? "merge-row-selected" : "merge-row-unselected"}`}>
                                <td className={`col-source-half col-source-top col-source-left`} colSpan={2}></td>
                                {renderPreferenceValueCells(conflict.remotePref, !localSelected ? "col-source-left source-half-selected" : "", "")}
                                <td
                                  className={`col-source-half col-source-top col-source-right${!localSelected ? " source-half-selected" : ""}`}
                                ></td>
                                <td className={`col-source-half col-source-top col-source-right`}></td>
                              </tr>
                            </React.Fragment>
                          );
                        })}
                      </tbody>
                    </table>
                  </div>
                )}
              </div>

              {/* Schedule Section */}
              <div className="merge-section mt-4">
                <h6 className="merge-section-title">{t("LeaderMergeSchedule")}</h6>
                {scheduleConflicts.length === 0 ? (
                  <p className="text-muted">{t("LeaderMergeNoScheduleConflicts")}</p>
                ) : (
                  <div className="merge-table-container schedule-table-container">
                    <table className="table table-sm merge-table">
                      <thead>
                        <tr>
                          <th className="col-expand"></th>
                          <th className="col-date">{t("LeaderMergeDate")}</th>
                          <th className="col-source">{effectiveLocalLabel}</th>
                          <th className="col-playlist-value">{t("LeaderMergeSongCount")}</th>
                          <th className="col-source">{effectiveRemoteLabel}</th>
                          <th className="col-playlist-value">{t("LeaderMergeSongCount")}</th>
                        </tr>
                      </thead>
                      <tbody>
                        {scheduleConflicts.map((conflict, index) => {
                          const dateTs = conflict.date.getTime();
                          const isExpanded = isScheduleExpanded(dateTs);

                          return (
                            <React.Fragment key={dateTs}>
                              <tr className="merge-row" onMouseEnter={(e) => handleRowMouseEnter(index, e)} onMouseLeave={handleRowMouseLeave}>
                                <td className="col-expand">
                                  <button
                                    type="button"
                                    className="btn btn-sm btn-link playlist-expand-btn p-0"
                                    onClick={() => toggleScheduleExpanded(dateTs)}
                                    title={isExpanded ? t("Collapse") : t("Expand")}
                                  >
                                    {isExpanded ? "▼" : "▶"}
                                  </button>
                                </td>
                                <td className="col-date">{conflict.date.toLocaleDateString()}</td>
                                <td className="col-source">
                                  <button
                                    type="button"
                                    className={`btn btn-sm merge-source-btn ${!conflict.useRemote ? "btn-primary" : "btn-outline-secondary"}`}
                                    onClick={() => handleScheduleToggle(index)}
                                    title={effectiveLocalLabel}
                                    disabled={readOnly}
                                  >
                                    {!conflict.useRemote ? "✓" : ""}
                                  </button>
                                </td>
                                <td className="col-playlist-value">{renderPlaylistCount(conflict.localPlaylist, !conflict.useRemote)}</td>
                                <td className="col-source">
                                  <button
                                    type="button"
                                    className={`btn btn-sm merge-source-btn ${conflict.useRemote ? "btn-primary" : "btn-outline-secondary"}`}
                                    onClick={() => handleScheduleToggle(index)}
                                    title={effectiveRemoteLabel}
                                    disabled={readOnly}
                                  >
                                    {conflict.useRemote ? "✓" : ""}
                                  </button>
                                </td>
                                <td className="col-playlist-value">{renderPlaylistCount(conflict.remotePlaylist, conflict.useRemote)}</td>
                              </tr>
                              {/* Expanded playlist items row - shows both side by side */}
                              {isExpanded && (
                                <tr className="playlist-expanded-row">
                                  <td colSpan={6} className="playlist-expanded-cell">
                                    {renderExpandedPlaylistsRow(
                                      conflict.localPlaylist,
                                      conflict.remotePlaylist,
                                      !conflict.useRemote,
                                      conflict.useRemote
                                    )}
                                  </td>
                                </tr>
                              )}
                            </React.Fragment>
                          );
                        })}
                      </tbody>
                    </table>
                  </div>
                )}
              </div>
            </div>
            <div className="modal-footer">
              <button type="button" className="btn btn-secondary" onClick={onCancel}>
                {readOnly ? t("Close") : t("Cancel")}
              </button>
              {!readOnly && (
                <button type="button" className="btn btn-primary" onClick={handleSave}>
                  {t("Save")}
                </button>
              )}
            </div>
          </div>
        </div>
      </div>
      {/* Hover popup for playlist differences */}
      {renderHoverPopup()}
    </div>
  );
};

export default LeaderDataMergeDialog;
