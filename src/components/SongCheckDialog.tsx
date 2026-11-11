import React, { useState, useEffect, useCallback } from "react";
import { Song } from "../../db-common/Song";
import { SongDBPendingEntry, PendingSongOperation, PendingSongState } from "../../common/pp-types";
import { cloudApi } from "../../common/cloudApi";
import { useLocalization, StringKey } from "../localization/LocalizationContext";
import { useAuth } from "../contexts/AuthContext";
import { useMessageBox } from "../contexts/MessageBoxContext";
import { useSettings } from "../hooks/useSettings";
import { acknowledgeHeldSong, unacknowledgedHeldSongs } from "../state/heldSongsStore";
import type { SongCheckDecision } from "./CompareDialog";
import "./SongCheckDialog.css";

const CompareDialog = React.lazy(() => import("./CompareDialog"));

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
    case "UPSTREAM":
      return t("SongCheckUpstream");
    case "HELD":
      return t("SongCheckHeld");
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
    case "UPSTREAM":
      return "\u{2B06}";
    case "HELD":
      return "\u{23F8}";
  }
};

const SongCheckDialog: React.FC<SongCheckDialogProps> = ({ onClose }) => {
  const { t } = useLocalization();
  const { username } = useAuth();
  const { showConfirmAsync, showMessage } = useMessageBox();
  const { settings } = useSettings();
  const showHeldSongs = !!settings?.showHeldSongs;

  // Entries needing a decision. Held versions (state HELD) are kept apart in
  // heldSongs: informational only, they never reach the decision logic.
  const [pendingSongs, setPendingSongs] = useState<SongDBPendingEntry[]>([]);
  const [heldSongs, setHeldSongs] = useState<SongDBPendingEntry[]>([]);
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

  const fetchPendingSongs = useCallback(async (): Promise<{ pending: SongDBPendingEntry[]; held: SongDBPendingEntry[] }> => {
    try {
      setLoading(true);
      const list = await cloudApi.fetchPendingSongs(true, showHeldSongs);
      const pending = sortPendingSongs(list.filter((entry) => entry.state !== "HELD"));
      const held = sortPendingSongs(unacknowledgedHeldSongs(list.filter((entry) => entry.state === "HELD")));
      setPendingSongs(pending);
      setHeldSongs(held);
      return { pending, held };
    } catch (error) {
      console.error("SongCheck", "Failed to fetch pending songs", error);
      setPendingSongs([]);
      setHeldSongs([]);
      return { pending: [], held: [] };
    } finally {
      setLoading(false);
    }
  }, [sortPendingSongs, showHeldSongs]);

  useEffect(() => {
    fetchPendingSongs();
  }, [fetchPendingSongs]);

  const handleRowClick = (entry: SongDBPendingEntry) => {
    setSelectedEntry(entry);
  };

  const determineOperation = (entry: SongDBPendingEntry, decision: SongCheckDecision): PendingSongOperation => {
    if (entry.state === "UPSTREAM") return decision === "approve" ? "TAKE_UPSTREAM" : "KEEP_MINE";
    if (decision === "revoke") return "REVOKE";
    if (entry.state === "REJECTED") {
      return decision === "approve" ? "KEEP" : "REVOKE";
    }
    return decision === "approve" ? "APPROVE" : "REJECT";
  };

  const getConfirmMessage = (decision: SongCheckDecision, state: PendingSongState): StringKey => {
    if (state === "UPSTREAM") return decision === "approve" ? "SongCheckConfirmTakeUpstream" : "SongCheckConfirmKeepMine";
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

    const decidedSongId = selectedEntry.songId;
    const decidedVersion = selectedEntry.version;
    const decidedIndex = pendingSongs.findIndex((e) => e.songId === decidedSongId && e.version === decidedVersion);

    try {
      setProcessing(true);
      const operation = determineOperation(selectedEntry, decision);
      const error = await cloudApi.updatePendingSongState(selectedEntry.songId, selectedEntry.version, operation);
      if (error) {
        showMessage(t("Error"), error);
      } else {
        const refreshed = await fetchPendingSongs();
        const remainingSongs = refreshed.pending.filter((e) => !(e.songId === decidedSongId && e.version === decidedVersion));

        if (remainingSongs.length === 0) {
          setSelectedEntry(null);
          if (refreshed.held.length === 0) onClose();
        } else {
          const nextIndex = decidedIndex >= 0 && decidedIndex < remainingSongs.length ? decidedIndex : remainingSongs.length - 1;
          setSelectedEntry(remainingSongs[nextIndex]);
        }

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

  // Acknowledging only hides the held version on this device; nothing is sent.
  const handleAcknowledgeHeld = (entry: SongDBPendingEntry) => {
    acknowledgeHeldSong(entry);
    const remainingHeld = heldSongs.filter((e) => !(e.songId === entry.songId && e.created === entry.created));
    setHeldSongs(remainingHeld);
    if (selectedEntry?.state === "HELD" && selectedEntry.songId === entry.songId) setSelectedEntry(null);
    if (remainingHeld.length === 0 && pendingSongs.length === 0) onClose();
  };

  const selectedIsHeld = selectedEntry?.state === "HELD";
  const selectedList = selectedIsHeld ? heldSongs : pendingSongs;
  const selectedIndex = selectedEntry ? selectedList.findIndex((e) => e.songId === selectedEntry.songId && e.version === selectedEntry.version) : -1;
  const selectedEntryHasPreviousVersion = !!selectedEntry?.current;

  const handleNavigatePrev = selectedIndex > 0 ? () => setSelectedEntry(selectedList[selectedIndex - 1]) : undefined;
  const handleNavigateNext =
    selectedIndex >= 0 && selectedIndex < selectedList.length - 1 ? () => setSelectedEntry(selectedList[selectedIndex + 1]) : undefined;

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
                  heldSongs.length === 0 && <p className="text-muted text-center">{t("SongCheckNoSongs")}</p>
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
                {!loading && heldSongs.length > 0 && (
                  <div className="song-check-held">
                    <h6 className="mt-2">
                      {stateIcon("HELD")} {t("SongCheckHeldTitle")}
                    </h6>
                    <p className="text-muted small">{t("SongCheckHeldDescription")}</p>
                    <table className="table table-hover song-check-table">
                      <thead>
                        <tr>
                          <th>{t("SongCheckSongTitle")}</th>
                          <th>{t("SongCheckHeldIn")}</th>
                          <th>{t("SongCheckDate")}</th>
                          <th></th>
                        </tr>
                      </thead>
                      <tbody>
                        {heldSongs.map((entry) => (
                          <tr
                            key={`${entry.songId}-${entry.version}`}
                            className={`song-check-row ${selectedEntry?.songId === entry.songId && selectedEntry?.version === entry.version ? "table-active" : ""}`}
                            onClick={() => handleRowClick(entry)}
                            role="button"
                          >
                            <td>{entry.title}</td>
                            <td>{entry.heldIn}</td>
                            <td>{formatDate(entry.created)}</td>
                            <td className="text-end">
                              <button
                                type="button"
                                className="btn btn-sm btn-outline-secondary"
                                onClick={(event) => {
                                  event.stopPropagation();
                                  handleAcknowledgeHeld(entry);
                                }}
                              >
                                {t("SongCheckAcknowledge")}
                              </button>
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
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
        <React.Suspense fallback={<div className="loading-overlay" />}>
          <CompareDialog
            originalSong={
              selectedEntryHasPreviousVersion
                ? new Song(selectedEntry.current!, selectedEntry.songdata.system, undefined, selectedEntry.currentLanguage)
                : null
            }
            songsToCompare={[new Song(selectedEntry.songdata.text, selectedEntry.songdata.system, undefined, selectedEntry.songdata.language)]}
            mode="SongCheck"
            onClose={handleCompareClose}
            leftLabel={
              selectedIsHeld
                ? t(selectedEntryHasPreviousVersion ? "SongCheckPublicVersion" : "SongCheckNoPublicVersion")
                : selectedEntryHasPreviousVersion
                  ? t("SongCheckCurrentVersion")
                  : t("SongCheckNewSong")
            }
            initialLeftCollapsed={!selectedEntryHasPreviousVersion}
            rightLabel={t(selectedIsHeld ? "SongCheckHeldOwnVersion" : "SongCheckProposedVersion")}
            // A held version is only for viewing: no decision is offered.
            onSongCheckDecision={selectedIsHeld ? undefined : handleSongCheckDecision}
            songCheckCanRevoke={selectedEntry.canRevoke ?? (isOwnUpload(selectedEntry) && selectedEntry.state !== "PENDING")}
            songCheckState={selectedEntry.state}
            requesterName={selectedEntry.uploader}
            onNavigatePrev={handleNavigatePrev}
            onNavigateNext={handleNavigateNext}
          />
        </React.Suspense>
      )}
    </>
  );
};

export default SongCheckDialog;
