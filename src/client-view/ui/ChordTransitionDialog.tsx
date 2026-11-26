import { useEffect, useRef, useState, type CSSProperties, type MutableRefObject } from "react";
import { getChordSystem } from "../../../chordpro/chordpro_base";
import { playPianoChordSequence } from "../../../chordpro/midi";
import type { TransitionRecommendation } from "../../../chordpro/transition-instruction";
import { CHORD_TRANSITION_STYLES, type ChordTransitionStyle } from "../../../common/chord-transition-settings";
import { isAppModalOpen } from "../../hardware-input/modalGuard";
import { useLocalization } from "../../localization/LocalizationContext";
import { useClientViewState, useClientViewStore } from "../controller/ClientViewContext";
import { localizeTransitionChord, localizeTransitionKey, type SongTransitionDialog } from "../controller/songTransitions";
import { icon } from "./assets";

const STYLE_ICONS = {
  pop: "transition-electric-guitar.svg",
  cadential: "transition-harp.svg",
} satisfies Record<ChordTransitionStyle, string>;

export function ChordTransitionDialog({
  dialog,
  stopPlayback,
}: {
  dialog: SongTransitionDialog;
  stopPlayback: MutableRefObject<(() => void) | null>;
}) {
  const store = useClientViewStore();
  const { displaySettings } = useClientViewState();
  const { t } = useLocalization();
  const modal = useRef<HTMLDialogElement>(null);
  const timedOut = useRef(false);
  // Any touch, click or key inside the dialog keeps it open: the countdown stops for good.
  const [held, setHeld] = useState(false);
  const [playing, setPlaying] = useState<TransitionRecommendation | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<"play" | "save" | null>(null);
  const noteSystem = displaySettings.bb ? "S" : "G";
  const canSave = store.canSaveChordTransition(dialog);
  const { durationMs } = dialog;
  const keyRange = `${localizeTransitionKey(dialog.sourceKey, noteSystem)} → ${localizeTransitionKey(dialog.targetKey, noteSystem)}`;

  useEffect(() => {
    if (isAppModalOpen(undefined, "dialog.cv-chord-transition-modal")) {
      store.dismissChordTransition();
      return;
    }
    const element = modal.current;
    element?.showModal();
    return () => {
      element?.close();
      if (!timedOut.current) {
        stopPlayback.current?.();
        stopPlayback.current = null;
      }
    };
  }, [stopPlayback, store]);

  useEffect(() => {
    if (!durationMs || held) return;
    const timer = setTimeout(() => {
      timedOut.current = true;
      store.dismissChordTransition();
    }, durationMs);
    return () => clearTimeout(timer);
  }, [durationMs, held, store]);

  /** The dialog element itself is also the target of backdrop clicks; only its own box counts as inside. */
  const isInside = (event: { target: EventTarget; currentTarget: HTMLDialogElement; clientX: number; clientY: number }) => {
    if (event.target !== event.currentTarget) return true;
    const rect = event.currentTarget.getBoundingClientRect();
    return event.clientX >= rect.left && event.clientX <= rect.right && event.clientY >= rect.top && event.clientY <= rect.bottom;
  };

  const changeStyle = (style: ChordTransitionStyle) => {
    store.toggleChordTransitionStyle(style);
    if (playing) {
      stopPlayback.current?.();
      stopPlayback.current = null;
      setPlaying(null);
    }
    setError(null);
  };

  const play = (recommendation: TransitionRecommendation) => {
    stopPlayback.current?.();
    if (playing === recommendation) {
      stopPlayback.current = null;
      setPlaying(null);
      return;
    }
    const system = getChordSystem("S");
    const sequence = recommendation.chords.map((label) => {
      const chord = system.identifyChord(label);
      if (!chord) return [];
      const notes = system.chordNotes(chord, true);
      if (chord.bassNote != null) notes.unshift(chord.bassNote - 12);
      return notes;
    });
    if (sequence.some((notes) => !notes.length)) {
      setPlaying(null);
      setError("play");
      return;
    }
    setError(null);
    setPlaying(recommendation);
    stopPlayback.current = playPianoChordSequence(sequence, (played) => {
      stopPlayback.current = null;
      setPlaying(null);
      if (!played) setError("play");
    });
  };

  const save = async (recommendation: TransitionRecommendation) => {
    setSaving(true);
    setError(null);
    try {
      await store.saveChordTransition(dialog, recommendation);
    } catch {
      setError("save");
    } finally {
      setSaving(false);
    }
  };

  return (
    <dialog
      ref={modal}
      className="cv-dialog cv-chord-transition-modal"
      role="dialog"
      aria-modal="true"
      aria-labelledby="cv-chord-transition-title"
      aria-describedby="cv-chord-transition-keys"
      onPointerDown={(event) => {
        if (isInside(event)) setHeld(true);
      }}
      onKeyDown={(event) => {
        if (event.key !== "Escape") setHeld(true);
      }}
      onClick={(event) => {
        if (!isInside(event)) store.dismissChordTransition();
      }}
      onCancel={(event) => {
        event.preventDefault();
        store.dismissChordTransition();
      }}
    >
      <div className="cv-chord-transition-content">
        <header className="cv-chord-transition-header">
          <h2 id="cv-chord-transition-title">{t("ChordTransitionsTitle")}</h2>
          <div id="cv-chord-transition-keys" className="cv-chord-transition-keys" title={keyRange}>
            {keyRange}
          </div>
          <div className="cv-chord-transition-controls">
            {!dialog.saved && (
              <div className="cv-chord-transition-filters" role="group" aria-label={t("ChordTransitionsStyles")}>
                {CHORD_TRANSITION_STYLES.map((style) => {
                  const active = dialog.styles.includes(style);
                  const label = t(style === "pop" ? "ChordTransitionsPop" : "ChordTransitionsCadential");
                  return (
                    <button
                      key={style}
                      type="button"
                      title={label}
                      aria-label={label}
                      aria-pressed={active}
                      disabled={saving || (active && dialog.styles.length === 1)}
                      onClick={() => changeStyle(style)}
                    >
                      <img src={icon(STYLE_ICONS[style])} alt="" width={22} height={22} />
                    </button>
                  );
                })}
              </div>
            )}
          </div>
        </header>
        <ul className="cv-chord-transition-list">
          {dialog.recommendations.map((recommendation) => (
            <li key={recommendation.chords.join(" ")} className="cv-chord-transition-row">
              <button type="button" className="cv-chord-transition-recommendation" onClick={() => setHeld(true)}>
                <span className="cv-chord-transition-chords">
                  {recommendation.chords.map((chord, index) => (
                    <span
                      key={index}
                      className={
                        index === 0
                          ? "cv-chord-transition-source"
                          : index === recommendation.chords.length - 1
                            ? "cv-chord-transition-target"
                            : undefined
                      }
                    >
                      {index > 0 && <span className="cv-chord-transition-arrow">→</span>}
                      {localizeTransitionChord(chord, noteSystem)}
                    </span>
                  ))}
                </span>
                <span className="cv-chord-transition-style">
                  {t(recommendation.style === "pop" ? "ChordTransitionsPop" : "ChordTransitionsCadential")}
                </span>
                <span
                  className="cv-chord-transition-rating"
                  role="img"
                  aria-label={t("ChordTransitionsRating").replace("{0}", String(recommendation.rating))}
                >
                  {Array.from({ length: 5 }, (_, index) => (
                    <span key={index} aria-hidden="true" className={index < recommendation.rating ? "active" : undefined}>
                      ♪
                    </span>
                  ))}
                </span>
              </button>
              <button
                type="button"
                className="cv-chord-transition-action"
                aria-pressed={playing === recommendation}
                title={t(playing === recommendation ? "ChordTransitionsStop" : "ChordTransitionsPlay")}
                aria-label={t(playing === recommendation ? "ChordTransitionsStop" : "ChordTransitionsPlay")}
                onClick={() => play(recommendation)}
              >
                {playing === recommendation ? <span className="cv-chord-transition-stop" /> : <span className="cv-chord-transition-play" />}
              </button>
              {canSave && (
                <button
                  type="button"
                  className="cv-chord-transition-action"
                  title={t("ChordTransitionsSave")}
                  aria-label={t("ChordTransitionsSave")}
                  disabled={saving}
                  onClick={() => void save(recommendation)}
                >
                  <img src={icon("save.svg")} alt="" />
                </button>
              )}
            </li>
          ))}
        </ul>
        {!dialog.recommendations.length && (
          <p className="cv-chord-transition-empty" role="status">
            {t("ChordTransitionsEmptyStyles")}
          </p>
        )}
        {error && (
          <p className="cv-chord-transition-error" role="alert">
            {t(error === "play" ? "ChordTransitionsPlayError" : "ChordTransitionsSaveError")}
          </p>
        )}
      </div>
      {/* Outside the scrolling content, so it stays in the corner; last in DOM order, so it does not take the initial focus. */}
      <button
        type="button"
        className="cv-chord-transition-close"
        title={t("Close")}
        aria-label={t("Close")}
        onClick={() => store.dismissChordTransition()}
      >
        &times;
      </button>
      {durationMs > 0 && (
        <div
          className={held ? "cv-chord-transition-timer held" : "cv-chord-transition-timer"}
          aria-hidden="true"
          style={{ "--cv-transition-duration": `${durationMs}ms` } as CSSProperties}
        >
          <div />
        </div>
      )}
    </dialog>
  );
}
