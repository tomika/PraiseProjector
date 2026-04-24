import React, { useMemo } from "react";
import { Settings } from "../../types";
import { useLocalization } from "../../localization/LocalizationContext";
import { useProjectorRenderDims } from "../../state/CurrentSongStore";
import "./NetDisplaySettings.css";
import SafeSlider from "../SafeSlider";

interface NetDisplaySettingsProps {
  settings: Settings;
  updateSetting: <K extends keyof Settings>(key: K, value: Settings[K]) => void;
}

const TRANSITION_TYPE_OPTIONS = ["linear", "ease", "ease-in", "ease-out", "ease-in-out"] as const;
type TransitionTypeOption = (typeof TRANSITION_TYPE_OPTIONS)[number];

const NET_DISPLAY_RESOLUTION_PRESETS: Array<{ value: string; label: string; width: number; height: number }> = [
  { value: "640x480", label: "480p (4:3) – 640×480", width: 640, height: 480 },
  { value: "854x480", label: "480p (16:9) – 854×480", width: 854, height: 480 },
  { value: "1280x720", label: "720p HD – 1280×720", width: 1280, height: 720 },
  { value: "1920x1080", label: "1080p Full HD – 1920×1080", width: 1920, height: 1080 },
  { value: "3840x2160", label: "4K UHD – 3840×2160", width: 3840, height: 2160 },
];

const TRANSITION_TYPE_LABELS = {
  linear: "NetDisplayTransitionTypeLinear",
  ease: "NetDisplayTransitionTypeEase",
  "ease-in": "NetDisplayTransitionTypeEaseIn",
  "ease-out": "NetDisplayTransitionTypeEaseOut",
  "ease-in-out": "NetDisplayTransitionTypeEaseInOut",
} as const;

type TransitionTypeLabels = typeof TRANSITION_TYPE_LABELS;
type TransitionTypeLabelValue = TransitionTypeLabels[keyof TransitionTypeLabels];

const TRANSITION_TYPE_CURVES: Record<TransitionTypeOption, string> = {
  linear: "M6 26 L58 6",
  ease: "M6 26 C 16 26, 12 6, 58 6",
  "ease-in": "M6 26 C 36 26, 48 26, 58 6",
  "ease-out": "M6 26 C 16 6, 28 6, 58 6",
  "ease-in-out": "M6 26 C 26 26, 38 6, 58 6",
};

function getTransitionTypeLabel(type: string): TransitionTypeLabelValue {
  const key = type as keyof TransitionTypeLabels;
  return TRANSITION_TYPE_LABELS[key] ?? "NetDisplayTransitionTypeLinear";
}

function isTransitionTypeOption(type: string): type is TransitionTypeOption {
  return TRANSITION_TYPE_OPTIONS.includes(type as TransitionTypeOption);
}

const NetDisplaySettings: React.FC<NetDisplaySettingsProps> = ({ settings, updateSetting }) => {
  const { t } = useLocalization();
  const projectorRenderDims = useProjectorRenderDims();

  const netDisplayResolution = settings.netDisplayResolution ?? "1920x1080";
  const netDisplayTransitionType = isTransitionTypeOption(settings.netDisplayTransitionType ?? "") ? settings.netDisplayTransitionType : "linear";
  const netDisplayUseJpegCompression = settings.netDisplayUseJpegCompression ?? true;
  const netDisplayJpegQuality = Math.max(1, Math.min(100, settings.netDisplayJpegQuality || 70));
  const netDisplayImageScale = Math.round(Math.max(0.1, Math.min(1, settings.netDisplayImageScale || 1)) * 100);
  const netDisplayScaledWidth = Math.max(1, Math.round(projectorRenderDims.width * (netDisplayImageScale / 100)));
  const netDisplayScaledHeight = Math.max(1, Math.round(projectorRenderDims.height * (netDisplayImageScale / 100)));

  const netDisplayTransitionMs = useMemo(() => {
    if (typeof settings.netDisplayTransient === "boolean") {
      return settings.netDisplayTransient ? 500 : 0;
    }
    if (typeof settings.netDisplayTransient !== "number" || !Number.isFinite(settings.netDisplayTransient)) {
      return 200;
    }
    return Math.max(0, Math.min(500, Math.round(settings.netDisplayTransient)));
  }, [settings.netDisplayTransient]);

  return (
    <div className="net-display-settings">
      <div className="form-group">
        <label htmlFor="netDisplayResolution">{t("NetDisplayResolution")}</label>
        <select
          id="netDisplayResolution"
          className="form-select form-select-sm"
          value={netDisplayResolution}
          onChange={(e) => updateSetting("netDisplayResolution", e.target.value)}
        >
          {NET_DISPLAY_RESOLUTION_PRESETS.map((p) => (
            <option key={p.value} value={p.value}>
              {p.label}
            </option>
          ))}
        </select>
        <small className="form-text text-muted">{t("NetDisplayResolutionHelp")}</small>
      </div>

      <div className="form-check mb-2">
        <input
          className="form-check-input"
          type="checkbox"
          id="netDisplayUseJpegCompression"
          checked={netDisplayUseJpegCompression}
          onChange={(e) => updateSetting("netDisplayUseJpegCompression", e.target.checked)}
        />
        <label className="form-check-label" htmlFor="netDisplayUseJpegCompression">
          {t("NetDisplayUseJpegCompression")}
        </label>
      </div>

      <div className="form-group">
        <label htmlFor="netDisplayJpegQuality" className={netDisplayUseJpegCompression ? "" : "text-muted"}>
          {t("NetDisplayJpegQuality")}
        </label>
        <div className="d-flex align-items-center gap-2">
          <SafeSlider
            className="form-range flex-grow-1"
            id="netDisplayJpegQuality"
            min={1}
            max={100}
            step={1}
            value={netDisplayJpegQuality}
            disabled={!netDisplayUseJpegCompression}
            onChange={(e) => updateSetting("netDisplayJpegQuality", parseInt(e.target.value, 10))}
          />
          <span className="small text-muted">{netDisplayJpegQuality}%</span>
        </div>
        <small className="form-text text-muted">{t("NetDisplayJpegQualityHelp")}</small>
      </div>

      <div className="form-group">
        <label htmlFor="netDisplayImageScale">{t("NetDisplayImageScale")}</label>
        <div className="d-flex align-items-center gap-2">
          <SafeSlider
            className="form-range flex-grow-1"
            id="netDisplayImageScale"
            min={10}
            max={100}
            step={5}
            value={netDisplayImageScale}
            onChange={(e) => updateSetting("netDisplayImageScale", parseInt(e.target.value, 10) / 100)}
          />
          <span className="small text-muted">{netDisplayImageScale}%</span>
        </div>
        <small className="form-text text-muted">
          {t("NetDisplayImageScaleHelp")} ({netDisplayScaledWidth}×{netDisplayScaledHeight})
        </small>
      </div>

      <div className="form-group">
        <label htmlFor="netDisplayTransient">{t("NetDisplayTransient")}</label>
        <div className="d-flex align-items-center gap-2">
          <SafeSlider
            className="form-range flex-grow-1"
            id="netDisplayTransient"
            min={0}
            max={500}
            step={10}
            value={netDisplayTransitionMs}
            onChange={(e) => updateSetting("netDisplayTransient", parseInt(e.target.value, 10))}
          />
          <span className="small text-muted">{netDisplayTransitionMs}ms</span>
        </div>
        <small className="form-text text-muted">{t("NetDisplayTransientHelp")}</small>
      </div>

      <div className="form-group">
        <label className={netDisplayTransitionMs > 0 ? "" : "text-muted"}>{t("NetDisplayTransitionType")}</label>
        <div className="net-display-transition-type-grid">
          {TRANSITION_TYPE_OPTIONS.map((type) => {
            const selected = netDisplayTransitionType === type;
            return (
              <button
                key={type}
                type="button"
                className={`net-display-transition-type-btn${selected ? " selected" : ""}`}
                title={t(getTransitionTypeLabel(type))}
                aria-label={t(getTransitionTypeLabel(type))}
                disabled={netDisplayTransitionMs <= 0}
                onClick={() => updateSetting("netDisplayTransitionType", type)}
              >
                <svg viewBox="0 0 64 32" className="net-display-transition-type-icon" aria-hidden="true" focusable="false">
                  <line x1="6" y1="26" x2="58" y2="26" className="axis" />
                  <line x1="6" y1="26" x2="6" y2="6" className="axis" />
                  <path d={TRANSITION_TYPE_CURVES[type]} className="curve" />
                </svg>
              </button>
            );
          })}
        </div>
      </div>
    </div>
  );
};

export default NetDisplaySettings;
