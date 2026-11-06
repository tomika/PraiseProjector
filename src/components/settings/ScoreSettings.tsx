import React, { useEffect, useState } from "react";
import type { Settings } from "../../types";
import { createDefaultScoreDefaults, normalizeScoreDefaults, type ScoreDefaults } from "../../../common/score-settings";
import { loadAbcjs } from "../../../chordpro/abcjs-lazy";
import { useLocalization, type StringKey } from "../../localization/LocalizationContext";

interface ScoreSettingsProps {
  settings: Settings;
  updateSetting: <K extends keyof Settings>(key: K, value: Settings[K]) => void;
  isActive: boolean;
}

const ScoreNumberInput: React.FC<{ id: string; label: string; value: number; min: number; step: number; onChange: (value: number) => void }> = ({
  id,
  label,
  value,
  min,
  step,
  onChange,
}) => {
  const [draft, setDraft] = useState({ value, text: String(value) });
  if (draft.value !== value) setDraft({ value, text: String(value) });
  return (
    <div className="col-md-4 mb-3">
      <label className="form-label" htmlFor={id}>
        {label}
      </label>
      <input
        type="number"
        className="form-control"
        id={id}
        min={min}
        step={step}
        required
        value={draft.text}
        onChange={(event) => {
          setDraft({ value, text: event.target.value });
          if (event.target.validity.valid) onChange(Number(event.target.value));
        }}
        onBlur={() => setDraft({ value, text: String(value) })}
      />
    </div>
  );
};

const ScoreSettings: React.FC<ScoreSettingsProps> = ({ settings, updateSetting, isActive }) => {
  const { t } = useLocalization();
  const [instruments, setInstruments] = useState<string[]>([]);
  const defaults = normalizeScoreDefaults(settings.scoreDefaults);

  useEffect(() => {
    if (!isActive) return;
    let cancelled = false;
    void loadAbcjs()
      .then((abcjs) => {
        if (!cancelled) setInstruments(abcjs.synth.instrumentIndexToName);
      })
      .catch((error) => console.error("Failed to load MIDI instrument names", error));
    return () => {
      cancelled = true;
    };
  }, [isActive]);

  const update = <K extends keyof ScoreDefaults>(key: K, value: ScoreDefaults[K]) => {
    updateSetting("scoreDefaults", normalizeScoreDefaults({ ...defaults, [key]: value }));
  };

  const instrument = (key: "program" | "bassprog" | "chordprog", label: StringKey) => (
    <div className="col-md-4 mb-3">
      <label className="form-label" htmlFor={`score-${key}`}>
        {t(label)}
      </label>
      <select className="form-select" id={`score-${key}`} value={defaults[key]} onChange={(event) => update(key, Number(event.target.value))}>
        {Array.from({ length: 128 }, (_, index) => (
          <option key={index} value={index}>
            {index}: {instruments[index]?.replace(/_/g, " ") ?? t("ScoreMidiInstrument")}
          </option>
        ))}
      </select>
    </div>
  );

  const number = (key: "swing" | "paddingtop" | "paddingbottom", label: StringKey, min: number, step: number) => (
    <ScoreNumberInput id={`score-${key}`} label={t(label)} value={defaults[key]} min={min} step={step} onChange={(value) => update(key, value)} />
  );

  return (
    <div className="container-fluid">
      <p className="text-muted">{t("ScoreDefaultsDescription")}</p>
      <section className="mb-4">
        <h6>{t("ScorePlayback")}</h6>
        <div className="row">
          {instrument("program", "ScoreMelodyInstrument")}
          {instrument("bassprog", "ScoreBassInstrument")}
          {instrument("chordprog", "ScoreChordInstrument")}
        </div>
        <div className="row">
          {(
            [
              ["bassvol", "ScoreBassVolume"],
              ["chordvol", "ScoreChordVolume"],
            ] as const
          ).map(([key, label]) => (
            <div key={key} className="col-md-6 mb-3">
              <label className="form-label" htmlFor={`score-${key}`}>
                {t(label)}: {defaults[key]}
              </label>
              <input
                type="range"
                className="form-range"
                id={`score-${key}`}
                min="0"
                max="127"
                step="1"
                value={defaults[key]}
                onChange={(event) => update(key, Number(event.target.value))}
              />
            </div>
          ))}
        </div>
        <div className="row align-items-end">
          {number("swing", "ScoreSwing", 0, 0.01)}
          <div className="col-md-8 mb-3">
            <input
              type="range"
              className="form-range"
              id="score-swing-slider"
              aria-label={t("ScoreSwing")}
              aria-describedby="score-swing-help"
              min="50"
              max="75"
              step="0.01"
              value={Math.max(50, Math.min(75, defaults.swing))}
              onChange={(event) => update("swing", Number(event.target.value))}
            />
          </div>
        </div>
        <p id="score-swing-help" className="text-muted small">
          {t("ScoreSwingDescription")}
        </p>
        {(
          [
            ["chordsOff", "ScoreChordsOff"],
            ["voicesOff", "ScoreVoicesOff"],
          ] as const
        ).map(([key, label]) => (
          <div className="form-check mb-2" key={key}>
            <input
              className="form-check-input"
              type="checkbox"
              id={`score-${key}`}
              checked={defaults[key]}
              onChange={(event) => update(key, event.target.checked)}
            />
            <label className="form-check-label" htmlFor={`score-${key}`}>
              {t(label)}
            </label>
          </div>
        ))}
      </section>
      <section className="mb-4">
        <h6>{t("ScoreAppearance")}</h6>
        <div className="row">
          {number("paddingtop", "ScorePaddingTop", 0, 1)}
          {number("paddingbottom", "ScorePaddingBottom", 0, 1)}
        </div>
        <p className="text-muted small">{t("ScoreSongDefaultsDescription")}</p>
      </section>
      <button type="button" className="btn btn-outline-secondary" onClick={() => updateSetting("scoreDefaults", createDefaultScoreDefaults())}>
        {t("ScoreResetDefaults")}
      </button>
    </div>
  );
};

export default ScoreSettings;
