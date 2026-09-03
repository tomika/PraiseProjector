import React, { useCallback, useEffect, useRef, useState } from "react";
import { Settings } from "../../types";
import { useTheme, ThemeSetting } from "../../contexts/ThemeContext";
import { useLocalization, LanguageSetting } from "../../localization/LocalizationContext";
import { useAuth } from "../../contexts/AuthContext";
import { calculateAutoFontSize } from "../../hooks/useResponsiveFontSize";
import { cloudApi } from "../../../common/cloudApi";
import "./GeneralSettings.css";

/** Android pushes native events by calling this global directly (see MainActivity.sendDeviceMessage). */
type GlobalWindowWithHandler = { handleDeviceMessage?: (raw: string) => void };

interface GeneralSettingsProps {
  settings: Settings;
  updateSetting: <K extends keyof Settings>(key: K, value: Settings[K]) => void;
}

const GeneralSettings: React.FC<GeneralSettingsProps> = ({ settings, updateSetting }) => {
  const { themeSetting, setThemeSetting } = useTheme();
  const { languageSetting, setLanguageSetting, t } = useLocalization();
  const { token, isAuthenticated } = useAuth();
  const notificationHost = window.hostDevice;
  const canManageNotifications =
    typeof notificationHost?.enableNotification === "function" &&
    typeof notificationHost.isNotificationEnabled === "function" &&
    typeof notificationHost.disableNotification === "function" &&
    typeof notificationHost.retrievePreference === "function" &&
    typeof notificationHost.storePreference === "function";
  const [notificationsEnabled, setNotificationsEnabled] = useState(false);
  const [canTestNotifications, setCanTestNotifications] = useState(false);
  const [notificationBusy, setNotificationBusy] = useState(canManageNotifications);
  const [notificationStatus, setNotificationStatus] = useState("");
  // Set while an explicit user-driven toggle is in flight, so an incidental
  // refresh cannot overwrite the optimistic state it is about to produce.
  const notificationOperationRef = useRef(false);
  const isManualFontSize = settings.fontSizeMode === "manual";
  const screenMajorSize = Math.max(window.screen.width || 0, window.screen.height || 0);
  const autoFontSizePreview =
    settings.fontSizeMode === "auto-resolution-dpi"
      ? calculateAutoFontSize(screenMajorSize, window.devicePixelRatio || 1, "auto-resolution-dpi")
      : calculateAutoFontSize(screenMajorSize, window.devicePixelRatio || 1, "auto-resolution");

  const refreshNotificationState = useCallback(async () => {
    if (!canManageNotifications || !notificationHost || notificationOperationRef.current) return;
    try {
      const optedOut = (await Promise.resolve(notificationHost.retrievePreference!("notifsEnabled"))) === "false";
      const nativeEnabled = await Promise.resolve(notificationHost.isNotificationEnabled!());
      if (!notificationOperationRef.current) setNotificationsEnabled(!optedOut && nativeEnabled);
    } catch (error) {
      console.error("Notifications", "Failed to read native notification state", error);
    }
  }, [canManageNotifications, notificationHost]);

  useEffect(() => {
    if (!canManageNotifications) return;
    let active = true;
    void refreshNotificationState().then(() => {
      if (active) setNotificationBusy(false);
    });
    return () => {
      active = false;
    };
  }, [canManageNotifications, refreshNotificationState]);

  // The Android runtime-permission prompt is answered long after
  // enableNotification() returned, and the permission can also be revoked from
  // Android settings while the app sits in the background. Neither shows up in
  // the value the toggle optimistically stored, so re-read the native state on
  // the host's "notify" event and whenever the window comes back to the front.
  useEffect(() => {
    if (!canManageNotifications) return;
    let active = true;
    const refresh = () => {
      if (active) void refreshNotificationState();
    };
    const onVisibilityChange = () => {
      if (!document.hidden) refresh();
    };
    window.addEventListener("focus", refresh);
    document.addEventListener("visibilitychange", onVisibilityChange);

    // Chain rather than replace: other modules install their own handler the
    // same way (see hostDevicePpd.initHostDevicePpd).
    const globalWin = window as unknown as GlobalWindowWithHandler;
    const previous = globalWin.handleDeviceMessage;
    const ourHandler = (raw: string) => {
      previous?.(raw);
      try {
        if ((JSON.parse(raw) as { op?: string })?.op === "notify") refresh();
      } catch {
        /* malformed payloads are intentionally ignored */
      }
    };
    globalWin.handleDeviceMessage = ourHandler;

    return () => {
      active = false;
      window.removeEventListener("focus", refresh);
      document.removeEventListener("visibilitychange", onVisibilityChange);
      if (globalWin.handleDeviceMessage === ourHandler) globalWin.handleDeviceMessage = previous;
    };
  }, [canManageNotifications, refreshNotificationState]);

  useEffect(() => {
    let active = true;
    void Promise.resolve(notificationHost?.isDebugBuild?.())
      .then((isDebugBuild) => {
        if (active) setCanTestNotifications(isDebugBuild === true);
      })
      .catch(() => {
        if (active) setCanTestNotifications(false);
      });
    return () => {
      active = false;
    };
  }, [notificationHost]);

  const updateNotificationsEnabled = async (enabled: boolean) => {
    if (!canManageNotifications || !notificationHost || notificationBusy) return;
    notificationOperationRef.current = true;
    setNotificationBusy(true);
    setNotificationStatus("");
    try {
      if (enabled) {
        if (!token) return;
        // Publish the opt-in before native registration so a simultaneous
        // token refresh cannot observe the old opt-out and skip configuration.
        await Promise.resolve(notificationHost.storePreference!("notifsEnabled", "true"));
        const configured = await Promise.resolve(
          notificationHost.enableNotification!(token, "PraiseProjector", "PraiseProjector Notifications", 60, true)
        );
        if (!configured) await Promise.resolve(notificationHost.storePreference!("notifsEnabled", "false"));
        // Optimistic: with a permission prompt still open the native side cannot
        // report the outcome yet. The refresh effect above corrects this once the
        // user answers.
        setNotificationsEnabled(configured);
      } else {
        // Publish the opt-out first so no concurrent login/token refresh can
        // recreate the registration while native cleanup is running.
        await Promise.resolve(notificationHost.storePreference!("notifsEnabled", "false"));
        const disabled = await Promise.resolve(notificationHost.disableNotification!());
        if (!disabled) throw new Error("Native host rejected notification disable");
        setNotificationsEnabled(false);
      }
    } catch (error) {
      try {
        await Promise.resolve(notificationHost.storePreference!("notifsEnabled", enabled ? "false" : "true"));
      } catch {
        // Keep the original native operation error as the useful diagnostic.
      }
      console.error("Notifications", "Failed to update native notification state", error);
      setNotificationStatus(t("SettingsNotificationsFailed"));
    } finally {
      notificationOperationRef.current = false;
      setNotificationBusy(false);
    }
  };

  const sendTestNotification = async () => {
    setNotificationBusy(true);
    setNotificationStatus("");
    try {
      let result = await cloudApi.sendFcmTestNotification();
      if (result.attempted === 0 && token && notificationHost) {
        await Promise.resolve(notificationHost.enableNotification!(token, "PraiseProjector", "PraiseProjector Notifications", 60, false));
        for (let attempt = 0; attempt < 8 && result.attempted === 0; attempt += 1) {
          await new Promise((resolve) => window.setTimeout(resolve, 750));
          result = await cloudApi.sendFcmTestNotification();
        }
      }
      setNotificationStatus(result.sent > 0 ? t("SettingsNotificationTestSent") : t("SettingsNotificationTestUnavailable"));
    } catch (error) {
      console.error("Notifications", "FCM test request failed", error);
      setNotificationStatus(t("SettingsNotificationsFailed"));
    } finally {
      setNotificationBusy(false);
    }
  };

  return (
    <div className="container-fluid general-settings-root">
      <div className="row">
        <div className="col-12">
          <div className="form-group">
            <label htmlFor="themeSelect">{t("Theme")}</label>
            <select id="themeSelect" className="form-control" value={themeSetting} onChange={(e) => setThemeSetting(e.target.value as ThemeSetting)}>
              <option value="auto">{t("ThemeAuto")}</option>
              <option value="light">{t("ThemeLight")}</option>
              <option value="dark">{t("ThemeDark")}</option>
            </select>
            <small className="form-text text-muted">{t("ThemeDescription")}</small>
          </div>
          <div className="form-group">
            <label htmlFor="languageSelect">{t("Language")}</label>
            <select
              id="languageSelect"
              className="form-control"
              value={languageSetting}
              onChange={(e) => setLanguageSetting(e.target.value as LanguageSetting)}
            >
              <option value="auto">{t("LanguageAuto")}</option>
              <option value="en">English</option>
              <option value="hu">Magyar</option>
            </select>
            <small className="form-text text-muted">{t("LanguageDescription")}</small>
          </div>
          <div className="form-check">
            <input
              className="form-check-input"
              type="checkbox"
              id="useFontAwesomeIcons"
              checked={settings.useFontAwesomeIcons}
              onChange={(e) => updateSetting("useFontAwesomeIcons", e.target.checked)}
            />
            <label className="form-check-label" htmlFor="useFontAwesomeIcons">
              {t("SettingsUseFontAwesomeIcons")}
            </label>
          </div>
          <div className="form-group">
            <label htmlFor="fontSizeMode">{t("SettingsUIFontSizeMode")}</label>
            <select
              id="fontSizeMode"
              className="form-control"
              value={settings.fontSizeMode}
              onChange={(e) => {
                const mode = e.target.value as Settings["fontSizeMode"];
                updateSetting("fontSizeMode", mode);
              }}
            >
              <option value="manual">{t("SettingsUIFontSizeModeManual")}</option>
              <option value="auto-resolution">{t("SettingsUIFontSizeModeAutoResolution")}</option>
              <option value="auto-resolution-dpi">{t("SettingsUIFontSizeModeAutoResolutionDpi")}</option>
            </select>
            <small className="form-text text-muted">{t("SettingsUIFontSizeModeDescription")}</small>
          </div>
          <div className={`form-group ${isManualFontSize ? "" : "disabled"}`}>
            <label htmlFor="baseFontSize">{t("SettingsUIFontSize")}</label>
            <select
              id="baseFontSize"
              className="form-control"
              value={isManualFontSize ? settings.baseFontSize : autoFontSizePreview}
              onChange={(e) => updateSetting("baseFontSize", parseInt(e.target.value))}
              disabled={!isManualFontSize}
            >
              <option value="10">{t("SettingsFontSizeExtraSmall")}</option>
              <option value="12">{t("SettingsFontSizeSmall")}</option>
              <option value="14">{t("SettingsFontSizeMedium")}</option>
              <option value="16">{t("SettingsFontSizeNormal")}</option>
              <option value="18">{t("SettingsFontSizeLarge")}</option>
              <option value="20">{t("SettingsFontSizeExtraLarge")}</option>
              <option value="22">{t("SettingsFontSizeXXLarge")}</option>
            </select>
            <small className="form-text text-muted">{t("SettingsUIFontSizeDescription")}</small>
          </div>
          <div className="form-group">
            <label htmlFor="defaultChordSystem">{t("SettingsChordSystem")}</label>
            <select id="defaultChordSystem" className="form-control" value="G" disabled>
              <option value="G">{t("SettingsChordSystemGerman")}</option>
              <option value="S">{t("SettingsChordSystemStandard")}</option>
            </select>
          </div>
          <div className="form-check">
            <input
              className="form-check-input"
              type="checkbox"
              id="keepAwake"
              checked={settings.keepAwake}
              onChange={(e) => updateSetting("keepAwake", e.target.checked)}
            />
            <label className="form-check-label" htmlFor="keepAwake">
              {t("SettingsKeepAwake")}
            </label>
          </div>
          {window.hostDevice && (
            <div className="form-check">
              <input
                className="form-check-input"
                type="checkbox"
                id="fullscreen"
                checked={settings.fullscreen}
                onChange={(e) => updateSetting("fullscreen", e.target.checked)}
              />
              <label className="form-check-label" htmlFor="fullscreen">
                {t("SettingsFullscreen")}
              </label>
            </div>
          )}
          <div className="form-check">
            <input
              className="form-check-input"
              type="checkbox"
              id="hideChordsInEditor"
              checked={settings.hideChordsInReadonlyEditor}
              onChange={(e) => updateSetting("hideChordsInReadonlyEditor", e.target.checked)}
            />
            <label className="form-check-label" htmlFor="hideChordsInEditor">
              {t("SettingsHideChordsInEditor")}
            </label>
          </div>
          <div className="form-check">
            <input
              className="form-check-input"
              type="checkbox"
              id="showTooltips"
              checked={settings.showTooltips}
              onChange={(e) => updateSetting("showTooltips", e.target.checked)}
            />
            <label className="form-check-label" htmlFor="showTooltips">
              {t("SettingsShowTooltips")}
            </label>
          </div>
          <div className="form-group">
            <label htmlFor="serverPeekIntervalMinutes">{t("SettingsPeekIntervalMinutes")}</label>
            <input
              id="serverPeekIntervalMinutes"
              className="form-control"
              type="number"
              min={1}
              max={1440}
              step={1}
              value={settings.serverPeekIntervalMinutes}
              onChange={(e) => updateSetting("serverPeekIntervalMinutes", Math.max(1, parseInt(e.target.value || "0", 10) || 1))}
            />
            <small className="form-text text-muted">{t("SettingsPeekIntervalMinutesDescription")}</small>
          </div>
          <div className="form-group">
            <label htmlFor="syncDeclineTimeoutMinutes">{t("SettingsSyncDeclineTimeoutMinutes")}</label>
            <input
              id="syncDeclineTimeoutMinutes"
              className="form-control"
              type="number"
              min={0}
              max={1440}
              step={1}
              value={settings.syncDeclineTimeoutMinutes}
              onChange={(e) => updateSetting("syncDeclineTimeoutMinutes", Math.max(0, Math.min(1440, parseInt(e.target.value || "0", 10) || 0)))}
            />
            <small className="form-text text-muted">{t("SettingsSyncDeclineTimeoutMinutesDescription")}</small>
          </div>
          <div className="form-check">
            <input
              className="form-check-input"
              type="checkbox"
              id="showCloudNetworkErrorToasts"
              checked={settings.showCloudNetworkErrorToasts}
              onChange={(e) => updateSetting("showCloudNetworkErrorToasts", e.target.checked)}
            />
            <label className="form-check-label" htmlFor="showCloudNetworkErrorToasts">
              {t("SettingsShowCloudNetworkErrorToasts")}
            </label>
          </div>
          {canManageNotifications && (
            <div className="form-group">
              <div className="form-check">
                <input
                  className="form-check-input"
                  type="checkbox"
                  id="notificationsEnabled"
                  checked={notificationsEnabled}
                  disabled={notificationBusy || !isAuthenticated || !token}
                  onChange={(event) => void updateNotificationsEnabled(event.target.checked)}
                />
                <label className="form-check-label" htmlFor="notificationsEnabled">
                  {t("SettingsNotifications")}
                </label>
              </div>
              <small className="form-text text-muted">{t("SettingsNotificationsDescription")}</small>
              {canTestNotifications && notificationsEnabled && (
                <div className="mt-2">
                  <button
                    type="button"
                    className="btn btn-outline-secondary btn-sm"
                    disabled={notificationBusy}
                    onClick={() => void sendTestNotification()}
                  >
                    {t("SettingsNotificationTest")}
                  </button>
                </div>
              )}
              {notificationStatus && <small className="form-text text-muted">{notificationStatus}</small>}
            </div>
          )}
        </div>
      </div>
    </div>
  );
};

export default GeneralSettings;
