import React, { useState, useEffect, useRef, useCallback, useMemo } from "react";
import { Song } from "../../db-common/Song";
import { Settings } from "../types";
import { ChordProEditor } from "./ChordProEditor/ChordProEditor";
import ChordProEditorWithLocalization from "./ChordProEditor/ChordProEditor";
import { useLocalization } from "../localization/LocalizationContext";
import { chordProAPI } from "../../chordpro/chordProApi";
import "./PrintWindow.css";

/** Key used to pass print data between the main window and the print window */
const PRINT_DATA_KEY = "pp-print-data";
const SETTINGS_KEY = "pp-settings";

interface PrintData {
  songText: string;
  songTitle: string;
  chordSystem: "G" | "S";
}

/**
 * PrintWindow - standalone page rendered in a new tab/window for printing.
 * Shows printer settings in a header bar and a ChordProEditor preview beneath.
 * On "Print" the header is hidden and window.print() is called so only the
 * editor content appears on paper. Works in both webapp and Electron mode.
 */
const PrintWindow: React.FC = () => {
  const { t } = useLocalization();

  // Settings panel visibility
  const [showSettings, setShowSettings] = useState(false);
  const settingsPanelRef = useRef<HTMLDivElement>(null);
  const settingsButtonRef = useRef<HTMLButtonElement>(null);

  // Printer settings (local state, loaded from stored settings)
  const [printingBB, setPrintingBB] = useState(false);
  const [printingTitle, setPrintingTitle] = useState(true);
  const [printingMetaData, setPrintingMetaData] = useState(true);
  const [printingSuperScript, setPrintingSuperScript] = useState(false);
  const [printingSectionLabels, setPrintingSectionLabels] = useState<"None" | "Abbreviated" | "Full">("Full");
  const [printingMollMode, setPrintingMollMode] = useState("Am");
  const [useAsDefault, setUseAsDefault] = useState(true);

  // Full settings object to pass to ChordProEditor
  const [settings, setSettings] = useState<Settings | null>(null);

  // Song to display
  const [song, setSong] = useState<Song | null>(null);

  // Track whether the editor has initialised so we can apply display settings
  const editorRef = useRef<ChordProEditor | null>(null);
  const [editorReady, setEditorReady] = useState(false);

  // Force light mode + set document title
  useEffect(() => {
    document.documentElement.setAttribute("data-theme", "light");
    document.title = t("PrintWindowTitle");
  }, [t]);

  const [dropdownPos, setDropdownPos] = useState<{ top: number; left?: number; right?: number } | null>(null);

  // Position dropdown intelligently to keep it within viewport bounds
  useEffect(() => {
    if (!showSettings || !settingsButtonRef.current || !settingsPanelRef.current) return;

    const buttonRect = settingsButtonRef.current.getBoundingClientRect();
    const panelWidth = settingsPanelRef.current.offsetWidth;
    const gap = 6;

    const top = buttonRect.bottom + gap;
    const rightAlignLeft = buttonRect.right - panelWidth;
    const leftAlignLeft = buttonRect.left;

    // Check if right-aligned version fits without clipping
    if (rightAlignLeft >= 16) {
      setDropdownPos({ top, right: window.innerWidth - buttonRect.right });
    } else {
      // Fall back to left alignment if it fits better
      setDropdownPos({ top, left: Math.max(16, leftAlignLeft) });
    }
  }, [showSettings]);

  // Clear position when dropdown closes
  useEffect(() => {
    if (!showSettings) {
      setDropdownPos(null);
    }
  }, [showSettings]);

  // Close settings panel when clicking outside
  useEffect(() => {
    if (!showSettings) return;
    const handleClickOutside = (e: MouseEvent) => {
      if (
        settingsPanelRef.current &&
        !settingsPanelRef.current.contains(e.target as Node) &&
        settingsButtonRef.current &&
        !settingsButtonRef.current.contains(e.target as Node)
      ) {
        setShowSettings(false);
      }
    };
    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, [showSettings]);

  // Load print data + stored settings on mount
  useEffect(() => {
    // 1. Load print data passed from the main window
    const raw = localStorage.getItem(PRINT_DATA_KEY);
    if (raw) {
      try {
        const data: PrintData = JSON.parse(raw);
        const s = new Song(data.songText, data.chordSystem);
        // Preserve the title from the metadata already in song text
        setSong(s);
      } catch (e) {
        console.error("PrintWindow: failed to parse print data", e);
      }
    }

    // 2. Load stored settings to restore printer settings
    const storedRaw = localStorage.getItem(SETTINGS_KEY);
    if (storedRaw) {
      try {
        const stored: Settings = JSON.parse(storedRaw);
        setSettings(stored);
        // Restore individual printer settings from stored settings
        setPrintingBB(stored.printingBB ?? false);
        setPrintingTitle(stored.printingTitle ?? true);
        setPrintingMetaData(stored.printingMetaData ?? true);
        setPrintingSuperScript(stored.printingSuperScript ?? false);
        setPrintingSectionLabels(stored.printingSectionLabels ?? "Full");
        setPrintingMollMode(stored.printingMollMode ?? "Am");
      } catch {
        // Ignore – defaults are fine
      }
    }
  }, []);

  // Build a settings object that reflects the current printer toggles so
  // ChordProEditor always sees up-to-date printer settings.
  // Apply display settings whenever printer toggles change OR editor finishes loading.
  // Also ensure light mode is always active on the ChordPro API.
  useEffect(() => {
    if (!editorReady) return;
    // Always force light mode in the print window
    chordProAPI.darkMode?.(false);
    chordProAPI.setDisplay(printingTitle, printingMetaData, printingSuperScript, printingBB, printingMollMode, printingSectionLabels, 1.0, false);
  }, [editorReady, printingBB, printingTitle, printingMetaData, printingSuperScript, printingSectionLabels, printingMollMode]);

  // Mark editor as ready once it reports a line-select (signals load complete)
  // We also use a timer fallback to catch the case where no line-select fires.
  useEffect(() => {
    const timer = setTimeout(() => setEditorReady(true), 500);
    return () => clearTimeout(timer);
  }, [song]);

  /** Persist current printer settings into localStorage so they survive across sessions */
  const savePrinterSettings = useCallback(() => {
    const storedRaw = localStorage.getItem(SETTINGS_KEY);
    if (!storedRaw) return;
    try {
      const stored: Settings = JSON.parse(storedRaw);
      stored.printingBB = printingBB;
      stored.printingTitle = printingTitle;
      stored.printingMetaData = printingMetaData;
      stored.printingSuperScript = printingSuperScript;
      stored.printingSectionLabels = printingSectionLabels;
      stored.printingMollMode = printingMollMode;
      localStorage.setItem(SETTINGS_KEY, JSON.stringify(stored));
      // Notify other windows / contexts
      window.dispatchEvent(new CustomEvent("pp-settings-changed"));
    } catch {
      /* ignore */
    }
  }, [printingBB, printingTitle, printingMetaData, printingSuperScript, printingSectionLabels, printingMollMode]);

  /** Print handler: optionally save settings, then print */
  const handlePrint = useCallback(() => {
    // Save printer settings before printing if "use as default" is checked
    if (useAsDefault) {
      savePrinterSettings();
    }

    // Use requestAnimationFrame to let the CSS @media print rules take effect
    // The @media print CSS already hides the header
    requestAnimationFrame(() => {
      window.print();
      // Close the window after printing (or if the user cancels the print dialog)
      window.close();
    });
  }, [useAsDefault, savePrinterSettings]);

  // Memoize the editor element so that when only printer-settings checkboxes
  // change the ChordProEditor is NOT re-rendered.  Without this, every React
  // re-render triggers componentDidUpdate → prepareWysiwygHost → loadSongToWysiwyg
  // → setDisplay(defaults) which overwrites the print-specific display settings.
  // Display updates are applied separately via chordProAPI.setDisplay() in
  // the useEffect above.
  const editorElement = useMemo(
    () => (
      <ChordProEditorWithLocalization
        ref={(ref) => {
          editorRef.current = ref as unknown as ChordProEditor;
        }}
        song={song}
        settings={settings}
        previewOnly
      />
    ),
    // Only re-create when the song or base settings object changes

    [song, settings]
  );

  if (!song) {
    return (
      <div className="print-window d-flex align-items-center justify-content-center">
        <p className="text-muted">{t("NoSongSelected")}</p>
      </div>
    );
  }

  return (
    <div className="print-window">
      {/* Compact toolbar */}
      <div className="print-toolbar">
        <span className="print-toolbar-title">{t("PrintWindowTitle")}</span>

        <div className="print-toolbar-actions">
          <div className="print-toolbar-settings-wrapper">
            <button
              ref={settingsButtonRef}
              className={`btn btn-sm btn-outline-secondary${showSettings ? " active" : ""}`}
              onClick={() => setShowSettings((v) => !v)}
              title={t("PrintSettings")}
            >
              <i className="fa fa-cog me-1"></i>
              {t("PrintSettings")}
            </button>

            {/* Settings dropdown panel */}
            {showSettings && (
              <div className="print-settings-panel" ref={settingsPanelRef} style={dropdownPos ?? undefined}>
                <div className="print-settings-item">
                  <div className="form-check">
                    <input
                      className="form-check-input"
                      type="checkbox"
                      id="printTitle"
                      checked={printingTitle}
                      onChange={(e) => setPrintingTitle(e.target.checked)}
                    />
                    <label className="form-check-label" htmlFor="printTitle">
                      {t("PrintTitle")}
                    </label>
                  </div>
                </div>

                <div className="print-settings-item">
                  <div className="form-check">
                    <input
                      className="form-check-input"
                      type="checkbox"
                      id="printMeta"
                      checked={printingMetaData}
                      onChange={(e) => setPrintingMetaData(e.target.checked)}
                    />
                    <label className="form-check-label" htmlFor="printMeta">
                      {t("ShowOtherMetadata")}
                    </label>
                  </div>
                </div>

                <div className="print-settings-item">
                  <div className="form-check">
                    <input
                      className="form-check-input"
                      type="checkbox"
                      id="printSuperscript"
                      checked={printingSuperScript}
                      onChange={(e) => setPrintingSuperScript(e.target.checked)}
                    />
                    <label className="form-check-label" htmlFor="printSuperscript">
                      {t("SuperscriptChords")}
                    </label>
                  </div>
                </div>

                <div className="print-settings-item">
                  <label htmlFor="sectionLabelMode">{t("PrintSectionLabels")}</label>
                  <select
                    className="form-control form-control-sm"
                    id="sectionLabelMode"
                    value={printingSectionLabels}
                    onChange={(e) => setPrintingSectionLabels(e.target.value as "None" | "Abbreviated" | "Full")}
                  >
                    <option value="None">{t("None")}</option>
                    <option value="Abbreviated">{t("Abbreviated")}</option>
                    <option value="Full">{t("Full")}</option>
                  </select>
                </div>

                <div className="print-settings-item">
                  <label htmlFor="mollMode">{t("MollMode")}</label>
                  <select
                    className="form-control form-control-sm"
                    id="mollMode"
                    value={printingMollMode}
                    onChange={(e) => setPrintingMollMode(e.target.value)}
                  >
                    <option value="Am">Am</option>
                    <option value="am">am</option>
                    <option value="a">a</option>
                  </select>
                </div>

                <div className="print-settings-item">
                  <label htmlFor="system">{t("NoteSystem")}</label>
                  <select
                    className="form-control form-control-sm"
                    id="system"
                    value={printingBB ? "english" : "german"}
                    onChange={(e) => setPrintingBB(e.target.value === "english")}
                  >
                    <option value="german">{t("German")}</option>
                    <option value="english">{t("English")}</option>
                  </select>
                </div>

                <div className="print-settings-divider" />

                <div className="print-settings-item">
                  <div className="form-check">
                    <input
                      className="form-check-input"
                      type="checkbox"
                      id="useAsDefault"
                      checked={useAsDefault}
                      onChange={(e) => setUseAsDefault(e.target.checked)}
                    />
                    <label className="form-check-label" htmlFor="useAsDefault">
                      {t("PrintUseAsDefault")}
                    </label>
                  </div>
                </div>
              </div>
            )}
          </div>

          <button className="btn btn-sm btn-primary" onClick={handlePrint}>
            <i className="fa fa-print me-1"></i>
            {t("PrintButton")}
          </button>
        </div>
      </div>

      {/* ChordPro Editor – preview only, memoized so checkbox changes don't
          trigger componentDidUpdate which would reset display via loadSongToWysiwyg */}
      <div className="print-editor-area">{editorElement}</div>
    </div>
  );
};

export default PrintWindow;
