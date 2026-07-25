import React, { useSyncExternalStore } from "react";
import type { PerformanceFeatureMode, Settings } from "../../types";
import { useLocalization, type StringKey } from "../../localization/LocalizationContext";
import { getClientPerformanceSnapshot, resetClientPerformanceProfile, subscribeClientPerformance } from "../../shared/clientPerformanceProfile";

interface PerformanceSettingsProps {
  settings: Settings;
  updateSetting: <K extends keyof Settings>(key: K, value: Settings[K]) => void;
}

function FeatureModeSelect({
  id,
  value,
  onChange,
  t,
}: {
  id: string;
  value: PerformanceFeatureMode;
  onChange: (value: PerformanceFeatureMode) => void;
  t: (key: StringKey) => string;
}) {
  return (
    <select id={id} className="form-select" value={value} onChange={(event) => onChange(event.target.value as PerformanceFeatureMode)}>
      <option value="off">{t("PerformanceModeOff")}</option>
      <option value="auto">{t("PerformanceModeAuto")}</option>
      <option value="on">{t("PerformanceModeOn")}</option>
    </select>
  );
}

const PerformanceSettings: React.FC<PerformanceSettingsProps> = ({ settings, updateSetting }) => {
  const { t } = useLocalization();
  const profile = useSyncExternalStore(subscribeClientPerformance, getClientPerformanceSnapshot, getClientPerformanceSnapshot);
  const isMeasurementPending = !profile.chordProMeasured || !profile.projectionMeasured;

  const profileState = (measured: boolean, slow: boolean, sampleCount: number, medianMs: number | null) => {
    const state = !measured
      ? sampleCount === 0
        ? t("PerformanceWaitingForUsage")
        : t("PerformanceMeasuring")
      : slow
        ? t("PerformanceSlow")
        : t("PerformanceFast");
    const median = medianMs === null ? "—" : `${Math.round(medianMs)} ms`;
    return `${state} · ${sampleCount}/5 · ${t("PerformanceMedian")}: ${median}`;
  };

  return (
    <div className="container-fluid performance-settings">
      <section className="mb-4">
        <h6>{t("PerformanceAutomaticOptimization")}</h6>
        <p className="text-muted small mb-2">{t("PerformanceAutomaticOptimizationDescription")}</p>
        <div className="border rounded p-3">
          <div>
            <strong>{t("PerformanceChordProProfile")}:</strong>{" "}
            {profileState(profile.chordProMeasured, profile.chordProSlow, profile.chordProSampleCount, profile.chordProMedianRenderMs)}
          </div>
          <div className="mt-1">
            <strong>{t("PerformanceProjectionProfile")}:</strong>{" "}
            {profileState(profile.projectionMeasured, profile.projectionSlow, profile.projectionSampleCount, profile.projectionMedianRenderMs)}
          </div>
          {isMeasurementPending && <div className="alert alert-info small mt-3 mb-0">{t("PerformanceMeasurementPendingDescription")}</div>}
          <button type="button" className="btn btn-sm btn-outline-secondary mt-3" onClick={resetClientPerformanceProfile}>
            {t("PerformanceClearMeasurements")}
          </button>
          <small className="form-text text-muted d-block">{t("PerformanceClearMeasurementsDescription")}</small>
        </div>
      </section>

      <section className="mb-4">
        <h6>{t("PerformanceMainView")}</h6>
        <div className="form-group">
          <label htmlFor="fullViewChordProPageTurnMode">{t("PerformanceFullViewPageTurn")}</label>
          <FeatureModeSelect
            id="fullViewChordProPageTurnMode"
            value={settings.fullViewChordProPageTurnMode}
            onChange={(value) => updateSetting("fullViewChordProPageTurnMode", value)}
            t={t}
          />
          <small className="form-text text-muted">{t("PerformanceFullViewPageTurnDescription")}</small>
        </div>

        <div className="form-group">
          <label htmlFor="playlistProjectionCheckMode">{t("PerformancePlaylistProjectionCheck")}</label>
          <FeatureModeSelect
            id="playlistProjectionCheckMode"
            value={settings.playlistProjectionCheckMode}
            onChange={(value) => updateSetting("playlistProjectionCheckMode", value)}
            t={t}
          />
          <small className="form-text text-muted">{t("PerformancePlaylistProjectionCheckDescription")}</small>
        </div>

        {settings.playlistProjectionCheckMode === "on" && (
          <div className="form-group">
            <label htmlFor="playlistUpdateMode">{t("PlaylistStateUpdateMode")}</label>
            <select
              className="form-select"
              id="playlistUpdateMode"
              value={settings.displayPlaylistUpdateInterval}
              onChange={(event) => updateSetting("displayPlaylistUpdateInterval", Number.parseInt(event.target.value, 10))}
            >
              <option value="500">{t("Slow")}</option>
              <option value="100">{t("Normal")}</option>
              <option value="20">{t("Fast")}</option>
            </select>
          </div>
        )}

        <div className="form-group">
          <label htmlFor="projectionRenderQualityMode">{t("PerformanceProjectionRenderQuality")}</label>
          <select
            id="projectionRenderQualityMode"
            className="form-select"
            value={settings.projectionRenderQualityMode}
            onChange={(event) => updateSetting("projectionRenderQualityMode", event.target.value as Settings["projectionRenderQualityMode"])}
          >
            <option value="performance">{t("PerformanceProjectionRenderPerformance")}</option>
            <option value="auto">{t("PerformanceModeAuto")}</option>
            <option value="quality">{t("PerformanceProjectionRenderNative")}</option>
          </select>
          <small className="form-text text-muted">{t("PerformanceProjectionRenderQualityDescription")}</small>
        </div>

        <div className="form-group">
          <label htmlFor="projectedImageCacheMode">{t("PerformanceProjectedImageCache")}</label>
          <FeatureModeSelect
            id="projectedImageCacheMode"
            value={settings.projectedImageCacheMode}
            onChange={(value) => updateSetting("projectedImageCacheMode", value)}
            t={t}
          />
          <small className="form-text text-muted">{t("PerformanceProjectedImageCacheDescription")}</small>
        </div>
      </section>

      <section className="mb-4">
        <h6>{t("PerformanceClientView")}</h6>
        <div className="form-group">
          <label htmlFor="clientViewPageTurnMode">{t("PerformanceClientViewPageTurn")}</label>
          <FeatureModeSelect
            id="clientViewPageTurnMode"
            value={settings.clientViewPageTurnMode}
            onChange={(value) => updateSetting("clientViewPageTurnMode", value)}
            t={t}
          />
          <small className="form-text text-muted">{t("PerformanceClientViewPageTurnDescription")}</small>
        </div>

        <div className="form-group">
          <label htmlFor="clientViewLivePitchPreviewMode">{t("PerformanceLivePitchPreview")}</label>
          <FeatureModeSelect
            id="clientViewLivePitchPreviewMode"
            value={settings.clientViewLivePitchPreviewMode}
            onChange={(value) => updateSetting("clientViewLivePitchPreviewMode", value)}
            t={t}
          />
          <small className="form-text text-muted">{t("PerformanceLivePitchPreviewDescription")}</small>
        </div>
      </section>

      <section className="mb-4">
        <h6>{t("PerformanceGeneralAnimations")}</h6>
        <div className="form-group">
          <label htmlFor="uiAnimationMode">{t("PerformanceUiAnimations")}</label>
          <FeatureModeSelect
            id="uiAnimationMode"
            value={settings.uiAnimationMode}
            onChange={(value) => updateSetting("uiAnimationMode", value)}
            t={t}
          />
          <small className="form-text text-muted">{t("PerformanceUiAnimationsDescription")}</small>
        </div>
      </section>

      {window.electronAPI && (
        <section className="mb-2">
          <h6>{t("PerformanceElectron")}</h6>
          <div className="form-check">
            <input
              className="form-check-input"
              type="checkbox"
              id="disableHardwareAccelerationOnStartup"
              checked={settings.disableHardwareAccelerationOnStartup}
              onChange={(event) => updateSetting("disableHardwareAccelerationOnStartup", event.target.checked)}
            />
            <label className="form-check-label" htmlFor="disableHardwareAccelerationOnStartup">
              {t("SettingsDisableHardwareAccelerationOnStartup")}
            </label>
          </div>
          <small className="form-text text-muted">{t("SettingsDisableHardwareAccelerationOnStartupHint")}</small>
        </section>
      )}
    </div>
  );
};

export default PerformanceSettings;
