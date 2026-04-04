import React from "react";
import { useLocalization } from "../../localization/LocalizationContext";
import { useSettings } from "../../contexts/SettingsContext";
import { cloudApi } from "../../../common/cloudApi";
import { useUpdate } from "../../contexts/UpdateContext";
import { getSettingsAboutLicenseSections } from "../../about-licenses";
import "./AboutSettings.css";

// Version is injected by Vite from package.json
declare const __APP_VERSION__: string;
declare const __APP_COMMIT__: string;
declare const __APP_SHOW_COMMIT__: boolean;

const AboutSettings: React.FC = () => {
  const { t } = useLocalization();
  const { settings, updateSettingWithAutoSave } = useSettings();
  const version = typeof __APP_VERSION__ !== "undefined" ? __APP_VERSION__ : "0.0.0";
  const commit = typeof __APP_COMMIT__ !== "undefined" ? __APP_COMMIT__ : "";
  const showCommit = typeof __APP_SHOW_COMMIT__ !== "undefined" ? __APP_SHOW_COMMIT__ : false;
  const versionDisplay = showCommit && commit ? `${version} (${commit})` : version;
  const isElectronRuntime = !!window.electronAPI;
  const selectedUpdateChannel = settings?.updateChannel ?? "stable";
  const licenseSections = getSettingsAboutLicenseSections(isElectronRuntime ? "full-electron" : "frontend-only");

  // Derive site URL from API base URL (remove the path portion)
  const apiBaseUrl = cloudApi.getBaseUrl();
  const siteUrl = apiBaseUrl.replace(/(https?:\/\/[^/]+).*/, "$1");

  const { updateAvailable, downloadProgress, updateDownloaded, checking, checkForUpdates, downloadUpdate, installUpdate } = useUpdate();

  const onUpdateChannelChange = (event: React.ChangeEvent<HTMLSelectElement>) => {
    const channel = event.target.value as "stable" | "testing";
    updateSettingWithAutoSave("updateChannel", channel);
  };

  const renderUpdateStatus = () => {
    if (!window.electronAPI) return null;

    if (updateDownloaded) {
      return (
        <p className="text-success mb-1">
          {t("UpdateDownloaded")} ({updateDownloaded.version})
        </p>
      );
    }
    if (downloadProgress !== null) {
      return (
        <>
          <p className="mb-1">
            {t("UpdateDownloading")} {Math.round(downloadProgress)}%
          </p>
          <progress className="about-update-progress-native mb-2" max={100} value={downloadProgress} />
        </>
      );
    }
    if (updateAvailable) {
      return (
        <p className="text-warning mb-1">
          {t("UpdateAvailable")} ({updateAvailable.version})
        </p>
      );
    }
    if (checking) {
      return <p className="text-muted mb-1">{t("UpdateChecking")}</p>;
    }
    return <p className="text-success mb-1">{t("UpdateUpToDate")}</p>;
  };

  const renderUpdateActions = () => {
    if (!window.electronAPI) return null;

    return (
      <p>
        {updateDownloaded ? (
          <button type="button" className="btn btn-success btn-sm me-2" onClick={installUpdate}>
            {t("UpdateInstall")}
          </button>
        ) : updateAvailable && downloadProgress === null ? (
          <button type="button" className="btn btn-primary btn-sm me-2" onClick={downloadUpdate}>
            {t("UpdateDownload")}
          </button>
        ) : null}
        <button type="button" className="btn btn-outline-secondary btn-sm" onClick={checkForUpdates} disabled={checking || downloadProgress !== null}>
          {t("UpdateCheckNow")}
        </button>
      </p>
    );
  };

  return (
    <div className="container-fluid">
      <h3>{t("AboutTitle")}</h3>
      <p>{t("AboutDescription")}</p>
      <p>{t("AboutVersion").replace("{version}", versionDisplay)}</p>
      {isElectronRuntime && (
        <div className="mb-3">
          <div className="d-flex align-items-center gap-2 flex-wrap">
            <label className="form-label mb-0" htmlFor="updateChannelSelect">
              {t("UpdateChannelLabel")}
            </label>
            <select
              id="updateChannelSelect"
              className="form-select form-select-sm w-auto"
              value={selectedUpdateChannel}
              onChange={onUpdateChannelChange}
            >
              <option value="stable">{t("UpdateChannelStable")}</option>
              <option value="testing">{t("UpdateChannelTesting")}</option>
            </select>
            {selectedUpdateChannel === "testing" ? <span className="badge text-bg-warning">{t("UpdateChannelTestingWarning")}</span> : null}
          </div>
        </div>
      )}
      {renderUpdateStatus()}
      {renderUpdateActions()}
      <p>
        {t("AboutMoreInfo")}{" "}
        <a href={siteUrl} target="_blank" rel="noopener noreferrer">
          {siteUrl.replace(/^https?:\/\//, "")}
        </a>
        .
      </p>
      <hr />
      <h5>{t("AboutLicensesTitle")}</h5>
      {licenseSections.map((section) => (
        <div key={section.id} className="mb-3">
          <div className="fw-semibold">{t(section.titleKey) || section.title}</div>
          <ul className="mb-0">
            {section.entries.map((entry) => (
              <li key={entry.name + entry.licenceUrl}>
                <a href={entry.url} target="_blank" rel="noopener noreferrer">
                  {entry.name}
                </a>{" "}
                (
                <a href={entry.licenceUrl} target="_blank" rel="noopener noreferrer">
                  {entry.licence}
                </a>
                )
              </li>
            ))}
          </ul>
        </div>
      ))}
      <p>
        <button
          type="button"
          className="btn btn-outline-secondary btn-sm"
          onClick={() => window.dispatchEvent(new CustomEvent("pp-open-eula-dialog"))}
        >
          {t("EulaViewLicense")}
        </button>
      </p>
    </div>
  );
};

export default AboutSettings;
