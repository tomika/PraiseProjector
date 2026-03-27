import React, { useState, useCallback, useRef, useEffect, Suspense, lazy } from "react";
import { DocumentImporter } from "../../services/DocumentImporter";
import { ChordProConverter } from "../../services/ChordProConverter";
import { ImportLines } from "../../classes/ImportLine";
import { ChordMap, ChordDetectionMode, ChordNormalizer } from "../../classes/ChordMap";
import { Song } from "../../classes/Song";
import { ChordProDocument, getChordSystem } from "../../../chordpro/chordpro_base";
import { ChordSelector } from "../../../chordpro/chord_selector";
import { ChordDetails } from "../../../chordpro/note_system";
import { Database } from "../../classes/Database";
import ChordProEditorComponent from "../ChordProEditor/ChordProEditor";
import { ChordProEditor } from "../ChordProEditor/ChordProEditor";
import { setEditedSong } from "../../state/CurrentSongStore";
import MessageBox from "../MessageBox";
import { ContextMenu, ContextMenuItem } from "../ContextMenu/ContextMenu";
import { useLocalization, StringKey } from "../../localization/LocalizationContext";
import { ensureChordProAssets } from "../../utils/loadChordProAssets";
import type { ImportDecision } from "../CompareDialog";
import "./SongImporterWizard.css";
import { ChordBoxType, ChordDrawer } from "../../../chordpro/chord_drawer";
import { defaultDisplayProperties } from "../../../chordpro/chordpro_styles";
import { NoteHitBox } from "../../../chordpro/ui_base";

const CompareDialog = lazy(() => import("../CompareDialog"));

const IMPORT_CHORD_SELECTOR_IDS = {
  baseNoteSelector: "song-import-baseNoteSel",
  bassNoteSelector: "song-import-bassNoteSel",
  modifierSelector: "song-import-modifier",
  customSpan: "song-import-customSpan",
  subscript: "song-import-subscript",
  baseNoteSpan: "song-import-baseNoteSpan",
  steps: "song-import-steps",
  notes: "song-import-notes",
  guitarChordBox: "song-import-guitarChordBox",
  pianoChordBox: "song-import-pianoChordBox",
  musicChordBox: "song-import-musicChordBox",
  closeSelector: "song-import-closeSelector",
  applySelector: "song-import-applySelector",
} as const;

function looksLikeChordPro(text: string): boolean {
  const doc = new ChordProDocument(getChordSystem("G"), text);
  for (const key of ChordProDocument.metaDataDirectives) {
    if (doc.getMeta(key)) return true;
  }
  for (const line of doc.lines) {
    if (line.chords.length) return true;
  }
  return false;
}

interface SongImporterWizardProps {
  database: Database;
  onClose: () => void;
  onSongImported?: (song: Song) => void;
  initialFiles?: File[];
}

/**
 * Complete port of C# SongImporterForm to React/TypeScript
 * 4-step wizard for importing songs from documents
 */
export const SongImporterWizard: React.FC<SongImporterWizardProps> = ({ database, onClose, onSongImported, initialFiles }) => {
  const { t } = useLocalization();
  const normalizedChordSystem = getChordSystem("G");

  const format = useCallback((key: StringKey, ...args: string[]) => args.reduce((text, arg, index) => text.replace(`{${index}}`, arg), t(key)), [t]);

  const getLineTypeLabel = useCallback(
    (lineType?: string | null) => {
      switch (lineType) {
        case "title":
          return t("SongImportLineTypeTitle");
        case "chord":
          return t("SongImportLineTypeChord");
        case "lyrics":
          return t("SongImportLineTypeLyrics");
        case "comment":
          return t("SongImportLineTypeComment");
        default:
          return t("SongImportLineTypeUnset");
      }
    },
    [t]
  );
  // Wizard state
  const [currentTab, setCurrentTab] = useState(0);

  // File selection state (Tab 0)
  const [selectedFile, setSelectedFile] = useState<File | null>(null);
  const [importedFiles, setImportedFiles] = useState<File[]>([]);

  // Line classification state (Tab 1)
  const [allLines, setAllLines] = useState<ImportLines>(new ImportLines());
  const [selectedLines, setSelectedLines] = useState<Set<number>>(new Set());
  const [filteredLines, setFilteredLines] = useState<ImportLines>(new ImportLines());

  // Long press tracking
  const longPressTimerRef = useRef<NodeJS.Timeout | null>(null);
  const isLongPressRef = useRef(false);

  // Chord normalization state (Tab 2)
  const [chordMap, setChordMap] = useState<ChordMap>(new ChordMap());
  const [autoChordMap, setAutoChordMap] = useState<ChordMap>(new ChordMap());
  const [manualEditedChords, setManualEditedChords] = useState<Set<string>>(new Set());
  const [flashingChords, setFlashingChords] = useState<Set<string>>(new Set());
  const [useHMode, setUseHMode] = useState<ChordDetectionMode>(-1);
  const [lcMollMode, setLcMollMode] = useState<ChordDetectionMode>(-1);
  const [selectedChord] = useState<string | null>(null);

  // ChordPro editor state (Tab 3)
  const [generatedChordPro, setGeneratedChordPro] = useState("");
  const [isChordProDirectFlow, setIsChordProDirectFlow] = useState(false);
  const [editorSong, setEditorSong] = useState<Song | null>(null);

  // MessageBox state
  const [messageBox, setMessageBox] = useState<{
    title?: string;
    message: string;
    onConfirm: () => void;
    onCancel: () => void;
    confirmText?: string;
    showCancel?: boolean;
  } | null>(null);

  // ContextMenu state
  const [contextMenu, setContextMenu] = useState<{
    items: ContextMenuItem[];
    position: { x: number; y: number };
    onSelect: (value: string) => void;
  } | null>(null);

  // CompareDialog state for similarity check when saving imported songs
  const [compareDialogState, setCompareDialogState] = useState<{
    song: Song;
    similarSongs: Song[];
    onDecision: (decision: ImportDecision) => void;
  } | null>(null);

  // Refs
  const chordProEditorRef = useRef<ChordProEditor>(null);
  const useHInputRef = useRef<HTMLInputElement>(null);
  const lcMollInputRef = useRef<HTMLInputElement>(null);
  const chordFlashTimeoutRef = useRef<NodeJS.Timeout | null>(null);
  const chordSelectorHostRef = useRef<HTMLDivElement>(null);
  const chordSelectorRef = useRef<ChordSelector | null>(null);
  const chordDrawerRef = useRef<ChordDrawer | null>(null);
  const activeChordSelectorTargetRef = useRef<string | null>(null);

  // Services
  const documentImporter = useRef(new DocumentImporter());

  const collectChordsFromChordPro = useCallback((text: string): Set<string> => {
    const chords = new Set<string>();
    const chordRegex = /\[([^\]\r\n]+)\]/g;
    let match: RegExpExecArray | null;

    while ((match = chordRegex.exec(text)) !== null) {
      const chord = (match[1] || "").trim();
      if (chord) chords.add(chord);
    }

    return chords;
  }, []);

  const normalizeChordProChords = useCallback((text: string, map: ChordMap): string => {
    return text.replace(/\[([^\]\r\n]+)\]/g, (full, rawChord: string) => {
      const chord = (rawChord || "").trim();
      const normalized = map.get(chord);
      return `[${normalized ?? chord}]`;
    });
  }, []);

  const triggerChordFlash = useCallback((changedKeys: Iterable<string>) => {
    const next = new Set(changedKeys);
    if (next.size === 0) return;

    setFlashingChords(next);
    if (chordFlashTimeoutRef.current) {
      clearTimeout(chordFlashTimeoutRef.current);
    }
    chordFlashTimeoutRef.current = setTimeout(() => {
      setFlashingChords(new Set());
      chordFlashTimeoutRef.current = null;
    }, 700);
  }, []);

  const getUnknownNormalizedChords = useCallback(() => {
    return chordMap
      .getEntries()
      .filter(([, normalized]) => {
        const value = normalized.trim();
        return value.length > 0 && normalizedChordSystem.identifyChord(value) == null;
      })
      .map(([original, normalized]) => ({ original, normalized: normalized.trim() }));
  }, [chordMap, normalizedChordSystem]);

  const buildChordNormalizationState = useCallback(
    (
      chords: Set<string>,
      requestedHMode: ChordDetectionMode,
      requestedLcMollMode: ChordDetectionMode,
      preserveExistingValues: boolean,
      flashChanges: boolean
    ) => {
      const result = ChordNormalizer.createChordMap(chords, requestedHMode, requestedLcMollMode);

      setUseHMode(result.hMode);
      setLcMollMode(result.lcMollMode);
      const nextAutoMap = result.map ?? new ChordMap();
      const nextManuals = preserveExistingValues
        ? new Set(Array.from(manualEditedChords).filter((key) => nextAutoMap.get(key) !== undefined))
        : new Set<string>();
      const nextChordMap = new ChordMap();
      const preservedValues = preserveExistingValues ? new Map(chordMap.getEntries()) : new Map<string, string>();

      for (const [key, value] of nextAutoMap.getEntries()) {
        nextChordMap.set(key, nextManuals.has(key) ? (preservedValues.get(key) ?? value) : value);
      }

      setAutoChordMap(nextAutoMap);
      setManualEditedChords(nextManuals);
      setChordMap(nextChordMap);

      if (flashChanges) {
        const changedKeys = new Set<string>();
        for (const [key, value] of nextChordMap.getEntries()) {
          if ((chordMap.get(key) ?? "") !== value) {
            changedKeys.add(key);
          }
        }

        triggerChordFlash(changedKeys);
      }
    },
    [chordMap, manualEditedChords, triggerChordFlash]
  );

  const getCurrentChordSet = useCallback(() => {
    return isChordProDirectFlow ? collectChordsFromChordPro(generatedChordPro) : ChordProConverter.collectChords(filteredLines);
  }, [collectChordsFromChordPro, filteredLines, generatedChordPro, isChordProDirectFlow]);

  const startChordProNormalizationFlow = useCallback(
    (rawChordPro: string) => {
      const chords = collectChordsFromChordPro(rawChordPro);
      setGeneratedChordPro(rawChordPro);
      setIsChordProDirectFlow(true);
      buildChordNormalizationState(chords, -1, -1, false, false);
      setCurrentTab(2);
    },
    [buildChordNormalizationState, collectChordsFromChordPro]
  );

  const minTabIndex = isChordProDirectFlow ? 2 : 0;
  const chordModesResolved = useHMode >= 0 && lcMollMode >= 0;

  useEffect(() => {
    if (useHInputRef.current) {
      useHInputRef.current.indeterminate = useHMode < 0;
    }
  }, [useHMode]);

  useEffect(() => {
    if (lcMollInputRef.current) {
      lcMollInputRef.current.indeterminate = lcMollMode < 0;
    }
  }, [lcMollMode]);

  useEffect(() => {
    return () => {
      if (chordFlashTimeoutRef.current) {
        clearTimeout(chordFlashTimeoutRef.current);
      }
    };
  }, []);

  // === Tab 0: File Selection ===

  const handleFileSelect = useCallback(
    async (file: File) => {
      if (!DocumentImporter.isSupportedFile(file.name)) {
        setMessageBox({
          title: t("SongImportUnsupportedFormatTitle"),
          message: format("SongImportUnsupportedFormatMessage", file.name),
          onConfirm: () => setMessageBox(null),
          onCancel: () => setMessageBox(null),
        });
        return;
      }

      setSelectedFile(file);
      setImportedFiles([file]);
      setIsChordProDirectFlow(false);

      // Auto-load if it's a .chp file
      const ext = file.name.substring(file.name.lastIndexOf(".")).toLowerCase();
      if (ext === ".chp") {
        const text = await file.text();
        startChordProNormalizationFlow(text);
        return;
      }
    },
    [format, startChordProNormalizationFlow, t]
  );

  const parseFileAndAdvance = useCallback(
    async (file: File) => {
      const proceedToTab1 = async () => {
        try {
          setIsChordProDirectFlow(false);
          const lines = await documentImporter.current.parseDocument(file);
          setAllLines(lines);

          ChordProConverter.autoDetectLineTypes(lines);

          const allIndices = new Set<number>();
          for (let i = 0; i < lines.count; i++) {
            allIndices.add(i);
          }
          setSelectedLines(allIndices);

          setCurrentTab(1);
        } catch (error) {
          console.error("Import", "Failed to parse document", error);

          let errorMessage = t("SongImportParseUnknownError");

          if (error instanceof Error) {
            const message = error.message.toLowerCase();

            if (message.includes("pdf") || message.includes("worker")) {
              errorMessage = t("SongImportParsePdfError");
            } else if (message.includes("unsupported file format")) {
              errorMessage = t("SongImportParseUnsupportedError");
            } else if (message.includes("network") || message.includes("fetch")) {
              errorMessage = t("SongImportParseNetworkError");
            } else if (message.includes("encoding") || message.includes("charset")) {
              errorMessage = t("SongImportParseEncodingError");
            } else {
              errorMessage = format("SongImportParseErrorWithDetails", error.message);
            }
          }

          setMessageBox({
            title: t("SongImportErrorTitle"),
            message: errorMessage,
            onConfirm: () => setMessageBox(null),
            onCancel: () => setMessageBox(null),
          });
        }
      };

      const ext = file.name.substring(file.name.lastIndexOf(".")).toLowerCase();
      if ([".txt", ".html", ".htm"].includes(ext)) {
        const rawText = await file.text();
        if (looksLikeChordPro(rawText)) {
          setMessageBox({
            title: t("SongImportDetectedChordProTitle"),
            message: t("SongImportDetectedChordProMessage"),
            onConfirm: () => {
              setMessageBox(null);
              startChordProNormalizationFlow(rawText);
            },
            onCancel: () => {
              setMessageBox(null);
              setIsChordProDirectFlow(false);
              void proceedToTab1();
            },
          });
          return;
        }
      }

      await proceedToTab1();
    },
    [format, startChordProNormalizationFlow, t]
  );

  const handleFileUpload = useCallback(
    (event: React.ChangeEvent<HTMLInputElement>) => {
      const files = event.target.files;
      if (files && files.length > 0) {
        handleFileSelect(files[0]);
      }
    },
    [handleFileSelect]
  );

  const handleNextFromFileSelection = useCallback(async () => {
    if (!selectedFile) {
      setMessageBox({
        title: t("SongImportNoFileSelectedTitle"),
        message: t("SongImportNoFileSelectedMessage"),
        onConfirm: () => setMessageBox(null),
        onCancel: () => setMessageBox(null),
      });
      return;
    }

    await parseFileAndAdvance(selectedFile);
  }, [parseFileAndAdvance, selectedFile, t]);

  useEffect(() => {
    if (!initialFiles || initialFiles.length === 0) return;

    const supportedFiles = initialFiles.filter((file) => DocumentImporter.isSupportedFile(file.name));
    if (supportedFiles.length === 0) {
      const firstName = initialFiles[0]?.name || "";
      setMessageBox({
        title: t("SongImportUnsupportedFormatTitle"),
        message: format("SongImportUnsupportedFormatMessage", firstName),
        onConfirm: () => setMessageBox(null),
        onCancel: () => setMessageBox(null),
      });
      return;
    }

    const firstFile = supportedFiles[0];
    setImportedFiles(supportedFiles);
    setSelectedFile(firstFile);

    const ext = firstFile.name.substring(firstFile.name.lastIndexOf(".")).toLowerCase();
    if (ext === ".chp") {
      void firstFile.text().then((text) => {
        startChordProNormalizationFlow(text);
      });
      return;
    }

    setIsChordProDirectFlow(false);
    void parseFileAndAdvance(firstFile);
  }, [format, initialFiles, parseFileAndAdvance, startChordProNormalizationFlow, t]);

  // === Tab 1: Line Classification ===

  const handleLineCheckToggle = useCallback((index: number) => {
    setSelectedLines((prev) => {
      const newSet = new Set(prev);
      if (newSet.has(index)) {
        newSet.delete(index);
      } else {
        newSet.add(index);
      }
      return newSet;
    });
  }, []);

  const handleLineTypeBadgeClick = useCallback(
    (index: number) => {
      const line = allLines.get(index);
      if (!line) return;

      // Toggle between 'lyrics' and 'chord'
      if (line.line_type === "lyrics") {
        line.line_type = "chord";
      } else {
        line.line_type = "lyrics";
      }

      setAllLines(new ImportLines(allLines.getAll())); // Trigger re-render
    },
    [allLines]
  );

  const handleLineTypeBadgeLongPress = useCallback(
    (index: number, event: React.MouseEvent | React.TouchEvent) => {
      event.preventDefault();
      const line = allLines.get(index);
      if (!line) return;

      // Get position for context menu
      const rect = (event.target as HTMLElement).getBoundingClientRect();
      const position = {
        x: rect.left,
        y: rect.bottom + 5,
      };

      // Show context menu with all options
      const items: ContextMenuItem[] = [
        { label: t("SongImportLineTypeTitle"), value: "title" },
        { label: t("SongImportLineTypeChord"), value: "chord" },
        { label: t("SongImportLineTypeLyrics"), value: "lyrics" },
        { label: t("SongImportLineTypeComment"), value: "comment" },
      ];

      setContextMenu({
        items,
        position,
        onSelect: (value: string) => {
          line.line_type = value;
          setAllLines(new ImportLines(allLines.getAll())); // Trigger re-render
        },
      });
    },
    [allLines, setContextMenu, t]
  );

  const _handleLineTypeChange = useCallback(
    (lineType: string) => {
      // Apply to selected lines
      for (const index of selectedLines) {
        const line = allLines.get(index);
        if (line) {
          line.line_type = lineType;
        }
      }
      setAllLines(new ImportLines(allLines.getAll())); // Trigger re-render
    },
    [selectedLines, allLines]
  );

  const handleSelectAll = useCallback(() => {
    const newSet = new Set<number>();
    for (let i = 0; i < allLines.count; i++) {
      newSet.add(i);
    }
    setSelectedLines(newSet);
  }, [allLines]);

  const handleSelectNone = useCallback(() => {
    setSelectedLines(new Set());
  }, []);

  const handleSelectInvert = useCallback(() => {
    const newSet = new Set<number>();
    for (let i = 0; i < allLines.count; i++) {
      if (!selectedLines.has(i)) {
        newSet.add(i);
      }
    }
    setSelectedLines(newSet);
  }, [selectedLines, allLines]);

  const handleLyricsOnly = useCallback(() => {
    // Select all lines with 'lyrics' type, deselect others
    const newSet = new Set<number>();
    for (let i = 0; i < allLines.count; i++) {
      const line = allLines.get(i);
      if (line && line.line_type === "lyrics") {
        newSet.add(i);
      }
    }
    setSelectedLines(newSet);
  }, [allLines]);

  const handleNextFromLineClassification = useCallback(() => {
    // Filter only selected lines
    const selectedLinesArray = allLines.getAll().filter((_, index) => selectedLines.has(index));
    const filtered = new ImportLines(selectedLinesArray);
    setFilteredLines(filtered);

    // Collect chords and auto-detect normalization modes from selected lines only
    const chords = ChordProConverter.collectChords(filtered);
    buildChordNormalizationState(chords, -1, -1, false, false);
    setCurrentTab(2);
  }, [allLines, buildChordNormalizationState, selectedLines]);

  // === Tab 2: Chord Normalization ===

  const handleUseHChange = useCallback(
    (checked: boolean) => {
      buildChordNormalizationState(getCurrentChordSet(), checked ? 1 : 0, lcMollMode, true, true);
    },
    [buildChordNormalizationState, getCurrentChordSet, lcMollMode]
  );

  const handleLcMollChange = useCallback(
    (checked: boolean) => {
      buildChordNormalizationState(getCurrentChordSet(), useHMode, checked ? 1 : 0, true, true);
    },
    [buildChordNormalizationState, getCurrentChordSet, useHMode]
  );

  const handleChordEdit = useCallback(
    (original: string, newValue: string) => {
      const automaticValue = autoChordMap.get(original) ?? original;

      setManualEditedChords((prev) => {
        const next = new Set(prev);
        if (newValue === automaticValue) next.delete(original);
        else next.add(original);
        return next;
      });

      setChordMap((prev) => {
        const updated = new ChordMap();
        for (const [k, v] of prev.getEntries()) {
          updated.set(k, v);
        }
        updated.set(original, newValue);
        return updated;
      });
    },
    [autoChordMap]
  );

  const handleResetChordNormalization = useCallback(() => {
    const reset = new ChordMap();
    const changedKeys = new Set<string>();
    for (const [key, value] of autoChordMap.getEntries()) {
      reset.set(key, value);
      if ((chordMap.get(key) ?? "") !== value) {
        changedKeys.add(key);
      }
    }

    setManualEditedChords(new Set());
    setChordMap(reset);
    triggerChordFlash(changedKeys);
  }, [autoChordMap, chordMap, triggerChordFlash]);

  const handleOpenChordSelector = useCallback(
    (original: string) => {
      const selector = chordSelectorRef.current;
      if (!selector) return;

      activeChordSelectorTargetRef.current = original;
      selector.setNoteSystem(normalizedChordSystem);
      selector.showDialog(chordMap.get(original) ?? original, false, false);
    },
    [chordMap, normalizedChordSystem]
  );

  useEffect(() => {
    let disposed = false;

    void ensureChordProAssets().then(() => {
      if (disposed || chordSelectorRef.current || !chordSelectorHostRef.current) return;

      const hostStyle = getComputedStyle(chordSelectorHostRef.current);
      const darkMode = document.documentElement.getAttribute("data-theme") === "dark";
      const displayProps = defaultDisplayProperties(darkMode);
      displayProps.backgroundColor = hostStyle.backgroundColor;
      displayProps.chordBoxColor = hostStyle.color;
      displayProps.lineColor = hostStyle.color;
      displayProps.tagColor = hostStyle.color;
      displayProps.cursorColor = hostStyle.color;

      const selector = new ChordSelector(
        normalizedChordSystem,
        chordSelectorHostRef.current,
        {
          onClose: (chord?: string) => {
            const target = activeChordSelectorTargetRef.current;
            activeChordSelectorTargetRef.current = null;
            if (target && chord) handleChordEdit(target, chord);
          },
          baseNoteSelector: IMPORT_CHORD_SELECTOR_IDS.baseNoteSelector,
          bassNoteSelector: IMPORT_CHORD_SELECTOR_IDS.bassNoteSelector,
          modifierSelector: IMPORT_CHORD_SELECTOR_IDS.modifierSelector,
          customSpan: IMPORT_CHORD_SELECTOR_IDS.customSpan,
          subscript: IMPORT_CHORD_SELECTOR_IDS.subscript,
          baseNoteSpan: IMPORT_CHORD_SELECTOR_IDS.baseNoteSpan,
          steps: IMPORT_CHORD_SELECTOR_IDS.steps,
          notes: IMPORT_CHORD_SELECTOR_IDS.notes,
          guitarChordBox: IMPORT_CHORD_SELECTOR_IDS.guitarChordBox,
          pianoChordBox: IMPORT_CHORD_SELECTOR_IDS.pianoChordBox,
          musicChordBox: IMPORT_CHORD_SELECTOR_IDS.musicChordBox,
          closeSelector: IMPORT_CHORD_SELECTOR_IDS.closeSelector,
          applySelector: IMPORT_CHORD_SELECTOR_IDS.applySelector,
        },
        (type: ChordBoxType, chord: string | ChordDetails, canvas: HTMLCanvasElement, variant: number) => {
          const drawer = chordDrawerRef.current;
          if (!drawer) return [];
          const hits: NoteHitBox[] = [];
          drawer.chordBoxDraw(type, chord, canvas, variant, undefined, hits);
          return hits;
        }
      );
      chordSelectorRef.current = selector;
      chordDrawerRef.current = new ChordDrawer(normalizedChordSystem, selector, false, displayProps);
    });

    return () => {
      disposed = true;
      if (chordSelectorRef.current?.inModal) chordSelectorRef.current.closeDialog();
      chordSelectorRef.current = null;
      chordDrawerRef.current = null;
    };
  }, [handleChordEdit, normalizedChordSystem]);

  const handleNextFromChordNormalization = useCallback(() => {
    if (!chordModesResolved) return;

    const unknownChords = getUnknownNormalizedChords();

    const proceedToEditor = () => {
      if (isChordProDirectFlow) {
        const normalizedChordPro = normalizeChordProChords(generatedChordPro, chordMap);
        setGeneratedChordPro(normalizedChordPro);
        setEditorSong(new Song(normalizedChordPro));
        setCurrentTab(3);
        return;
      }

      const chordPro = ChordProConverter.convertToChordPro(filteredLines, chordMap);
      setGeneratedChordPro(chordPro);
      setEditorSong(new Song(chordPro));
      setCurrentTab(3);
    };

    if (unknownChords.length > 0) {
      setMessageBox({
        title: t("SongImportUnknownChordConfirmTitle"),
        message: format("SongImportUnknownChordConfirmMessage", unknownChords.map(({ normalized }) => normalized).join(", ")),
        confirmText: t("Continue"),
        showCancel: true,
        onConfirm: () => {
          setMessageBox(null);
          proceedToEditor();
        },
        onCancel: () => setMessageBox(null),
      });
      return;
    }

    proceedToEditor();
  }, [
    chordMap,
    chordModesResolved,
    filteredLines,
    format,
    generatedChordPro,
    getUnknownNormalizedChords,
    isChordProDirectFlow,
    normalizeChordProChords,
    t,
  ]);

  // === Tab 3: ChordPro Editor ===

  const handleChordProChange = useCallback((value: string) => {
    setGeneratedChordPro(value);
  }, []);

  const handleSaveAndRestart = useCallback(async () => {
    try {
      // Parse ChordPro and create song
      const song = new Song(generatedChordPro, "G");

      if (!song.Title || !song.Title.trim()) {
        // force user to set title before saving
        setMessageBox({
          title: t("SongImportMissingTitleTitle"),
          message: t("SongImportMissingTitleMessage"),
          onConfirm: () => {
            setMessageBox(null);
            // Navigate to meta tab and focus the title input
            chordProEditorRef.current?.focusMetaTitle();
          },
          onCancel: () => setMessageBox(null),
        });
        return;
      }

      const completeSave = (groupWithSong?: Song) => {
        setEditedSong(song);

        // Add to database
        database.addSong(song);

        // If user chose to group with an existing song, create the group
        if (groupWithSong) {
          database.MakeGroup(song, groupWithSong);
        }

        // Notify parent
        if (onSongImported) {
          onSongImported(song);
        }

        // Reset wizard for next file
        if (importedFiles.length > 1) {
          // Remove current file from list
          const remainingFiles = importedFiles.filter((f) => f !== selectedFile);
          setImportedFiles(remainingFiles);

          if (remainingFiles.length > 0) {
            // Load next file
            setSelectedFile(remainingFiles[0]);
            setCurrentTab(0);
          } else {
            onClose();
          }
        } else {
          onClose();
        }
      };

      // Check for similar songs in the database before saving
      const similarSongs = database.findSimilarSongs(song, true);
      if (similarSongs.length > 0) {
        // Show CompareDialog in Import mode so user can decide
        setCompareDialogState({
          song,
          similarSongs,
          onDecision: (decision) => {
            setCompareDialogState(null);
            if (decision.action === "import-and-group" && decision.groupWithSong) {
              completeSave(decision.groupWithSong);
            } else {
              // "import" — save as independent song
              completeSave();
            }
          },
        });
        return;
      }

      completeSave();
    } catch (error) {
      console.error("Import", "Failed to save song", error);
      setMessageBox({
        title: t("SongImportSaveErrorTitle"),
        message: format("SongImportSaveErrorMessage", error instanceof Error ? error.message : t("SongImportSaveErrorUnknown")),
        onConfirm: () => setMessageBox(null),
        onCancel: () => setMessageBox(null),
      });
    }
  }, [database, format, generatedChordPro, importedFiles, onClose, onSongImported, selectedFile, setCompareDialogState, t]);

  // === Navigation ===

  const handlePrevious = useCallback(() => {
    if (currentTab > minTabIndex) {
      setCurrentTab(Math.max(minTabIndex, currentTab - 1));
    }
  }, [currentTab, minTabIndex]);

  const handleNext = useCallback(() => {
    switch (currentTab) {
      case 0:
        handleNextFromFileSelection();
        break;
      case 1:
        handleNextFromLineClassification();
        break;
      case 2:
        handleNextFromChordNormalization();
        break;
      case 3:
        handleSaveAndRestart();
        break;
    }
  }, [currentTab, handleNextFromFileSelection, handleNextFromLineClassification, handleNextFromChordNormalization, handleSaveAndRestart]);

  // === Render ===

  const renderTab0 = () => (
    <div className="wizard-tab file-selection-tab">
      <h2>{t("SongImportSelectInputFileTitle")}</h2>
      <div className="file-input-container">
        <input
          type="file"
          accept=".chp,.txt,.pdf,.docx,.htm,.html"
          onChange={handleFileUpload}
          className="file-input"
          aria-label={t("SongImportSelectFileAria")}
        />
        {selectedFile && (
          <div className="selected-file-info">
            <strong>{t("SongImportSelectedLabel")}</strong> {selectedFile.name}
          </div>
        )}
      </div>
      <div className="supported-formats">
        <p>
          <strong>{t("SongImportSupportedFormatsTitle")}</strong>
        </p>
        <ul>
          <li>{t("SongImportFormatChp")}</li>
          <li>{t("SongImportFormatTxt")}</li>
          <li>{t("SongImportFormatDocx")}</li>
          <li>{t("SongImportFormatPdf")}</li>
          <li>{t("SongImportFormatHtml")}</li>
        </ul>
      </div>
    </div>
  );

  const renderTab1 = () => {
    const handleBadgeMouseDown = (index: number, event: React.MouseEvent) => {
      isLongPressRef.current = false;
      longPressTimerRef.current = setTimeout(() => {
        isLongPressRef.current = true;
        handleLineTypeBadgeLongPress(index, event);
      }, 500); // 500ms for long press
    };

    const handleBadgeTouchStart = (index: number, event: React.TouchEvent) => {
      isLongPressRef.current = false;
      longPressTimerRef.current = setTimeout(() => {
        isLongPressRef.current = true;
        handleLineTypeBadgeLongPress(index, event);
      }, 500); // 500ms for long press
    };

    const handleBadgeMouseUp = (index: number) => {
      if (longPressTimerRef.current) {
        clearTimeout(longPressTimerRef.current);
        longPressTimerRef.current = null;
      }

      if (!isLongPressRef.current) {
        handleLineTypeBadgeClick(index);
      }
    };

    const handleBadgeTouchEnd = (index: number) => {
      if (longPressTimerRef.current) {
        clearTimeout(longPressTimerRef.current);
        longPressTimerRef.current = null;
      }

      if (!isLongPressRef.current) {
        handleLineTypeBadgeClick(index);
      }
    };

    return (
      <div className="wizard-tab line-classification-tab">
        <h2>{t("SongImportClassifyLinesTitle")}</h2>
        <div className="line-controls">
          <button onClick={handleSelectAll}>{t("SongImportSelectAll")}</button>
          <button onClick={handleSelectNone}>{t("SongImportSelectNone")}</button>
          <button onClick={handleSelectInvert}>{t("SongImportInvertSelection")}</button>
          <button onClick={handleLyricsOnly}>{t("SongImportLyricsOnly")}</button>
        </div>
        <div className="line-list">
          {Array.from({ length: allLines.count }, (_, i) => {
            const line = allLines.get(i);
            if (!line) return null;

            return (
              <div key={i} className={`line-item ${selectedLines.has(i) ? "selected" : ""}`}>
                <input
                  type="checkbox"
                  checked={selectedLines.has(i)}
                  onChange={() => handleLineCheckToggle(i)}
                  aria-label={format("SongImportSelectLineAria", String(i + 1))}
                />
                <span
                  className={`line-type-badge line-type-badge-clickable ${line.line_type || "unset"}`}
                  onMouseDown={(e) => handleBadgeMouseDown(i, e)}
                  onMouseUp={() => handleBadgeMouseUp(i)}
                  onMouseLeave={() => {
                    if (longPressTimerRef.current) {
                      clearTimeout(longPressTimerRef.current);
                      longPressTimerRef.current = null;
                    }
                  }}
                  onTouchStart={(e) => handleBadgeTouchStart(i, e)}
                  onTouchEnd={() => handleBadgeTouchEnd(i)}
                  onTouchCancel={() => {
                    if (longPressTimerRef.current) {
                      clearTimeout(longPressTimerRef.current);
                      longPressTimerRef.current = null;
                    }
                  }}
                  title={t("SongImportLineTypeToggleTitle")}
                >
                  {getLineTypeLabel(line.line_type)}
                </span>
                <span className="line-text">{line.text}</span>
              </div>
            );
          })}
        </div>
      </div>
    );
  };

  const renderTab2 = () => (
    <div className="wizard-tab chord-normalization-tab">
      <h2>{t("SongImportNormalizeChordsTitle")}</h2>
      <div className="chord-options">
        <label>
          <input ref={useHInputRef} type="checkbox" checked={useHMode > 0} onChange={(e) => handleUseHChange(e.target.checked)} />
          {t("SongImportUseH")}
        </label>
        <label>
          <input ref={lcMollInputRef} type="checkbox" checked={lcMollMode > 0} onChange={(e) => handleLcMollChange(e.target.checked)} />
          {t("SongImportLowercaseMoll")}
        </label>
        <button type="button" className="chord-reset-button" onClick={handleResetChordNormalization} disabled={manualEditedChords.size === 0}>
          {t("SongImportResetNormalizedChords")}
        </button>
      </div>
      {!chordModesResolved && <div className="chord-options-warning">{t("SongImportResolveChordModesMessage")}</div>}
      <div className="chord-table-hint">{t("SongImportChordSelectorHint")}</div>
      <div className="chord-list">
        <table>
          <thead>
            <tr>
              <th>{t("SongImportOriginalHeader")}</th>
              <th>{t("SongImportNormalizedHeader")}</th>
            </tr>
          </thead>
          <tbody>
            {chordMap.getEntries().map(([original, normalized]) => {
              const isUnknownChord = normalized.trim().length > 0 && normalizedChordSystem.identifyChord(normalized.trim()) == null;

              return (
                <tr
                  key={original}
                  className={`${selectedChord === original ? "selected" : ""} ${manualEditedChords.has(original) ? "manual-override" : ""}`.trim()}
                >
                  <td>{original}</td>
                  <td>
                    <div className="chord-edit-control">
                      <input
                        className={`${manualEditedChords.has(original) ? "manual-override-input" : ""} ${flashingChords.has(original) ? "chord-auto-flash" : ""} ${isUnknownChord ? "unknown-chord-input" : ""}`.trim()}
                        type="text"
                        value={normalized}
                        onChange={(e) => handleChordEdit(original, e.target.value)}
                        onDoubleClick={() => handleOpenChordSelector(original)}
                        aria-label={format("SongImportNormalizedChordAria", original)}
                      />
                      <button
                        type="button"
                        className="open-chord-selector-button"
                        onClick={() => handleOpenChordSelector(original)}
                        aria-label={t("SongImportOpenChordSelector")}
                      >
                        {t("SongImportOpenChordSelector")}
                      </button>
                    </div>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <div className="song-importer-chord-selector-host chordSelector" ref={chordSelectorHostRef}>
        <div id={IMPORT_CHORD_SELECTOR_IDS.closeSelector} className="song-importer-chord-selector-close">
          X
        </div>
        <table className="song-importer-chord-selector-table">
          <tbody>
            <tr>
              <td>Base note</td>
              <td>
                <select id={IMPORT_CHORD_SELECTOR_IDS.baseNoteSelector}></select>
              </td>
              <td>Bass note</td>
              <td>
                <select id={IMPORT_CHORD_SELECTOR_IDS.bassNoteSelector}></select>
              </td>
            </tr>
            <tr>
              <td>Chord</td>
              <td colSpan={3}>
                <div>
                  <label id={IMPORT_CHORD_SELECTOR_IDS.customSpan} htmlFor={IMPORT_CHORD_SELECTOR_IDS.modifierSelector}></label>
                  <select id={IMPORT_CHORD_SELECTOR_IDS.modifierSelector}></select>
                </div>
              </td>
            </tr>
            <tr>
              <td>Symbol</td>
              <td colSpan={3}>
                <input id={IMPORT_CHORD_SELECTOR_IDS.subscript} type="text" />
              </td>
            </tr>
            <tr>
              <td>Steps</td>
              <td colSpan={3}>
                <div>
                  <label htmlFor={IMPORT_CHORD_SELECTOR_IDS.steps}>1-</label>
                  <input id={IMPORT_CHORD_SELECTOR_IDS.steps} type="text" />
                </div>
              </td>
            </tr>
            <tr>
              <td>Notes</td>
              <td colSpan={3}>
                <div>
                  <label id={IMPORT_CHORD_SELECTOR_IDS.baseNoteSpan}></label>
                  <input id={IMPORT_CHORD_SELECTOR_IDS.notes} type="text" />
                </div>
              </td>
            </tr>
          </tbody>
        </table>
        <table className="song-importer-chord-selector-table">
          <tbody>
            <tr>
              <td className="song-importer-chord-selector-panel song-importer-chord-selector-panel-main">
                <div id={IMPORT_CHORD_SELECTOR_IDS.musicChordBox} className="song-importer-chord-selector-music-box"></div>
                <input type="button" id={IMPORT_CHORD_SELECTOR_IDS.applySelector} value="OK" />
              </td>
              <td className="song-importer-chord-selector-panel song-importer-chord-selector-panel-piano">
                <canvas id={IMPORT_CHORD_SELECTOR_IDS.pianoChordBox}></canvas>
              </td>
              <td className="song-importer-chord-selector-panel song-importer-chord-selector-panel-guitar">
                <canvas id={IMPORT_CHORD_SELECTOR_IDS.guitarChordBox}></canvas>
              </td>
            </tr>
          </tbody>
        </table>
      </div>
    </div>
  );

  const renderTab3 = () => (
    <div className="wizard-tab chordpro-editor-tab">
      <h2>{t("SongImportEditChordProTitle")}</h2>
      <div className="chordpro-editor-wrapper">
        <ChordProEditorComponent ref={chordProEditorRef} song={editorSong} onTextChange={handleChordProChange} initialEditMode={true} />
      </div>
    </div>
  );

  return (
    <>
      <div className="song-importer-backdrop" onClick={onClose}></div>
      <div className="song-importer-wizard">
        <div className="wizard-header">
          <h1>{t("SongImportWizardTitle")}</h1>
          <button onClick={onClose} className="close-button" aria-label={t("Close")}>
            ×
          </button>
        </div>

        <div className="wizard-tabs">
          <button className={currentTab === 0 ? "active" : ""} onClick={() => setCurrentTab(0)}>
            {t("SongImportTabFileSelection")}
          </button>
          <button className={currentTab === 1 ? "active" : ""} onClick={() => setCurrentTab(1)} disabled={isChordProDirectFlow || currentTab < 1}>
            {t("SongImportTabLineClassification")}
          </button>
          <button className={currentTab === 2 ? "active" : ""} onClick={() => setCurrentTab(2)} disabled={currentTab < 2}>
            {t("SongImportTabChordNormalization")}
          </button>
          <button className={currentTab === 3 ? "active" : ""} onClick={() => setCurrentTab(3)} disabled={currentTab < 3}>
            {t("SongImportTabChordProEditor")}
          </button>
        </div>

        <div className="wizard-content">
          {currentTab === 0 && renderTab0()}
          {currentTab === 1 && renderTab1()}
          {currentTab === 2 && renderTab2()}
          {currentTab === 3 && renderTab3()}
        </div>

        <div className="wizard-footer">
          <button onClick={handlePrevious} disabled={currentTab <= minTabIndex} className="prev-button">
            {t("SongImportPrevious")}
          </button>
          <button onClick={handleNext} className="next-button" disabled={currentTab === 2 && !chordModesResolved}>
            {currentTab === 3 ? t("SongImportSaveClose") : t("SongImportNext")}
          </button>
        </div>

        {messageBox && (
          <MessageBox
            title={messageBox.title}
            message={messageBox.message}
            onConfirm={messageBox.onConfirm}
            onCancel={messageBox.onCancel}
            confirmText={messageBox.confirmText}
            showCancel={messageBox.showCancel}
          />
        )}

        {contextMenu && (
          <ContextMenu
            items={contextMenu.items}
            position={contextMenu.position}
            onSelect={contextMenu.onSelect}
            onClose={() => setContextMenu(null)}
          />
        )}

        {compareDialogState && (
          <Suspense
            fallback={
              <div className="loading-overlay">
                <div className="loading-spinner" />
              </div>
            }
          >
            <CompareDialog
              originalSong={compareDialogState.song}
              songsToCompare={compareDialogState.similarSongs}
              mode="Import"
              onClose={(_mergedSong, importDecision) => {
                if (importDecision) {
                  compareDialogState.onDecision(importDecision);
                } else {
                  // User closed dialog without choosing — cancel the save
                  setCompareDialogState(null);
                }
              }}
            />
          </Suspense>
        )}
      </div>
    </>
  );
};
