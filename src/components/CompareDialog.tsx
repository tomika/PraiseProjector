import React, { useState } from "react";
import { diffWords } from "diff";
import { Song, SongChange } from "../../db-common/Song";
import { Database } from "../../db-common/Database";
import { PendingSongState, SongHistoryEntry } from "../../common/pp-types";
import { useLocalization, StringKey } from "../localization/LocalizationContext";
import ChordProEditor from "./ChordProEditor/ChordProEditor";
import "./CompareDialog.css";

// Result type for Import mode decisions
export interface ImportDecision {
  action: "import" | "import-and-group";
  groupWithSong?: Song; // the song to group with (for "import-and-group")
}

// Result type for SongCheck mode decisions
export type SongCheckDecision = "approve" | "reject" | "revoke";

export function convertHistoryEntryToSongWithHistory(historyEntry: SongHistoryEntry): Song {
  return new Song(historyEntry.songdata.text, historyEntry.songdata.system, {
    uploader: historyEntry.uploader,
    created: new Date(historyEntry.created),
  });
}

export function convertHistoryEntriesToSongsWithHistory(historyEntries: SongHistoryEntry[]): Song[] {
  return historyEntries.map((entry) => {
    return convertHistoryEntryToSongWithHistory(entry);
  });
}

interface CompareDialogProps {
  originalSong?: Song | null;
  songsToCompare?: Song[];
  mode: "ViewOnly" | "Verify" | "Import" | "Conflict" | "History" | "SongCheck" | "ComparePairs";
  comparePairs?: Array<{ left: Song; right: Song }>;
  initialPairIndex?: number;
  onClose: (mergedSong?: Song, importDecision?: ImportDecision) => void;
  leftLabel?: string;
  rightLabel?: string;
  leftButtonLabel?: string;
  rightButtonLabel?: string;
  /** SongCheck mode: callback when user approves/rejects/revokes */
  onSongCheckDecision?: (decision: SongCheckDecision) => void;
  /** SongCheck mode: if true, reject button shows "Revoke" instead */
  songCheckIsOwnUpload?: boolean;
  /** SongCheck mode: the current state of the pending song */
  songCheckState?: PendingSongState;
}

// Helper to get version display text from song's Change property
const getVersionLabel = (
  song: Song,
  isActual: boolean,
  actualSongText: string,
  t: (key: StringKey) => string,
  actualChangeOverride?: SongChange
): string => {
  const change = isActual ? actualChangeOverride : song.Change;
  if (isActual && song.Text === actualSongText) {
    return change ? `${change.uploader} @ ${change.created.toLocaleString()} (${t("ActualSong")})` : t("ActualSong");
  }
  return change ? `${change.uploader} @ ${change.created.toLocaleString()}` : t("UnknownVersion");
};

const CompareDialog: React.FC<CompareDialogProps> = ({
  originalSong = null,
  songsToCompare = [],
  mode,
  comparePairs,
  initialPairIndex = 0,
  onClose,
  leftLabel,
  rightLabel,
  leftButtonLabel,
  rightButtonLabel,
  onSongCheckDecision,
  songCheckIsOwnUpload,
  songCheckState,
}) => {
  const { t } = useLocalization();
  const [currentIndex, setCurrentIndex] = useState(initialPairIndex);
  const [showDiff, setShowDiff] = useState(false);
  const [showCode, setShowCode] = useState(false);

  // For History mode: track selected indices for left and right panels
  const [leftVersionIndex, setLeftVersionIndex] = useState(0);
  const [rightVersionIndex, setRightVersionIndex] = useState(Math.min(1, songsToCompare.length - 1));

  // In History mode, all versions are in songsToCompare (including current)
  // Left panel shows the version at leftVersionIndex, right shows rightVersionIndex
  const isHistoryMode = mode === "History";
  const isImportMode = mode === "Import";
  const isSongCheckMode = mode === "SongCheck";
  const isComparePairsMode = mode === "ComparePairs";

  // Build version list for History mode dropdowns
  const buildVersionList = (): { label: string; song: Song }[] => {
    const versions: { label: string; song: Song }[] = [];
    const actualText = originalSong?.Text || "";
    let actualChange = originalSong?.Change;

    // If current song has no embedded change metadata, reuse it from matching history entry.
    // History entries carry uploader@timestamp in Song.Change.
    if (!actualChange && originalSong) {
      const matchingHistory = songsToCompare.find((s) => s.Text === originalSong.Text && s.Change);
      if (matchingHistory) {
        actualChange = matchingHistory.Change;
      }
    }

    // Add original song as first item if available
    if (originalSong) {
      versions.push({
        label: getVersionLabel(originalSong, true, actualText, t, actualChange),
        song: originalSong,
      });
    }

    // Add all history versions
    for (const s of songsToCompare) {
      // Skip if it's the same as original
      if (originalSong && s.Text === originalSong.Text) continue;
      versions.push({
        label: getVersionLabel(s, false, actualText, t),
        song: s,
      });
    }

    return versions;
  };

  const versionList = isHistoryMode ? buildVersionList() : [];

  // Get the actual songs to display based on selected indices
  const getLeftSongForHistory = () => versionList[leftVersionIndex]?.song || originalSong;
  const getRightSongForHistory = () => versionList[rightVersionIndex]?.song || songsToCompare[0];

  // Get current compared song for non-History modes
  const comparedSong = songsToCompare[currentIndex];
  const currentPair = isComparePairsMode && comparePairs && comparePairs.length > 0 ? comparePairs[currentIndex] : null;
  const navItemCount = isComparePairsMode ? (comparePairs?.length ?? 0) : songsToCompare.length;

  const leftContent = isHistoryMode
    ? getLeftSongForHistory()?.Text || ""
    : isComparePairsMode
      ? currentPair?.left.Text || ""
      : originalSong?.Text || "";
  const rightContent = isHistoryMode
    ? getRightSongForHistory()?.Text || ""
    : isComparePairsMode
      ? currentPair?.right.Text || ""
      : comparedSong?.Text || "";

  const compactLeft = leftContent.replace(/[^\S\r\n]+/g, " ");
  const compactRight = rightContent.replace(/[^\S\r\n]+/g, " ");
  const codeDiffChunks = diffWords(compactLeft, compactRight).filter((chunk) => chunk.value.length > 0);
  const hasDifferences = leftContent !== rightContent;
  const showDiffActive = showDiff && hasDifferences;

  // Get the actual Song objects for group ID comparison
  const leftSong: Song | null = isHistoryMode ? getLeftSongForHistory() || null : isComparePairsMode ? currentPair?.left || null : originalSong;
  const rightSong: Song | null = isHistoryMode
    ? getRightSongForHistory() || null
    : isComparePairsMode
      ? currentPair?.right || null
      : comparedSong || null;

  // Check if group ID changed between left and right songs
  const leftGroupId = leftSong?.GroupId || "";
  const rightGroupId = rightSong?.GroupId || "";
  const groupIdChanged = leftGroupId !== rightGroupId && (leftGroupId !== "" || rightGroupId !== "");

  const getGroupMembersByTitle = (groupId: string, panelSong: Song | null): Song[] => {
    if (!groupId) return [];

    const allSongs = Database.getInstance().getSongs();
    const members = allSongs.filter((s) => s.GroupId === groupId);

    if (panelSong && panelSong.GroupId === groupId && !members.some((s) => s.Id === panelSong.Id)) {
      members.push(panelSong);
    }

    return members.sort((a, b) => a.Title.localeCompare(b.Title));
  };

  const renderGroupChangeBadge = (groupId: string, panelSong: Song | null) => {
    if (!groupId) {
      return (
        <div className="compare-group-id-badge">
          {t("GroupIdChanged")}: <span className="compare-group-empty">-</span>
        </div>
      );
    }

    const groupMembers = getGroupMembersByTitle(groupId, panelSong);
    return (
      <div className="compare-group-id-badge">
        <details className="compare-group-details">
          <summary>
            {t("GroupIdChanged")} ({groupMembers.length})
          </summary>
          <ul className="compare-group-song-list">
            {groupMembers.map((song) => (
              <li key={song.Id}>{song.Title || t("UntitledSong")}</li>
            ))}
          </ul>
        </details>
      </div>
    );
  };

  const handleSaveLeft = () => {
    if (originalSong) {
      const merged = new Song(leftContent, originalSong.System);
      onClose(merged);
    }
  };

  const handleSaveRight = () => {
    const song = isHistoryMode ? getRightSongForHistory() : comparedSong;
    if (song) {
      const merged = new Song(rightContent, song.System);
      onClose(merged);
    }
  };

  // Import mode handlers
  const handleImportIndependent = () => {
    onClose(undefined, { action: "import" });
  };

  const handleImportAndGroup = () => {
    onClose(undefined, { action: "import-and-group", groupWithSong: comparedSong });
  };

  const handleNext = () => {
    if (currentIndex < navItemCount - 1) {
      setCurrentIndex(currentIndex + 1);
    }
  };

  const handlePrev = () => {
    if (currentIndex > 0) {
      setCurrentIndex(currentIndex - 1);
    }
  };

  const renderHistoryVersionSelector = (selectedIndex: number, onChange: (index: number) => void, ariaLabel: string) => {
    return (
      <select
        className="form-select form-select-sm history-version-select"
        value={selectedIndex}
        onChange={(e) => onChange(parseInt(e.target.value, 10))}
        aria-label={ariaLabel}
      >
        {versionList.map((v, idx) => (
          <option key={idx} value={idx}>
            {v.label}
          </option>
        ))}
      </select>
    );
  };

  const renderContent = () => {
    // When showing diff, all editors should be read-only (like C# EnableEditMode(false))
    const editableInConflict = mode === "Conflict" && !showDiffActive;
    // Always hide toolbar/tabs in CompareDialog (like C# PreviewOnly) - this is a compare view, not an editor
    const usePreviewOnly = true;

    return (
      <div className={`compare-view ${showDiffActive ? "compare-view-with-diff" : ""}`}>
        {/* Left panel - Original/Local version */}
        <div className="compare-panel">
          {isHistoryMode ? (
            renderHistoryVersionSelector(leftVersionIndex, setLeftVersionIndex, t("LeftVersion"))
          ) : (
            <label>
              {leftLabel ||
                (isSongCheckMode
                  ? t("SongCheckCurrentVersion")
                  : isImportMode
                    ? t("SongToImport")
                    : isComparePairsMode
                      ? t("OriginalVersion")
                      : mode === "Conflict"
                        ? t("LocallyModifiedVersion")
                        : t("ActualSong"))}
            </label>
          )}
          {groupIdChanged && renderGroupChangeBadge(leftGroupId, leftSong)}
          {showCode ? (
            <textarea className="compare-code-textarea" value={leftContent} readOnly wrap="off" aria-label="Left ChordPro Code" />
          ) : (
            <ChordProEditor
              key={`left-${isHistoryMode ? leftVersionIndex : currentIndex}`}
              song={new Song(leftContent)}
              initialEditMode={editableInConflict}
              previewOnly={usePreviewOnly}
            />
          )}
          {mode === "Conflict" && !showDiffActive && (
            <button className="btn btn-primary mt-2" onClick={handleSaveLeft}>
              {leftButtonLabel || t("KeepThisOne")}
            </button>
          )}
        </div>

        {/* Middle panel - Diff view for both WYSIWYG and code mode */}
        {showDiffActive && (
          <div className="compare-panel diff-panel">
            <label>{t("Differences")}</label>
            {showCode ? (
              <div className="compare-code-diff-compact" aria-label="Code Differences">
                {codeDiffChunks.map((chunk, idx) => (
                  <span
                    key={idx}
                    className={`compare-code-diff-chunk ${chunk.added ? "compare-code-diff-added" : chunk.removed ? "compare-code-diff-removed" : "compare-code-diff-unchanged"}`}
                  >
                    {chunk.value}
                  </span>
                ))}
              </div>
            ) : (
              <ChordProEditor
                key={`diff-${isHistoryMode ? `${leftVersionIndex}-${rightVersionIndex}` : currentIndex}`}
                song={new Song(rightContent)}
                compareBase={leftContent}
                initialEditMode={false}
              />
            )}
          </div>
        )}

        {/* Right panel - Compared/Server version */}
        <div className="compare-panel">
          {isHistoryMode ? (
            renderHistoryVersionSelector(rightVersionIndex, setRightVersionIndex, t("RightVersion"))
          ) : (
            <label>
              {rightLabel ||
                (isSongCheckMode
                  ? t("SongCheckProposedVersion")
                  : isImportMode
                    ? t("SimilarSongInDatabase")
                    : isComparePairsMode
                      ? t("NewVersionOnServer")
                      : mode === "Conflict"
                        ? t("NewVersionOnServer")
                        : t("SimilarSongInDatabase"))}
            </label>
          )}
          {groupIdChanged && renderGroupChangeBadge(rightGroupId, rightSong)}
          {showCode ? (
            <textarea className="compare-code-textarea" value={rightContent} readOnly wrap="off" aria-label="Right ChordPro Code" />
          ) : (
            <ChordProEditor
              key={`right-${isHistoryMode ? rightVersionIndex : currentIndex}`}
              song={new Song(rightContent)}
              initialEditMode={editableInConflict}
              previewOnly={usePreviewOnly}
            />
          )}
          {mode === "Conflict" && !showDiffActive && (
            <button className="btn btn-primary mt-2" onClick={handleSaveRight}>
              {rightButtonLabel || t("KeepThisOne")}
            </button>
          )}
        </div>
      </div>
    );
  };

  // Arrows are only for read-only browsing flows.
  const showNavButtons = mode === "ViewOnly" || isComparePairsMode;

  return (
    <div className="modal-backdrop show compare-dialog-backdrop">
      <div className="modal d-block">
        <div className="modal-dialog modal-xl">
          <div className="modal-content">
            <div className="modal-header">
              <h5 className="modal-title">
                {isSongCheckMode ? t("SongCheckTitle") : isHistoryMode ? t("SongHistory") : isImportMode ? t("ImportSong") : t("CompareSongs")}
              </h5>
              <button type="button" className="btn-close" aria-label="Close" onClick={() => onClose()}></button>
            </div>
            <div className="modal-body">{renderContent()}</div>
            <div className="modal-footer">
              {showNavButtons && (
                <button className="btn btn-secondary" onClick={handlePrev} disabled={currentIndex === 0}>
                  &lt;&lt;
                </button>
              )}
              <button className="btn btn-secondary" onClick={() => setShowDiff(!showDiff)} disabled={!hasDifferences}>
                {showDiffActive ? t("HideDifferences") : t("ShowDifferences")}
              </button>
              <button className="btn btn-secondary" onClick={() => setShowCode(!showCode)}>
                {showCode ? t("ShowWysiwyg") : t("ShowChordProCode")}
              </button>
              {showNavButtons && (
                <button className="btn btn-secondary" onClick={handleNext} disabled={currentIndex >= navItemCount - 1}>
                  &gt;&gt;
                </button>
              )}
              {isImportMode && (
                <>
                  <button type="button" className="btn btn-primary" onClick={handleImportIndependent}>
                    {t("Import")}
                  </button>
                  <button type="button" className="btn btn-success" onClick={handleImportAndGroup} disabled={songsToCompare.length === 0}>
                    {t("ImportAndGroup")}
                  </button>
                </>
              )}
              {isSongCheckMode && onSongCheckDecision && songCheckState === "PENDING" && (
                <>
                  <button type="button" className="btn btn-success" onClick={() => onSongCheckDecision("approve")}>
                    {t("SongCheckApprove")}
                  </button>
                  <button type="button" className="btn btn-danger" onClick={() => onSongCheckDecision(songCheckIsOwnUpload ? "revoke" : "reject")}>
                    {songCheckIsOwnUpload ? t("SongCheckWithdraw") : t("SongCheckReject")}
                  </button>
                </>
              )}
              {isSongCheckMode && onSongCheckDecision && songCheckState === "REJECTED" && (
                <>
                  <button type="button" className="btn btn-success" onClick={() => onSongCheckDecision("approve")}>
                    {t("SongCheckKeep")}
                  </button>
                  <button type="button" className="btn btn-danger" onClick={() => onSongCheckDecision("revoke")}>
                    {t("SongCheckWithdraw")}
                  </button>
                </>
              )}
              {isSongCheckMode && onSongCheckDecision && songCheckState === "KEPT" && (
                <button type="button" className="btn btn-danger" onClick={() => onSongCheckDecision("revoke")}>
                  {t("SongCheckWithdraw")}
                </button>
              )}
              <button className="btn btn-secondary" onClick={() => onClose()}>
                {isImportMode ? t("Cancel") : t("Close")}
              </button>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
};

export default CompareDialog;
