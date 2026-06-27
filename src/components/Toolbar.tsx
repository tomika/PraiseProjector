import React, { useEffect, useRef, useState } from "react";
import { Icon, IconType } from "../services/IconService";
import { useLocalization } from "../localization/LocalizationContext";
import { useTooltips } from "../localization/TooltipContext";
import { useUpdate } from "../contexts/UpdateContext";

interface ToolbarProps {
  onSettingsClick: () => void;
  onLoadSong?: () => void;
  onSaveSong?: () => void;
  onNewSong?: () => void;
  onPrint?: () => void;
  onImport?: () => void;
  onLaunchViewer?: () => void;
  onSwitchToMobileView?: () => void;
  canLoadSong?: boolean;
  canSaveSong?: boolean;
}

const Toolbar: React.FC<ToolbarProps> = ({
  onSettingsClick,
  onLoadSong,
  onSaveSong,
  onNewSong,
  onPrint,
  onImport,
  onLaunchViewer,
  onSwitchToMobileView,
  canLoadSong,
  canSaveSong,
}) => {
  const { t } = useLocalization();
  const { tt } = useTooltips();
  const { hasUpdate } = useUpdate();
  const [showViewerMenu, setShowViewerMenu] = useState(false);
  const viewerMenuRef = useRef<HTMLDivElement>(null);
  const loadDisabled = canLoadSong === false;
  const saveDisabled = canSaveSong === false;

  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      if (viewerMenuRef.current && !viewerMenuRef.current.contains(event.target as Node)) {
        setShowViewerMenu(false);
      }
    };

    if (showViewerMenu) {
      document.addEventListener("mousedown", handleClickOutside);
    }
    return () => {
      document.removeEventListener("mousedown", handleClickOutside);
    };
  }, [showViewerMenu]);

  const handleLaunchViewerClick = () => {
    setShowViewerMenu(false);
    onLaunchViewer?.();
  };

  const handleMobileViewClick = () => {
    setShowViewerMenu(false);
    onSwitchToMobileView?.();
  };

  return (
    <div className="btn-toolbar" role="toolbar">
      <button
        type="button"
        className="btn btn-light"
        aria-label="Load Song"
        title={tt("toolbar_reload_song")}
        disabled={loadDisabled}
        onClick={onLoadSong}
      >
        <Icon type={IconType.LOAD} />
      </button>
      <button
        type="button"
        className="btn btn-light"
        aria-label="Save Song"
        title={tt("toolbar_save_song")}
        disabled={saveDisabled}
        onClick={onSaveSong}
      >
        <Icon type={IconType.SAVE} />
      </button>
      <button className="btn btn-light" aria-label="New Song" title={tt("toolbar_new_song")} onClick={onNewSong}>
        <Icon type={IconType.NEW} />
      </button>
      <button className="btn btn-light" aria-label="Import from Word" title={tt("toolbar_import_word")} onClick={onImport}>
        <Icon type={IconType.IMPORT} />
      </button>
      <button className="btn btn-light" aria-label="Print" title={tt("toolbar_print")} onClick={onPrint}>
        <Icon type={IconType.PRINT} />
      </button>
      <div className="btn-group position-relative toolbar-viewer-group" ref={viewerMenuRef}>
        <button className="btn btn-light" aria-label="Launch Viewer" title={tt("toolbar_launch_browser")} onClick={handleLaunchViewerClick}>
          <Icon type={IconType.VIEWER} />
        </button>
        <button
          type="button"
          className="btn btn-light dropdown-toggle-split sync-menu-toggle toolbar-viewer-menu-toggle"
          aria-label={t("ViewerMenu")}
          aria-expanded={showViewerMenu}
          title={t("ViewerMenu")}
          onClick={() => setShowViewerMenu(!showViewerMenu)}
        >
          <span className="sync-menu-indicator">{"\u25BE"}</span>
        </button>
        {showViewerMenu && (
          <div className="dropdown-menu show sync-dropdown-menu toolbar-viewer-dropdown-menu">
            <button type="button" className="dropdown-item" onClick={handleLaunchViewerClick}>
              {t("MenuSessionManagement")}
            </button>
            <button type="button" className="dropdown-item" onClick={handleMobileViewClick}>
              {t("MenuMobileView")}
            </button>
          </div>
        )}
      </div>
      <button
        type="button"
        className="btn btn-light position-relative"
        aria-label="Settings"
        title={tt("toolbar_settings")}
        onClick={onSettingsClick}
      >
        <Icon type={IconType.SETTINGS} />
        {hasUpdate && <span className="update-dot update-dot-abs" />}
      </button>
    </div>
  );
};

export default Toolbar;
