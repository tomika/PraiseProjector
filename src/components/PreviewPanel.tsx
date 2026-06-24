import React, { useState, useEffect, useRef, useImperativeHandle, forwardRef, useCallback, useMemo } from "react";
import { generateQRCodeSVG } from "../hooks/useSessionUrl";
import "./PreviewPanel.css";
import { PlaylistEntry } from "../../db-common/PlaylistEntry";
import { Song } from "../../db-common/Song";
import { SectionGenerator, SectionItem, DisplaySettings } from "../utils/SectionGenerator";
import { SectionRenderer, RenderSettings } from "../utils/SectionRenderer";
import { useSettings } from "../hooks/useSettings";
import { Icon, IconType } from "../services/IconService";
import { getProjectedSong, getCurrentDisplay, useProjectedSong, updateCurrentDisplay, setProjectorRenderDims } from "../state/CurrentSongStore";
import { useMessageBox } from "../contexts/MessageBoxContext";
import { useLocalization } from "../localization/LocalizationContext";
import { useTooltips } from "../localization/TooltipContext";
import { MonitorDisplay } from "../types/electron";
import ImageSelector from "./preview/ImageSelector";
import { Settings } from "../types";
import { useLeader } from "../contexts/LeaderContext";
import { useSessionUrl } from "../hooks/useSessionUrl";
import { Panel, PanelGroup, type ImperativePanelHandle } from "react-resizable-panels";
import ResizeHandle from "./ResizeHandle";
import { imageStorageService } from "../services/ImageStorage";
import { projectedImageCacheService } from "../services/ProjectedImageCacheService";
import { Display } from "../../common/pp-types";

type PreviewTab = "format" | "image" | "message" | "controls";
type PreviewPanelCollapseMode = Settings["previewPanelCollapseMode"];

const PREVIEW_PANEL_COLLAPSE_MODES: PreviewPanelCollapseMode[] = ["expanded", "tabsCollapsed", "tabsAndPreviewCollapsed", "previewCollapsed"];
const PREVIEW_PANEL_COLLAPSED_SIZE_FALLBACK = 4;
const PREVIEW_PANEL_WITH_TAB_CONTENT_FALLBACK_PX = 168;
const PREVIEW_TABS_ICON_MODE_HYSTERESIS_PX = 24;

type SectionListActionKey =
  | "ArrowDown"
  | "ArrowRight"
  | "ArrowUp"
  | "ArrowLeft"
  | "Home"
  | "End"
  | "PageDown"
  | "PageUp"
  | " "
  | "Enter"
  | "Backspace"
  | "Escape";

function normalizePreviewPanelCollapseMode(mode: unknown): PreviewPanelCollapseMode {
  return PREVIEW_PANEL_COLLAPSE_MODES.includes(mode as PreviewPanelCollapseMode) ? (mode as PreviewPanelCollapseMode) : "expanded";
}

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
  showSettingsButton?: boolean;
  initialTab?: PreviewTab;
  onActiveTabChange?: (tab: PreviewTab) => void;
}

// Define ref methods that can be called from parent
export interface PreviewPanelMethods {
  selectSectionByLine: (lineNumber: number, section?: number) => boolean;
  getSelectedSectionIndex: () => number;
  setSelectedSectionIndex: (index: number) => void;
  setSectionListFocused: () => void;
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

interface ScreenInfo {
  left: number;
  top: number;
  availWidth: number;
  availHeight: number;
}

interface ScreenDetailsResult {
  screens?: ScreenInfo[];
}

function resolveDisplayIdFromWindowCenter(
  displays: MonitorDisplay[],
  bounds: { x: number; y: number; width: number; height: number }
): string | null {
  if (!displays.length) return null;

  const centerX = Math.round(bounds.x + bounds.width / 2);
  const centerY = Math.round(bounds.y + bounds.height / 2);

  const containing = displays.find((d) => {
    const left = d.bounds.x;
    const top = d.bounds.y;
    const right = left + d.bounds.width;
    const bottom = top + d.bounds.height;
    return centerX >= left && centerX < right && centerY >= top && centerY < bottom;
  });
  if (containing) return containing.id;

  // Fallback to nearest display center if no direct containment (edge/window-manager quirks).
  let bestId: string | null = null;
  let bestDistance = Number.POSITIVE_INFINITY;
  for (const display of displays) {
    const dx = centerX - (display.bounds.x + display.bounds.width / 2);
    const dy = centerY - (display.bounds.y + display.bounds.height / 2);
    const distance = dx * dx + dy * dy;
    if (distance < bestDistance) {
      bestDistance = distance;
      bestId = display.id;
    }
  }
  return bestId;
}

interface WindowWithScreenDetails extends Window {
  getScreenDetails?: () => Promise<ScreenDetailsResult>;
}

const remoteIndicatorOverlaySrc = `${import.meta.env.BASE_URL}assets/smartphone-tablet.png`;

const NET_DISPLAY_RESOLUTION_MAP: Record<string, [number, number]> = {
  "640x480": [640, 480],
  "854x480": [854, 480],
  "1280x720": [1280, 720],
  "1920x1080": [1920, 1080],
  "3840x2160": [3840, 2160],
};

function getNetDisplayDimensions(preset?: string | null): [number, number] {
  return NET_DISPLAY_RESOLUTION_MAP[preset ?? "1920x1080"] ?? [1920, 1080];
}

function getBackgroundImageSignature(imageId: string | null, image: HTMLImageElement | null): string {
  if (!image) return "none";
  const src = image.currentSrc || image.src || "";
  const srcLen = src.length;
  const head = src.slice(0, 64);
  const tail = src.slice(Math.max(0, srcLen - 64));
  return `${imageId ?? "inline"}|${image.naturalWidth}x${image.naturalHeight}|${srcLen}|${head}|${tail}`;
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
      showSettingsButton = true,
      initialTab = "format",
      onActiveTabChange,
    },
    ref
  ) => {
    const { settings, updateSettingWithAutoSave } = useSettings();
    const projectedSong = useProjectedSong();
    const { showMessage } = useMessageBox();
    const { t } = useLocalization();
    const { tt } = useTooltips();
    const [activeTab, setActiveTab] = useState<PreviewTab>(initialTab);
    const previewPanelCollapseMode = normalizePreviewPanelCollapseMode(settings?.previewPanelCollapseMode);
    const isTabContentCollapsed = previewPanelCollapseMode === "tabsCollapsed" || previewPanelCollapseMode === "tabsAndPreviewCollapsed";
    const isProjectedPreviewCollapsed = previewPanelCollapseMode === "tabsAndPreviewCollapsed" || previewPanelCollapseMode === "previewCollapsed";
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

    const lastSelectionIndexRef = useRef<number>(selectedSectionIndex);

    // Track previous projectedSong to detect when it changes
    const prevProjectedSongIdRef = useRef<string | null>(null);

    // Display settings state (not from Settings)
    const [contentBasedSections, setContentBasedSections] = useState(settings?.contentBasedSections ?? true);
    const [projectInstructions, setProjectInstructions] = useState(settings?.projectInstructions ?? false);
    const [displayMessageEnabled, setDisplayMessageEnabled] = useState(false);
    const [freezePreview, setFreezePreview] = useState(false);
    const [showText, setShowText] = useState(settings?.showTextInPreview ?? true);
    const [showImage, setShowImage] = useState(settings?.showImageInPreview ?? true);

    const handleTabChange = useCallback(
      (tab: PreviewTab) => {
        setActiveTab(tab);
        onActiveTabChange?.(tab);

        const modeWithTabPagesVisible: PreviewPanelCollapseMode =
          previewPanelCollapseMode === "tabsAndPreviewCollapsed"
            ? "previewCollapsed"
            : previewPanelCollapseMode === "tabsCollapsed"
              ? "expanded"
              : previewPanelCollapseMode;

        if (modeWithTabPagesVisible !== previewPanelCollapseMode) {
          // Tab click should only add tab-page visibility to the current layout state.
          updateSettingWithAutoSave("previewPanelCollapseMode", modeWithTabPagesVisible);
        }
      },
      [onActiveTabChange, previewPanelCollapseMode, updateSettingWithAutoSave]
    );

    const cyclePreviewPanelCollapseMode = useCallback(() => {
      const currentIndex = PREVIEW_PANEL_COLLAPSE_MODES.indexOf(previewPanelCollapseMode);
      const safeIndex = currentIndex >= 0 ? currentIndex : 0;
      const nextMode = PREVIEW_PANEL_COLLAPSE_MODES[(safeIndex + 1) % PREVIEW_PANEL_COLLAPSE_MODES.length];
      updateSettingWithAutoSave("previewPanelCollapseMode", nextMode);
      sectionListRef.current?.focus();
    }, [previewPanelCollapseMode, updateSettingWithAutoSave]);

    const nextPreviewPanelCollapseMode = useMemo<PreviewPanelCollapseMode>(() => {
      const currentIndex = PREVIEW_PANEL_COLLAPSE_MODES.indexOf(previewPanelCollapseMode);
      const safeIndex = currentIndex >= 0 ? currentIndex : 0;
      return PREVIEW_PANEL_COLLAPSE_MODES[(safeIndex + 1) % PREVIEW_PANEL_COLLAPSE_MODES.length];
    }, [previewPanelCollapseMode]);

    const previewPanelCollapseStateLabel = useMemo(() => {
      switch (nextPreviewPanelCollapseMode) {
        case "expanded":
          return tt("preview_panel_layout_state_expanded");
        case "tabsCollapsed":
          return tt("preview_panel_layout_state_tabs_collapsed");
        case "tabsAndPreviewCollapsed":
          return tt("preview_panel_layout_state_tabs_and_preview_collapsed");
        case "previewCollapsed":
          return tt("preview_panel_layout_state_preview_collapsed");
        default:
          return tt("preview_panel_layout_state_expanded");
      }
    }, [nextPreviewPanelCollapseMode, tt]);

    const previewPanelCollapseTitle = useMemo(() => {
      const toggleLabel = tt("preview_panel_layout_toggle");
      if (!toggleLabel) return undefined;
      return `${toggleLabel}: ${previewPanelCollapseStateLabel}`;
    }, [previewPanelCollapseStateLabel, tt]);

    const previewPanelCollapseAriaLabel = useMemo(() => {
      const toggleLabel = tt("preview_panel_layout_toggle") ?? "Rotate preview panel layout";
      return `${toggleLabel}: ${previewPanelCollapseStateLabel}`;
    }, [previewPanelCollapseStateLabel, tt]);

    const previewPanelCollapseIconClass = useMemo(() => {
      switch (nextPreviewPanelCollapseMode) {
        case "expanded":
          return "fa fa-columns fa-rotate-90";
        case "tabsCollapsed":
          return "fa fa-window-maximize";
        case "tabsAndPreviewCollapsed":
          return "fa fa-window-minimize";
        case "previewCollapsed":
          return "fa fa-window-maximize";
        default:
          return "fa fa-columns fa-rotate-90";
      }
    }, [nextPreviewPanelCollapseMode]);

    const previewTabs = useMemo(
      () => [
        { id: "format" as const, label: t("Format"), iconClass: "fa fa-paint-brush" },
        { id: "image" as const, label: t("Image"), iconClass: "fa fa-picture-o" },
        { id: "message" as const, label: t("Message"), iconClass: "fa fa-comment-o" },
        { id: "controls" as const, label: t("Controls"), iconClass: "fa fa-arrows" },
      ],
      [t]
    );

    const previewControlButtons = useMemo(
      () => [
        {
          key: "Home" as SectionListActionKey,
          iconClass: "fa fa-step-backward",
          tooltip: tt("preview_controls_home"),
        },
        {
          key: "PageUp" as SectionListActionKey,
          iconClass: "fa fa-angle-double-up",
          tooltip: tt("preview_controls_page_up"),
        },
        {
          key: "ArrowUp" as SectionListActionKey,
          iconClass: "fa fa-arrow-up",
          tooltip: tt("preview_controls_up"),
        },
        {
          key: "Backspace" as SectionListActionKey,
          iconClass: "fa fa-undo",
          tooltip: tt("preview_controls_backspace"),
        },
        {
          key: "End" as SectionListActionKey,
          iconClass: "fa fa-step-forward",
          tooltip: tt("preview_controls_end"),
        },
        {
          key: "PageDown" as SectionListActionKey,
          iconClass: "fa fa-angle-double-down",
          tooltip: tt("preview_controls_page_down"),
        },
        {
          key: "ArrowDown" as SectionListActionKey,
          iconClass: "fa fa-arrow-down",
          tooltip: tt("preview_controls_down"),
        },
        {
          key: "Enter" as SectionListActionKey,
          iconClass: "fa fa-sign-in",
          tooltip: tt("preview_controls_enter"),
        },
      ],
      [tt]
    );

    useEffect(() => {
      setActiveTab(initialTab);
    }, [initialTab]);

    // Sync local state with settings changes
    useEffect(() => {
      setContentBasedSections(settings?.contentBasedSections ?? true);
    }, [settings?.contentBasedSections]);

    useEffect(() => {
      setProjectInstructions(settings?.projectInstructions ?? false);
    }, [settings?.projectInstructions]);

    useEffect(() => {
      setShowText(settings?.showTextInPreview ?? true);
    }, [settings?.showTextInPreview]);

    useEffect(() => {
      setShowImage(settings?.showImageInPreview ?? true);
    }, [settings?.showImageInPreview]);

    // Projector state - matching C# DisplayForm
    const [projectorEnabled, setProjectorEnabled] = useState(false);
    // Connected net-display clients (Electron only; stays false in web mode)
    const [hasConnectedClients, setHasConnectedClients] = useState(false);
    const [currentMonitorIndex, setCurrentMonitorIndex] = useState(-1);
    const [availableMonitors, setAvailableMonitors] = useState<MonitorDisplay[]>([]);
    // Total number of physical displays (Electron only). Defaults to 2 so the
    // projector button is never falsely disabled in web mode or before the first probe.
    const [electronDisplayCount, setElectronDisplayCount] = useState(2);
    const [projectorWindowRef, setProjectorWindowRef] = useState<Window | null>(null);
    const [_displayAspectRatio, setDisplayAspectRatio] = useState(16 / 9); // Default aspect ratio
    const [projectorWidth, setProjectorWidth] = useState(1920);
    const [projectorHeight, setProjectorHeight] = useState(1080);

    const getTargetDisplays = useCallback(async (displays: MonitorDisplay[]): Promise<MonitorDisplay[]> => {
      const api = window.electronAPI;

      let excludedId: string | null = null;
      if (api?.getMainWindowDisplayId) {
        try {
          excludedId = await api.getMainWindowDisplayId();
        } catch {
          // Ignore and fall back to bounds-based detection.
        }
      }

      if (api?.getWindowBounds) {
        try {
          const bounds = await api.getWindowBounds();
          if (bounds) {
            const idFromBounds = resolveDisplayIdFromWindowCenter(displays, bounds);
            if (idFromBounds) {
              excludedId = idFromBounds;
            }
          }
        } catch {
          // Ignore and keep ID-based exclusion.
        }
      }

      if (!excludedId) {
        return displays;
      }

      const filtered = displays.filter((d) => d.id !== excludedId);
      // Do not hide all displays if exclusion over-matches for any reason.
      return filtered.length > 0 ? filtered : displays;
    }, []);

    // Poll connected clients every 2 s (Electron only — in web mode we can't know)
    useEffect(() => {
      if (!window.electronAPI?.getProjectingClientsCount) return;
      const poll = async () => {
        try {
          const clientCount = await window.electronAPI!.getProjectingClientsCount!();
          setHasConnectedClients(clientCount > 0);
        } catch {
          // ignore transient errors
        }
      };
      void poll(); // immediate first check
      const id = setInterval(poll, 2000);
      return () => clearInterval(id);
    }, []);

    // Track the number of connected displays (Electron only) so the projector
    // switch button can be disabled when there is only one monitor to project on.
    // Displays can be plugged/unplugged at runtime, so we re-probe periodically.
    useEffect(() => {
      const api = window.electronAPI;
      if (!api?.getAllDisplays) return;
      let cancelled = false;
      const poll = async () => {
        try {
          const displays = await api.getAllDisplays!();
          if (!cancelled) setElectronDisplayCount(displays.length);
        } catch {
          // ignore transient errors
        }
      };
      void poll(); // immediate first check
      const id = setInterval(poll, 2000);
      return () => {
        cancelled = true;
        clearInterval(id);
      };
    }, []);

    // When no projector window is open, render at the user-configured net display resolution
    useEffect(() => {
      if (projectorEnabled) return;
      const [w, h] = getNetDisplayDimensions(settings?.netDisplayResolution);
      setProjectorWidth(w);
      setProjectorHeight(h);
      setDisplayAspectRatio(w / h);
    }, [settings?.netDisplayResolution, projectorEnabled]);

    // Publish render dimensions to the global store so other components (e.g. settings) can read them
    useEffect(() => {
      setProjectorRenderDims(projectorWidth, projectorHeight);
    }, [projectorWidth, projectorHeight]);

    // Preview canvas state
    const [previewDataUrl, setPreviewDataUrl] = useState<string | null>(null);
    const [bgImage, setBgImage] = useState<HTMLImageElement | null>(null);
    const [selectedImageId, setSelectedImageId] = useState<string | null>(null);

    useEffect(() => {
      const savedImageId = settings?.selectedBackgroundImageId ?? null;

      if (!savedImageId) {
        setSelectedImageId(null);
        setBgImage(null);
        return;
      }

      if (savedImageId === selectedImageId && bgImage) {
        return;
      }

      let cancelled = false;

      const loadSavedBackground = async () => {
        let dataUrl: string | null = null;

        if (savedImageId.startsWith("ext:")) {
          const path = savedImageId.slice(4);
          if (window.electronAPI?.readImageAsDataUrl) {
            dataUrl = await window.electronAPI.readImageAsDataUrl(path);
          }
        } else {
          const internalImages = await imageStorageService.getAllImages();
          dataUrl = internalImages.find((img) => img.id === savedImageId)?.dataUrl ?? null;
        }

        if (cancelled) {
          return;
        }

        if (!dataUrl) {
          setSelectedImageId(null);
          setBgImage(null);
          updateSettingWithAutoSave("selectedBackgroundImageId", null);
          return;
        }

        // Avoid rendering/caching a stale bitmap under the new image ID while the new image is loading.
        setBgImage(null);
        setSelectedImageId(savedImageId);
        const img = new Image();
        img.onload = () => {
          if (!cancelled) {
            setBgImage(img);
          }
        };
        img.onerror = () => {
          if (!cancelled) {
            setBgImage(null);
          }
        };
        img.src = dataUrl;
      };

      loadSavedBackground();

      return () => {
        cancelled = true;
      };
    }, [settings?.selectedBackgroundImageId, selectedImageId, bgImage, updateSettingWithAutoSave]);

    const generatorRef = useRef<SectionGenerator | null>(null);
    const rendererRef = useRef<SectionRenderer | null>(null);
    const sectionRefs = useRef<(HTMLDivElement | null)[]>([]);
    const sectionListRef = useRef<HTMLDivElement | null>(null);
    // Set to true by keyboard navigation so the scroll effect follows next, not current.
    const nextNavigatedByKeyRef = useRef(false);
    const projectorChannelRef = useRef<BroadcastChannel | null>(null);
    const previewDataUrlRef = useRef<string | null>(null); // Ref to access latest preview in callbacks
    const lastFocusedElementRef = useRef<HTMLElement | null>(null);

    // Splitter: compute bottom panel minSize as a percentage from actual container height
    const panelGroupRef = useRef<HTMLDivElement | null>(null);
    const bottomPanelRef = useRef<ImperativePanelHandle | null>(null);
    const tabsRowRef = useRef<HTMLDivElement | null>(null);
    const tabsNavRef = useRef<HTMLUListElement | null>(null);
    const tabsMeasureRef = useRef<HTMLUListElement | null>(null);
    const formatsContainerRef = useRef<HTMLDivElement | null>(null);
    const tabContentRef = useRef<HTMLDivElement | null>(null);
    const lastExpandedBottomSizeRef = useRef<number>((previewSplitSize ?? 60) > 0 ? 100 - (previewSplitSize ?? 60) : 40);
    const lastAppliedCollapseModeRef = useRef<PreviewPanelCollapseMode | null>(null);
    const [bottomMinSize, setBottomMinSize] = useState(30);
    const [collapsedBottomSize, setCollapsedBottomSize] = useState(PREVIEW_PANEL_COLLAPSED_SIZE_FALLBACK);
    const [previewCollapsedBottomSize, setPreviewCollapsedBottomSize] = useState(12);
    const [isTabIconMode, setIsTabIconMode] = useState(false);

    useEffect(() => {
      if (activeTab !== "controls") {
        return;
      }
      const frameId = window.requestAnimationFrame(() => {
        sectionListRef.current?.focus();
      });
      return () => {
        window.cancelAnimationFrame(frameId);
      };
    }, [activeTab]);

    useEffect(() => {
      const navEl = tabsNavRef.current;
      const measureEl = tabsMeasureRef.current;
      if (!navEl || !measureEl) {
        return;
      }

      const updateTabMode = () => {
        const availableWidth = Math.floor(navEl.clientWidth);
        const requiredTextWidth = Math.ceil(measureEl.scrollWidth);

        setIsTabIconMode((prev) => {
          if (prev) {
            // Use hysteresis to avoid rapid text/icon toggling around threshold.
            return requiredTextWidth > availableWidth - PREVIEW_TABS_ICON_MODE_HYSTERESIS_PX;
          }
          return requiredTextWidth > availableWidth;
        });
      };

      updateTabMode();

      const obs = new ResizeObserver(() => {
        updateTabMode();
      });
      obs.observe(navEl);
      obs.observe(measureEl);
      if (tabsRowRef.current) {
        obs.observe(tabsRowRef.current);
      }

      window.addEventListener("resize", updateTabMode);
      return () => {
        window.removeEventListener("resize", updateTabMode);
        obs.disconnect();
      };
    }, [previewTabs]);

    useEffect(() => {
      const panelGroupEl = panelGroupRef.current;
      if (!panelGroupEl) return;

      const recomputeSplitSizes = () => {
        const groupHeight = panelGroupEl.getBoundingClientRect().height;
        if (groupHeight <= 0) return;

        const minPx = previewPanelCollapseMode === "tabsCollapsed" ? 100 : 200;
        setBottomMinSize(Math.min(70, Math.max(20, (minPx / groupHeight) * 100)));

        const tabsRowHeight = tabsRowRef.current?.getBoundingClientRect().height ?? 0;
        const collapsedPx = Math.max(1, Math.ceil(tabsRowHeight) + 2);
        const collapsedPercent = Math.min(20, Math.max(1, (collapsedPx / groupHeight) * 100));
        setCollapsedBottomSize(collapsedPercent);

        const tabContentHeight = tabContentRef.current?.getBoundingClientRect().height ?? PREVIEW_PANEL_WITH_TAB_CONTENT_FALLBACK_PX;
        const formatAreaPx = Math.max(collapsedPx, Math.ceil(tabsRowHeight + tabContentHeight + 2));
        const formatAreaPercent = Math.min(70, Math.max(collapsedPercent, (formatAreaPx / groupHeight) * 100));
        setPreviewCollapsedBottomSize(formatAreaPercent);
      };

      recomputeSplitSizes();

      const obs = new ResizeObserver(() => {
        recomputeSplitSizes();
      });
      obs.observe(panelGroupEl);
      if (tabsRowRef.current) {
        obs.observe(tabsRowRef.current);
      }
      if (formatsContainerRef.current) {
        obs.observe(formatsContainerRef.current);
      }
      return () => obs.disconnect();
    }, [previewPanelCollapseMode]);

    useEffect(() => {
      const panel = bottomPanelRef.current;
      if (!panel) return;

      const previousMode = lastAppliedCollapseModeRef.current;
      if (previousMode === null) {
        if (previewPanelCollapseMode === "tabsAndPreviewCollapsed") {
          panel.resize(collapsedBottomSize);
        } else if (previewPanelCollapseMode === "previewCollapsed") {
          panel.resize(previewCollapsedBottomSize);
        }
        lastAppliedCollapseModeRef.current = previewPanelCollapseMode;
        return;
      }

      if (previousMode === previewPanelCollapseMode) {
        if (previewPanelCollapseMode === "tabsAndPreviewCollapsed") {
          panel.resize(collapsedBottomSize);
        } else if (previewPanelCollapseMode === "previewCollapsed") {
          panel.resize(previewCollapsedBottomSize);
        }
        return;
      }

      if (previewPanelCollapseMode === "tabsAndPreviewCollapsed") {
        panel.resize(collapsedBottomSize);
      } else if (previewPanelCollapseMode === "previewCollapsed") {
        panel.resize(previewCollapsedBottomSize);
      } else if (previousMode === "tabsAndPreviewCollapsed" || previousMode === "previewCollapsed") {
        panel.resize(Math.max(bottomMinSize, lastExpandedBottomSizeRef.current));
      }

      lastAppliedCollapseModeRef.current = previewPanelCollapseMode;
    }, [previewPanelCollapseMode, bottomMinSize, collapsedBottomSize, previewCollapsedBottomSize]);

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
    const suppressQrClickRef = useRef(false);
    const suppressNextWrapperClickRef = useRef(false);
    const qrOverlayRef = useRef<HTMLDivElement | null>(null);
    const fontColorSwatchRef = useRef<HTMLSpanElement | null>(null);
    // Throttle ref for QR-interaction canvas re-renders (max once per 100ms)
    const lastQrRenderRef = useRef(0);

    // Flash overlay state: null = show normal preview, 'black'/'white' = solid flash frame
    const [flashOverlay, setFlashOverlay] = useState<"black" | "white" | null>(null);
    const flashTimersRef = useRef<ReturnType<typeof setTimeout>[]>([]);

    const triggerFlash = useCallback(() => {
      // Cancel any in-progress flash sequence
      for (const t of flashTimersRef.current) clearTimeout(t);
      flashTimersRef.current = [];

      // 3 x (black 125ms – image 125ms – white 125ms – image 125ms) = 1500ms
      const stepMs = 125;
      // sequence: B I W I  B I W I  B I W I  then null to restore
      const sequence: Array<"black" | "white" | null> = [
        "black",
        null,
        "white",
        null,
        "black",
        null,
        "white",
        null,
        "black",
        null,
        "white",
        null,
        null,
      ];
      sequence.forEach((frame, i) => {
        flashTimersRef.current.push(setTimeout(() => setFlashOverlay(frame), i * stepMs));
      });
    }, []);

    useEffect(() => {
      return () => {
        for (const t of flashTimersRef.current) clearTimeout(t);
        flashTimersRef.current = [];
      };
    }, []);

    // Attention-flash state for the side control buttons. When a section is
    // selected but its current state prevents real projection (preview frozen,
    // lyrics hidden, or no display/client attached), the button responsible for
    // that blocking state is flashed to draw the user's attention to it.
    type AttentionButton = "freeze" | "showText" | "projector";
    const [flashingButtons, setFlashingButtons] = useState<Record<AttentionButton, boolean>>({
      freeze: false,
      showText: false,
      projector: false,
    });
    const buttonFlashTimersRef = useRef<Partial<Record<AttentionButton, ReturnType<typeof setTimeout>>>>({});

    const triggerButtonFlash = useCallback((button: AttentionButton) => {
      const existing = buttonFlashTimersRef.current[button];
      if (existing) clearTimeout(existing);
      // Restart the CSS animation cleanly even if it is already running.
      setFlashingButtons((prev) => ({ ...prev, [button]: false }));
      const frameId = requestAnimationFrame(() => {
        setFlashingButtons((prev) => ({ ...prev, [button]: true }));
      });
      buttonFlashTimersRef.current[button] = setTimeout(() => {
        cancelAnimationFrame(frameId);
        setFlashingButtons((prev) => ({ ...prev, [button]: false }));
        delete buttonFlashTimersRef.current[button];
      }, 1500);
    }, []);

    const triggerFreezeButtonFlash = useCallback(() => triggerButtonFlash("freeze"), [triggerButtonFlash]);
    const triggerShowTextButtonFlash = useCallback(() => triggerButtonFlash("showText"), [triggerButtonFlash]);
    const triggerProjectorButtonFlash = useCallback(() => triggerButtonFlash("projector"), [triggerButtonFlash]);

    useEffect(() => {
      return () => {
        for (const t of Object.values(buttonFlashTimersRef.current)) {
          if (t) clearTimeout(t);
        }
        buttonFlashTimersRef.current = {};
      };
    }, []);

    // QR size context menu state
    const [qrContextMenu, setQrContextMenu] = useState<{ x: number; y: number } | null>(null);
    const qrContextMenuRef = useRef<HTMLDivElement | null>(null);

    const clampQrContextMenuPosition = useCallback((x: number, y: number, menuWidth = 220, menuHeight = 84) => {
      const container = previewContainerRef.current;
      const bounds = container?.getBoundingClientRect();
      const margin = 8;

      if (!bounds) {
        return {
          x: Math.max(margin, Math.min(window.innerWidth - menuWidth - margin, x)),
          y: Math.max(margin, Math.min(window.innerHeight - menuHeight - margin, y)),
        };
      }

      const minX = bounds.left + margin;
      const maxX = bounds.right - menuWidth - margin;
      const minY = bounds.top + margin;
      const maxY = bounds.bottom - menuHeight - margin;

      return {
        x: Math.max(minX, Math.min(maxX, x)),
        y: Math.max(minY, Math.min(maxY, y)),
      };
    }, []);

    const openQrContextMenuAt = useCallback(
      (x: number, y: number) => {
        setQrContextMenu(clampQrContextMenuPosition(x, y));
      },
      [clampQrContextMenuPosition]
    );

    const getFontOptionClassName = useCallback((font: string) => {
      return `preview-panel-font-option-${font.replace(/[^a-z0-9]+/gi, "-").toLowerCase()}`;
    }, []);

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

    useEffect(() => {
      const styleElementId = "preview-panel-font-option-styles";
      let styleElement = document.getElementById(styleElementId) as HTMLStyleElement | null;

      if (!styleElement) {
        styleElement = document.createElement("style");
        styleElement.id = styleElementId;
        document.head.appendChild(styleElement);
      }

      const escapeCssValue = (value: string) => value.replace(/\\/g, "\\\\").replace(/"/g, '\\"');

      styleElement.textContent = availableFonts
        .map((font) => {
          const className = getFontOptionClassName(font);
          return [
            `select.preview-panel-font-family-select option.${className} { font-family: "${escapeCssValue(font)}", sans-serif; }`,
            `select.preview-panel-font-family-select.${className} { font-family: "${escapeCssValue(font)}", sans-serif; }`,
          ].join("\n");
        })
        .join("\n");
    }, [availableFonts, getFontOptionClassName]);

    const buildSectionRepeatCounts = useCallback((sectionList: SectionItem[]): Display["sectionRepeatCounts"] => {
      const grouped = new Map<string, { section: number; from: number; to: number; multiplier: number; uniqueRanges: Set<string> }>();
      for (const section of sectionList) {
        const multiplier = section.instructedMultiplier ?? 1;
        if (section.instructedIndex == null || multiplier <= 1) continue;
        // `block` keeps distinct same-signature occurrences separate.
        const key = `${section.instructedIndex}|${section.block}|${multiplier}|${section.instructedSignature || ""}`;
        const existing = grouped.get(key);
        if (!existing) {
          grouped.set(key, {
            section: section.instructedIndex,
            from: section.from,
            to: section.to,
            multiplier,
            uniqueRanges: new Set<string>([`${section.from}:${section.to}`]),
          });
          continue;
        }
        existing.from = Math.min(existing.from, section.from);
        existing.to = Math.max(existing.to, section.to);
        existing.uniqueRanges.add(`${section.from}:${section.to}`);
      }

      const result = Array.from(grouped.values())
        // Join repeats only when whole repeated section fits one projected row.
        .filter((x) => x.uniqueRanges.size === 1)
        .map(({ section, from, to, multiplier }) => ({ section, from, to, multiplier }))
        .sort((a, b) => a.section - b.section || a.from - b.from || a.to - b.to);
      return result.length > 0 ? result : undefined;
    }, []);

    const sectionRepeatCounts = useMemo(() => buildSectionRepeatCounts(sections), [sections, buildSectionRepeatCounts]);
    const repeatProgressRef = useRef<{ sectionIndex: number; repeatIndex: number }>({ sectionIndex: -1, repeatIndex: 1 });
    const [selectedRepeatIndex, setSelectedRepeatIndex] = useState(1);

    useEffect(() => {
      if (selectedSectionIndex < 0 || selectedSectionIndex >= sections.length) {
        repeatProgressRef.current = { sectionIndex: -1, repeatIndex: 1 };
        setSelectedRepeatIndex(1);
        return;
      }
      if (repeatProgressRef.current.sectionIndex !== selectedSectionIndex) {
        repeatProgressRef.current = { sectionIndex: selectedSectionIndex, repeatIndex: 1 };
        setSelectedRepeatIndex(1);
      }
    }, [selectedSectionIndex, sections]);

    const getSectionRepeatTotal = useCallback(
      (section: SectionItem): number => {
        if (section.instructedIndex == null) return 1;
        const containing = sectionRepeatCounts?.find(
          (item) => item.section === section.instructedIndex && item.from <= section.from && section.to <= item.to
        );
        const fallback = sectionRepeatCounts?.find((item) => item.section === section.instructedIndex);
        const multiplier = containing?.multiplier ?? fallback?.multiplier ?? 1;
        if (!Number.isFinite(multiplier) || multiplier <= 1) return 1;
        return Math.max(2, Math.floor(multiplier));
      },
      [sectionRepeatCounts]
    );

    const getRepeatGroupBounds = useCallback(
      (index: number) => {
        if (index < 0 || index >= sections.length) return { start: index, end: index, repeatTotal: 1 };
        const section = sections[index];
        if (section.instructedIndex == null) return { start: index, end: index, repeatTotal: 1 };

        const repeatEntry = sectionRepeatCounts?.find(
          (item) => item.section === section.instructedIndex && item.from <= section.from && section.to <= item.to
        );

        const repeatTotal =
          repeatEntry && Number.isFinite(repeatEntry.multiplier) && repeatEntry.multiplier > 1 ? Math.max(2, Math.floor(repeatEntry.multiplier)) : 1;

        if (!repeatEntry || repeatTotal <= 1) return { start: index, end: index, repeatTotal: 1 };

        let start = index;
        while (start > 0) {
          const prev = sections[start - 1];
          if (prev.instructedIndex !== section.instructedIndex) break;
          if (prev.from < repeatEntry.from || prev.to > repeatEntry.to) break;
          start--;
        }

        let end = index;
        while (end + 1 < sections.length) {
          const next = sections[end + 1];
          if (next.instructedIndex !== section.instructedIndex) break;
          if (next.from < repeatEntry.from || next.to > repeatEntry.to) break;
          end++;
        }

        return { start, end, repeatTotal };
      },
      [sections, sectionRepeatCounts]
    );

    // Update display state when section changes
    const updateDisplayState = useCallback(
      async (
        sectionIndex: number,
        section: SectionItem,
        options?: { forceEmit?: boolean; bumpRepeatNonce?: boolean; preserveRepeatNonce?: boolean }
      ) => {
        const song = getProjectedSong();
        if (!song) return;
        // Only emit a canonical section number when this SectionItem was
        // derived from instructions (each instruction-item has a stable
        // index shared with the editor's instructed-line rendering). For
        // non-instructed sections the editor lines have no
        // `instructedSectionIndex` to compare against, so leaving `section`
        // unset lets the highlight fall back to the source line range.
        const updateData: Partial<Display> = {
          songId: song.Id,
          from: section.from,
          to: section.to,
          section: section.instructedIndex,
          sectionRepeatNonce: options?.bumpRepeatNonce
            ? (getCurrentDisplay().sectionRepeatNonce ?? 0) + 1
            : options?.preserveRepeatNonce
              ? (getCurrentDisplay().sectionRepeatNonce ?? 0)
              : 0,
          sectionRepeatCounts,
          song: song.Text,
          system: song.System,
        };
        if (selectedPlaylistItem?.transpose) updateData.transpose = selectedPlaylistItem.transpose;
        if (selectedPlaylistItem?.capo) updateData.capo = selectedPlaylistItem.capo;
        if (selectedPlaylistItem?.instructions) updateData.instructions = selectedPlaylistItem.instructions;
        updateCurrentDisplay(updateData, { forceEmit: options?.forceEmit });
      },
      [selectedPlaylistItem, sectionRepeatCounts]
    );

    const selectSectionIndex = useCallback(
      (
        index: number,
        options?: {
          advanceRepeat?: boolean;
          repeatIndexOverride?: number;
          bumpRepeatNonce?: boolean;
          preserveRepeatNonce?: boolean;
          forceEmit?: boolean;
        }
      ) => {
        if (index < 0 || index >= sections.length) {
          repeatProgressRef.current = { sectionIndex: -1, repeatIndex: 1 };
          setSelectedRepeatIndex(1);
          onSelectedSectionIndexChange?.(-1);
          updateCurrentDisplay({ from: 0, to: 0, section: -1, sectionRepeatNonce: 0, sectionRepeatCounts });
          return false;
        }

        const section = sections[index];
        const repeatTotal = getSectionRepeatTotal(section);
        const shouldAdvanceRepeat = !!options?.advanceRepeat && selectedSectionIndex === index && repeatTotal > 1;
        let repeatIndex = options?.repeatIndexOverride ?? 1;

        if (options?.repeatIndexOverride == null && shouldAdvanceRepeat) {
          const prevRepeat = repeatProgressRef.current.sectionIndex === index ? repeatProgressRef.current.repeatIndex : 1;
          repeatIndex = prevRepeat < repeatTotal ? prevRepeat + 1 : 1;
        }

        repeatProgressRef.current = { sectionIndex: index, repeatIndex };
        setSelectedRepeatIndex(repeatIndex);

        onSelectedSectionIndexChange?.(index);
        const shouldBumpRepeatNonce = !!options?.bumpRepeatNonce || shouldAdvanceRepeat;
        const shouldPreserveRepeatNonce = !shouldBumpRepeatNonce && !!options?.preserveRepeatNonce;
        const shouldForceEmit = !!options?.forceEmit || shouldAdvanceRepeat;
        updateDisplayState(index, section, {
          forceEmit: shouldForceEmit,
          bumpRepeatNonce: shouldBumpRepeatNonce,
          preserveRepeatNonce: shouldPreserveRepeatNonce,
        });
        return true;
      },
      [sections, getSectionRepeatTotal, selectedSectionIndex, onSelectedSectionIndexChange, sectionRepeatCounts, updateDisplayState]
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
        selectSectionByLine: (lineNumber: number, section?: number): boolean => {
          // Prefer the canonical instruction-item section index when provided
          // — this disambiguates repeated sections / transposed clones that
          // share the same source line range.
          if (section != null) {
            for (let i = 0; i < sections.length; i++) {
              if (sections[i].instructedIndex === section && sections[i].from <= lineNumber && lineNumber < sections[i].to) {
                return selectSectionIndex(i, { advanceRepeat: selectedSectionIndex === i });
              }
            }
            for (let i = 0; i < sections.length; i++) {
              if (sections[i].instructedIndex === section) {
                return selectSectionIndex(i, { advanceRepeat: selectedSectionIndex === i });
              }
            }
          }
          // Find section that contains the given line number
          // Matching C# ChangeHighlightByLine logic
          for (let i = 0; i < sections.length; i++) {
            const section = sections[i];
            if (section.from <= lineNumber && lineNumber < section.to) {
              return selectSectionIndex(i, { advanceRepeat: selectedSectionIndex === i });
            }
          }
          return selectSectionIndex(-1);
        },
        getSelectedSectionIndex: (): number => {
          return selectedSectionIndex;
        },
        setSelectedSectionIndex: (index: number): void => {
          if (index >= -1 && index < sections.length) selectSectionIndex(index);
        },
        setSectionListFocused: (): void => {
          sectionListRef.current?.focus();
        },
      }),
      [sections, selectedSectionIndex, selectSectionIndex]
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
          const targetDisplays = await getTargetDisplays(displays);
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
        nonSplittingWords: settings?.useNonSplittingWords ? (settings?.nonSplittingWordList ?? []) : [],
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

    // Scroll the section list when selection or next changes.
    // - Arrow-key navigation (nextNavigatedByKeyRef=true): freely follow the next item.
    // - Any other trigger (selection changed, new song): keep current visible, show next if it fits.
    useEffect(() => {
      const sectionListEl = sectionListRef.current;
      if (!sectionListEl) return;

      if (selectedSectionIndex < 0) {
        nextNavigatedByKeyRef.current = false;
        sectionListEl.scrollTop = 0;
        return;
      }

      const viewportHeight = sectionListEl.clientHeight;
      const maxScrollTop = Math.max(0, sectionListEl.scrollHeight - viewportHeight);

      // When only next changed via keyboard, just scroll next into view.
      if (nextNavigatedByKeyRef.current) {
        nextNavigatedByKeyRef.current = false;
        const nextEl = nextSectionIndex >= 0 ? sectionRefs.current[nextSectionIndex] : null;
        if (nextEl) {
          const nextTop = nextEl.offsetTop;
          const nextBottom = nextTop + nextEl.offsetHeight;
          let t = sectionListEl.scrollTop;
          if (nextTop < t) t = nextTop;
          else if (nextBottom > t + viewportHeight) t = nextBottom - viewportHeight;
          t = Math.max(0, Math.min(maxScrollTop, t));
          if (Math.abs(sectionListEl.scrollTop - t) > 1) sectionListEl.scrollTo({ top: t, behavior: "smooth" });
        }
        return;
      }

      // Selection changed: keep current visible, include next if possible.
      const selectedEl = sectionRefs.current[selectedSectionIndex];
      if (!selectedEl) return;

      let targetScrollTop = sectionListEl.scrollTop;
      const selectedTop = selectedEl.offsetTop;
      const selectedBottom = selectedTop + selectedEl.offsetHeight;

      // Step 1: ensure selected item is visible.
      if (selectedTop < targetScrollTop) {
        targetScrollTop = selectedTop;
      } else if (selectedBottom > targetScrollTop + viewportHeight) {
        targetScrollTop = selectedBottom - viewportHeight;
      }

      // Step 2: try to include next item without breaking selected visibility.
      const nextEl = nextSectionIndex >= 0 && nextSectionIndex < sectionRefs.current.length ? sectionRefs.current[nextSectionIndex] : null;

      if (nextEl && nextEl !== selectedEl) {
        const nextTop = nextEl.offsetTop;
        const nextBottom = nextTop + nextEl.offsetHeight;

        let desiredScrollTop = targetScrollTop;
        if (nextTop < desiredScrollTop) {
          desiredScrollTop = nextTop;
        } else if (nextBottom > desiredScrollTop + viewportHeight) {
          desiredScrollTop = nextBottom - viewportHeight;
        }

        // Clamp to range that keeps selected visible. If impossible, selected keeps priority.
        const minForSelected = selectedBottom - viewportHeight;
        const maxForSelected = selectedTop;
        const clampedForSelected = Math.min(maxForSelected, Math.max(minForSelected, desiredScrollTop));
        targetScrollTop = clampedForSelected;
      }

      targetScrollTop = Math.max(0, Math.min(maxScrollTop, targetScrollTop));

      if (Math.abs(sectionListEl.scrollTop - targetScrollTop) > 1) {
        sectionListEl.scrollTo({ top: targetScrollTop, behavior: "smooth" });
      }
    }, [selectedSectionIndex, nextSectionIndex, sections]);

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
    const netDisplayUseJpegCompression = settings?.netDisplayUseJpegCompression ?? true;
    const netDisplayJpegQuality = Math.max(1, Math.min(100, settings?.netDisplayJpegQuality ?? 70));
    const netDisplayImageScale = Math.max(0.1, Math.min(1, settings?.netDisplayImageScale ?? 1));
    const netDisplayTransient =
      typeof settings?.netDisplayTransient === "boolean"
        ? settings.netDisplayTransient
          ? 500
          : 0
        : Math.max(0, Math.min(500, Math.round(settings?.netDisplayTransient ?? 200)));
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
    }, [settings, settings?.qrCodeSizePercent, settings?.qrCodeX, settings?.qrCodeY, projectorWidth, projectorHeight, updateSettingWithAutoSave]);

    // Render preview when selected section or settings change
    useEffect(() => {
      // If preview is frozen, don't update
      if (freezePreview) {
        return;
      }

      if (!rendererRef.current) {
        const timerId = setTimeout(() => setPreviewDataUrl(null), 0);
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

        const render = (renderer: SectionRenderer, text: string) => {
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
            textShadowEnabled: settings?.displayTextShadowEnabled ?? false,
            textShadowOffset: settings?.displayTextShadowOffset ?? 2,
            textShadowBlur: settings?.displayTextShadowBlur ?? 4,
            textShadowColor: settings?.displayTextShadowColor || "#000000",
            textShadowOpacity: settings?.displayTextShadowOpacity ?? 0.8,
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

          updateCurrentDisplay({ message: text });

          try {
            const backgroundSignature = showImage ? getBackgroundImageSignature(selectedImageId, bgImage) : "none";

            const cacheKey = projectedImageCacheService.buildCacheKey({
              text,
              renderSettingsSnapshot: {
                ...renderSettings,
                // Explicitly include image-on/off in key; bgImage signature is tracked separately.
                showImage,
              },
              backgroundSignature,
            });

            const useCache = !isQrDragging && qrDragPos === null;
            const previewPng = useCache
              ? projectedImageCacheService.getOrCreate(cacheKey, () =>
                  renderer.renderSection(text, renderSettings, showImage ? bgImage : null).toDataURL("image/png")
                )
              : renderer.renderSection(text, renderSettings, showImage ? bgImage : null).toDataURL("image/png");

            setPreviewDataUrl(previewPng);
          } catch (error) {
            console.error("Preview", "Error rendering message", error);
            setPreviewDataUrl(null);
          }
        };

        // If message display is enabled, render message instead of section
        if (displayMessageEnabled) {
          const messageText = showText ? settings?.message || "" : "";
          render(rendererRef.current, messageText);
          return;
        }

        // Normal section rendering
        if (selectedSectionIndex < 0 || !sections[selectedSectionIndex]) {
          setPreviewDataUrl(null);
          return;
        }

        const section = sections[selectedSectionIndex];
        const sectionText = showText ? section.text : "";
        render(rendererRef.current, sectionText);
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
      isQrDragging,
      qrDragPos,
      liveQrX,
      liveQrY,
      selectedImageId,
    ]);

    // Flash only when section selection changes (not when toggling text/projector settings)
    useEffect(() => {
      const previousSelectionIndex = lastSelectionIndexRef.current;
      lastSelectionIndexRef.current = selectedSectionIndex;

      if (previousSelectionIndex === selectedSectionIndex) {
        return;
      }

      const noProjectionTarget = !projectorEnabled && !hasConnectedClients;
      if (selectedSectionIndex >= 0 && (freezePreview || !showText || noProjectionTarget)) {
        if (settings?.warningFlashInPreview) triggerFlash();
        if (freezePreview) triggerFreezeButtonFlash();
        if (!showText) triggerShowTextButtonFlash();
        if (noProjectionTarget) triggerProjectorButtonFlash();
      }
    }, [
      selectedSectionIndex,
      settings?.warningFlashInPreview,
      freezePreview,
      showText,
      projectorEnabled,
      hasConnectedClients,
      triggerFlash,
      triggerFreezeButtonFlash,
      triggerShowTextButtonFlash,
      triggerProjectorButtonFlash,
    ]);

    const handleSectionClick = (index: number) => {
      selectSectionIndex(index, { advanceRepeat: selectedSectionIndex === index });
    };

    const handleSectionListAction = useCallback(
      (key: string): boolean => {
        if (sections.length === 0) return false;

        // Helper to check if index is valid for next selection
        const isValidNextIndex = (i: number) => i >= 0 && i < sections.length && i !== selectedSectionIndex && sections[i].checked;

        switch (key) {
          case "ArrowDown":
          case "ArrowRight": {
            // Move nextIndex forward (matching C# OnKeyDown Keys.Down/Right)
            const newNext = getNextCheckedIndex(nextSectionIndex, sections);
            if (newNext >= 0) {
              nextNavigatedByKeyRef.current = true;
              setNextSectionIndex(newNext);
            }
            return true;
          }

          case "ArrowUp":
          case "ArrowLeft": {
            // Move nextIndex backward (matching C# OnKeyDown Keys.Up/Left)
            // Find item whose next would be current nextIndex
            for (let i = 0; i < sections.length; i++) {
              if (i !== selectedSectionIndex && sections[i].checked && getNextCheckedIndex(i, sections) === nextSectionIndex) {
                nextNavigatedByKeyRef.current = true;
                setNextSectionIndex(i);
                break;
              }
            }
            return true;
          }

          case "Home": {
            // Move to first valid next item (matching C# OnKeyDown Keys.Home)
            let i = 0;
            while (i < sections.length && !isValidNextIndex(i)) i++;
            if (i < sections.length) {
              nextNavigatedByKeyRef.current = true;
              setNextSectionIndex(i);
            }
            return true;
          }

          case "End": {
            // Move to last valid next item (matching C# OnKeyDown Keys.End)
            let i = sections.length - 1;
            while (i >= 0 && !isValidNextIndex(i)) i--;
            if (i >= 0) {
              nextNavigatedByKeyRef.current = true;
              setNextSectionIndex(i);
            }
            return true;
          }

          case "PageDown": {
            // Move to next block (matching C# OnKeyDown Keys.PageDown)
            let i = nextSectionIndex >= 0 ? nextSectionIndex : selectedSectionIndex >= 0 ? selectedSectionIndex : 0;
            if (i >= 0 && i < sections.length) {
              const block = sections[i].block;
              while (i < sections.length && sections[i].block === block) i++;
              while (i < sections.length && !isValidNextIndex(i)) i++;
              if (i < sections.length) {
                nextNavigatedByKeyRef.current = true;
                setNextSectionIndex(i);
              }
            }
            return true;
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
                  nextNavigatedByKeyRef.current = true;
                  setNextSectionIndex(i);
                }
              }
            }
            return true;
          }

          case " ": {
            // Toggle checkbox on selected item (matching C# OnKeyPress space)
            if (selectedSectionIndex >= 0) {
              toggleSectionCheck(selectedSectionIndex);
            }
            return true;
          }

          case "Enter": {
            // Advance repeats at the end of the split-group, not per fragment.
            if (selectedSectionIndex >= 0 && sections[selectedSectionIndex]) {
              const group = getRepeatGroupBounds(selectedSectionIndex);
              const repeatIndex = repeatProgressRef.current.sectionIndex === selectedSectionIndex ? repeatProgressRef.current.repeatIndex : 1;
              if (group.repeatTotal > 1 && selectedSectionIndex === group.end && repeatIndex < group.repeatTotal) {
                selectSectionIndex(group.start, {
                  repeatIndexOverride: repeatIndex + 1,
                  bumpRepeatNonce: true,
                  forceEmit: true,
                });
                return true;
              }
            }

            if (nextSectionIndex >= 0) {
              const selectedGroup = getRepeatGroupBounds(selectedSectionIndex);
              const nextInSameGroup = selectedSectionIndex >= 0 && nextSectionIndex >= selectedGroup.start && nextSectionIndex <= selectedGroup.end;
              const repeatIndex = repeatProgressRef.current.sectionIndex === selectedSectionIndex ? repeatProgressRef.current.repeatIndex : 1;

              if (nextInSameGroup && selectedGroup.repeatTotal > 1) {
                selectSectionIndex(nextSectionIndex, { repeatIndexOverride: repeatIndex, preserveRepeatNonce: true });
              } else {
                selectSectionIndex(nextSectionIndex);
              }
            }
            return true;
          }

          case "Backspace": {
            // set selection to first section of current block
            if (selectedSectionIndex >= 0) {
              const currentBlock = sections[selectedSectionIndex].block;
              let i = selectedSectionIndex;
              while (i >= 0 && sections[i].block === currentBlock) i--;
              if (i + 1 < sections.length) {
                selectSectionIndex(i + 1);
              }
            }
            return true;
          }

          case "Escape": {
            // Clear selection
            selectSectionIndex(-1);
            return true;
          }

          default:
            return false;
        }
      },
      [sections, selectedSectionIndex, nextSectionIndex, getNextCheckedIndex, toggleSectionCheck, selectSectionIndex, getRepeatGroupBounds]
    );

    // Keyboard handler for section list (matching C# SectionListBox.OnKeyDown and OnKeyPress)
    const handleSectionListKeyDown = useCallback(
      (e: React.KeyboardEvent) => {
        if (handleSectionListAction(e.key)) {
          e.preventDefault();
        }
      },
      [handleSectionListAction]
    );

    const handleSectionControlButtonPress = useCallback(
      (key: SectionListActionKey) => {
        handleSectionListAction(key);
        sectionListRef.current?.focus();
      },
      [handleSectionListAction]
    );

    const handleCheckboxClick = (e: React.MouseEvent, index: number) => {
      e.stopPropagation();
      toggleSectionCheck(index);
    };

    const toggleButton = (
      currentState: boolean,
      setter: (value: boolean) => void,
      settingKey?: keyof Pick<Settings, "contentBasedSections" | "projectInstructions" | "showTextInPreview" | "showImageInPreview">,
      focusElement?: HTMLElement | null
    ) => {
      const newState = !currentState;
      setter(newState);
      if (settingKey) {
        updateSettingWithAutoSave(settingKey, newState);
      }
      if (!focusElement) focusElement = sectionListRef.current;
      focusElement?.focus();
    };

    // True when running in Electron with only a single monitor — there is no
    // secondary screen to project onto, so the projector switch is disabled.
    const projectorSwitchDisabled = !!window.electronAPI && electronDisplayCount <= 1;

    // Projector button handler - matching C# OnSwitchButtonClicked + UpdateDisplaySetting
    const handleProjectorToggle = async () => {
      const isElectron = !!window.electronAPI;

      // Defensive: ignore activation when there is no secondary screen to project on.
      if (projectorSwitchDisabled) return;

      if (isElectron) {
        // Electron mode: enumerate displays and cycle through them
        if (!window.electronAPI?.getAllDisplays) {
          console.warn("Preview", "Display enumeration not available in Electron");
          return;
        }

        try {
          const displays = await window.electronAPI.getAllDisplays();

          // Skip the screen hosting the main window (matching C# UpdateDisplaySetting refPoint check)
          const targetDisplays = await getTargetDisplays(displays);

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
          let screenDetails: ScreenDetailsResult | null = null;
          try {
            const windowWithScreenDetails = window as WindowWithScreenDetails;
            if (typeof windowWithScreenDetails.getScreenDetails === "function") {
              screenDetails = await windowWithScreenDetails.getScreenDetails();
            }
          } catch {
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
          } catch {
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
            } catch {
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
      sectionListRef.current?.focus();
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
      // Send frame once; main process updates both display window and net display clients.
      window.electronAPI?.setDisplayWindowImage?.(previewDataUrl, {
        jpegQuality: netDisplayUseJpegCompression ? netDisplayJpegQuality : undefined,
        imageScale: netDisplayImageScale,
        bgColor: settings?.backgroundColor || "#000000",
        transient: netDisplayTransient,
      });
    }, [
      previewDataUrl,
      projectorWindowRef,
      projectorEnabled,
      netDisplayUseJpegCompression,
      netDisplayJpegQuality,
      netDisplayImageScale,
      netDisplayTransient,
      settings?.backgroundColor,
    ]);

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
                    className={`form-control form-control-sm preview-panel-font-family-select ${getFontOptionClassName(
                      settings?.displayFontName || "Arial"
                    )}`}
                    aria-label="Font Family"
                    value={settings?.displayFontName || "Arial"}
                    onChange={(e) => updateSettingWithAutoSave("displayFontName", e.target.value)}
                  >
                    {availableFonts.map((font) => (
                      <option key={font} value={font} className={getFontOptionClassName(font)}>
                        {font}
                      </option>
                    ))}
                  </select>
                  <div className="btn-group flex-fill">
                    <button
                      className={`btn flex-fill ${settings?.displayFontBold ? "btn-light btn-active" : "btn-light"}`}
                      aria-label="Bold"
                      onClick={() => {
                        updateSettingWithAutoSave("displayFontBold", !settings?.displayFontBold);
                        sectionListRef.current?.focus();
                      }}
                    >
                      <Icon type={IconType.BOLD} />
                    </button>
                    <button
                      className={`btn flex-fill ${settings?.displayFontItalic ? "btn-light btn-active" : "btn-light"}`}
                      aria-label="Italic"
                      onClick={() => {
                        updateSettingWithAutoSave("displayFontItalic", !settings?.displayFontItalic);
                        sectionListRef.current?.focus();
                      }}
                    >
                      <Icon type={IconType.ITALIC} />
                    </button>
                    <button
                      className={`btn flex-fill ${settings?.displayFontUnderline ? "btn-light btn-active" : "btn-light"}`}
                      aria-label="Underline"
                      onClick={() => {
                        updateSettingWithAutoSave("displayFontUnderline", !settings?.displayFontUnderline);
                        sectionListRef.current?.focus();
                      }}
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
                    onChange={(e) => {
                      updateSettingWithAutoSave("displayFontSize", parseInt(e.target.value, 10));
                      sectionListRef.current?.focus();
                    }}
                    aria-label="Font Size"
                  >
                    {Array.from({ length: 99 }, (_, i) => i + 1).map((size) => (
                      <option key={size} value={size}>
                        {size}
                      </option>
                    ))}
                  </select>
                  <label className="btn btn-light font-color-btn" title={tt("format_text_color")}>
                    <input
                      type="color"
                      className="font-color-picker-hidden"
                      value={settings?.textColor || "#FFFFFF"}
                      onChange={(e) => {
                        updateSettingWithAutoSave("textColor", e.target.value);
                        sectionListRef.current?.focus();
                      }}
                      title={tt("format_text_color")}
                      aria-label="Text Color"
                    />
                    <span className="font-color-swatch" ref={fontColorSwatchRef} />
                  </label>
                  <div className="btn-group align-buttons">
                    <button
                      className={`btn flex-fill ${(settings?.displayFontAlign || "center") === "left" ? "btn-light btn-active" : "btn-light"}`}
                      aria-label="Align Left"
                      onClick={() => {
                        updateSettingWithAutoSave("displayFontAlign", "left");
                        sectionListRef.current?.focus();
                      }}
                    >
                      <Icon type={IconType.ALIGN_LEFT} />
                    </button>
                    <button
                      className={`btn flex-fill ${(settings?.displayFontAlign || "center") === "center" ? "btn-light btn-active" : "btn-light"}`}
                      aria-label="Align Center"
                      onClick={() => {
                        updateSettingWithAutoSave("displayFontAlign", "center");
                        sectionListRef.current?.focus();
                      }}
                    >
                      <Icon type={IconType.ALIGN_CENTER} />
                    </button>
                    <button
                      className={`btn flex-fill ${(settings?.displayFontAlign || "center") === "right" ? "btn-light btn-active" : "btn-light"}`}
                      aria-label="Align Right"
                      onClick={() => {
                        updateSettingWithAutoSave("displayFontAlign", "right");
                        sectionListRef.current?.focus();
                      }}
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
                  // Clear current image immediately to prevent stale-image cache collisions during async load.
                  setBgImage(null);
                  setSelectedImageId(imageId);
                  updateSettingWithAutoSave("selectedBackgroundImageId", imageId);
                  if (dataUrl) {
                    const img = new Image();
                    img.onload = () => setBgImage(img);
                    img.onerror = () => setBgImage(null);
                    img.src = dataUrl;
                  } else {
                    setBgImage(null);
                  }
                  sectionListRef.current?.focus();
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
                onFocus={(e) => {
                  lastFocusedElementRef.current = e.target as HTMLElement;
                }}
              ></textarea>
            </div>
          );
        case "controls":
          return (
            <div className="tab-pane-content">
              <div className="preview-controls-grid" role="group" aria-label={t("Controls")}>
                {previewControlButtons.map((button) => (
                  <button
                    key={button.key}
                    type="button"
                    className="btn btn-light preview-controls-btn"
                    title={button.tooltip}
                    aria-label={button.tooltip}
                    onPointerDown={(e) => e.preventDefault()}
                    onClick={() => handleSectionControlButtonPress(button.key)}
                  >
                    <i className={button.iconClass} aria-hidden="true" />
                  </button>
                ))}
              </div>
            </div>
          );
        default:
          return null;
      }
    };

    // ── QR code drag / resize handlers ─────────────────────────────────────

    // Click on the preview background: toggle QR visibility
    const handlePreviewWrapperClick = useCallback(() => {
      if (suppressNextWrapperClickRef.current) {
        suppressNextWrapperClickRef.current = false;
        return;
      }
      if (qrContextMenu) {
        setQrContextMenu(null);
        return;
      }
      if (qrRawUrl) {
        const nextVisible = !(settings?.qrCodeInPreview ?? false);
        updateSettingWithAutoSave("qrCodeInPreview", nextVisible);
        if (!nextVisible) {
          setQrContextMenu(null);
          setQrDragPos(null);
        }
      }
    }, [settings?.qrCodeInPreview, qrRawUrl, qrContextMenu, updateSettingWithAutoSave]);

    // Context menu on the projected image preview -> show QR size slider (only when QR is visible)
    const handlePreviewContextMenu = useCallback(
      (e: React.MouseEvent) => {
        e.preventDefault();
        e.stopPropagation();
        if (settings?.qrCodeInPreview && qrCodeUrl) {
          openQrContextMenuAt(e.clientX, e.clientY);
        }
      },
      [settings?.qrCodeInPreview, qrCodeUrl, openQrContextMenuAt]
    );

    // Close the QR context menu when clicking outside or pressing Escape
    useEffect(() => {
      if (!qrContextMenu) return;
      const handleClickOutside = (e: MouseEvent) => {
        if (qrContextMenuRef.current && !qrContextMenuRef.current.contains(e.target as Node)) {
          suppressNextWrapperClickRef.current = true;
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

    useEffect(() => {
      if (!settings?.qrCodeInPreview && qrContextMenu) {
        setQrContextMenu(null);
      }
    }, [settings?.qrCodeInPreview, qrContextMenu]);

    useEffect(() => {
      if (isProjectedPreviewCollapsed && qrContextMenu) {
        setQrContextMenu(null);
      }
    }, [isProjectedPreviewCollapsed, qrContextMenu]);

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

        const handleMouseUp = (me: MouseEvent) => {
          document.removeEventListener("mousemove", handleMouseMove);
          document.removeEventListener("mouseup", handleMouseUp);
          setIsQrDragging(false);
          if (!qrDragRef.current.moved) {
            setQrDragPos(null);
            openQrContextMenuAt(me.clientX, me.clientY);
          } else {
            suppressQrClickRef.current = true;
            window.setTimeout(() => {
              suppressQrClickRef.current = false;
            }, 0);
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
      [settings, openQrContextMenuAt, updateSettingWithAutoSave]
    );

    // Scroll wheel on the QR overlay → resize
    const handleQrWheel = useCallback(
      (e: React.WheelEvent) => {
        e.preventDefault();
        e.stopPropagation();
        if (!settings) return;
        const delta = e.deltaY > 0 ? -2 : 2;
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
          const touch = e.changedTouches[0];
          if (!qrDragRef.current.moved) {
            setQrDragPos(null);
            if (touch) {
              openQrContextMenuAt(touch.clientX, touch.clientY);
            }
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
      [isQrDragging, openQrContextMenuAt, updateSettingWithAutoSave]
    );

    // Compute pixel position/size for the QR overlay
    const qrSizePercent = settings?.qrCodeSizePercent ?? 15;
    const qrSizePx = wrapperDims.h > 0 ? wrapperDims.h * (qrSizePercent / 100) : 0;
    const qrLeftPx = wrapperDims.w > 0 ? wrapperDims.w * (liveQrX / 100) : 0;
    const qrTopPx = wrapperDims.h > 0 ? wrapperDims.h * (liveQrY / 100) : 0;

    useEffect(() => {
      const wrapper = previewWrapperRef.current;
      if (!wrapper) {
        return;
      }

      if (imageDims.w > 0 && imageDims.h > 0) {
        wrapper.style.width = `${imageDims.w}px`;
        wrapper.style.height = `${imageDims.h}px`;
      } else {
        wrapper.style.removeProperty("width");
        wrapper.style.removeProperty("height");
      }
    }, [imageDims.h, imageDims.w, previewDataUrl]);

    useEffect(() => {
      const overlay = qrOverlayRef.current;
      if (!overlay) {
        return;
      }

      overlay.style.setProperty("--qr-left", `${qrLeftPx}px`);
      overlay.style.setProperty("--qr-top", `${qrTopPx}px`);
      overlay.style.setProperty("--qr-size", `${qrSizePx}px`);
    }, [qrLeftPx, qrTopPx, qrSizePx, qrCodeUrl, settings?.qrCodeInPreview, previewDataUrl]);

    useEffect(() => {
      const menu = qrContextMenuRef.current;
      if (!menu || !qrContextMenu) {
        return;
      }

      const clamped = clampQrContextMenuPosition(qrContextMenu.x, qrContextMenu.y, menu.offsetWidth, menu.offsetHeight);

      if (clamped.x !== qrContextMenu.x || clamped.y !== qrContextMenu.y) {
        setQrContextMenu(clamped);
        return;
      }

      menu.style.left = `${clamped.x}px`;
      menu.style.top = `${clamped.y}px`;
    }, [qrContextMenu, clampQrContextMenuPosition]);

    useEffect(() => {
      if (!qrContextMenu) {
        return;
      }

      const handleResize = () => {
        setQrContextMenu((prev) => {
          if (!prev) return prev;
          return clampQrContextMenuPosition(prev.x, prev.y);
        });
      };

      window.addEventListener("resize", handleResize);
      return () => {
        window.removeEventListener("resize", handleResize);
      };
    }, [qrContextMenu, clampQrContextMenuPosition]);

    useEffect(() => {
      const swatch = fontColorSwatchRef.current;
      if (!swatch) {
        return;
      }

      swatch.style.backgroundColor = settings?.textColor || "#FFFFFF";
    }, [settings?.textColor]);

    useEffect(() => {
      const sectionList = sectionListRef.current;
      if (!sectionList) {
        return;
      }

      sectionList.style.setProperty("--section-preview-font-family", settings?.displayFontName || "Arial");
    }, [settings?.displayFontName]);

    return (
      <div className="d-flex flex-column h-100" ref={panelGroupRef}>
        <PanelGroup
          direction="vertical"
          onLayout={(sizes) => {
            onPreviewSplitSizeChange?.(sizes[0]);
            const nextBottomSize = sizes[1];
            if (
              typeof nextBottomSize === "number" &&
              previewPanelCollapseMode !== "tabsAndPreviewCollapsed" &&
              previewPanelCollapseMode !== "previewCollapsed"
            ) {
              lastExpandedBottomSizeRef.current = nextBottomSize;
            }
          }}
        >
          <Panel defaultSize={previewSplitSize ?? 60} minSize={20}>
            <div className="d-flex flex-grow-1 min-height-0 h-100">
              <div className={`flex-grow-1 preview-sections-container ${remoteHighlightController ? "remote-controlled" : ""}`}>
                {/* Remote control indicator overlay - matching C# SectionListBox.Remote */}
                {remoteHighlightController && <img src={remoteIndicatorOverlaySrc} alt="" className="remote-indicator-overlay" aria-hidden="true" />}
                <div ref={sectionListRef} className="list-group preview-sections-list" tabIndex={0} onKeyDown={handleSectionListKeyDown}>
                  {sections.length === 0 ? (
                    <div className="text-muted text-center p-3">{t("NoSongSelected")}</div>
                  ) : (
                    sections.map((section, index) => {
                      const isSelected = selectedSectionIndex === index;
                      const isNext = nextSectionIndex === index;
                      const repeatTotal = getSectionRepeatTotal(section);
                      const repeatIndex = isSelected ? Math.max(1, Math.min(selectedRepeatIndex, repeatTotal)) : 1;
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
                      const sectionTextClassName = `section-text${
                        settings?.previewFontInSections
                          ? ` section-text-preview section-text-align-${settings.displayFontAlign || "center"}${
                              settings?.displayFontBold ? " section-text-bold" : ""
                            }${settings?.displayFontItalic ? " section-text-italic" : ""}${
                              settings?.displayFontUnderline ? " section-text-underline" : ""
                            }`
                          : ""
                      }`;

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
                          onFocus={() => {
                            lastFocusedElementRef.current = null;
                          }}
                          title={tt("sectionlist")}
                        >
                          <div className="d-flex align-items-start">
                            <input
                              type="checkbox"
                              className={`section-checkbox ${!hasTypeColor ? "mr-1 mt-1" : ""}`}
                              checked={section.checked}
                              onClick={(e) => handleCheckboxClick(e, index)}
                              onChange={() => {}} // Controlled by onClick
                              aria-label={`Include section ${index + 1}`}
                            />
                            {}
                            <div className="section-text-wrap">
                              <span className={sectionTextClassName}>{displayText}</span>
                              {repeatTotal > 1 && (
                                <div className="section-repeat-progress" aria-hidden="true">
                                  {Array.from({ length: repeatTotal }, (_, repeatSegment) => {
                                    const segmentIndex = repeatSegment + 1;
                                    const segmentClassName =
                                      segmentIndex < repeatIndex
                                        ? "section-repeat-segment done"
                                        : segmentIndex === repeatIndex
                                          ? "section-repeat-segment active"
                                          : "section-repeat-segment";
                                    return <span key={`repeat-${index}-${segmentIndex}`} className={segmentClassName} />;
                                  })}
                                </div>
                              )}
                            </div>
                          </div>
                        </div>
                      );
                    })
                  )}
                </div>
              </div>
              <div className="d-flex flex-column ml-1 flex-shrink-0 preview-button-column">
                <div className="btn-group-vertical">
                  {showSettingsButton && onSettingsClick && (
                    <button className="btn btn-light" aria-label="Settings" title={tt("toolbar_settings")} onClick={() => onSettingsClick()}>
                      <Icon type={IconType.SETTINGS} />
                    </button>
                  )}
                  <button
                    className={`btn ${projectorEnabled ? "btn-light btn-active" : "btn-light"}${projectorSwitchDisabled ? " btn-look-disabled" : ""}${flashingButtons.projector ? " preview-button-flash" : ""}`}
                    aria-label="Display Enabled"
                    aria-disabled={projectorSwitchDisabled ? "true" : "false"}
                    onClick={handleProjectorToggle}
                    title={projectorSwitchDisabled ? tt("display_enabled_single_monitor") : tt("display_enabled")}
                  >
                    <Icon type={IconType.DISPLAY} />
                    {currentMonitorIndex >= 0 && availableMonitors.length > 2 && <span className="monitor-label">{currentMonitorIndex + 1}</span>}
                  </button>
                  <button
                    className={`btn ${showText ? "btn-light btn-active" : "btn-light"}${flashingButtons.showText ? " preview-button-flash" : ""}`}
                    aria-label="Display Text"
                    onClick={() => toggleButton(showText, setShowText, "showTextInPreview")}
                    title={tt("display_lyrics")}
                  >
                    <Icon type={IconType.TEXT} />
                  </button>
                  <button
                    className={`btn ${showImage ? "btn-light btn-active" : "btn-light"}`}
                    aria-label="Display Image"
                    onClick={() => toggleButton(showImage, setShowImage, "showImageInPreview")}
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
                    className={`btn ${freezePreview ? "btn-light btn-active" : "btn-light"}${flashingButtons.freeze ? " preview-button-flash" : ""}`}
                    aria-label="Freeze"
                    onClick={() => toggleButton(freezePreview, setFreezePreview)}
                  >
                    <Icon type={IconType.FREEZE} />
                  </button>
                  <button
                    className={`btn ${displayMessageEnabled ? "btn-light btn-active" : "btn-light"}`}
                    aria-label="Message"
                    onClick={() =>
                      toggleButton(
                        displayMessageEnabled,
                        setDisplayMessageEnabled,
                        undefined,
                        activeTab === "message" ? lastFocusedElementRef.current : undefined
                      )
                    }
                  >
                    <Icon type={IconType.MESSAGE} />
                  </button>
                </div>
              </div>
            </div>
          </Panel>
          <ResizeHandle className="mt-1 mb-1" disabled={isProjectedPreviewCollapsed} />
          <Panel
            ref={bottomPanelRef}
            defaultSize={(previewSplitSize ?? 60) > 0 ? 100 - (previewSplitSize ?? 60) : 40}
            minSize={
              previewPanelCollapseMode === "tabsAndPreviewCollapsed"
                ? collapsedBottomSize
                : previewPanelCollapseMode === "previewCollapsed"
                  ? previewCollapsedBottomSize
                  : bottomMinSize
            }
          >
            <div className="d-flex flex-column h-100">
              <div className="projecting-formats-container" ref={formatsContainerRef}>
                <ul className="nav nav-tabs preview-tabs-measure" ref={tabsMeasureRef} aria-hidden="true">
                  {previewTabs.map((tab) => (
                    <li className="nav-item" key={`measure-${tab.id}`}>
                      <span className="nav-link">{tab.label}</span>
                    </li>
                  ))}
                </ul>
                <div className="projecting-tabs-row" ref={tabsRowRef}>
                  <ul className={`nav nav-tabs flex-grow-1${isTabIconMode ? " preview-tabs-icons" : ""}`} ref={tabsNavRef}>
                    {previewTabs.map((tab) => (
                      <li className="nav-item" key={tab.id}>
                        <a
                          className={`nav-link ${activeTab === tab.id ? "active" : ""}`}
                          href="#"
                          aria-label={tab.label}
                          title={tab.label}
                          onClick={(e) => {
                            e.preventDefault();
                            handleTabChange(tab.id);
                          }}
                        >
                          <i className={`preview-tab-icon ${tab.iconClass}`} aria-hidden="true" />
                          <span className="preview-tab-label">{tab.label}</span>
                        </a>
                      </li>
                    ))}
                  </ul>
                  <button
                    type="button"
                    className={`btn btn-light preview-layout-cycle-btn ${previewPanelCollapseMode !== "expanded" ? "btn-active" : ""}`}
                    title={previewPanelCollapseTitle}
                    aria-label={previewPanelCollapseAriaLabel}
                    onClick={cyclePreviewPanelCollapseMode}
                  >
                    <i className={previewPanelCollapseIconClass} aria-hidden="true" />
                  </button>
                </div>
                {!isTabContentCollapsed && (
                  <div className="tab-content p-2 border border-top-0 preview-tab-content" ref={tabContentRef}>
                    {renderTabContent()}
                  </div>
                )}
              </div>
              {!isProjectedPreviewCollapsed && (
                <div
                  className={`flex-grow-1 preview-display-container${flashOverlay ? ` preview-display-container-flash preview-display-container-flash-${flashOverlay}` : ""}`}
                  ref={containerRefCallback}
                >
                  {previewDataUrl ? (
                    <div
                      ref={previewWrapperRef}
                      className={`preview-image-wrapper${flashOverlay ? " preview-image-wrapper-hidden" : ""}`}
                      onClick={handlePreviewWrapperClick}
                      onContextMenu={handlePreviewContextMenu}
                      title={!settings?.qrCodeInPreview && qrRawUrl ? tt("preview_no_qrcode") : undefined}
                    >
                      <img src={previewDataUrl} alt="Section Preview" className="preview-display-image" />
                      {settings?.qrCodeInPreview && qrCodeUrl && (
                        <div
                          ref={qrOverlayRef}
                          className={`qr-code-overlay${isQrDragging ? " dragging" : ""}`}
                          onClick={(e) => {
                            // Keep overlay interactions from triggering wrapper toggle.
                            e.stopPropagation();
                            if (suppressQrClickRef.current) {
                              return;
                            }
                            const bounds = (e.currentTarget as HTMLDivElement).getBoundingClientRect();
                            openQrContextMenuAt(bounds.left + bounds.width / 2, bounds.bottom + 8);
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
                    <div ref={qrContextMenuRef} className="qr-context-menu">
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
              )}
            </div>
          </Panel>
        </PanelGroup>
      </div>
    );
  }
);

PreviewPanel.displayName = "PreviewPanel";

export default PreviewPanel;
