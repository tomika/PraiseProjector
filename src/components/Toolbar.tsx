import React, { useRef } from "react";
import { Icon, IconType } from "../services/IconService";
import { useTooltips } from "../localization/TooltipContext";
import { useUpdate } from "../contexts/UpdateContext";

interface ToolbarProps {
  onSettingsClick: () => void;
  onLoadSong?: () => void;
  onSaveSong?: () => void;
  onNewSong?: () => void;
  onPrint?: () => void;
  onImport?: () => void;
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
  onSwitchToMobileView,
  canLoadSong,
  canSaveSong,
}) => {
  const { tt } = useTooltips();
  const { hasUpdate } = useUpdate();
  const settingsButtonRef = useRef<HTMLButtonElement>(null);
  const loadDisabled = canLoadSong === false;
  const saveDisabled = canSaveSong === false;

  const handleMobileViewClick = () => {
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
      <button className="btn btn-light" aria-label="Mobile View" title={tt("toolbar_mobile_view")} onClick={handleMobileViewClick}>
        <Icon type={IconType.VIEWER} />
      </button>
      <button
        type="button"
        className="btn btn-light position-relative"
        ref={settingsButtonRef}
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
