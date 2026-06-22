/**
 * InstructionsEditor — the single, shared ChordPro instructions editor used by
 * BOTH the Electron desktop GUI and the client-view.
 *
 * It owns the duplicated, fiddly part: the read-only {@link ChordProEditor} +
 * `setupInstructionsEditor` lifecycle, dark-mode propagation, touch routing,
 * panel-collapse logic and the Clear / Reset / Save actions. Everything visual
 * is driven by props so each host can supply its own look:
 *   - `variant` selects the CSS skin ("desktop" base styling vs the "cv" reskin
 *     applied through the `.instructions-editor--cv` modifier).
 *   - `action` renders the footer buttons as text labels (desktop) or icons (cv).
 *
 * IMPORTANT: this component must stay free of Electron imports so the client-view
 * bundle served by the webserver can include it. Localization is injected via
 * props (`title`, `action`, `collapse`, `localeHandler`) rather than imported.
 */

import { useEffect, useRef, useState } from "react";
import type { SongData } from "../../common/pp-types";
import type { ChordSystemCode } from "../../chordpro/chordpro_base";
import { getChordSystem } from "../../chordpro/chordpro_base";
import { ChordProEditor } from "../../chordpro/chordpro_editor";
import { routeTouchEventsToMouse } from "../../common/utils";
import { ensureChordProAssets } from "../utils/loadChordProAssets";
import "./InstructionsEditor.css";

const NARROW_SCREEN_COLLAPSE_RIGHT_PX = 900;
const EYE_OPEN = "👁";
const EYE_CLOSED = "🙈";

type ActionConfig =
  | { style: "text"; clearLabel: string; resetLabel: string; saveLabel: string; saveTitle?: string }
  | {
      style: "icon";
      clearIcon: string;
      resetIcon: string;
      saveIcon: string;
      clearTitle: string;
      resetTitle: string;
      saveTitle: string;
    };

interface CollapseStrings {
  /** Short caption shown next to the eye glyph (desktop only). */
  short: string;
  /** Accessible label/tooltip while the panel is collapsed (clicking shows it). */
  showLabel: string;
  /** Accessible label/tooltip while the panel is visible (clicking hides it). */
  hideLabel: string;
}

export interface InstructionsEditorProps {
  /** Selects the CSS skin: desktop base styling or the client-view reskin. */
  variant: "desktop" | "cv";
  /** Song to render in the source/preview panes. `null` while loading or on error. */
  songData: SongData | null;
  /** Instructions to load into the editor when it (re)mounts. */
  initialInstructions: string;
  loading?: boolean;
  error?: string | null;
  loadingText?: string;
  /** Controlled dark-mode flag (desktop derives it from data-theme, cv from state). */
  isDark: boolean;
  /** Optional localizer for the editor's internally-rendered strings. */
  localeHandler?: (s: string) => string;

  title: string;
  closeLabel: string;

  collapse: { showText: boolean; left: CollapseStrings; middle: CollapseStrings; right: CollapseStrings };

  /** When provided, renders the "store in profile" checkbox (desktop only). */
  storeInProfile?: { label: string; isInProfile: boolean; defaultChecked?: boolean };

  action: ActionConfig;

  onSave: (instructions: string, storeInProfile: boolean) => void | Promise<void>;
  onClose: () => void;
}

export function InstructionsEditor({
  variant,
  songData,
  initialInstructions,
  loading = false,
  error = null,
  loadingText,
  isDark,
  localeHandler,
  title,
  closeLabel,
  collapse,
  storeInProfile,
  action,
  onSave,
  onClose,
}: InstructionsEditorProps) {
  const [storeChecked, setStoreChecked] = useState(storeInProfile?.defaultChecked ?? true);
  const [leftCollapsed, setLeftCollapsed] = useState(false);
  const [middleCollapsed, setMiddleCollapsed] = useState(false);
  const [rightCollapsed, setRightCollapsed] = useState(typeof window !== "undefined" ? window.innerWidth < NARROW_SCREEN_COLLAPSE_RIGHT_PX : false);
  const [saving, setSaving] = useState(false);
  const wasNarrowViewportRef = useRef(typeof window !== "undefined" ? window.innerWidth < NARROW_SCREEN_COLLAPSE_RIGHT_PX : false);
  const mountedRef = useRef(true);

  const panesRef = useRef<HTMLDivElement>(null);
  const songRef = useRef<HTMLDivElement>(null);

  const editorRef = useRef<ChordProEditor | null>(null);
  const cleanupRef = useRef<(() => void) | null>(null);
  const touchCleanupRef = useRef<(() => void) | null>(null);
  const startupInstructionsRef = useRef(initialInstructions);

  const localeHandlerRef = useRef(localeHandler);
  useEffect(() => {
    localeHandlerRef.current = localeHandler;
  }, [localeHandler]);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const rebindInstructions = (instructions: string) => {
    const editor = editorRef.current;
    const panes = panesRef.current;
    if (!editor || !panes) return;
    cleanupRef.current?.();
    cleanupRef.current = editor.setupInstructionsEditor(panes, instructions, () => {}) ?? null;
  };

  // Create the read-only ChordPro editor + wire up the instructions editor once
  // the song data and pane elements are available.
  useEffect(() => {
    const host = songRef.current;
    const panes = panesRef.current;
    if (!host || !panes || !songData) return;

    startupInstructionsRef.current = initialInstructions;

    void ensureChordProAssets();

    const chordSystem = getChordSystem((songData.system || "G") as ChordSystemCode);
    const editor = new ChordProEditor(
      chordSystem,
      host,
      songData.text,
      false, // not editable
      1.0, // scale
      undefined, // no chord selector
      false, // drawing not suppressed
      undefined, // no reference chp
      undefined, // no touch routing
      false // no parent scroll correction
    );
    editor.darkMode(isDark);
    if (localeHandlerRef.current) editor.installLocaleHandler(localeHandlerRef.current);
    editorRef.current = editor;

    touchCleanupRef.current = routeTouchEventsToMouse(panes, { preventDefault: false, stopPropagation: false });
    rebindInstructions(startupInstructionsRef.current);

    return () => {
      cleanupRef.current?.();
      cleanupRef.current = null;
      touchCleanupRef.current?.();
      touchCleanupRef.current = null;
      editor.dispose();
      editorRef.current = null;
    };
    // Re-create only when the song content actually changes — callers may pass a
    // fresh songData object each render. initialInstructions/isDark are captured
    // intentionally (initial load value; live updates handled by other effects).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [songData?.text, songData?.system]);

  useEffect(() => {
    editorRef.current?.darkMode(isDark);
  }, [isDark]);

  // On shrinking to a narrow viewport, auto-collapse the preview pane (mirrors
  // the original desktop behaviour).
  useEffect(() => {
    if (typeof window === "undefined") return;
    const handleResize = () => {
      const isNarrow = window.innerWidth < NARROW_SCREEN_COLLAPSE_RIGHT_PX;
      if (isNarrow && !wasNarrowViewportRef.current) setRightCollapsed(true);
      wasNarrowViewportRef.current = isNarrow;
    };
    window.addEventListener("resize", handleResize);
    return () => window.removeEventListener("resize", handleResize);
  }, []);

  const ready = !loading && !error && !!songData;
  const actionsDisabled = !ready || saving;

  const close = () => {
    if (!saving) onClose();
  };

  const handleSave = async () => {
    if (!editorRef.current || actionsDisabled) return;
    const instructions = editorRef.current.getInstructions("SETTING") ?? "";
    setSaving(true);
    try {
      await onSave(instructions, storeInProfile ? storeChecked : false);
    } finally {
      if (mountedRef.current) setSaving(false);
    }
  };

  const cvModifier = variant === "cv" ? " instructions-editor--cv" : "";
  const darkClass = isDark ? " dark" : "";

  const renderCollapseButton = (collapsed: boolean, toggle: () => void, strings: CollapseStrings) => {
    const a11y = collapsed ? strings.showLabel : strings.hideLabel;
    const eye = collapsed ? EYE_OPEN : EYE_CLOSED;
    return (
      <button
        type="button"
        className="btn btn-sm btn-outline-secondary instructions-collapse-btn"
        onClick={toggle}
        disabled={!ready}
        title={a11y}
        aria-label={a11y}
      >
        {collapse.showText ? `${eye} ${strings.short}` : eye}
      </button>
    );
  };

  const renderActionButton = (kind: "clear" | "reset", onClick: () => void) => {
    if (action.style === "text") {
      return (
        <button type="button" className="btn btn-outline-secondary instructions-action-btn" onClick={onClick} disabled={actionsDisabled}>
          {kind === "clear" ? action.clearLabel : action.resetLabel}
        </button>
      );
    }
    const src = kind === "clear" ? action.clearIcon : action.resetIcon;
    const titleText = kind === "clear" ? action.clearTitle : action.resetTitle;
    return (
      <button type="button" className="instructions-action-btn instructions-iconbtn" onClick={onClick} disabled={actionsDisabled} title={titleText}>
        <img className="btnImg" src={src} alt={titleText} />
      </button>
    );
  };

  return (
    <div className={`instructions-editor-backdrop${cvModifier}`} onClick={close}>
      <div className={`instructions-editor-dialog${cvModifier}${darkClass}`} onClick={(e) => e.stopPropagation()}>
        <div className="instructions-editor-header">
          <h5 className="instructions-editor-title">{title}</h5>
          <div className="instructions-editor-header-actions">
            {renderCollapseButton(leftCollapsed, () => setLeftCollapsed((c) => !c), collapse.left)}
            {renderCollapseButton(middleCollapsed, () => setMiddleCollapsed((c) => !c), collapse.middle)}
            {renderCollapseButton(rightCollapsed, () => setRightCollapsed((c) => !c), collapse.right)}
            {variant === "cv" ? (
              <button
                type="button"
                className="instructions-editor-close instructions-editor-close--glyph"
                onClick={close}
                disabled={saving}
                title={closeLabel}
                aria-label={closeLabel}
              >
                <span aria-hidden="true">&times;</span>
              </button>
            ) : (
              <button
                type="button"
                className="instructions-editor-close btn-close"
                onClick={close}
                disabled={saving}
                title={closeLabel}
                aria-label={closeLabel}
              ></button>
            )}
          </div>
        </div>

        <div className="instructions-editor-body">
          {loading ? <p className="instructions-editor-status">{loadingText ?? "Loading…"}</p> : null}
          {!loading && error ? <p className="instructions-editor-status instructions-editor-error">{error}</p> : null}
          {ready ? (
            <div
              ref={panesRef}
              className={`instructions-editor-panes${leftCollapsed ? " left-panel-collapsed" : ""}${middleCollapsed ? " middle-panel-collapsed" : ""}${rightCollapsed ? " right-panel-collapsed" : ""}`}
            >
              <div className="song-editor" ref={songRef} id="ies-song"></div>
              <div className="instructions-editor-separator" id="ies-left">
                &nbsp;
              </div>
              <div className="instructions-editor" id="ies-list"></div>
              <div className="instructions-editor-separator" id="ies-right">
                &nbsp;
              </div>
              <div className="song-editor" id="ies-preview"></div>
            </div>
          ) : null}
        </div>

        <div className="instructions-editor-footer">
          <div className="instructions-footer-left">
            {renderActionButton("clear", () => rebindInstructions(""))}
            {renderActionButton("reset", () => rebindInstructions(startupInstructionsRef.current))}
            {storeInProfile ? (
              <div className="form-check ml-3 mt-1 instructions-store-check">
                <input
                  className="form-check-input"
                  type="checkbox"
                  id="storeInProfile"
                  checked={storeChecked}
                  onChange={(e) => setStoreChecked(e.target.checked)}
                  disabled={storeInProfile.isInProfile}
                />
                <label className="form-check-label" htmlFor="storeInProfile">
                  {storeInProfile.label}
                </label>
              </div>
            ) : null}
          </div>
          <div className="instructions-footer-right">
            {action.style === "text" ? (
              <button
                type="button"
                className="btn btn-primary instructions-save-btn"
                title={action.saveTitle}
                onClick={() => void handleSave()}
                disabled={actionsDisabled}
              >
                {action.saveLabel}
              </button>
            ) : (
              <button
                type="button"
                className="instructions-save-btn instructions-iconbtn"
                title={action.saveTitle}
                onClick={() => void handleSave()}
                disabled={actionsDisabled}
              >
                <img className="btnImg" src={action.saveIcon} alt={action.saveTitle} />
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

export default InstructionsEditor;
