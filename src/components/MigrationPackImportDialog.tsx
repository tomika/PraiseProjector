import React, { useState } from "react";
import { useLocalization } from "../localization/LocalizationContext";
import type { DatabaseSummary, MigrationPackDatabase } from "../services/migrationPack";
import "./MigrationPackImportDialog.css";

export interface MigrationPackImportItem extends MigrationPackDatabase {
  /**
   * What this device currently stores for the same account: null when it has no
   * database for it, "unreadable" when it has one that could not be summarized.
   */
  local: DatabaseSummary | "unreadable" | null;
}

interface MigrationPackImportDialogProps {
  items: MigrationPackImportItem[];
  currentUsername: string;
  onImport: (selected: MigrationPackImportItem[]) => void;
  onClose: () => void;
}

/**
 * Lets the user pick which account databases of a `.ppmigrate` pack to import.
 * Accounts that have no database on this device are preselected; one that would
 * replace existing local data has to be ticked explicitly.
 */
const MigrationPackImportDialog: React.FC<MigrationPackImportDialogProps> = ({ items, currentUsername, onImport, onClose }) => {
  const { t } = useLocalization();
  const [selected, setSelected] = useState<Set<string>>(() => new Set(items.filter((item) => item.local === null).map((item) => item.username)));

  const toggle = (username: string) => {
    setSelected((previous) => {
      const next = new Set(previous);
      if (next.has(username)) next.delete(username);
      else next.add(username);
      return next;
    });
  };

  const describe = (summary: MigrationPackImportItem["local"]) => {
    if (summary === null) return t("MigrationImportNoDatabase");
    if (summary === "unreadable") return t("MigrationImportUnreadable");
    return t("MigrationImportSummary")
      .replace("{0}", String(summary.songs))
      .replace("{1}", String(summary.profiles))
      .replace("{2}", String(summary.unsynced))
      .replace("{3}", String(summary.version));
  };

  return (
    <div className="modal-backdrop show migration-import-backdrop">
      <div className="modal d-block" tabIndex={-1}>
        <div className="modal-dialog modal-dialog-centered modal-lg modal-dialog-scrollable">
          <div className="modal-content">
            <div className="modal-header">
              <h5 className="modal-title">{t("MigrationImportTitle")}</h5>
              <button type="button" className="btn-close" aria-label={t("Close")} onClick={onClose} />
            </div>
            <div className="modal-body">
              <p>{t("MigrationImportDescription")}</p>
              <div className="mb-2">
                <button className="btn btn-sm btn-outline-secondary me-2" onClick={() => setSelected(new Set(items.map((item) => item.username)))}>
                  {t("SelectAll")}
                </button>
                <button className="btn btn-sm btn-outline-secondary" onClick={() => setSelected(new Set())}>
                  {t("DeselectAll")}
                </button>
              </div>
              <table className="table table-sm migration-import-table">
                <thead>
                  <tr>
                    <th></th>
                    <th>{t("MigrationImportAccount")}</th>
                    <th>{t("MigrationImportInFile")}</th>
                    <th>{t("MigrationImportOnDevice")}</th>
                  </tr>
                </thead>
                <tbody>
                  {items.map((item) => {
                    const id = `migration-import-${item.username || "guest"}`;
                    return (
                      <tr key={item.username}>
                        <td>
                          <input
                            id={id}
                            type="checkbox"
                            className="form-check-input"
                            checked={selected.has(item.username)}
                            onChange={() => toggle(item.username)}
                          />
                        </td>
                        <td>
                          <label htmlFor={id}>
                            {item.username || t("Guest")}
                            {item.username === currentUsername && <span className="badge bg-secondary ms-2">{t("MigrationImportCurrent")}</span>}
                          </label>
                        </td>
                        <td className="migration-import-summary">{describe(item.summary)}</td>
                        <td className="migration-import-summary">{describe(item.local)}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
            <div className="modal-footer">
              <button className="btn btn-secondary" onClick={onClose}>
                {t("Cancel")}
              </button>
              <button
                className="btn btn-danger"
                disabled={selected.size === 0}
                onClick={() => onImport(items.filter((item) => selected.has(item.username)))}
              >
                {t("MigrationImportSelected")}
              </button>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
};

export default MigrationPackImportDialog;
