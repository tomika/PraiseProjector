import React, { useState } from "react";
import { createPortal } from "react-dom";
import { Settings } from "../../types";
import { Leaders, Leader } from "../../../db-common";
import SongPreferencesEditor from "./SongPreferencesEditor";
import { useLocalization } from "../../localization/LocalizationContext";
import "./LeadersSettings.css";

interface LeadersSettingsProps {
  settings: Settings;
  updateSetting: <K extends keyof Settings>(key: K, value: Settings[K]) => void;
  leaders: Leaders;
  selectedLeaderId: string | null;
  onSelectedLeaderChange: (id: string | null) => void;
  onAddLeader: (name: string) => void;
  onRemoveLeader: () => void;
  isGuest?: boolean;
}

const LeadersSettings: React.FC<LeadersSettingsProps> = ({
  settings,
  updateSetting,
  leaders,
  selectedLeaderId,
  onSelectedLeaderChange,
  onAddLeader,
  onRemoveLeader,
  isGuest = false,
}) => {
  const { t } = useLocalization();
  const [showAddDialog, setShowAddDialog] = useState(false);
  const [newLeaderName, setNewLeaderName] = useState("");

  const handleSelectChange = (e: React.ChangeEvent<HTMLSelectElement>) => {
    const leaderId = e.target.value;
    if (leaderId) {
      onSelectedLeaderChange(leaderId);
    } else {
      onSelectedLeaderChange(null);
    }
  };

  const handleAddClick = () => {
    setNewLeaderName("");
    setShowAddDialog(true);
  };

  const handleAddConfirm = () => {
    if (newLeaderName.trim()) {
      onAddLeader(newLeaderName.trim());
      setShowAddDialog(false);
      setNewLeaderName("");
    }
  };

  const handleAddCancel = () => {
    setShowAddDialog(false);
    setNewLeaderName("");
  };

  const selectedLeader = selectedLeaderId !== null ? leaders.find(selectedLeaderId) : null;
  // Enable Remove button when a leader is selected (matching C# UpdateLeaderData)
  const canRemove = selectedLeaderId !== null;

  return (
    <div className="leaders-settings-container">
      {settings && updateSetting && (
        <div className="form-group">
          <label htmlFor="leaderProfileUpdateMode">{t("LeaderProfileUpdateMode")}</label>
          <select
            className="form-control"
            id="leaderProfileUpdateMode"
            value={settings.leaderProfileUpdateMode || "allSources"}
            onChange={(e) => updateSetting("leaderProfileUpdateMode", e.target.value as "leaderPageOnly" | "uiChangesAlso" | "allSources")}
          >
            <option value="leaderPageOnly">{t("LeaderProfileUpdateLeaderPageOnly")}</option>
            <option value="uiChangesAlso">{t("LeaderProfileUpdateUiChangesAlso")}</option>
            <option value="allSources">{t("LeaderProfileUpdateAllSources")}</option>
          </select>
        </div>
      )}

      <div className="form-group">
        <label htmlFor="leaderSelect">{t("Leader")}</label>
        <div className="d-flex gap-2 align-items-start leaders-settings-buttons">
          <select className="form-control flex-grow-1" id="leaderSelect" value={selectedLeaderId || ""} onChange={handleSelectChange}>
            <option value="">{t("SelectALeader")}</option>
            {leaders.items.map((leader: Leader) => (
              <option key={leader.id} value={leader.id}>
                {leader.name}
              </option>
            ))}
          </select>
          {isGuest && (
            <>
              <button className="btn btn-outline-secondary" onClick={handleAddClick} title={t("Add")}>
                {t("Add")}
              </button>
              <button className="btn btn-outline-secondary" onClick={onRemoveLeader} disabled={!canRemove} title={t("Remove")}>
                {t("Remove")}
              </button>
            </>
          )}
        </div>
      </div>

      <SongPreferencesEditor leader={selectedLeader} />

      {/* Add Leader Dialog - Rendered using Portal to escape modal hierarchy */}
      {showAddDialog &&
        createPortal(
          <div className="modal-backdrop show leader-add-dialog-backdrop" onClick={handleAddCancel}>
            <div className="modal d-block">
              <div className="modal-dialog modal-dialog-centered" onClick={(e) => e.stopPropagation()}>
                <div className="modal-content">
                  <div className="modal-header">
                    <h5 className="modal-title">{t("AddNewLeader")}</h5>
                    <button type="button" className="btn-close" onClick={handleAddCancel} aria-label="Close"></button>
                  </div>
                  <div className="modal-body">
                    <div className="form-group">
                      <label htmlFor="newLeaderNameInput">{t("LeaderName")}</label>
                      <input
                        type="text"
                        className="form-control"
                        id="newLeaderNameInput"
                        value={newLeaderName}
                        onChange={(e) => setNewLeaderName(e.target.value)}
                        onKeyDown={(e) => {
                          if (e.key === "Enter") {
                            handleAddConfirm();
                          } else if (e.key === "Escape") {
                            handleAddCancel();
                          }
                        }}
                        placeholder={t("EnterLeaderName")}
                        autoFocus
                      />
                    </div>
                  </div>
                  <div className="modal-footer">
                    <button type="button" className="btn btn-secondary" onClick={handleAddCancel}>
                      {t("Cancel")}
                    </button>
                    <button type="button" className="btn btn-primary" onClick={handleAddConfirm} disabled={!newLeaderName.trim()}>
                      {t("Add")}
                    </button>
                  </div>
                </div>
              </div>
            </div>
          </div>,
          document.body
        )}
    </div>
  );
};

export default LeadersSettings;
