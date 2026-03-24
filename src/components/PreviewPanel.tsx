import React, { useState, useEffect, useRef, useImperativeHandle, forwardRef, useCallback, useMemo } from "react";
import { generateQRCodeSVG } from "../hooks/useSessionUrl";
import "./PreviewPanel.css";
import { PlaylistEntry } from "../classes/PlaylistEntry";
import { Song } from "../classes/Song";
import { SectionGenerator, SectionItem, DisplaySettings } from "../utils/SectionGenerator";
import { SectionRenderer, RenderSettings } from "../utils/SectionRenderer";
import { useSettings } from "../hooks/useSettings";
import { Icon, IconType } from "../services/IconService";
import { getProjectedSong, useProjectedSong, updateCurrentDisplay } from "../state/CurrentSongStore";
import { useMessageBox } from "../contexts/MessageBoxContext";
import { useLocalization } from "../localization/LocalizationContext";
import { useTooltips } from "../localization/TooltipContext";
import { MonitorDisplay } from "../types/electron";
import { useAuth } from "../contexts/AuthContext";
import ImageSelector from "./preview/ImageSelector";
import { Settings } from "../types";
import { useLeader } from "../contexts/LeaderContext";
import { useSessionUrl } from "../hooks/useSessionUrl";
import { Panel, PanelGroup } from "react-resizable-panels";
import ResizeHandle from "./ResizeHandle";

interface PreviewPanelProps {
  selectedPlaylistItem: PlaylistEntry | null;
  editorRef?: React.RefObject<{ highlightSectionInEditor: (from: number, to: number) => void } | null>;
  enableHighlight?: boolean;
  currentSongText?: string;
  // Remote highlight controller - non-empty when a client controls highlighting (matching C# SectionListBox.Remote)
  remoteHighlightController?: string;
  // Controlled section selection (optional - for state persistence)
  selectedSectionIndex?: number;
  onSelectedSectionIndexChange?: (index: number) => void;
  // Callback when sections are (re)generated - index is the auto-selected index or -1
  onSectionsReady?: (sectionCount: number, selectedIndex: number) => void;
  // Splitter between section list and preview display
  previewSplitSize?: number;
  onPreviewSplitSizeChange?: (size: number) => void;
  onSettingsClick?: (initialTab?: string) => void;
}

// Define ref methods that can be called from parent
export interface PreviewPanelMethods {
  selectSectionByLine: (lineNumber: number) => boolean;
  getSelectedSectionIndex: () => number;
  setSelectedSectionIndex: (index: number) => void;
}

// Section display modes matching C# SectionListBox.Item.Mode
enum SectionDisplayMode {
  Normal = 0, // Text fits without issues
  Shrink = 1, // Font size was reduced to fit
  Crops = 2, // Text is cropped/doesn't fit
}

// Extended section item with checkbox and display mode
interface ExtendedSectionItem extends SectionItem {
  checked: boolean;
  displayMode: SectionDisplayMode;
}

const PreviewPanel = forwardRef<PreviewPanelMethods, PreviewPanelProps>(
  (
    {
      selectedPlaylistItem,
      editorRef,
      enableHighlight = true,
      currentSongText = "",
      remoteHighlightController = "",
      selectedSectionIndex = -1,
      onSelectedSectionIndexChange,
      onSectionsReady,
      previewSplitSize,
      onPreviewSplitSizeChange,
      onSettingsClick,
    },
    ref
  ) => {
    const { settings, updateSettingWithAutoSave } = useSettings();
    const projectedSong = useProjectedSong();
    const { showMessage } = useMessageBox();
    const { t } = useLocalization();
    const { tt } = useTooltips();
    const { isAuthenticated } = useAuth();
    const [activeTab, setActiveTab] = useState("format");
    const [sections, setSections] = useState<ExtendedSectionItem[]>([]);
    const [nextSectionIndex, setNextSectionIndex] = useState(-1);
    const { guestLeaderId: _guestLeaderId } = useLeader(); // kept for potential future use

    // Auto-compute nextSectionIndex when selection or sections change.
    // Keyboard navigation (arrow keys, Home/End, Page) overrides this until the next selection change.
    useEffect(() => {
      if (selectedSectionIndex >= 0 && sections.length > 0) {
        setNextSectionIndex((selectedSectionIndex + 1) % sections.length);
      } else {
        setNextSectionIndex(-1);
      }
    }, [selectedSectionIndex, sections]);

    // Track previous projectedSong to detect when it changes
    const prevProjectedSongIdRef = useRef<string | null>(null);

    // Display settings state (not from Settings)
    const [contentBasedSections, setContentBasedSections] = useState(settings?.contentBasedSections ?? true);
    const [projectInstructions, setProjectInstructions] = useState(settings?.projectInstructions ?? false);
    const [displayMessageEnabled, setDisplayMessageEnabled] = useState(false);
    const [freezePreview, setFreezePreview] = useState(false);
    const [showText, setShowText] = useState(true);
    const [showImage, setShowImage] = useState(true);

    // Sync local state with settings changes
    useEffect(() => {
      setContentBasedSections(settings?.contentBasedSections ?? true);
    }, [settings?.contentBasedSections]);

    useEffect(() => {
      setProjectInstructions(settings?.projectInstructions ?? false);
    }, [settings?.projectInstructions]);

    // Projector state - matching C# DisplayForm
    const [projectorEnabled, setProjectorEnabled] = useState(false);
    const [currentMonitorIndex, setCurrentMonitorIndex] = useState(-1);
    const [availableMonitors, setAvailableMonitors] = useState<MonitorDisplay[]>([]);
    const [projectorWindowRef, setProjectorWindowRef] = useState<Window | null>(null);
    const [_displayAspectRatio, setDisplayAspectRatio] = useState(16 / 9); // Default aspect ratio
    const [projectorWidth, setProjectorWidth] = useState(1920);
    const [projectorHeight, setProjectorHeight] = useState(1080);

    // Preview canvas state
    const [previewDataUrl, setPreviewDataUrl] = useState<string | null>(null);
    const [netDisplayDataUrl, setNetDisplayDataUrl] = useState<string | null>(null);
    const [bgImage, setBgImage] = useState<HTMLImageElement | null>(null);
    const [selectedImageId, setSelectedImageId] = useState<string | null>(null);

    const generatorRef = useRef<SectionGenerator | null>(null);
    const rendererRef = useRef<SectionRenderer | null>(null);
    const sectionRefs = useRef<(HTMLDivElement | null)[]>([]);
    const sectionListRef = useRef<HTMLDivElement | null>(null);
    const projectorChannelRef = useRef<BroadcastChannel | null>(null);
    const previewDataUrlRef = useRef<string | null>(null); // Ref to access latest preview in callbacks

    // Splitter: compute bottom panel minSize as a percentage from actual container height
    const panelGroupRef = useRef<HTMLDivElement | null>(null);
    const [bottomMinSize, setBottomMinSize] = useState(30);
    useEffect(() => {
      const el = panelGroupRef.current;
      if (!el) return;
      const obs = new ResizeObserver(([entry]) => {
        const h = entry.contentRect.height;
        if (h > 0) {
          const minPx = 300; // tabs + preview = minimum for bottom panel
          setBottomMinSize(Math.min(70, Math.max(20, (minPx / h) * 100)));
        }
      });
      obs.observe(el);
      return () => obs.disconnect();
    }, []);

    // QR code overlay interaction state
    // We observe the *container* (always mounted) rather than the conditional wrapper so the
    // ResizeObserver is never torn down / re-created when previewDataUrl toggles.
    const previewContainerRef = useRef<HTMLDivElement | null>(null);
    const [containerEl, setContainerEl] = useState<HTMLDivElement | null>(null);
    const containerRefCallback = useCallback((el: HTMLDivElement | null) => {
      previewContainerRef.current = el;
      setContainerEl(el);
    }, []);
    // previewWrapperRef gives drag handlers synchronous access to wrapper dimensions
    const previewWrapperRef = useRef<HTMLDivElement | null>(null);
    // imageDims: the letterboxed / pillarboxed size the preview image should actually be
    const [imageDims, setImageDims] = useState({ w: 0, h: 0 });
    // wrapperDims mirrors imageDims (used by QR overlay pixel computations)
    const wrapperDims = imageDims;
    const [qrDragPos, setQrDragPos] = useState<{ x: number; y: number } | null>(null);
    const [isQrDragging, setIsQrDragging] = useState(false);
    const qrDragRef = useRef({ startClientX: 0, startClientY: 0, startQrX: 0, startQrY: 0, moved: false });
    const qrPinchRef = useRef({ startDist: 0, startSizePercent: 0 });
    // Throttle ref for QR-interaction canvas re-renders (max once per 100ms)
    const lastQrRenderRef = useRef(0);

    // QR size context menu state
    const [qrContextMenu, setQrContextMenu] = useState<{ x: number; y: number } | null>(null);
    const qrContextMenuRef = useRef<HTMLDivElement | null>(null);

    // Available fonts for the font picker
    const [availableFonts, setAvailableFonts] = useState<string[]>(["Arial", "Times New Roman", "Verdana", "Georgia", "Courier New"]);

    // Detect available system fonts on mount
    useEffect(() => {
      const detectFonts = async () => {
        // Comprehensive list of commonly available fonts across platforms
        const fontsToCheck = [
          // Sans-serif fonts
          "Arial",
          "Arial Black",
          "Verdana",
          "Tahoma",
          "Trebuchet MS",
          "Segoe UI",
          "Calibri",
          "Helvetica",
          "Helvetica Neue",
          "Open Sans",
          "Roboto",
          "Ubuntu",
          "Noto Sans",
          "Liberation Sans",
          "DejaVu Sans",
          "Lucida Sans",
          "Lucida Grande",
          "Century Gothic",
          "Franklin Gothic Medium",
          "Gill Sans",
          "Optima",
          // Serif fonts
          "Times New Roman",
          "Georgia",
          "Palatino Linotype",
          "Palatino",
          "Book Antiqua",
          "Cambria",
          "Garamond",
          "Baskerville",
          "Bodoni MT",
          "Bookman Old Style",
          "Century Schoolbook",
          "Constantia",
          "Didot",
          "Liberation Serif",
          "DejaVu Serif",
          "Noto Serif",
          "PT Serif",
          // Monospace fonts
          "Courier New",
          "Consolas",
          "Monaco",
          "Lucida Console",
          "Liberation Mono",
          "DejaVu Sans Mono",
          "Source Code Pro",
          "Fira Mono",
          "Ubuntu Mono",
          "Menlo",
          // Display/decorative fonts
          "Impact",
          "Comic Sans MS",
          "Papyrus",
          "Copperplate",
          "Rockwell",
          "Brush Script MT",
          // Cursive fonts
          "Lucida Handwriting",
          "Segoe Script",
          "Script MT",
        ];

        // Use canvas-based font detection
        const canvas = document.createElement("canvas");
        const ctx = canvas.getContext("2d");
        if (!ctx) {
          return;
        }

        const testString = "mmmmmmmmmmlli";
        const testSize = "72px";
        const baselineFont = "monospace";

        // Measure baseline width
        ctx.font = `${testSize} ${baselineFont}`;
        const baselineWidth = ctx.measureText(testString).width;

        const detectedFonts: string[] = [];

        for (const font of fontsToCheck) {
          ctx.font = `${testSize} "${font}", ${baselineFont}`;
          const fontWidth = ctx.measureText(testString).width;

          // If width differs from baseline, the font is available
          if (fontWidth !== baselineWidth) {
            detectedFonts.push(font);
          }
        }

        // Sort alphabetically and update state
        detectedFonts.sort((a, b) => a.localeCompare(b));
        if (detectedFonts.length > 0) {
          setAvailableFonts(detectedFonts);
        }
      };

      detectFonts();
    }, []);

    // Update display state when section changes
    const updateDisplayState = useCallback(
      async (sectionIndex: number, section: SectionItem) => {
        const song = getProjectedSong();
        if (!song) return;
        updateCurrentDisplay({
          songId: song.Id,
          from: section.from,
          to: section.to,
          section: sectionIndex,
          transpose: selectedPlaylistItem?.transpose || 0,
          capo: selectedPlaylistItem?.capo,
          song: song.Text,
          system: song.System,
          instructions: selectedPlaylistItem?.instructions,
        });
      },
      [selectedPlaylistItem, settings?.externalWebDisplayEnabled, settings?.selectedLeader, isAuthenticated]
    );

    // Helper function to get next checked section index (matching C# GetNextOf logic)
    const getNextCheckedIndex = useCallback(
      (startIndex: number, sectionList: ExtendedSectionItem[]): number => {
        if (sectionList.length === 0) return -1;

        const start = startIndex < 0 ? -1 : startIndex;
        let acceptSelected = false;

        for (let i = start + 1; i !== start; i++) {
          if (i >= sectionList.length) {
            i = 0;
            if (acceptSelected) break;
            acceptSelected = true;
          }

          if (sectionList[i].checked && (acceptSelected || selectedSectionIndex !== i)) {
            return i;
          }
        }

        return -1;
      },
      [selectedSectionIndex]
    );

    // Expose methods to parent component via ref
    useImperativeHandle(
      ref,
      () => ({
        selectSectionByLine: (lineNumber: number): boolean => {
          // Find section that contains the given line number
          // Matching C# ChangeHighlightByLine logic
          for (let i = 0; i < sections.length; i++) {
            const section = sections[i];
            if (section.from <= lineNumber && lineNumber < section.to) {
              onSelectedSectionIndexChange?.(i);
              updateDisplayState(i, section);
              return true;
            }
          }
          onSelectedSectionIndexChange?.(-1);
          updateCurrentDisplay({ from: 0, to: 0, section: -1 }); // Clear display
          return false;
        },
        getSelectedSectionIndex: (): number => {
          return selectedSectionIndex;
        },
        setSelectedSectionIndex: (index: number): void => {
          if (index >= -1 && index < sections.length) {
            onSelectedSectionIndexChange?.(index);
            if (index >= 0 && sections[index]) {
              updateDisplayState(index, sections[index]);
            }
          }
        },
      }),
      [sections, updateDisplayState, selectedSectionIndex, onSelectedSectionIndexChange]
    );

    // Toggle section checkbox
    const toggleSectionCheck = useCallback((index: number) => {
      setSections((prev) => {
        const newSections = [...prev];
        newSections[index] = { ...newSections[index], checked: !newSections[index].checked };
        return newSections;
      });
    }, []);

    // Get background color for section based on display mode (matching C# StateColor logic)
    const getSectionBgColor = (mode: SectionDisplayMode): string => {
      switch (mode) {
        case SectionDisplayMode.Crops:
          return settings?.checkSectionsProjectable ? settings?.displayCroppedTextBgColor || "#de9191" : "transparent";
        case SectionDisplayMode.Shrink: {
          // Check if font reduction should be shown in sections
          const showReduction = settings?.displayShowFontSizeReduction === "BOTH" || settings?.displayShowFontSizeReduction === "SECTIONS";
          return showReduction ? settings?.displayShrinkedTextBgColor || "#fffa9e" : "transparent";
        }
        default:
          return "transparent";
      }
    };

    // Get section type color (matching C# UseSectionColoring logic)
    const getSectionTypeColor = (type: number): string | null => {
      // Only return colors if section coloring is enabled (matching C# if UseSectionColoring check)
      if (!settings?.useSectionColoring) {
        return null;
      }

      // Song.SectionType: unknown=0, verse=1, chorus=2, bridge=3
      switch (type) {
        case 1: // verse
          return settings.verseSectionColor;
        case 2: // chorus
          return settings.chorusSectionColor;
        case 3: // bridge
          return settings.bridgeSectionColor;
        default:
          return null;
      }
    };

    // Initialize generator and renderer
    useEffect(() => {
      generatorRef.current = new SectionGenerator();
      rendererRef.current = new SectionRenderer();
      return () => {
        generatorRef.current?.dispose();
        rendererRef.current?.dispose();
      };
    }, []);

    // Initialize BroadcastChannel for projector communication (survives page reload)
    useEffect(() => {
      const channel = new BroadcastChannel("pp-projector");
      projectorChannelRef.current = channel;

      // Listen for projector window messages
      channel.onmessage = (event) => {
        if (event.data.type === "PROJECTOR_READY") {
          // Projector window is ready - enable projector mode and send current preview
          // console.debug("Preview", "Projector window connected via BroadcastChannel");
          setProjectorEnabled(true);
          // Update dimensions if provided
          if (event.data.width && event.data.height) {
            setProjectorWidth(event.data.width);
            setProjectorHeight(event.data.height);
            setDisplayAspectRatio(event.data.width / event.data.height);
          }
          // Send current preview to the newly connected projector
          if (previewDataUrlRef.current) {
            channel.postMessage({ type: "UPDATE_DISPLAY", imageData: previewDataUrlRef.current });
          }
        } else if (event.data.type === "PROJECTOR_RESIZE") {
          // Projector window resized
          if (event.data.width && event.data.height) {
            setProjectorWidth(event.data.width);
            setProjectorHeight(event.data.height);
            setDisplayAspectRatio(event.data.width / event.data.height);
          }
        } else if (event.data.type === "PROJECTOR_CLOSED") {
          // Projector window closed
          // console.debug("Preview", "Projector window disconnected via BroadcastChannel");
          setProjectorEnabled(false);
          setProjectorWindowRef(null);
          setProjectorWidth(1920);
          setProjectorHeight(1080);
          setDisplayAspectRatio(16 / 9);
        }
      };

      // Request current projector status (in case projector is already open)
      channel.postMessage({ type: "PROJECTOR_PING" });

      return () => {
        channel.close();
        projectorChannelRef.current = null;
      };
    }, []);

    // Restore Electron projector state on mount (display window survives renderer reload)
    useEffect(() => {
      const api = window.electronAPI;
      if (!api?.isDisplayWindowOpen || !api?.getAllDisplays) return;
      (async () => {
        try {
          const isOpen = await api.isDisplayWindowOpen!();
          if (!isOpen) return;
          const displays = await api.getAllDisplays!();
          const mainDisplayId = api.getMainWindowDisplayId ? await api.getMainWindowDisplayId() : null;
          const targetDisplays = mainDisplayId ? displays.filter((d) => d.id !== mainDisplayId) : displays;
          const savedId = settings?.displayMonitorId;
          const idx = savedId ? targetDisplays.findIndex((d) => d.id === savedId) : 0;
          const matchIndex = idx >= 0 ? idx : 0;
          if (matchIndex < targetDisplays.length) {
            const display = targetDisplays[matchIndex];
            setAvailableMonitors(targetDisplays);
            setCurrentMonitorIndex(matchIndex);
            setProjectorEnabled(true);
            setProjectorWidth(display.bounds.width);
            setProjectorHeight(display.bounds.height);
            setDisplayAspectRatio(display.bounds.width / display.bounds.height);
          }
        } catch (error) {
          console.error("Preview", "Failed to restore projector state", error);
        }
      })();
    }, []); // eslint-disable-line react-hooks/exhaustive-deps

    // Update sections when song or settings change
    useEffect(() => {
      // If we're editing the same song as projected (enableHighlight) and have live lyrics,
      // build a temporary Song from currentLyrics to regenerate sections immediately.
      const song =
        enableHighlight && currentSongText && currentSongText.length > 0 ? new Song(currentSongText, projectedSong?.System || "G") : projectedSong;

      if (!song || !generatorRef.current) {
        const timerId = setTimeout(() => {
          setSections([]);
          onSelectedSectionIndexChange?.(-1);
        }, 0);
        return () => clearTimeout(timerId);
      }

      // Calculate render rectangle with margins applied - matching C# UpdateDisplayArea logic
      // In C#: previewRenderRect.Width = previewDisplayRect.Width - (previewDisplayRect.Width * (left + right) / 100)
      const marginLeft = settings?.displayBorderRect?.left || 0;
      const marginRight = settings?.displayBorderRect?.width || 0; // right is stored as width
      const marginTop = settings?.displayBorderRect?.top || 0;
      const marginBottom = settings?.displayBorderRect?.height || 0; // bottom is stored as height

      const renderRectWidth = projectorWidth - Math.floor((projectorWidth * (marginLeft + marginRight)) / 100);
      const renderRectHeight = projectorHeight - Math.floor((projectorHeight * (marginTop + marginBottom)) / 100);

      const actualFontSize = SectionRenderer.calculateActualFontSize(settings?.displayFontSize || 16, projectorWidth, projectorHeight);

      const displaySettings: DisplaySettings = {
        fontFamily: settings?.displayFontName || "Arial",
        fontSize: actualFontSize, // Use pixel-based font size for section generation
        bold: settings?.displayFontBold ?? false,
        italic: settings?.displayFontItalic ?? false,
        underline: settings?.displayFontUnderline ?? false,
        alignment: settings?.displayFontAlign || "center",
        renderRectWidth: renderRectWidth,
        renderRectHeight: renderRectHeight,
        contentBasedSections,
        checkSectionsProjectable: settings?.checkSectionsProjectable ?? true,
        allowFontSizeReduction: settings?.displayAllowFontSizeReduction ?? true,
        displayFaultThreshold: 10,
        nonSplittingWords: settings?.nonSplittingWordList || [],
        displayMinimumFontSize: settings?.displayMinimumFontSize || 0,
        displayMinimumFontSizePercent: settings?.displayMinimumFontSizePercent || 70,
      };

      const instructions = projectInstructions && selectedPlaylistItem?.instructions ? selectedPlaylistItem.instructions : "";
      const baseSections = generatorRef.current.updateSectionList(song, displaySettings, projectInstructions, instructions);

      // Convert to extended sections with checkbox and display mode
      const newSections: ExtendedSectionItem[] = baseSections.map((section, index) => {
        // Preserve checkbox state if section existed before
        const oldSection = sections[index];
        const checked = oldSection ? oldSection.checked : true;

        // Determine display mode based on label (matching C# logic)
        let displayMode = SectionDisplayMode.Normal;
        if (section.label === null) {
          displayMode = SectionDisplayMode.Crops;
        } else if (section.label === "") {
          displayMode = SectionDisplayMode.Shrink;
        }

        return {
          ...section,
          checked,
          displayMode,
        };
      });

      setSections(newSections);

      // Reset selection when projectedSong changes (different song)
      const currentSongId = projectedSong?.Id || null;
      prevProjectedSongIdRef.current = currentSongId;

      // Determine the new selected index
      let newSelectedIndex: number;

      // If we have a controlled section index from parent, use it (during restoration)
      // Parent has a valid selection — apply it
      if (selectedSectionIndex >= 0 && selectedSectionIndex < newSections.length) {
        newSelectedIndex = selectedSectionIndex;
        if (newSections[newSelectedIndex]) {
          updateDisplayState(newSelectedIndex, newSections[newSelectedIndex]);
        }
        // Highlight in editor
        if (enableHighlight && settings?.sectionHighlightInEditor && editorRef?.current && newSections[newSelectedIndex]) {
          const section = newSections[newSelectedIndex];
          requestAnimationFrame(() => {
            editorRef.current?.highlightSectionInEditor(section.from, section.to);
          });
        }
      } else {
        newSelectedIndex = -1;
      }

      // Notify parent that sections are ready
      onSectionsReady?.(newSections.length, newSelectedIndex);
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [
      projectedSong,
      currentSongText,
      selectedPlaylistItem,
      settings,
      contentBasedSections,
      projectInstructions,
      projectorWidth,
      projectorHeight,
      selectedSectionIndex,
    ]);

    // Highlight section in editor when selection changes (matching C# SectionHighlightInEditor)
    useEffect(() => {
      if (
        enableHighlight &&
        settings?.sectionHighlightInEditor &&
        editorRef?.current &&
        selectedSectionIndex >= 0 &&
        selectedSectionIndex < sections.length
      ) {
        const section = sections[selectedSectionIndex];
        // Call editor's highlight method with from/to line numbers
        editorRef.current.highlightSectionInEditor(section.from, section.to);
      } else if (enableHighlight && editorRef?.current && selectedSectionIndex < 0) {
        // Clear highlight when no section is selected
        editorRef.current.highlightSectionInEditor(0, 0);
      }
    }, [selectedSectionIndex, sections, settings?.sectionHighlightInEditor, editorRef, enableHighlight]);

    // Scroll selected section into view, or scroll to top when no selection (new song loaded)
    useEffect(() => {
      if (selectedSectionIndex >= 0 && sectionRefs.current[selectedSectionIndex]) {
        sectionRefs.current[selectedSectionIndex]?.scrollIntoView({
          behavior: "smooth",
          block: "nearest",
        });
      } else if (selectedSectionIndex < 0 && sectionListRef.current) {
        sectionListRef.current.scrollTop = 0;
      }
    }, [selectedSectionIndex, sections]);

    // Observe the CONTAINER to compute the correct letterboxed image dimensions.
    // The container's size is constrained by the flex layout, so it's the reliable reference.
    useEffect(() => {
      if (!containerEl) {
        setImageDims({ w: 0, h: 0 });
        return;
      }
      const computeDims = (cw: number, ch: number) => {
        if (!cw || !ch || !projectorWidth || !projectorHeight) {
          setImageDims({ w: 0, h: 0 });
          return;
        }
        const aspect = projectorWidth / projectorHeight;
        let w: number, h: number;
        if (cw / ch > aspect) {
          // Container is wider than image → height-constrained
          h = ch;
          w = ch * aspect;
        } else {
          // Container is narrower → width-constrained
          w = cw;
          h = cw / aspect;
        }
        setImageDims({ w: Math.round(w), h: Math.round(h) });
      };
      computeDims(containerEl.offsetWidth, containerEl.offsetHeight);
      const obs = new ResizeObserver((entries) => {
        const r = entries[0]?.contentRect;
        if (r) computeDims(r.width, r.height);
      });
      obs.observe(containerEl);
      return () => obs.disconnect();
    }, [containerEl, projectorWidth, projectorHeight]);

    // Raw QR URL — computed regardless of qrCodeInPreview (so clicking can re-show the QR)
    const qrRawUrl = useSessionUrl("auto");

    // Effective URL for canvas / overlay rendering — empty when QR is hidden
    const qrCodeUrl = settings?.qrCodeInPreview ? (qrRawUrl ?? "") : "";

    // Live QR position: prefer drag position, fall back to persisted settings
    const liveQrX = qrDragPos !== null ? qrDragPos.x : (settings?.qrCodeX ?? 85);
    const liveQrY = qrDragPos !== null ? qrDragPos.y : (settings?.qrCodeY ?? 82);
    const netDisplayJpegQuality = Math.max(1, Math.min(100, settings?.netDisplayJpegQuality ?? 70));
    const netDisplayJpegQualityFactor = netDisplayJpegQuality / 100;

    // Clamp QR position when size changes so it stays within the image area
    useEffect(() => {
      if (!settings) return;
      const sizePercent = settings.qrCodeSizePercent ?? 15;
      const currentX = settings.qrCodeX ?? 85;
      const currentY = settings.qrCodeY ?? 82;
      const aspectRatio = projectorWidth / projectorHeight || 16 / 9;
      const maxX = Math.max(0, 100 - sizePercent / aspectRatio);
      const maxY = Math.max(0, 100 - sizePercent);
      const clampedX = Math.max(0, Math.min(maxX, currentX));
      const clampedY = Math.max(0, Math.min(maxY, currentY));
      if (Math.abs(clampedX - currentX) > 0.01) updateSettingWithAutoSave("qrCodeX", clampedX);
      if (Math.abs(clampedY - currentY) > 0.01) updateSettingWithAutoSave("qrCodeY", clampedY);
    }, [settings?.qrCodeSizePercent, settings?.qrCodeX, settings?.qrCodeY, projectorWidth, projectorHeight, updateSettingWithAutoSave]);

    // Render preview when selected section or settings change
    useEffect(() => {
      // If preview is frozen, don't update
      if (freezePreview) {
        return;
      }

      if (!rendererRef.current) {
        const timerId = setTimeout(() => setPreviewDataUrl(null), 0);
        setNetDisplayDataUrl(null);
        return () => clearTimeout(timerId);
      }

      // Throttle canvas re-renders during QR interactions (drag / slider) to max once per 100ms
      const isQrInteracting = isQrDragging || qrDragPos !== null;
      if (isQrInteracting) {
        const now = Date.now();
        const elapsed = now - lastQrRenderRef.current;
        if (elapsed < 100) {
          // Schedule a trailing render so the final position is always rendered
          const timer = setTimeout(() => {
            lastQrRenderRef.current = Date.now();
            // Re-trigger by doing an inline render with current closure values
            doRender();
          }, 100 - elapsed);
          return () => clearTimeout(timer);
        }
        lastQrRenderRef.current = now;
      } else {
        lastQrRenderRef.current = 0;
      }

      function doRender() {
        if (!rendererRef.current) return;

        // If message display is enabled, render message instead of section
        if (displayMessageEnabled) {
          const messageText = showText ? settings?.message || "" : "";
          const renderSettings: RenderSettings = {
            fontFamily: settings?.displayFontName || "Arial",
            fontSize: settings?.displayFontSize || 16,
            bold: settings?.displayFontBold ?? false,
            italic: settings?.displayFontItalic ?? false,
            underline: settings?.displayFontUnderline ?? false,
            alignment: settings?.displayFontAlign || "center",
            textColor: settings?.textColor || "#FFFFFF",
            bgColor: settings?.backgroundColor || "#000000",
            textBorderColor: settings?.textBorderColor || "#000000",
            textBorderWidth: settings?.textBorderWidth || 0,
            textShadowOffset: settings?.displayTextShadowOffset ?? 2,
            renderWidth: projectorWidth,
            renderHeight: projectorHeight,
            marginLeft: settings?.displayBorderRect?.left || 0,
            marginRight: settings?.displayBorderRect?.width || 0,
            marginTop: settings?.displayBorderRect?.top || 0,
            marginBottom: settings?.displayBorderRect?.height || 0,
            backgroundImageFit: settings?.backgroundImageFit || "touchInner",
            checkSectionsProjectable: settings?.checkSectionsProjectable || false,
            qrCodeUrl: qrCodeUrl,
            qrCodeX: liveQrX,
            qrCodeY: liveQrY,
            qrCodeSizePercent: settings?.qrCodeSizePercent,
          };

          updateCurrentDisplay({ message: messageText });

          try {
            const canvas = rendererRef.current.renderSection(messageText, renderSettings, showImage ? bgImage : null);
            setPreviewDataUrl(canvas.toDataURL("image/png"));
            setNetDisplayDataUrl(canvas.toDataURL("image/jpeg", netDisplayJpegQualityFactor));
          } catch (error) {
            console.error("Preview", "Error rendering message", error);
            setPreviewDataUrl(null);
            setNetDisplayDataUrl(null);
          }
          return;
        }

        // Normal section rendering
        if (selectedSectionIndex < 0 || !sections[selectedSectionIndex]) {
          setPreviewDataUrl(null);
          setNetDisplayDataUrl(null);
          return;
        }

        const section = sections[selectedSectionIndex];
        const sectionText = showText ? section.text : "";
        const renderSettings: RenderSettings = {
          fontFamily: settings?.displayFontName || "Arial",
          fontSize: settings?.displayFontSize || 16,
          bold: settings?.displayFontBold ?? false,
          italic: settings?.displayFontItalic ?? false,
          underline: settings?.displayFontUnderline ?? false,
          alignment: settings?.displayFontAlign || "center",
          textColor: settings?.textColor || "#FFFFFF",
          bgColor: settings?.backgroundColor || "#000000",
          textBorderColor: settings?.textBorderColor || "#000000",
          textBorderWidth: settings?.textBorderWidth || 0,
          textShadowOffset: settings?.displayTextShadowOffset ?? 2,
          renderWidth: projectorWidth,
          renderHeight: projectorHeight,
          marginLeft: settings?.displayBorderRect?.left || 0,
          marginRight: settings?.displayBorderRect?.width || 0,
          marginTop: settings?.displayBorderRect?.top || 0,
          marginBottom: settings?.displayBorderRect?.height || 0,
          backgroundImageFit: settings?.backgroundImageFit || "touchInner",
          checkSectionsProjectable: settings?.checkSectionsProjectable || false,
          qrCodeUrl: qrCodeUrl,
          qrCodeX: liveQrX,
          qrCodeY: liveQrY,
          qrCodeSizePercent: settings?.qrCodeSizePercent,
        };

        updateCurrentDisplay({ message: sectionText });

        try {
          const canvas = rendererRef.current.renderSection(sectionText, renderSettings, showImage ? bgImage : null);
          setPreviewDataUrl(canvas.toDataURL("image/png"));
          setNetDisplayDataUrl(canvas.toDataURL("image/jpeg", netDisplayJpegQualityFactor));
        } catch (error) {
          console.error("Preview", "Error rendering section", error);
          setPreviewDataUrl(null);
          setNetDisplayDataUrl(null);
        }
      }

      doRender();
    }, [
      selectedSectionIndex,
      sections,
      settings,
      bgImage,
      displayMessageEnabled,
      freezePreview,
      showText,
      showImage,
      projectorWidth,
      projectorHeight,
      qrCodeUrl,
      netDisplayJpegQualityFactor,
      isQrDragging,
      qrDragPos,
      liveQrX,
      liveQrY,
    ]);

    const handleSectionClick = (index: number) => {
      onSelectedSectionIndexChange?.(index);
      if (sections[index]) {
        updateDisplayState(index, sections[index]);
      }
    };

    // Keyboard handler for section list (matching C# SectionListBox.OnKeyDown and OnKeyPress)
    const handleSectionListKeyDown = useCallback(
      (e: React.KeyboardEvent) => {
        if (sections.length === 0) return;

        // Helper to check if index is valid for next selection
        const isValidNextIndex = (i: number) => i >= 0 && i < sections.length && i !== selectedSectionIndex && sections[i].checked;

        // Helper to ensure item is visible
        const ensureVisible = (index: number) => {
          if (index >= 0 && sectionRefs.current[index]) {
            sectionRefs.current[index]?.scrollIntoView({ behavior: "smooth", block: "nearest" });
          }
        };

        switch (e.key) {
          case "ArrowDown":
          case "ArrowRight": {
            // Move nextIndex forward (matching C# OnKeyDown Keys.Down/Right)
            const newNext = getNextCheckedIndex(nextSectionIndex, sections);
            if (newNext >= 0) {
              setNextSectionIndex(newNext);
              ensureVisible(newNext);
            }
            e.preventDefault();
            break;
          }

          case "ArrowUp":
          case "ArrowLeft": {
            // Move nextIndex backward (matching C# OnKeyDown Keys.Up/Left)
            // Find item whose next would be current nextIndex
            for (let i = 0; i < sections.length; i++) {
              if (i !== selectedSectionIndex && sections[i].checked && getNextCheckedIndex(i, sections) === nextSectionIndex) {
                setNextSectionIndex(i);
                ensureVisible(i);
                break;
              }
            }
            e.preventDefault();
            break;
          }

          case "Home": {
            // Move to first valid next item (matching C# OnKeyDown Keys.Home)
            let i = 0;
            while (i < sections.length && !isValidNextIndex(i)) i++;
            if (i < sections.length) {
              setNextSectionIndex(i);
              ensureVisible(i);
            }
            e.preventDefault();
            break;
          }

          case "End": {
            // Move to last valid next item (matching C# OnKeyDown Keys.End)
            let i = sections.length - 1;
            while (i >= 0 && !isValidNextIndex(i)) i--;
            if (i >= 0) {
              setNextSectionIndex(i);
              ensureVisible(i);
            }
            e.preventDefault();
            break;
          }

          case "PageDown": {
            // Move to next block (matching C# OnKeyDown Keys.PageDown)
            let i = nextSectionIndex >= 0 ? nextSectionIndex : selectedSectionIndex >= 0 ? selectedSectionIndex : 0;
            if (i >= 0 && i < sections.length) {
              const block = sections[i].block;
              while (i < sections.length && sections[i].block === block) i++;
              while (i < sections.length && !isValidNextIndex(i)) i++;
              if (i < sections.length) {
                setNextSectionIndex(i);
                ensureVisible(i);
              }
            }
            e.preventDefault();
            break;
          }

          case "PageUp": {
            // Move to previous block (matching C# OnKeyDown Keys.PageUp)
            let i = nextSectionIndex >= 0 ? nextSectionIndex : selectedSectionIndex >= 0 ? selectedSectionIndex : sections.length - 1;
            let found = false;
            while (!found && i-- > 0) {
              const block = sections[i].block;
              for (; i >= 0 && sections[i].block === block; i--) {
                if (isValidNextIndex(i)) {
                  found = true;
                  setNextSectionIndex(i);
                  ensureVisible(i);
                }
              }
            }
            e.preventDefault();
            break;
          }

          case " ": {
            // Toggle checkbox on selected item (matching C# OnKeyPress space)
            if (selectedSectionIndex >= 0) {
              toggleSectionCheck(selectedSectionIndex);
            }
            e.preventDefault();
            break;
          }

          case "Enter": {
            // Go to next index (matching C# OnKeyPress enter)
            if (nextSectionIndex >= 0) {
              const newSelectedIndex = nextSectionIndex;
              onSelectedSectionIndexChange?.(newSelectedIndex);
              if (sections[newSelectedIndex]) {
                updateDisplayState(newSelectedIndex, sections[newSelectedIndex]);
              }
            }
            e.preventDefault();
            break;
          }
        }
      },
      [sections, selectedSectionIndex, nextSectionIndex, getNextCheckedIndex, toggleSectionCheck, updateDisplayState]
    );

    const handleCheckboxClick = (e: React.MouseEvent, index: number) => {
      e.stopPropagation();
      toggleSectionCheck(index);
    };

    const toggleButton = (
      currentState: boolean,
      setter: (value: boolean) => void,
      settingKey?: keyof Pick<Settings, "contentBasedSections" | "projectInstructions">
    ) => {
      const newState = !currentState;
      setter(newState);
      if (settingKey) {
        updateSettingWithAutoSave(settingKey, newState);
      }
    };

    // Projector button handler - matching C# OnSwitchButtonClicked + UpdateDisplaySetting
    const handleProjectorToggle = async () => {
      const isElectron = !!window.electronAPI;

      if (isElectron) {
        // Electron mode: enumerate displays and cycle through them
        if (!window.electronAPI?.getAllDisplays) {
          console.warn("Preview", "Display enumeration not available in Electron");
          return;
        }

        try {
          const displays = await window.electronAPI.getAllDisplays();

          // Skip the screen hosting the main window (matching C# UpdateDisplaySetting refPoint check)
          const mainDisplayId = window.electronAPI.getMainWindowDisplayId ? await window.electronAPI.getMainWindowDisplayId() : null;
          const targetDisplays = mainDisplayId ? displays.filter((d) => d.id !== mainDisplayId) : displays;

          setAvailableMonitors(targetDisplays);

          if (targetDisplays.length <= 0) {
            showMessage(t("NoSecondaryDisplay"), t("NoSecondaryDisplayDetected"));
            return;
          }

          // Cycle through displays (matching C# logic)
          let nextIndex = currentMonitorIndex + 1;
          if (nextIndex >= targetDisplays.length) {
            nextIndex = -1; // Disable
          }

          setCurrentMonitorIndex(nextIndex);
          setProjectorEnabled(nextIndex >= 0);

          if (nextIndex >= 0) {
            const display = targetDisplays[nextIndex];
            // Update dimensions and aspect ratio for preview
            setProjectorWidth(display.bounds.width);
            setProjectorHeight(display.bounds.height);
            setDisplayAspectRatio(display.bounds.width / display.bounds.height);

            // Open fullscreen window on selected display
            if (window.electronAPI.showDisplayWindow) {
              await window.electronAPI.showDisplayWindow(display.id, previewDataUrl || "");
            }

            // Save to settings
            updateSettingWithAutoSave("displayMonitorId", display.id);
          } else {
            // Close display window
            if (window.electronAPI.hideDisplayWindow) {
              await window.electronAPI.hideDisplayWindow();
            }
            updateSettingWithAutoSave("displayMonitorId", "");
            setProjectorWidth(1920);
            setProjectorHeight(1080);
            setDisplayAspectRatio(16 / 9); // Reset to default
          }
        } catch (error) {
          console.error("Preview", "Failed to toggle projector", error);
        }
      } else {
        // Webapp mode: toggle secondary browser window
        if (projectorEnabled) {
          // Try closing via direct reference first, then fall back to BroadcastChannel
          if (projectorWindowRef && !projectorWindowRef.closed) {
            projectorWindowRef.close();
          } else if (projectorChannelRef.current) {
            // After reload, projectorWindowRef is lost but projector may still be open
            projectorChannelRef.current.postMessage({ type: "PROJECTOR_CLOSE" });
          }
          setProjectorWindowRef(null);
          setProjectorEnabled(false);
          setProjectorWidth(1920);
          setProjectorHeight(1080);
          setDisplayAspectRatio(16 / 9);
        } else {
          // Open new window with projection view
          // Restore saved bounds if available — requires Window Management API
          // permission for cross-screen placement.
          let width = 1920;
          let height = 1080;
          let left = window.screen.width - width;
          let top = 0;
          let hasSavedBounds = false;

          // Request window-management permission (needed for cross-screen window.open placement).
          // getScreenDetails() triggers the permission prompt and, once granted, unlocks
          // cross-screen coordinates in window.open() and moveTo()/resizeTo().
          let screenDetails: any = null;
          try {
            if ("getScreenDetails" in window) {
              screenDetails = await (window as any).getScreenDetails();
            }
          } catch (_) {
            /* permission denied or unsupported — fall back to single screen */
          }

          try {
            const saved = localStorage.getItem("pp-projector-bounds");
            if (saved) {
              const b = JSON.parse(saved) as { x: number; y: number; width: number; height: number };
              const minSize = 200;
              const maxCoord = 32000;
              if (
                b.width >= minSize &&
                b.height >= minSize &&
                b.width <= maxCoord &&
                b.height <= maxCoord &&
                Math.abs(b.x) <= maxCoord &&
                Math.abs(b.y) <= maxCoord
              ) {
                // If we have multi-screen info, verify a screen actually exists at those coords
                if (screenDetails?.screens) {
                  const screens = screenDetails.screens as Array<{ left: number; top: number; availWidth: number; availHeight: number }>;
                  const onAnyScreen = screens.some(
                    (s) => b.x + b.width > s.left && b.x < s.left + s.availWidth && b.y + b.height > s.top && b.y < s.top + s.availHeight
                  );
                  if (onAnyScreen) {
                    width = b.width;
                    height = b.height;
                    left = b.x;
                    top = b.y;
                    hasSavedBounds = true;
                  }
                } else {
                  // No screen details — accept the saved bounds optimistically
                  width = b.width;
                  height = b.height;
                  left = b.x;
                  top = b.y;
                  hasSavedBounds = true;
                }
              }
            }
          } catch (_) {
            /* ignore corrupt data */
          }

          // Use correct path based on environment
          const basePath = import.meta.env.BASE_URL || "/";
          const projectorPath = basePath.endsWith("/") ? `${basePath}projector.html` : `${basePath}/projector.html`;

          const projWindow = window.open(
            projectorPath,
            "PraiseProjectorDisplay",
            `width=${width},height=${height},left=${left},top=${top},toolbar=no,menubar=no,location=no,status=no,scrollbars=no`
          );

          // If the browser ignored our cross-screen coordinates (common without
          // window-management permission), retry with moveTo/resizeTo after open
          if (projWindow && hasSavedBounds) {
            try {
              projWindow.moveTo(left, top);
              projWindow.resizeTo(width, height);
            } catch (_) {
              /* best effort */
            }
          }

          if (projWindow) {
            setProjectorWindowRef(projWindow);
            setProjectorEnabled(true);
            setProjectorWidth(width);
            setProjectorHeight(height);
            setDisplayAspectRatio(width / height);

            // Listen for resize events from projector window
            const handleMessage = (event: MessageEvent) => {
              if (event.data.type === "PROJECTOR_RESIZE" && event.source === projWindow) {
                const { width: newWidth, height: newHeight } = event.data;
                setProjectorWidth(newWidth);
                setProjectorHeight(newHeight);
                setDisplayAspectRatio(newWidth / newHeight);
              }
            };
            window.addEventListener("message", handleMessage);

            // Send preview image to projector window when ready
            projWindow.addEventListener("load", () => {
              if (previewDataUrl) {
                projWindow.postMessage({ type: "UPDATE_DISPLAY", imageData: previewDataUrl }, "*");
              }
            });

            // Cleanup listener when projector window closes
            const checkClosed = setInterval(() => {
              if (projWindow.closed) {
                window.removeEventListener("message", handleMessage);
                clearInterval(checkClosed);
                setProjectorWindowRef(null);
                setProjectorEnabled(false);
                setProjectorWidth(1920);
                setProjectorHeight(1080);
                setDisplayAspectRatio(16 / 9);
              }
            }, 500);
          } else {
            showMessage(t("PopupBlocked"), t("FailedToOpenProjector"));
          }
        }
      }
    };

    // Update projector window when preview changes - use BroadcastChannel for cross-reload support
    useEffect(() => {
      // Update ref for access in callbacks
      previewDataUrlRef.current = previewDataUrl;

      // Send via postMessage to direct window reference (if we have one)
      if (projectorWindowRef && previewDataUrl && !projectorWindowRef.closed) {
        projectorWindowRef.postMessage({ type: "UPDATE_DISPLAY", imageData: previewDataUrl }, "*");
      }
      // Also send via BroadcastChannel (survives page reload)
      if (projectorEnabled && previewDataUrl && projectorChannelRef.current) {
        projectorChannelRef.current.postMessage({ type: "UPDATE_DISPLAY", imageData: previewDataUrl });
      }
      // Send to webserver for net display clients (matching C# SetImage)
      // Keep Electron display window lossless (PNG) while netdisplay uses JPEG.
      window.electronAPI?.setDisplayWindowImage?.(previewDataUrl);
      window.electronAPI?.setNetDisplayImage?.(netDisplayDataUrl);
    }, [previewDataUrl, netDisplayDataUrl, projectorWindowRef, projectorEnabled]);

    // Note: We intentionally do NOT close the projector window on unmount
    // because the PreviewPanel can be conditionally rendered (paging mode vs 3-panel mode)
    // and we want the projector window to stay open across mode switches.
    // The BroadcastChannel handles communication with the projector window
    // even when the PreviewPanel instance that opened it unmounts.

    const renderTabContent = () => {
      switch (activeTab) {
        case "format":
          return (
            <div className="tab-pane-content">
              <div className="d-flex format-columns">
                {/* Left column: font family + style buttons */}
                <div className="d-flex flex-column format-col">
                  <select
                    className="form-control form-control-sm"
                    aria-label="Font Family"
                    value={settings?.displayFontName || "Arial"}
                    onChange={(e) => updateSettingWithAutoSave("displayFontName", e.target.value)}
                  >
                    {availableFonts.map((font) => (
                      <option key={font} value={font} style={{ fontFamily: font }}>
                        {font}
                      </option>
                    ))}
                  </select>
                  <div className="btn-group flex-fill">
                    <button
                      className={`btn flex-fill ${settings?.displayFontBold ? "btn-light btn-active" : "btn-light"}`}
                      aria-label="Bold"
                      onClick={() => updateSettingWithAutoSave("displayFontBold", !settings?.displayFontBold)}
                    >
                      <Icon type={IconType.BOLD} />
                    </button>
                    <button
                      className={`btn flex-fill ${settings?.displayFontItalic ? "btn-light btn-active" : "btn-light"}`}
                      aria-label="Italic"
                      onClick={() => updateSettingWithAutoSave("displayFontItalic", !settings?.displayFontItalic)}
                    >
                      <Icon type={IconType.ITALIC} />
                    </button>
                    <button
                      className={`btn flex-fill ${settings?.displayFontUnderline ? "btn-light btn-active" : "btn-light"}`}
                      aria-label="Underline"
                      onClick={() => updateSettingWithAutoSave("displayFontUnderline", !settings?.displayFontUnderline)}
                    >
                      <Icon type={IconType.UNDERLINE} />
                    </button>
                  </div>
                </div>
                {/* Right column: CSS grid 3 cols for exact alignment */}
                <div className="format-col format-col-right">
                  <select
                    className="form-control form-control-sm font-size-input"
                    value={Math.max(1, Math.min(99, settings?.displayFontSize || 16))}
                    onChange={(e) => updateSettingWithAutoSave("displayFontSize", parseInt(e.target.value, 10))}
                    aria-label="Font Size"
                  >
                    {Array.from({ length: 99 }, (_, i) => i + 1).map((size) => (
                      <option key={size} value={size}>
                        {size}
                      </option>
                    ))}
                  </select>
                  <button className="btn btn-light font-color-btn" title={tt("format_text_color")}>
                    <input
                      type="color"
                      className="font-color-picker-hidden"
                      value={settings?.textColor || "#FFFFFF"}
                      onChange={(e) => updateSettingWithAutoSave("textColor", e.target.value)}
                      title={tt("format_text_color")}
                      aria-label="Text Color"
                    />
                    <span className="font-color-swatch" style={{ backgroundColor: settings?.textColor || "#FFFFFF" }} />
                  </button>
                  <div className="btn-group align-buttons">
                    <button
                      className={`btn flex-fill ${(settings?.displayFontAlign || "center") === "left" ? "btn-light btn-active" : "btn-light"}`}
                      aria-label="Align Left"
                      onClick={() => updateSettingWithAutoSave("displayFontAlign", "left")}
                    >
                      <Icon type={IconType.ALIGN_LEFT} />
                    </button>
                    <button
                      className={`btn flex-fill ${(settings?.displayFontAlign || "center") === "center" ? "btn-light btn-active" : "btn-light"}`}
                      aria-label="Align Center"
                      onClick={() => updateSettingWithAutoSave("displayFontAlign", "center")}
                    >
                      <Icon type={IconType.ALIGN_CENTER} />
                    </button>
                    <button
                      className={`btn flex-fill ${(settings?.displayFontAlign || "center") === "right" ? "btn-light btn-active" : "btn-light"}`}
                      aria-label="Align Right"
                      onClick={() => updateSettingWithAutoSave("displayFontAlign", "right")}
                    >
                      <Icon type={IconType.ALIGN_RIGHT} />
                    </button>
                  </div>
                </div>
              </div>
            </div>
          );
        case "image":
          return (
            <div className="tab-pane-content">
              <ImageSelector
                selectedImageId={selectedImageId}
                onOpenImageSettings={() => onSettingsClick?.("images")}
                onSelectImage={(imageId, dataUrl) => {
                  setSelectedImageId(imageId);
                  if (dataUrl) {
                    const img = new Image();
                    img.onload = () => setBgImage(img);
                    img.onerror = () => setBgImage(null);
                    img.src = dataUrl;
                  } else {
                    setBgImage(null);
                  }
                }}
              />
            </div>
          );
        case "message":
          return (
            <div className="tab-pane-content">
              <textarea
                className="form-control message-textarea"
                placeholder={t("EnterMessagePlaceholder")}
                value={settings?.message || ""}
                onChange={(e) => updateSettingWithAutoSave("message", e.target.value)}
              ></textarea>
            </div>
          );
        default:
          return null;
      }
    };

    // ── QR code drag / resize handlers ─────────────────────────────────────

    // Click on the preview background: toggle QR visibility
    const handlePreviewWrapperClick = useCallback(() => {
      if (qrRawUrl) {
        const nextVisible = !(settings?.qrCodeInPreview ?? false);
        updateSettingWithAutoSave("qrCodeInPreview", nextVisible);
        if (!nextVisible) {
          setQrContextMenu(null);
          setQrDragPos(null);
        }
      }
    }, [settings?.qrCodeInPreview, qrRawUrl, updateSettingWithAutoSave]);

    // Context menu on the projected image preview → show QR size slider (only when QR is visible)
    const handlePreviewContextMenu = useCallback(
      (e: React.MouseEvent) => {
        e.preventDefault();
        e.stopPropagation();
        if (settings?.qrCodeInPreview && qrCodeUrl) {
          setQrContextMenu({ x: e.clientX, y: e.clientY });
        }
      },
      [settings?.qrCodeInPreview, qrCodeUrl]
    );

    // Close the QR context menu when clicking outside or pressing Escape
    useEffect(() => {
      if (!qrContextMenu) return;
      const handleClickOutside = (e: MouseEvent) => {
        if (qrContextMenuRef.current && !qrContextMenuRef.current.contains(e.target as Node)) {
          setQrContextMenu(null);
        }
      };
      const handleKeyDown = (e: KeyboardEvent) => {
        if (e.key === "Escape") setQrContextMenu(null);
      };
      document.addEventListener("mousedown", handleClickOutside);
      document.addEventListener("keydown", handleKeyDown);
      return () => {
        document.removeEventListener("mousedown", handleClickOutside);
        document.removeEventListener("keydown", handleKeyDown);
      };
    }, [qrContextMenu]);

    // Mouse drag on the QR overlay (left button only)
    const handleQrMouseDown = useCallback(
      (e: React.MouseEvent) => {
        if (e.button !== 0) return; // ignore right-click / middle-click
        e.stopPropagation();
        e.preventDefault();
        if (!settings) return;

        const startX = e.clientX;
        const startY = e.clientY;
        const startQrX = settings.qrCodeX ?? 85;
        const startQrY = settings.qrCodeY ?? 82;
        qrDragRef.current = { startClientX: startX, startClientY: startY, startQrX, startQrY, moved: false };
        setIsQrDragging(true);
        setQrDragPos({ x: startQrX, y: startQrY });

        const handleMouseMove = (me: MouseEvent) => {
          const wrapper = previewWrapperRef.current;
          if (!wrapper) return;
          const dx = me.clientX - startX;
          const dy = me.clientY - startY;
          if (Math.abs(dx) > 4 || Math.abs(dy) > 4) qrDragRef.current.moved = true;
          const w = wrapper.offsetWidth;
          const h = wrapper.offsetHeight;
          if (!w || !h) return;
          const sizePercent = settings.qrCodeSizePercent ?? 15;
          const qrSizePxNow = h * (sizePercent / 100);
          const maxX = 100 - (qrSizePxNow / w) * 100;
          const maxY = 100 - (qrSizePxNow / h) * 100;
          const newX = Math.max(0, Math.min(maxX, startQrX + (dx / w) * 100));
          const newY = Math.max(0, Math.min(maxY, startQrY + (dy / h) * 100));
          setQrDragPos({ x: newX, y: newY });
        };

        const handleMouseUp = () => {
          document.removeEventListener("mousemove", handleMouseMove);
          document.removeEventListener("mouseup", handleMouseUp);
          setIsQrDragging(false);
          if (!qrDragRef.current.moved) {
            // Short click → hide QR
            setQrDragPos(null);
            updateSettingWithAutoSave("qrCodeInPreview", false);
          } else {
            // Drag ended → persist new position
            setQrDragPos((pos) => {
              if (pos) {
                updateSettingWithAutoSave("qrCodeX", pos.x);
                updateSettingWithAutoSave("qrCodeY", pos.y);
              }
              return null;
            });
          }
        };

        document.addEventListener("mousemove", handleMouseMove);
        document.addEventListener("mouseup", handleMouseUp);
      },
      [settings, updateSettingWithAutoSave]
    );

    // Scroll wheel on the QR overlay → resize
    const handleQrWheel = useCallback(
      (e: React.WheelEvent) => {
        e.preventDefault();
        e.stopPropagation();
        if (!settings) return;
        const delta = e.deltaY > 0 ? -1 : 1;
        const current = settings.qrCodeSizePercent ?? 15;
        const next = Math.max(1, Math.min(100, current + delta));
        if (next !== current) updateSettingWithAutoSave("qrCodeSizePercent", next);
      },
      [settings, updateSettingWithAutoSave]
    );

    // Touch start on the QR overlay (drag or pinch)
    const handleQrTouchStart = useCallback(
      (e: React.TouchEvent) => {
        e.stopPropagation();
        if (e.touches.length === 1) {
          const t = e.touches[0];
          const startQrX = settings?.qrCodeX ?? 85;
          const startQrY = settings?.qrCodeY ?? 82;
          qrDragRef.current = { startClientX: t.clientX, startClientY: t.clientY, startQrX, startQrY, moved: false };
          setIsQrDragging(true);
          setQrDragPos({ x: startQrX, y: startQrY });
        } else if (e.touches.length === 2) {
          setIsQrDragging(false);
          setQrDragPos(null);
          const dx = e.touches[1].clientX - e.touches[0].clientX;
          const dy = e.touches[1].clientY - e.touches[0].clientY;
          qrPinchRef.current = {
            startDist: Math.hypot(dx, dy),
            startSizePercent: settings?.qrCodeSizePercent ?? 15,
          };
        }
      },
      [settings]
    );

    // Touch move on the QR overlay (drag or pinch)
    const handleQrTouchMove = useCallback(
      (e: React.TouchEvent) => {
        e.preventDefault();
        e.stopPropagation();
        if (e.touches.length === 1 && isQrDragging) {
          const t = e.touches[0];
          const wrapper = previewWrapperRef.current;
          if (!wrapper || !settings) return;
          const dx = t.clientX - qrDragRef.current.startClientX;
          const dy = t.clientY - qrDragRef.current.startClientY;
          if (Math.abs(dx) > 4 || Math.abs(dy) > 4) qrDragRef.current.moved = true;
          const w = wrapper.offsetWidth;
          const h = wrapper.offsetHeight;
          if (!w || !h) return;
          const sizePercent = settings.qrCodeSizePercent ?? 15;
          const qrSizePxNow = h * (sizePercent / 100);
          const maxX = 100 - (qrSizePxNow / w) * 100;
          const maxY = 100 - (qrSizePxNow / h) * 100;
          const newX = Math.max(0, Math.min(maxX, qrDragRef.current.startQrX + (dx / w) * 100));
          const newY = Math.max(0, Math.min(maxY, qrDragRef.current.startQrY + (dy / h) * 100));
          setQrDragPos({ x: newX, y: newY });
        } else if (e.touches.length === 2) {
          const dx = e.touches[1].clientX - e.touches[0].clientX;
          const dy = e.touches[1].clientY - e.touches[0].clientY;
          const dist = Math.hypot(dx, dy);
          if (qrPinchRef.current.startDist > 0) {
            const ratio = dist / qrPinchRef.current.startDist;
            const newSize = Math.max(1, Math.min(100, qrPinchRef.current.startSizePercent * ratio));
            updateSettingWithAutoSave("qrCodeSizePercent", newSize);
          }
        }
      },
      [settings, isQrDragging, updateSettingWithAutoSave]
    );

    // Touch end on the QR overlay
    const handleQrTouchEnd = useCallback(
      (e: React.TouchEvent) => {
        e.stopPropagation();
        if (isQrDragging) {
          setIsQrDragging(false);
          if (!qrDragRef.current.moved) {
            setQrDragPos(null);
            updateSettingWithAutoSave("qrCodeInPreview", false);
          } else {
            setQrDragPos((pos) => {
              if (pos) {
                updateSettingWithAutoSave("qrCodeX", pos.x);
                updateSettingWithAutoSave("qrCodeY", pos.y);
              }
              return null;
            });
          }
        }
      },
      [isQrDragging, updateSettingWithAutoSave]
    );

    // Compute pixel position/size for the QR overlay
    const qrSizePercent = settings?.qrCodeSizePercent ?? 15;
    const qrSizePx = wrapperDims.h > 0 ? wrapperDims.h * (qrSizePercent / 100) : 0;
    const qrLeftPx = wrapperDims.w > 0 ? wrapperDims.w * (liveQrX / 100) : 0;
    const qrTopPx = wrapperDims.h > 0 ? wrapperDims.h * (liveQrY / 100) : 0;

    return (
      <div className="d-flex flex-column h-100" ref={panelGroupRef}>
        <PanelGroup
          direction="vertical"
          onLayout={(sizes) => {
            onPreviewSplitSizeChange?.(sizes[0]);
          }}
        >
          <Panel defaultSize={previewSplitSize ?? 60} minSize={20}>
            <div className="d-flex flex-grow-1 min-height-0 h-100">
              <div className={`flex-grow-1 preview-sections-container ${remoteHighlightController ? "remote-controlled" : ""}`}>
                {/* Remote control indicator overlay - matching C# SectionListBox.Remote */}
                {remoteHighlightController && (
                  <img src="/assets/smartphone-tablet.png" alt="" className="remote-indicator-overlay" aria-hidden="true" />
                )}
                <div ref={sectionListRef} className="list-group preview-sections-list" tabIndex={0} onKeyDown={handleSectionListKeyDown}>
                  {sections.length === 0 ? (
                    <div className="text-muted text-center p-3">{t("NoSongSelected")}</div>
                  ) : (
                    sections.map((section, index) => {
                      const isSelected = selectedSectionIndex === index;
                      const isNext = nextSectionIndex === index;
                      const bgColor = isSelected ? undefined : isNext ? "rgb(0, 255, 255)" : getSectionBgColor(section.displayMode);
                      const typeColor = getSectionTypeColor(section.type);

                      // Match C# SectionListBox.Item.Label property logic
                      const displayText = settings?.realSectionPreview
                        ? section.text
                        : section.label !== null && section.label !== ""
                          ? section.label
                          : section.text;

                      const hasTypeColor = section.type >= 1 && section.type <= 3;

                      // Match C# SectionListBox.PreviewFont and Format properties logic
                      // C# line 134-143: PreviewFont uses display font with format button states
                      // C# line 148-158: Format includes StringFormat with alignment (line 2387-2399)
                      const sectionTextStyle = settings?.previewFontInSections
                        ? {
                            fontFamily: settings.displayFontName || "Arial",
                            fontWeight: settings?.displayFontBold ? "bold" : "normal",
                            fontStyle: settings?.displayFontItalic ? "italic" : "normal",
                            textDecoration: settings?.displayFontUnderline ? "underline" : "none",
                            textAlign: settings.displayFontAlign || "center",
                          }
                        : {};

                      return (
                        <div
                          key={`section-${index}`}
                          ref={(el) => (sectionRefs.current[index] = el)}
                          className={`list-group-item list-group-item-action section-item ${
                            isSelected ? "active" : ""
                          } ${isNext ? "section-next" : ""} section-mode-${section.displayMode} section-type-${section.type}`}
                          data-bg-color={bgColor}
                          data-type-color={typeColor}
                          onClick={() => handleSectionClick(index)}
                          title={tt("sectionlist")}
                        >
                          <div className="d-flex align-items-start">
                            <input
                              type="checkbox"
                              className={`section-checkbox ${!hasTypeColor ? "mr-2 mt-1" : ""}`}
                              checked={section.checked}
                              onClick={(e) => handleCheckboxClick(e, index)}
                              onChange={() => {}} // Controlled by onClick
                              aria-label={`Include section ${index + 1}`}
                            />
                            {}
                            <span className="section-text" style={sectionTextStyle}>
                              {displayText}
                            </span>
                          </div>
                        </div>
                      );
                    })
                  )}
                </div>
              </div>
              <div className="d-flex flex-column ml-2 flex-shrink-0 preview-button-column">
                <div className="btn-group-vertical">
                  {onSettingsClick && (
                    <button className="btn btn-light" aria-label="Settings" title={tt("toolbar_settings")} onClick={() => onSettingsClick()}>
                      <Icon type={IconType.SETTINGS} />
                    </button>
                  )}
                  <button
                    className={`btn ${projectorEnabled ? "btn-light btn-active" : "btn-light"}`}
                    aria-label="Display Enabled"
                    onClick={handleProjectorToggle}
                    title={tt("display_enabled")}
                  >
                    <Icon type={IconType.DISPLAY} />
                    {currentMonitorIndex >= 0 && availableMonitors.length > 2 && <span className="monitor-label">{currentMonitorIndex + 1}</span>}
                  </button>
                  <button
                    className={`btn ${showText ? "btn-light btn-active" : "btn-light"}`}
                    aria-label="Display Text"
                    onClick={() => toggleButton(showText, setShowText)}
                    title={tt("display_lyrics")}
                  >
                    <Icon type={IconType.TEXT} />
                  </button>
                  <button
                    className={`btn ${showImage ? "btn-light btn-active" : "btn-light"}`}
                    aria-label="Display Image"
                    onClick={() => toggleButton(showImage, setShowImage)}
                    title={tt("display_image")}
                  >
                    <Icon type={IconType.IMAGE} />
                  </button>
                  <div
                    className="btn btn-light p-0 d-flex align-items-center justify-content-center bg-color-picker-container"
                    aria-label="Background Color"
                  >
                    <Icon type={IconType.BG_COLOR} />
                    <input
                      type="color"
                      value={settings?.backgroundColor || "#000000"}
                      onChange={(e) => updateSettingWithAutoSave("backgroundColor", e.target.value)}
                      title={tt("format_background_color")}
                    />
                  </div>
                  <button
                    className={`btn ${contentBasedSections ? "btn-light btn-active" : "btn-light"}`}
                    aria-label="Content Based Format"
                    onClick={() => toggleButton(contentBasedSections, setContentBasedSections, "contentBasedSections")}
                  >
                    <Icon type={IconType.CONTENT_FORMAT} />
                  </button>
                  <button
                    className={`btn ${projectInstructions ? "btn-light btn-active" : "btn-light"}`}
                    aria-label="Project Instructions"
                    onClick={() => toggleButton(projectInstructions, setProjectInstructions, "projectInstructions")}
                  >
                    <Icon type={IconType.INSTRUCTIONS} />
                  </button>
                </div>
                <div className="btn-group-vertical mt-auto">
                  <button
                    className={`btn ${freezePreview ? "btn-light btn-active" : "btn-light"}`}
                    aria-label="Freeze"
                    onClick={() => toggleButton(freezePreview, setFreezePreview)}
                  >
                    <Icon type={IconType.FREEZE} />
                  </button>
                  <button
                    className={`btn ${displayMessageEnabled ? "btn-light btn-active" : "btn-light"}`}
                    aria-label="Message"
                    onClick={() => toggleButton(displayMessageEnabled, setDisplayMessageEnabled)}
                  >
                    <Icon type={IconType.MESSAGE} />
                  </button>
                </div>
              </div>
            </div>
          </Panel>
          <ResizeHandle />
          <Panel defaultSize={(previewSplitSize ?? 60) > 0 ? 100 - (previewSplitSize ?? 60) : 40} minSize={bottomMinSize}>
            <div className="d-flex flex-column h-100">
              <div>
                <ul className="nav nav-tabs">
                  <li className="nav-item">
                    <a
                      className={`nav-link ${activeTab === "format" ? "active" : ""}`}
                      href="#"
                      onClick={(e) => {
                        e.preventDefault();
                        setActiveTab("format");
                      }}
                    >
                      {t("Format")}
                    </a>
                  </li>
                  <li className="nav-item">
                    <a
                      className={`nav-link ${activeTab === "image" ? "active" : ""}`}
                      href="#"
                      onClick={(e) => {
                        e.preventDefault();
                        setActiveTab("image");
                      }}
                    >
                      {t("Image")}
                    </a>
                  </li>
                  <li className="nav-item">
                    <a
                      className={`nav-link ${activeTab === "message" ? "active" : ""}`}
                      href="#"
                      onClick={(e) => {
                        e.preventDefault();
                        setActiveTab("message");
                      }}
                    >
                      {t("Message")}
                    </a>
                  </li>
                </ul>
                <div className="tab-content p-2 border border-top-0 preview-tab-content">{renderTabContent()}</div>
              </div>
              <div className="flex-grow-1 preview-display-container" ref={containerRefCallback}>
                {previewDataUrl ? (
                  <div
                    ref={previewWrapperRef}
                    className="preview-image-wrapper"
                    style={imageDims.w > 0 && imageDims.h > 0 ? { width: imageDims.w, height: imageDims.h } : undefined}
                    onClick={handlePreviewWrapperClick}
                    onContextMenu={handlePreviewContextMenu}
                    title={!settings?.qrCodeInPreview && qrRawUrl ? tt("preview_no_qrcode") : undefined}
                  >
                    <img src={previewDataUrl} alt="Section Preview" className="preview-display-image" />
                    {settings?.qrCodeInPreview && qrCodeUrl && (
                      <div
                        className={`qr-code-overlay${isQrDragging ? " dragging" : ""}`}
                        style={{ "--qr-left": `${qrLeftPx}px`, "--qr-top": `${qrTopPx}px`, "--qr-size": `${qrSizePx}px` } as React.CSSProperties}
                        onClick={(e) => {
                          // Keep overlay interactions from triggering wrapper toggle.
                          e.stopPropagation();
                        }}
                        onMouseDown={handleQrMouseDown}
                        onWheel={handleQrWheel}
                        onTouchStart={handleQrTouchStart}
                        onTouchMove={handleQrTouchMove}
                        onTouchEnd={handleQrTouchEnd}
                        onContextMenu={handlePreviewContextMenu}
                        title={settings?.showTooltips ? tt("preview_qrcode") : undefined}
                      >
                        <div dangerouslySetInnerHTML={{ __html: generateQRCodeSVG(qrCodeUrl, Math.max(16, Math.round(qrSizePx))) }} />
                      </div>
                    )}
                  </div>
                ) : (
                  <div className="preview-display-placeholder">{t("SelectSectionToPreview")}</div>
                )}
                {qrContextMenu && (
                  <div ref={qrContextMenuRef} className="qr-context-menu" style={{ left: qrContextMenu.x, top: qrContextMenu.y }}>
                    <label htmlFor="qr-size-slider" className="qr-context-menu-label">
                      {t("QRCodeSizeSettingLabel")}: {Math.round(settings?.qrCodeSizePercent ?? 15)}%
                    </label>
                    <input
                      id="qr-size-slider"
                      type="range"
                      className="qr-context-menu-slider"
                      min={1}
                      max={100}
                      step={1}
                      value={settings?.qrCodeSizePercent ?? 15}
                      onChange={(e) => updateSettingWithAutoSave("qrCodeSizePercent", Number(e.target.value))}
                    />
                  </div>
                )}
              </div>
            </div>
          </Panel>
        </PanelGroup>
      </div>
    );
  }
);

PreviewPanel.displayName = "PreviewPanel";

export default PreviewPanel;
