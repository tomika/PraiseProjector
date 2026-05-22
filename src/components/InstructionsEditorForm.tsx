import React, { useState, useRef, useEffect } from "react";
import { Song } from "../../db-common/Song";
import { ChordProEditor } from "../../chordpro/chordpro_editor";
import { getChordSystem } from "../../chordpro/chordpro_base";
import { useTooltips } from "../localization/TooltipContext";
import { useLocalization, StringKey } from "../localization/LocalizationContext";
import { ensureChordProAssets } from "../utils/loadChordProAssets";
import "./InstructionsEditorForm.css";
import { NoteSystemCode } from "../../chordpro/note_system";

const NARROW_SCREEN_COLLAPSE_RIGHT_PX = 900;
const EYE_OPEN = "👁";
const EYE_CLOSED = "🙈";

interface InstructionsEditorFormProps {
  song: Song;
  initialInstructions: string;
  isInProfile: boolean;
  onSave: (instructions: string, storeInProfile: boolean) => void;
  onClose: () => void;
}

const InstructionsEditorForm: React.FC<InstructionsEditorFormProps> = ({ song, initialInstructions, isInProfile, onSave, onClose }) => {
  const { tt } = useTooltips();
  const { t } = useLocalization();
  const tRef = useRef(t);
  useEffect(() => {
    tRef.current = t;
  }, [t]);
  const [storeInProfile, setStoreInProfile] = useState(isInProfile ? true : true);
  const [leftCollapsed, setLeftCollapsed] = useState(false);
  const [middleCollapsed, setMiddleCollapsed] = useState(false);
  const [rightCollapsed, setRightCollapsed] = useState(typeof window !== "undefined" ? window.innerWidth < NARROW_SCREEN_COLLAPSE_RIGHT_PX : false);
  const wasNarrowViewportRef = useRef(typeof window !== "undefined" ? window.innerWidth < NARROW_SCREEN_COLLAPSE_RIGHT_PX : false);

  // Refs for the three panes
  const songDivRef = useRef<HTMLDivElement>(null);
  const listDivRef = useRef<HTMLDivElement>(null);
  const previewDivRef = useRef<HTMLDivElement>(null);
  const leftSepRef = useRef<HTMLDivElement>(null);
  const rightSepRef = useRef<HTMLDivElement>(null);

  // Editor instance
  const editorRef = useRef<ChordProEditor | null>(null);
  const cleanupRef = useRef<(() => void) | null>(null);

  const [startupInstructions] = useState(initialInstructions);

  // Initialize editor on mount
  useEffect(() => {
    if (!songDivRef.current || !listDivRef.current || !previewDivRef.current) return;

    if (!song) return;

    // Ensure chordpro.css (which provides the dynamically-injected
    // instructions/editor element styles) is loaded for this form.
    void ensureChordProAssets();

    // Create editor
    const chordSystem = getChordSystem((song.System || "G") as NoteSystemCode);
    const editor = new ChordProEditor(
      chordSystem,
      songDivRef.current,
      song.Text,
      false, // not editable
      1.0, // scale
      undefined, // no chord selector
      false, // drawing not suppressed
      undefined, // no reference chp
      undefined, // no touch routing
      false // no parent scroll correction applied
    );

    if (!editor) return;

    editor.darkMode(document.documentElement.getAttribute("data-theme") === "dark");
    editor.installLocaleHandler((s: string) => tRef.current(s.replace(/ /g, "") as StringKey));

    editorRef.current = editor;

    // Setup instructions editor
    const panes = songDivRef.current.parentElement!;
    if (leftSepRef.current && rightSepRef.current && listDivRef.current && previewDivRef.current) {
      const cleanup = editor.setupInstructionsEditor(panes, startupInstructions, () => {
        // Display update callback
      });
      cleanupRef.current = cleanup || null;
    }

    return () => {
      if (cleanupRef.current) {
        cleanupRef.current();
        cleanupRef.current = null;
      }
      if (editorRef.current) {
        editorRef.current.dispose();
        editorRef.current = null;
      }
    };
  }, [song, startupInstructions]);

  // Handle dark mode changes
  useEffect(() => {
    const applyDarkMode = () => {
      const isDark = document.documentElement.getAttribute("data-theme") === "dark";
      if (editorRef.current && editorRef.current.darkMode) {
        editorRef.current.darkMode(isDark);
      }
    };

    // Apply initial dark mode
    applyDarkMode();

    // Listen for theme changes
    const observer = new MutationObserver(applyDarkMode);
    observer.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ["data-theme"],
    });

    return () => {
      observer.disconnect();
    };
  }, []);

  useEffect(() => {
    if (typeof window === "undefined") return;

    const handleResize = () => {
      const isNarrow = window.innerWidth < NARROW_SCREEN_COLLAPSE_RIGHT_PX;
      if (isNarrow && !wasNarrowViewportRef.current) {
        setRightCollapsed(true);
      }
      wasNarrowViewportRef.current = isNarrow;
    };

    window.addEventListener("resize", handleResize);
    return () => {
      window.removeEventListener("resize", handleResize);
    };
  }, []);

  const handleSave = () => {
    const instructions = editorRef.current?.getInstructions("SETTING") ?? "";
    onSave(instructions, storeInProfile);
  };

  const handleReset = () => {
    if (editorRef.current && listDivRef.current && previewDivRef.current) {
      // Re-setup with startup instructions
      const panes = songDivRef.current?.parentElement;
      if (panes && leftSepRef.current && rightSepRef.current) {
        if (cleanupRef.current) {
          cleanupRef.current();
        }
        const cleanup = editorRef.current.setupInstructionsEditor(panes, startupInstructions, () => {});
        cleanupRef.current = cleanup || null;
      }
    }
  };

  const handleClear = () => {
    if (editorRef.current && listDivRef.current && previewDivRef.current) {
      // Re-setup with empty instructions
      const panes = songDivRef.current?.parentElement;
      if (panes && leftSepRef.current && rightSepRef.current) {
        if (cleanupRef.current) {
          cleanupRef.current();
        }
        const cleanup = editorRef.current.setupInstructionsEditor(panes, "", () => {});
        cleanupRef.current = cleanup || null;
      }
    }
  };

  const leftPanelToggleA11yLabel = leftCollapsed ? t("InstructionsEditorShowLeftPanel") : t("InstructionsEditorCollapseLeftPanel");
  const middlePanelToggleA11yLabel = middleCollapsed ? t("InstructionsEditorShowMiddlePanel") : t("InstructionsEditorCollapseMiddlePanel");
  const rightPanelToggleA11yLabel = rightCollapsed ? t("InstructionsEditorShowRightPanel") : t("InstructionsEditorCollapseRightPanel");

  const leftPanelToggleLabel = `${leftCollapsed ? EYE_OPEN : EYE_CLOSED} ${t("InstructionsEditorLeftPanelShort")}`;
  const middlePanelToggleLabel = `${middleCollapsed ? EYE_OPEN : EYE_CLOSED} ${t("InstructionsEditorMiddlePanelShort")}`;
  const rightPanelToggleLabel = `${rightCollapsed ? EYE_OPEN : EYE_CLOSED} ${t("InstructionsEditorRightPanelShort")}`;

  return (
    <div className="instructions-editor-backdrop" onClick={onClose}>
      <div className="instructions-editor-dialog" onClick={(e) => e.stopPropagation()}>
        <div className="instructions-editor-header">
          <h5 className="instructions-editor-title">{t("InstructionsEditorTitle")}</h5>
          <div className="instructions-editor-header-actions">
            <button
              type="button"
              className="btn btn-sm btn-outline-secondary instructions-collapse-btn"
              onClick={() => setLeftCollapsed((c) => !c)}
              title={leftPanelToggleA11yLabel}
              aria-label={leftPanelToggleA11yLabel}
            >
              {leftPanelToggleLabel}
            </button>
            <button
              type="button"
              className="btn btn-sm btn-outline-secondary instructions-collapse-btn"
              onClick={() => setMiddleCollapsed((c) => !c)}
              title={middlePanelToggleA11yLabel}
              aria-label={middlePanelToggleA11yLabel}
            >
              {middlePanelToggleLabel}
            </button>
            <button
              type="button"
              className="btn btn-sm btn-outline-secondary instructions-collapse-btn"
              onClick={() => setRightCollapsed((c) => !c)}
              title={rightPanelToggleA11yLabel}
              aria-label={rightPanelToggleA11yLabel}
            >
              {rightPanelToggleLabel}
            </button>
            <button type="button" className="btn-close" onClick={onClose} aria-label={t("Close")}></button>
          </div>
        </div>
        <div className="instructions-editor-body">
          <div
            className={`instructions-editor-panes${leftCollapsed ? " left-panel-collapsed" : ""}${middleCollapsed ? " middle-panel-collapsed" : ""}${rightCollapsed ? " right-panel-collapsed" : ""}`}
          >
            <div className="song-editor" ref={songDivRef} id="ies-song"></div>
            <div className="instructions-editor-separator" ref={leftSepRef} id="ies-left">
              &nbsp;
            </div>
            <div className="instructions-editor" ref={listDivRef} id="ies-list"></div>
            <div className="instructions-editor-separator" ref={rightSepRef} id="ies-right">
              &nbsp;
            </div>
            <div className="song-editor" ref={previewDivRef} id="ies-preview"></div>
          </div>
        </div>
        <div className="instructions-editor-footer">
          <div className="instructions-footer-left">
            <button type="button" className="btn btn-outline-secondary" onClick={handleClear}>
              {t("InstructionsEditorClear")}
            </button>
            <button type="button" className="btn btn-outline-secondary ml-1" onClick={handleReset}>
              {t("InstructionsEditorReset")}
            </button>
            <div className="form-check ml-3 mt-1">
              <input
                className="form-check-input"
                type="checkbox"
                id="storeInProfile"
                checked={storeInProfile}
                onChange={(e) => setStoreInProfile(e.target.checked)}
                disabled={isInProfile}
              />
              <label className="form-check-label" htmlFor="storeInProfile">
                {t("InstructionsEditorStoreInProfile")}
              </label>
            </div>
          </div>
          <div className="instructions-footer-right">
            <button type="button" className="btn btn-primary" title={tt("instructions_save")} onClick={handleSave}>
              {t("Save")}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
};

export default InstructionsEditorForm;
