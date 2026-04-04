import React, { useState, useEffect, useCallback } from "react";
import { Song } from "../../db-common/Song";
import { SongDBPendingEntry, PendingSongOperation, PendingSongState } from "../../common/pp-types";
import { cloudApi } from "../../common/cloudApi";
import { useLocalization, StringKey } from "../localization/LocalizationContext";
import { useAuth } from "../contexts/AuthContext";
import { useMessageBox } from "../contexts/MessageBoxContext";
import type { SongCheckDecision } from "./CompareDialog";
import CompareDialog from "./CompareDialog";
import "./SongCheckDialog.css";

interface SongCheckDialogProps {
  onClose: () => void;
}

const stateLabel = (state: PendingSongState, t: (key: StringKey) => string): string => {
  switch (state) {
    case "PENDING":
      return t("SongCheckPending");
    case "REJECTED":
      return t("SongCheckRejected");
    case "KEPT":
      return t("SongCheckKept");
  }
};

const stateIcon = (state: PendingSongState): string => {
  switch (state) {
    case "PENDING":
      return "?";
    case "REJECTED":
      return "\u{1F6AB}";
    case "KEPT":
      return "\u{1F512}";
  }
};

const SongCheckDialog: React.FC<SongCheckDialogProps> = ({ onClose }) => {
  const { t } = useLocalization();
  const { username } = useAuth();
  const { showConfirmAsync, showMessage } = useMessageBox();

  const [pendingSongs, setPendingSongs] = useState<SongDBPendingEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [selectedEntry, setSelectedEntry] = useState<SongDBPendingEntry | null>(null);
  const [processing, setProcessing] = useState(false);

  const sortPendingSongs = useCallback(
    (list: SongDBPendingEntry[]): SongDBPendingEntry[] => {
      return [...list].sort((a, b) => {
        // Own uploads first
        const aMine = a.uploader === username ? 1 : 0;
        const bMine = b.uploader === username ? 1 : 0;
        if (aMine + bMine === 1) return bMine - aMine;
        // Then by date descending
        const dateDiff = a.created.localeCompare(b.created);
        if (dateDiff) return -dateDiff;
        // Then by title
        return a.title.localeCompare(b.title);
      });
    },
    [username]
  );

  const fetchPendingSongs = useCallback(async () => {
    try {
      setLoading(true);
      const list = await cloudApi.fetchPendingSongs();
      setPendingSongs(sortPendingSongs(list));
    } catch (error) {
      console.error("SongCheck", "Failed to fetch pending songs", error);
      setPendingSongs([]);
    } finally {
      setLoading(false);
    }
  }, [sortPendingSongs]);

  useEffect(() => {
    fetchPendingSongs();
  }, [fetchPendingSongs]);

  const handleRowClick = (entry: SongDBPendingEntry) => {
    setSelectedEntry(entry);
  };

  const determineOperation = (entry: SongDBPendingEntry, decision: SongCheckDecision): PendingSongOperation => {
    if (decision === "revoke") return "REVOKE";
    if (username === entry.uploader && decision === "reject") return "REVOKE";
    if (entry.state === "REJECTED") {
      return decision === "approve" ? "KEEP" : "REVOKE";
    }
    return decision === "approve" ? "APPROVE" : "REJECT";
  };

  const getConfirmMessage = (decision: SongCheckDecision, state: PendingSongState): StringKey => {
    if (state === "REJECTED" && decision === "approve") return "SongCheckConfirmKeep";
    if (state === "KEPT" || state === "REJECTED") return "SongCheckConfirmWithdraw";
    switch (decision) {
      case "approve":
        return "SongCheckConfirmApprove";
      case "reject":
        return "SongCheckConfirmReject";
      case "revoke":
        return "SongCheckConfirmWithdraw";
    }
  };

  const handleSongCheckDecision = async (decision: SongCheckDecision) => {
    if (!selectedEntry || processing) return;

    const confirmed = await showConfirmAsync(t("Confirm"), t(getConfirmMessage(decision, selectedEntry.state)));
    if (!confirmed) return;

    try {
      setProcessing(true);
      const operation = determineOperation(selectedEntry, decision);
      const error = await cloudApi.updatePendingSongState(selectedEntry.songId, selectedEntry.version, operation);
      if (error) {
        showMessage(t("Error"), error);
      } else {
        setSelectedEntry(null);
        await fetchPendingSongs();
        // Notify UserPanel to refresh its pending count badge
        window.dispatchEvent(new Event("pp-pending-songs-changed"));
      }
    } catch (error) {
      showMessage(t("Error"), error instanceof Error ? error.message : String(error));
    } finally {
      setProcessing(false);
    }
  };

  const handleCompareClose = () => {
    setSelectedEntry(null);
  };

  const formatDate = (isoDate: string): string => {
    try {
      return new Date(isoDate).toLocaleString();
    } catch {
      return isoDate;
    }
  };

  const isOwnUpload = (entry: SongDBPendingEntry) => entry.uploader === username;

  return (
    <>
      <div className="modal-backdrop show song-check-backdrop">
        <div className="modal d-block">
          <div className="modal-dialog modal-lg modal-dialog-centered modal-dialog-scrollable">
            <div className="modal-content">
              <div className="modal-header">
                <h5 className="modal-title">{t("SongCheckTitle")}</h5>
                <button type="button" className="btn-close" aria-label="Close" onClick={onClose}></button>
              </div>
              <div className="modal-body">
                {loading ? (
                  <div className="text-center p-3">
                    <div className="spinner-border text-primary" role="status">
                      <span className="visually-hidden">{t("LoadingEllipsis")}</span>
                    </div>
                  </div>
                ) : pendingSongs.length === 0 ? (
                  <p className="text-muted text-center">{t("SongCheckNoSongs")}</p>
                ) : (
                  <table className="table table-hover song-check-table">
                    <thead>
                      <tr>
                        <th>{t("SongCheckState")}</th>
                        <th>{t("SongCheckSongTitle")}</th>
                        <th>{t("SongCheckUploader")}</th>
                        <th>{t("SongCheckDate")}</th>
                      </tr>
                    </thead>
                    <tbody>
                      {pendingSongs.map((entry) => (
                        <tr
                          key={`${entry.songId}-${entry.version}`}
                          className={`song-check-row ${selectedEntry?.songId === entry.songId && selectedEntry?.version === entry.version ? "table-active" : ""}`}
                          onClick={() => handleRowClick(entry)}
                          role="button"
                        >
                          <td title={stateLabel(entry.state, t)}>{stateIcon(entry.state)}</td>
                          <td>
                            {entry.title}
                            {isOwnUpload(entry) && <span className="text-muted ms-1 small">{t("SongCheckOwnUpload")}</span>}
                          </td>
                          <td>{entry.uploader}</td>
                          <td>{formatDate(entry.created)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                )}
              </div>
              <div className="modal-footer">
                <button className="btn btn-secondary" onClick={onClose}>
                  {t("Close")}
                </button>
              </div>
            </div>
          </div>
        </div>
      </div>

      {selectedEntry && (
        <CompareDialog
          originalSong={selectedEntry.current ? new Song(selectedEntry.current, selectedEntry.songdata.system) : null}
          songsToCompare={[new Song(selectedEntry.songdata.text, selectedEntry.songdata.system)]}
          mode="SongCheck"
          onClose={handleCompareClose}
          leftLabel={selectedEntry.current ? t("SongCheckCurrentVersion") : t("SongCheckNewSong")}
          rightLabel={t("SongCheckProposedVersion")}
          onSongCheckDecision={handleSongCheckDecision}
          songCheckIsOwnUpload={isOwnUpload(selectedEntry)}
          songCheckState={selectedEntry.state}
        />
      )}
    </>
  );
};

export default SongCheckDialog;
