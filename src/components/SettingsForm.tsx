import React, { useState, useEffect, useRef } from "react";
import { useDialogResize } from "../hooks/useDialogResize";
import GeneralSettings from "./settings/GeneralSettings";
import ProjectingSettings from "./settings/ProjectingSettings";
import SearchingSettings from "./settings/SearchingSettings";
import LeadersSettings from "./settings/LeadersSettings";
import SectionsSettings from "./settings/SectionsSettings";
import WebServerSettings from "./settings/WebServerSettings";
import NetDisplaySettings from "./settings/NetDisplaySettings";
import ImagesSettings from "./settings/ImagesSettings";
import AboutSettings from "./settings/AboutSettings";
import { Leader } from "../../db-common";
import { v4 as uuidv4 } from "uuid";
import "./SettingsForm.css";
import { useSettings } from "../hooks/useSettings";
import { useDatabase } from "../hooks/useDatabase";
import { useTooltips } from "../localization/TooltipContext";
import { useLocalization } from "../localization/LocalizationContext";
import { useAuth } from "../contexts/AuthContext";
import { useUpdate } from "../contexts/UpdateContext";
import { useMessageBox } from "../contexts/MessageBoxContext";
import { TypesenseClient } from "../../common/typesense-client";

interface SettingsFormProps {
  onClose: () => void;
  initialTab?: string;
  initialLeaderId?: string | null;
  onOpenLogs?: () => void;
}

function normalizeSettingsTab(tab: string | undefined): string {
  const validTabs = new Set([
    "general",
    "searching",
    "projecting",
    "images",
    "leaders",
    "sections",
    "about",
    ...(window.electronAPI ? ["webserver", "netdisplay"] : []),
  ]);
  if (tab && validTabs.has(tab)) {
    return tab;
  }
  return "general";
}

const SettingsForm: React.FC<SettingsFormProps> = ({ onClose, initialTab, initialLeaderId, onOpenLogs }) => {
  const { settings, initialSettings, updateSetting, saveSettings, revertSettings, resetSettingsToDefaults } = useSettings();
  const { leaders, setLeaders, saveLeaders, revertLeaders } = useDatabase();
  const { tt } = useTooltips();
  const { t } = useLocalization();
  const { isGuest } = useAuth();
  const { hasUpdate } = useUpdate();
  const { showMessage, showConfirmAsync } = useMessageBox();
  const [activeTab, setActiveTab] = useState(() => normalizeSettingsTab(initialTab));
  const [selectedLeaderId, setSelectedLeaderId] = useState<string | null>(initialLeaderId ?? null);
  const dialogRef = useRef<HTMLDivElement>(null);
  const [isDragging, setIsDragging] = useState(false);
  const [dragOffset, setDragOffset] = useState({ x: 0, y: 0 });
  const [isMobile, setIsMobile] = useState(false);
  const [saving, setSaving] = useState(false);
  const [isMaximized, setIsMaximized] = useState(false);

  const { handleResizeMouseDown } = useDialogResize(dialogRef, { disabled: isMobile || isMaximized });

  // Detect mobile viewport
  useEffect(() => {
    const checkMobile = () => {
      setIsMobile(window.innerWidth <= 768);
    };

    checkMobile();
    window.addEventListener("resize", checkMobile);

    return () => window.removeEventListener("resize", checkMobile);
  }, []);

  // Auto-select first leader if none selected - using setTimeout to avoid synchronous setState warning
  useEffect(() => {
    if (leaders.items.length > 0 && selectedLeaderId === null) {
      const firstLeader = leaders.items[0];
      if (firstLeader) {
        const timerId = setTimeout(() => {
          setSelectedLeaderId(firstLeader.id);
        }, 0);
        return () => clearTimeout(timerId);
      }
    }
  }, [leaders, selectedLeaderId]);

  useEffect(() => {
    setActiveTab(normalizeSettingsTab(initialTab));
  }, [initialTab]);

  useEffect(() => {
    if (initialLeaderId !== undefined) {
      setSelectedLeaderId(initialLeaderId);
    }
  }, [initialLeaderId]);

  // Center dialog on mount and handle window resize
  useEffect(() => {
    if (dialogRef.current && !isMobile) {
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
    }
  }, [isMobile]);

  // Clamp dialog within viewport when its size changes (e.g. due to font-size change).
  useEffect(() => {
    if (!dialogRef.current || isMobile) return;

    const dialog = dialogRef.current;
    const observer = new ResizeObserver(() => {
      if (!dialog.style.left && !dialog.style.top) return; // not yet positioned
      const maxLeft = window.innerWidth - dialog.offsetWidth;
      const maxTop = window.innerHeight - dialog.offsetHeight;
      const currentLeft = parseFloat(dialog.style.left) || 0;
      const currentTop = parseFloat(dialog.style.top) || 0;
      const newLeft = Math.max(0, Math.min(maxLeft, currentLeft));
      const newTop = Math.max(0, Math.min(maxTop, currentTop));
      if (newLeft !== currentLeft) dialog.style.left = `${newLeft}px`;
      if (newTop !== currentTop) dialog.style.top = `${newTop}px`;
    });

    observer.observe(dialog);
    return () => observer.disconnect();
  }, [isMobile]);

  const handleMouseDown = (e: React.MouseEvent) => {
    if (isMobile || !dialogRef.current) return;

    const rect = dialogRef.current.getBoundingClientRect();
    setDragOffset({
      x: e.clientX - rect.left,
      y: e.clientY - rect.top,
    });
    setIsDragging(true);
  };

  useEffect(() => {
    if (!isDragging) return;

    const handleMouseMove = (e: MouseEvent) => {
      if (!dialogRef.current) return;

      const newLeft = e.clientX - dragOffset.x;
      const newTop = e.clientY - dragOffset.y;

      // Keep dialog within viewport
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
  }, [isDragging, dragOffset]);

  if (!settings) {
    return <div>Loading...</div>;
  }

  const handleOk = async () => {
    // Validate typesense if user just switched to it
    setSaving(true);
    try {
      if (settings.searchMethod === "typesense" && initialSettings?.searchMethod !== "typesense") {
        const error = await TypesenseClient.verifyConnection(settings.typesenseUrl, settings.typesenseApiKey);
        if (error) {
          if (error === "unhealthy") {
            showMessage(t("TypesenseValidationTitle"), t("TypesenseValidationUnhealthy"));
          } else {
            showMessage(t("TypesenseValidationTitle"), error);
          }
          return;
        }
      }
      await saveSettings();
      await saveLeaders();
      onClose();
    } finally {
      setSaving(false);
    }
  };

  const handleCancel = () => {
    // Revert all changes and close
    revertSettings();
    revertLeaders();
    onClose();
  };

  const handleResetToDefaults = async () => {
    const confirmed = await showConfirmAsync(t("ResetSettingsConfirmTitle"), t("ResetSettingsConfirm"), {
      confirmText: t("ResetToDefaults"),
      confirmDanger: true,
    });
    if (!confirmed) return;
    resetSettingsToDefaults();
  };

  const handleAddLeader = (name: string) => {
    const newLeader = new Leader(uuidv4(), name); // Leader constructor is (id, name, version)
    const newLeaders = leaders.clone();
    newLeaders.add(newLeader);
    setLeaders(newLeaders);
    setSelectedLeaderId(newLeader.id);
    if (isGuest) {
      saveLeaders(newLeaders).catch((error) => {
        console.error("Settings", "Failed to save guest leaders", error);
      });
    }
  };

  const handleRemoveLeader = () => {
    if (selectedLeaderId !== null) {
      const leaderToRemove = leaders.find(selectedLeaderId);
      if (leaderToRemove) {
        const newLeaders = leaders.clone();
        newLeaders.remove(leaderToRemove);
        setLeaders(newLeaders);
        const firstLeader = newLeaders.items[0];
        setSelectedLeaderId(newLeaders.items.length > 0 && firstLeader ? firstLeader.id : null);
        if (isGuest) {
          saveLeaders(newLeaders).catch((error) => {
            console.error("Settings", "Failed to save guest leaders", error);
          });
        }
      }
    }
  };

  const renderTabContent = () => {
    const tabs = {
      general: <GeneralSettings settings={settings} updateSetting={updateSetting} />,
      searching: <SearchingSettings settings={settings} updateSetting={updateSetting} />,
      projecting: <ProjectingSettings settings={settings} updateSetting={updateSetting} />,
      leaders: (
        <LeadersSettings
          settings={settings}
          updateSetting={updateSetting}
          leaders={leaders}
          selectedLeaderId={selectedLeaderId}
          onSelectedLeaderChange={setSelectedLeaderId}
          onAddLeader={handleAddLeader}
          onRemoveLeader={handleRemoveLeader}
          isGuest={isGuest}
        />
      ),
      sections: <SectionsSettings settings={settings} updateSetting={updateSetting} />,
      images: <ImagesSettings settings={settings} updateSetting={updateSetting} />,
      webserver: <WebServerSettings settings={settings} updateSetting={updateSetting} />,
      netdisplay: <NetDisplaySettings settings={settings} updateSetting={updateSetting} />,
      about: <AboutSettings />,
    };

    return (
      <div className="settings-tab-content p-3">
        {Object.entries(tabs).map(([key, value]) => (
          <div key={key} className={`settings-tab-pane ${activeTab === key ? "active" : ""}`}>
            {value}
          </div>
        ))}
      </div>
    );
  };

  return (
    <div className="settings-modal-backdrop">
      <div ref={dialogRef} className={`settings-modal-dialog${isMaximized ? " maximized" : ""}`} onClick={(e) => e.stopPropagation()}>
        <div className="settings-modal-header" onMouseDown={handleMouseDown}>
          <h5 className="settings-modal-title">{t("Settings")}</h5>
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
            <button type="button" className="btn-close" onClick={onClose} aria-label="Close"></button>
          </div>
        </div>
        <div className="settings-modal-body">
          <ul className="nav nav-tabs">
            <li className="nav-item">
              <a className={`nav-link ${activeTab === "general" ? "active" : ""}`} href="#" onClick={() => setActiveTab("general")}>
                {t("SettingsPageGeneral")}
              </a>
            </li>
            <li className="nav-item">
              <a className={`nav-link ${activeTab === "searching" ? "active" : ""}`} href="#" onClick={() => setActiveTab("searching")}>
                {t("SettingsPageSearching")}
              </a>
            </li>
            <li className="nav-item">
              <a className={`nav-link ${activeTab === "projecting" ? "active" : ""}`} href="#" onClick={() => setActiveTab("projecting")}>
                {t("SettingsPageProjecting")}
              </a>
            </li>
            <li className="nav-item">
              <a className={`nav-link ${activeTab === "images" ? "active" : ""}`} href="#" onClick={() => setActiveTab("images")}>
                {t("SettingsPageImages")}
              </a>
            </li>
            <li className="nav-item">
              <a className={`nav-link ${activeTab === "leaders" ? "active" : ""}`} href="#" onClick={() => setActiveTab("leaders")}>
                {t("SettingsPageLeaders")}
              </a>
            </li>
            <li className="nav-item">
              <a className={`nav-link ${activeTab === "sections" ? "active" : ""}`} href="#" onClick={() => setActiveTab("sections")}>
                {t("SettingsPageSections")}
              </a>
            </li>
            {!!window.electronAPI && (
              <li className="nav-item">
                <a className={`nav-link ${activeTab === "webserver" ? "active" : ""}`} href="#" onClick={() => setActiveTab("webserver")}>
                  {t("SettingsPageWebServer")}
                </a>
              </li>
            )}
            {!!window.electronAPI && (
              <li className="nav-item">
                <a className={`nav-link ${activeTab === "netdisplay" ? "active" : ""}`} href="#" onClick={() => setActiveTab("netdisplay")}>
                  {t("SettingsPageNetDisplay")}
                </a>
              </li>
            )}
            <li className="nav-item">
              <a className={`nav-link ${activeTab === "about" ? "active" : ""}`} href="#" onClick={() => setActiveTab("about")}>
                {t("SettingsPageAbout")}
                {hasUpdate && <span className="update-dot update-dot-inline ms-1" />}
              </a>
            </li>
          </ul>
          {renderTabContent()}
        </div>
        <div className="settings-modal-footer">
          {(!!window.electronAPI?.logs || onOpenLogs) && (
            <button
              type="button"
              className="btn btn-outline-secondary settings-log-button"
              onClick={() => {
                if (window.electronAPI?.logs) {
                  window.electronAPI.logs.openWindow();
                } else {
                  onOpenLogs?.();
                }
                onClose();
              }}
              title={t("ViewBackendLogs")}
            >
              <i className="fa fa-terminal me-1"></i>
              {t("Logs")}
            </button>
          )}
          <button type="button" className="btn btn-outline-danger settings-reset-button" onClick={handleResetToDefaults} title={t("ResetToDefaults")}>
            <i className="fa fa-undo me-1"></i>
            {t("ResetToDefaults")}
          </button>
          <div className="settings-footer-spacer"></div>
          <button type="button" className="btn btn-secondary" title={tt("settings_cancel")} onClick={handleCancel}>
            {t("Cancel")}
          </button>
          <button type="button" className="btn btn-primary" title={tt("settings_ok")} onClick={handleOk} disabled={saving}>
            {saving && <span className="spinner-border spinner-border-sm me-1" role="status" aria-hidden="true"></span>}
            {t("OK")}
          </button>
        </div>
        {!isMobile && !isMaximized && <div className="dialog-resize-handle" onMouseDown={handleResizeMouseDown} />}
      </div>
    </div>
  );
};

export default SettingsForm;
