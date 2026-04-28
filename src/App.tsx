import React, { useState, useEffect, useRef, useCallback, Suspense, lazy } from "react";
import { DndProvider } from "react-dnd";
import { HTML5Backend } from "react-dnd-html5-backend";
import { Panel, PanelGroup } from "react-resizable-panels";
import LeftPanel, { LeftPanelMethods } from "./components/LeftPanel";
import { PlaylistSelectionEvent } from "./components/PlaylistPanel";
import PreviewPanel, { PreviewPanelMethods } from "./components/PreviewPanel";
import EditorPanel from "./components/EditorPanel";
import Toolbar from "./components/Toolbar";
import MessageBox from "./components/MessageBox";
import { useWindowWidth } from "./hooks/useWindowWidth";
import { useOrientation } from "./hooks/useOrientation";
import ResizeHandle from "./components/ResizeHandle";

import EulaDialog, { EULA_DATE } from "./components/EulaDialog";

// Lazy-loaded dialogs (not needed on initial render)
const SettingsForm = lazy(() => import("./components/SettingsForm"));
const DBSyncDialog = lazy(() => import("./components/DBSyncDialog"));
const SessionsForm = lazy(() => import("./components/SessionsForm"));
const SongImporterWizard = lazy(() => import("./components/SongImporterWizard/SongImporterWizard").then((m) => ({ default: m.SongImporterWizard })));
const CompareDialog = lazy(() => import("./components/CompareDialog"));
const SongCheckDialog = lazy(() => import("./components/SongCheckDialog"));

import { Song } from "../db-common/Song";
import { PlaylistEntry } from "../db-common/PlaylistEntry";
import { Playlist } from "../db-common/Playlist";
import { Leader } from "../db-common/Leader";
import { SettingsProvider } from "./contexts/SettingsContext";
import { LeaderProvider, useLeader } from "./contexts/LeaderContext";
import { AuthProvider, useAuth } from "./contexts/AuthContext";
import { ThemeProvider } from "./contexts/ThemeContext";
import { MessageBoxProvider, MessageBoxConfig, useMessageBox } from "./contexts/MessageBoxContext";
import { UpdateProvider } from "./contexts/UpdateContext";
import { LocalizationProvider } from "./localization/LocalizationContext";
import { TooltipProvider } from "./localization/TooltipContext";
import { ToastProvider, useToast } from "./contexts/ToastContext";
import { ResponsiveFontSizeManager } from "./components/ResponsiveFontSizeManager";
import { UpdateNotification } from "./components/UpdateNotification";
import "./styles.css";
import {
  useEditedSong,
  useProjectedSong,
  setEditedSong,
  setProjectedSong,
  getEditedSong,
  getProjectedSong,
  updateEditedSong,
  getCurrentDisplay,
  updateCurrentDisplay,
  subscribeCurrentDisplayChange,
} from "./state/CurrentSongStore";
import { useSettings } from "./hooks/useSettings";
import { useSessionUrl } from "./hooks/useSessionUrl";
import { useWakeLock } from "./hooks/useWakeLock";
import { useLocalization } from "./localization/LocalizationContext";
import { cloudApi } from "./../common/cloudApi";
import { cloudApiHost } from "./config";
import { Display, PlaylistEntry as DisplayPlaylistEntry, SongFound, SongDBEntryWithData, LeaderDBProfile } from "../common/pp-types";
import * as t from "io-ts";
import { isRight } from "fp-ts/lib/Either";
import { DisplayUpdateRequest, WindowBounds } from "./types/electron";
import { Settings } from "./types";
import { enqueue } from "./utils/asyncQueue";
import { Database, FormatFoundReason } from "../db-common/Database";
import type { ImportDecision } from "./components/CompareDialog";
import { databaseStorage } from "../db-common/DatabaseStorage";
import { normalizeImportedDatabase, compressDatabaseToZip, DatabaseExportEnvelope } from "./services/DatabaseImportNormalizer";
import { formatLocalDateLabel } from "../common/date-only";
import { getEmptyDisplay } from "../common/pp-utils";
import { parseAndDecode } from "../common/io-utils";
import { initHostDevicePpd, isHostDevicePpdAvailable, startHostDeviceWatching, stopHostDeviceWatching } from "./services/hostDevicePpd";

type LeadersResponse = LeaderDBProfile[];
type PanelType = "side" | "editor" | "preview";

// App state persistence codec for io-ts validation
const AppStateCodec = t.type({
  selectedSongId: t.union([t.string, t.null]),
  selectedPlaylistIndex: t.number,
  selectedSectionIndex: t.number,
  // Song filter text
  songFilter: t.union([t.string, t.undefined]),
  // Active panel in paging mode
  activePanel: t.union([t.literal("side"), t.literal("editor"), t.literal("preview"), t.undefined]),
  // Panel layout state - named properties for clarity
  leftPanelSize: t.union([t.number, t.undefined]),
  editorPanelSize: t.union([t.number, t.undefined]),
  previewPanelSize: t.union([t.number, t.undefined]),
  playlistPanelSize: t.union([t.number, t.undefined]),
  songListPanelSize: t.union([t.number, t.undefined]),
  previewSplitSize: t.union([t.number, t.undefined]),
  previewTab: t.union([t.literal("format"), t.literal("image"), t.literal("message"), t.undefined]),
  // Window bounds for electron
  windowBounds: t.union([
    t.type({
      x: t.number,
      y: t.number,
      width: t.number,
      height: t.number,
      isMaximized: t.boolean,
    }),
    t.undefined,
  ]),
});

// App state persistence interface (derived from codec)
type AppState = t.TypeOf<typeof AppStateCodec>;

const APP_STATE_KEY = "pp-state";

// Load state synchronously to have values ready before first render
const getInitialAppState = (): AppState | null => {
  try {
    const stored = localStorage.getItem(APP_STATE_KEY);
    if (stored) {
      const parsed = JSON.parse(stored);
      const validation = AppStateCodec.decode(parsed);
      if (isRight(validation)) {
        return validation.right;
      }
    }
  } catch {
    // Ignore parse errors
  }
  return null;
};

// Cache the initial state for use in useState initializers
const initialAppState = getInitialAppState();

const loadAppState = (): AppState | null => {
  try {
    const stored = localStorage.getItem(APP_STATE_KEY);
    if (stored) {
      const parsed = JSON.parse(stored);
      const validation = AppStateCodec.decode(parsed);
      if (isRight(validation)) {
        return validation.right;
      }
      // Invalid structure, return null
      return null;
    }
  } catch {
    // Ignore parse errors
  }
  return null;
};

const saveAppState = (state: AppState): void => {
  try {
    localStorage.setItem(APP_STATE_KEY, JSON.stringify(state));
  } catch {
    // Ignore storage errors
  }
};

/**
 * Collect leaders that have a scheduled playlist for today (matching C# CollectScheduledLeaders).
 * Returns a Map<leaderId, Playlist>.
 */
function collectScheduledLeaders(): Map<string, Playlist> {
  const db = Database.getInstance();
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const dayMs = 24 * 60 * 60 * 1000; // 1 day in ms

  const result = new Map<string, Playlist>();
  for (const leader of db.getAllLeaders()) {
    const playlist = leader.getPlaylist(today, dayMs);
    if (playlist) {
      result.set(leader.id, playlist);
    }
  }
  return result;
}

const AppContent: React.FC = () => {
  const width = useWindowWidth();
  const orientation = useOrientation();
  const { settings, syncToBackend, updateSetting, updateSettingWithAutoSave } = useSettings();
  const { selectedLeader, guestLeaderId } = useLeader();
  const { loadInitialCredentials, isAuthenticated, isGuest, isLoading: isAuthLoading } = useAuth();
  const { t } = useLocalization();
  const { showToast } = useToast();
  const hasSyncedSettingsRef = useRef(false);

  // Auto-fallback from Typesense to traditional search on connectivity failure
  const fallbackFiredRef = useRef(false);
  useEffect(() => {
    fallbackFiredRef.current = settings?.searchMethod === "typesense" ? false : true;
  }, [settings?.searchMethod]);
  useEffect(() => {
    const handleFallback = () => {
      if (fallbackFiredRef.current) return;
      fallbackFiredRef.current = true;
      updateSettingWithAutoSave("searchMethod", "traditional");
      showToast(t("TypesenseFallbackToast"), "warning");
    };
    window.addEventListener("pp-typesense-fallback", handleFallback);
    return () => window.removeEventListener("pp-typesense-fallback", handleFallback);
  }, [updateSettingWithAutoSave, showToast, t]);

  // F11 fullscreen toggle (browser/webapp mode)
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      // Electron handles F11 in main process, so ignore in renderer
      if (e.key === "F11" && !window.electronAPI) {
        e.preventDefault();
        if (document.fullscreenElement) {
          document.exitFullscreen?.().catch(() => {});
        } else {
          document.documentElement.requestFullscreen?.().catch(() => {});
        }
      }
    };
    // Only add browser-side handler when Electron API is not available
    // (Electron handles F11 via before-input-event in main process)
    if (!window.electronAPI) {
      window.addEventListener("keydown", handleKeyDown);
      return () => window.removeEventListener("keydown", handleKeyDown);
    }
  }, []);

  const applyFullscreenSetting = useCallback(async (enabled: boolean) => {
    const hostDevice = window.hostDevice;
    if (hostDevice?.setFullScreen) {
      try {
        const current = hostDevice.isFullScreen ? await hostDevice.isFullScreen() : undefined;
        if (current !== enabled) {
          await hostDevice.setFullScreen(enabled);
        }
      } catch (error) {
        console.warn("[Fullscreen] hostDevice apply failed:", error);
      }
      return;
    }

    try {
      if (enabled) {
        if (!document.fullscreenElement) {
          await document.documentElement.requestFullscreen?.();
        }
      } else if (document.fullscreenElement) {
        await document.exitFullscreen?.();
      }
    } catch (error) {
      console.warn("[Fullscreen] browser apply failed:", error);
    }
  }, []);

  useEffect(() => {
    if (typeof settings?.fullscreen !== "boolean") return;
    void applyFullscreenSetting(settings.fullscreen);
  }, [settings?.fullscreen, applyFullscreenSetting]);

  // In webapp mode, request projector window close when main window/tab is closed.
  // Keep this at App level so it survives PreviewPanel unmount/remount cycles.
  useEffect(() => {
    if (window.electronAPI) return;

    const channel = new BroadcastChannel("pp-projector");
    const closeProjectorWindow = () => {
      channel.postMessage({ type: "PROJECTOR_CLOSE" });
    };

    window.addEventListener("beforeunload", closeProjectorWindow);
    window.addEventListener("pagehide", closeProjectorWindow);

    return () => {
      window.removeEventListener("beforeunload", closeProjectorWindow);
      window.removeEventListener("pagehide", closeProjectorWindow);
      channel.close();
    };
  }, []);

  // Prevent screen from sleeping when keepAwake is enabled (browser Wake Lock API)
  useWakeLock(settings?.keepAwake ?? false);

  // Sync settings to backend only on initial load
  useEffect(() => {
    if (!settings || hasSyncedSettingsRef.current) return;
    syncToBackend();
    hasSyncedSettingsRef.current = true;
  }, [settings, syncToBackend]);

  // Open EULA viewer when requested from About page
  useEffect(() => {
    const handler = () => setShowEulaView(true);
    window.addEventListener("pp-open-eula-dialog", handler);
    return () => window.removeEventListener("pp-open-eula-dialog", handler);
  }, []);

  // Load saved credentials on mount
  useEffect(() => {
    loadInitialCredentials();
  }, [loadInitialCredentials]);

  const [activePanel, setActivePanel] = useState<PanelType>(initialAppState?.activePanel ?? "side");
  const [showSettings, setShowSettings] = useState(false);
  const [settingsInitialTab, setSettingsInitialTab] = useState<string | null>(null);
  const [settingsInitialLeaderId, setSettingsInitialLeaderId] = useState<string | null>(null);
  const [showImportWizard, setShowImportWizard] = useState(false);
  const [importWizardInitialFiles, setImportWizardInitialFiles] = useState<File[] | null>(null);
  const [showDBSync, setShowDBSync] = useState(false);
  const [remoteChangeCount, setRemoteChangeCount] = useState(0);
  // CompareDialog state for similarity check when saving new songs
  const [compareDialogState, setCompareDialogState] = useState<{
    song: Song;
    similarSongs: Song[];
    onDecision: (decision: ImportDecision) => void;
  } | null>(null);
  const [showSessionsForm, setShowSessionsForm] = useState(false);
  const [showSongCheck, setShowSongCheck] = useState(false);
  const [isImporting, setIsImporting] = useState(false); // Loading state for database import
  const [eulaAccepted, setEulaAccepted] = useState(() => localStorage.getItem("pp-eula-accepted") === EULA_DATE);
  const [showEulaView, setShowEulaView] = useState(false);
  const [playlistSelection, setPlaylistSelection] = useState<PlaylistSelectionEvent | null>(null);
  const selectedPlaylistItem = playlistSelection?.item ?? null;
  const selectedPlaylistIndex = playlistSelection?.index ?? -1;
  const playlistSelectionSourceRef = useRef<PlaylistSelectionEvent["source"]>("programmatic");
  const keyboardSelectionTimerRef = useRef<number | null>(null);
  const latestKeyboardSelectionRef = useRef<PlaylistSelectionEvent | null>(null);
  const isArrowKeyHeldRef = useRef(false);
  const playlistLoadTargetSongIdRef = useRef<string | null>(null);
  const pendingPlaylistSelectionIndexRef = useRef<number | null>(null);
  const [isEditing, setIsEditing] = useState(false);
  const [_editorInitialized, setEditorInitialized] = useState(false);
  // Remote highlight controller state - matching C# ProjectorForm.sectionListBox.Remote
  const [remoteHighlightController, setRemoteHighlightController] = useState<string>("");
  // Session watching mode state - matching C# ProjectorForm.watchedSessionOrDeviceId and related
  const [watchedSessionId, setWatchedSessionId] = useState<string | null>(null);
  const [_watchedSessionUrl, setWatchedSessionUrl] = useState<string | null>(null);
  const [watchedPlaylist, setWatchedPlaylist] = useState<Playlist | null>(null);
  const watchPollingAbortRef = useRef<AbortController | null>(null);
  const selectedLeaderRef = useRef<Leader | null>(selectedLeader);
  const settingsRef = useRef<Settings | null>(settings);
  const isWatching = watchedSessionId !== null;
  const previewPanelRef = useRef<PreviewPanelMethods>(null);
  const syncDeclinedAtRef = useRef<number | null>(null);
  const leftPanelRef = useRef<LeftPanelMethods>(null);
  const editorPanelRef = useRef<EditorPanel>(null);
  const editedSong = useEditedSong();
  const projectedSong = useProjectedSong();
  const [currentSongText, updateCurrentSongText] = useState<string>("");
  const { showConfirm, showConfirmAsync, showYesNoCancelAsync, showMessage } = useMessageBox();

  const openSettings = useCallback((initialTab?: string | null) => {
    setSettingsInitialTab(initialTab ?? null);
    setSettingsInitialLeaderId(null);
    setShowSettings(true);
  }, []);

  const openLeaderSettings = useCallback((leaderId: string | null) => {
    setSettingsInitialTab("leaders");
    setSettingsInitialLeaderId(leaderId);
    setShowSettings(true);
  }, []);

  const closeSettings = useCallback(() => {
    const database = Database.getInstance();
    database.verifySearchEngine(settingsRef.current);
    setShowSettings(false);
    setSettingsInitialTab(null);
    setSettingsInitialLeaderId(null);
  }, []);

  useEffect(() => {
    const database = Database.getInstance();
    if (database) database.typesenseEngineEnabled = !showSettings;
    return () => {
      const database = Database.getInstance();
      if (database) database.typesenseEngineEnabled = true;
    };
  }, [showSettings]);

  useEffect(() => {
    selectedLeaderRef.current = selectedLeader;
  }, [selectedLeader]);

  useEffect(() => {
    settingsRef.current = settings;
  }, [settings]);

  // Track selected song ID for state persistence - initialized to null, restored after database loads
  const [_selectedSongId, setSelectedSongId] = useState<string | null>(null);
  // Track selected section index for state persistence
  const [selectedSectionIndex, setSelectedSectionIndex] = useState(-1);
  // Store pending section index to restore after sections are ready
  const pendingSectionIndexRef = useRef<number>(-1);
  // Track the target section index we're restoring to (to verify state update completed)
  const restoredSectionIndexRef = useRef<number>(-1);
  // Flag to prevent saving state during initial restore - starts TRUE to block saves until restore completes
  const isRestoringStateRef = useRef(true);
  // Flag to track if initial state restore has been done
  const hasRestoredStateRef = useRef(false);

  // Snapshot of scheduled leaders before sync starts (matching C# SyncDatabase prev/actual pattern)
  const preSyncScheduledLeadersRef = useRef<Map<string, Playlist>>(new Map());

  // Persist updateable leaders across sync sessions
  const updateableLeadersRef = useRef<Set<string>>(new Set());

  // Panel layout state for persistence - use initial cached state for first render
  const [leftPanelSize, setLeftPanelSize] = useState<number>(initialAppState?.leftPanelSize ?? 25);
  const [editorPanelSize, setEditorPanelSize] = useState<number>(initialAppState?.editorPanelSize ?? 45);
  const [previewPanelSize, setPreviewPanelSize] = useState<number>(initialAppState?.previewPanelSize ?? 30);
  const [playlistPanelSize, setPlaylistPanelSize] = useState<number>(initialAppState?.playlistPanelSize ?? 60);
  const [songListPanelSize, setSongListPanelSize] = useState<number>(initialAppState?.songListPanelSize ?? 40);
  const [previewSplitSize, setPreviewSplitSize] = useState<number>(initialAppState?.previewSplitSize ?? 60);
  const [previewTab, setPreviewTab] = useState<"format" | "image" | "message">(initialAppState?.previewTab ?? "format");
  const lastScheduledDisplayRef = useRef<Display>(getEmptyDisplay());

  // Song filter state for persistence
  const [songFilter, setSongFilter] = useState<string>(initialAppState?.songFilter ?? "");

  // Mirror the C# window title behavior: default title + webserver URL, or watch mode when observing another session
  const localUrl = useSessionUrl("local");

  useEffect(() => {
    const baseTitle = t("DefaultTitle");

    if (isWatching) {
      document.title = t("WatchingExternalSessionTitle") || baseTitle;
      return;
    }

    document.title = window.electronAPI && localUrl ? `${baseTitle} (${localUrl})` : baseTitle;
  }, [isWatching, localUrl, t]);

  // Restore window bounds from localStorage on mount (doesn't depend on database)
  useEffect(() => {
    const savedState = loadAppState();
    if (savedState?.windowBounds && window.electronAPI?.setWindowBounds) {
      window.electronAPI.setWindowBounds(savedState.windowBounds);
    }
  }, []);

  // Save app state to localStorage on changes
  useEffect(() => {
    if (isRestoringStateRef.current) {
      return;
    }

    const state: AppState = {
      selectedSongId: editedSong?.Id || null,
      selectedPlaylistIndex: selectedPlaylistIndex,
      selectedSectionIndex: selectedSectionIndex,
      songFilter: songFilter,
      activePanel: activePanel,
      leftPanelSize: leftPanelSize,
      editorPanelSize: editorPanelSize,
      previewPanelSize: previewPanelSize,
      playlistPanelSize: playlistPanelSize,
      songListPanelSize: songListPanelSize,
      previewSplitSize: previewSplitSize,
      previewTab: previewTab,
      windowBounds: undefined, // Will be set on beforeunload
    };
    saveAppState(state);
  }, [
    editedSong?.Id,
    selectedPlaylistIndex,
    selectedSectionIndex,
    songFilter,
    activePanel,
    leftPanelSize,
    editorPanelSize,
    previewPanelSize,
    playlistPanelSize,
    songListPanelSize,
    previewSplitSize,
    previewTab,
  ]);

  // Save app state before window closes (to capture final section selection and window bounds)
  useEffect(() => {
    const handleBeforeUnload = async () => {
      // Get window bounds in electron mode
      let windowBounds: WindowBounds | undefined = undefined;
      if (window.electronAPI?.getWindowBounds) {
        const bounds = await window.electronAPI.getWindowBounds();
        if (bounds) windowBounds = bounds;
      }

      const state: AppState = {
        selectedSongId: getEditedSong()?.Id || null,
        selectedPlaylistIndex: selectedPlaylistIndex,
        selectedSectionIndex: previewPanelRef.current?.getSelectedSectionIndex() ?? -1,
        songFilter: songFilter,
        activePanel: activePanel,
        leftPanelSize: leftPanelSize,
        editorPanelSize: editorPanelSize,
        previewPanelSize: previewPanelSize,
        playlistPanelSize: playlistPanelSize,
        songListPanelSize: songListPanelSize,
        previewSplitSize: previewSplitSize,
        previewTab: previewTab,
        windowBounds,
      };
      saveAppState(state);
    };

    window.addEventListener("beforeunload", handleBeforeUnload);
    return () => window.removeEventListener("beforeunload", handleBeforeUnload);
  }, [
    selectedPlaylistIndex,
    songFilter,
    activePanel,
    leftPanelSize,
    editorPanelSize,
    previewPanelSize,
    playlistPanelSize,
    songListPanelSize,
    previewSplitSize,
    previewTab,
  ]);

  // Notify the user exactly once if the database fails to persist (storage full / IndexedDB unavailable)
  // Uses window event instead of instance emitter because Database.switchUser() creates a new instance.
  const saveErrorNotifiedRef = useRef(false);
  useEffect(() => {
    const handleSaveError = () => {
      if (saveErrorNotifiedRef.current) return;
      saveErrorNotifiedRef.current = true;
      showMessage(t("StorageSaveErrorTitle"), t("StorageSaveErrorMessage"));
    };
    window.addEventListener("pp-db-save-error", handleSaveError);
    return () => {
      window.removeEventListener("pp-db-save-error", handleSaveError);
    };
  }, [showMessage, t]);

  // Wrapper for playlist selection change.
  // Keyboard events are debounced here so cross-panel updates only fire
  // after selection activity calms down (single debounce point).
  const KEYBOARD_SELECTION_DEBOUNCE_MS = 30;
  const applyPlaylistSelection = useCallback((selection: PlaylistSelectionEvent) => {
    playlistSelectionSourceRef.current = selection.source;
    setPlaylistSelection(selection);

    // Also update song tree to show the same song (visual consistency)
    // But NOT during restoration - we restore to savedState.selectedSongId instead
    if (selection.item && !isRestoringStateRef.current) {
      leftPanelRef.current?.setSelectedSongId(selection.item.songId);
      // Auto-select first section when user selects a new playlist item from UI
      setSelectedSectionIndex(0);
      previewPanelRef.current?.setSelectedSectionIndex(0);
    }
  }, []);

  const flushPendingKeyboardSelection = useCallback(() => {
    const pendingSelection = latestKeyboardSelectionRef.current;
    if (!pendingSelection) {
      return;
    }

    latestKeyboardSelectionRef.current = null;
    applyPlaylistSelection(pendingSelection);
  }, [applyPlaylistSelection]);

  const handlePlaylistSelectionChange = useCallback(
    (selection: PlaylistSelectionEvent) => {
      if (selection.source === "keyboard") {
        latestKeyboardSelectionRef.current = selection;

        // Debounce keyboard events — only update state once selection rests
        if (keyboardSelectionTimerRef.current !== null) {
          window.clearTimeout(keyboardSelectionTimerRef.current);
        }
        keyboardSelectionTimerRef.current = window.setTimeout(() => {
          keyboardSelectionTimerRef.current = null;

          // During key hold, keep buffering and wait for keyup to flush.
          if (isArrowKeyHeldRef.current) {
            return;
          }

          flushPendingKeyboardSelection();
        }, KEYBOARD_SELECTION_DEBOUNCE_MS);
        return;
      }

      // Mouse/programmatic: apply immediately
      if (keyboardSelectionTimerRef.current !== null) {
        window.clearTimeout(keyboardSelectionTimerRef.current);
        keyboardSelectionTimerRef.current = null;
      }
      latestKeyboardSelectionRef.current = null;
      applyPlaylistSelection(selection);
    },
    [applyPlaylistSelection, flushPendingKeyboardSelection]
  );

  useEffect(() => {
    const isArrowNavigationKey = (key: string) => key === "ArrowUp" || key === "ArrowDown";

    const handleKeyDown = (event: KeyboardEvent) => {
      if (!isArrowNavigationKey(event.key)) {
        return;
      }
      isArrowKeyHeldRef.current = true;
    };

    const flushAfterKeyRelease = () => {
      isArrowKeyHeldRef.current = false;

      if (keyboardSelectionTimerRef.current !== null) {
        window.clearTimeout(keyboardSelectionTimerRef.current);
        keyboardSelectionTimerRef.current = null;
      }

      flushPendingKeyboardSelection();
    };

    const handleKeyUp = (event: KeyboardEvent) => {
      if (!isArrowNavigationKey(event.key)) {
        return;
      }
      flushAfterKeyRelease();
    };

    const handleWindowBlur = () => {
      flushAfterKeyRelease();
    };

    window.addEventListener("keydown", handleKeyDown);
    window.addEventListener("keyup", handleKeyUp);
    window.addEventListener("blur", handleWindowBlur);

    return () => {
      window.removeEventListener("keydown", handleKeyDown);
      window.removeEventListener("keyup", handleKeyUp);
      window.removeEventListener("blur", handleWindowBlur);

      if (keyboardSelectionTimerRef.current !== null) {
        window.clearTimeout(keyboardSelectionTimerRef.current);
        keyboardSelectionTimerRef.current = null;
      }
    };
  }, [flushPendingKeyboardSelection]);

  // Callback when playlist is loaded - used for state restoration
  const handlePlaylistLoaded = useCallback((itemCount: number) => {
    console.info("App", `Playlist loaded with ${itemCount} items`);
  }, []);

  useEffect(() => {
    if (!settings?.externalWebDisplayEnabled || !settings.stylesToClients || !settings.chordProStyles) return;
    const leaderId = isGuest ? guestLeaderId : settings.selectedLeader;
    if (!leaderId) return;

    cloudApi
      .sendDisplayStylesUpdate({
        leaderId,
        chordProStyles: settings.chordProStyles,
      })
      .catch((err) => console.error("Cloud display styles update failed:", err));
  }, [settings?.externalWebDisplayEnabled, settings?.stylesToClients, settings?.selectedLeader, settings?.chordProStyles, isGuest, guestLeaderId]);

  useEffect(() => {
    if (pendingPlaylistSelectionIndexRef.current === null || !leftPanelRef.current) {
      return;
    }

    leftPanelRef.current.setPlaylistSelection({
      index: pendingPlaylistSelectionIndexRef.current,
      emitChange: true,
    });
    pendingPlaylistSelectionIndexRef.current = null;
  });

  const syncCurrentDisplayToBackend = useCallback(
    (display: Display) => {
      // Update ref to track the most recently scheduled display
      lastScheduledDisplayRef.current = display;

      const update = () => {
        // Only send if no newer display has been scheduled since this timeout was set
        if (display !== lastScheduledDisplayRef.current) {
          console.debug("API", "Skipping stale display update");
          return;
        }

        if (window.electronAPI?.setCurrentDisplay) {
          console.debug("API", "Syncing display to backend");
          window.electronAPI.setCurrentDisplay(display);
        }

        // Send display update to cloud when external web display is enabled
        if (settings?.externalWebDisplayEnabled && (isGuest || settings.selectedLeader)) {
          cloudApi
            .sendDisplayUpdate({
              songId: display.songId,
              from: display.from,
              to: display.to,
              transpose: display.transpose,
              leaderId: isGuest ? guestLeaderId : settings.selectedLeader,
              playlist: display.playlist,
              song: display.song,
              message: display.message,
              instructions: display.instructions,
            })
            .catch((err) => console.error("Cloud display update failed:", err));
        }
      };
      setTimeout(update, 50);
    },
    [settings?.externalWebDisplayEnabled, settings?.selectedLeader, isGuest, guestLeaderId]
  );

  // Subscribe to global display changes and sync to backend
  useEffect(() => {
    return subscribeCurrentDisplayChange((display) => {
      syncCurrentDisplayToBackend(display);
    });
  }, [syncCurrentDisplayToBackend]);

  // Callback when sections are generated - used for state restoration
  const handleSectionsReady = useCallback((sectionCount: number, autoSelectedIndex: number) => {
    // Check if we have a pending section index to restore
    const pendingIndex = pendingSectionIndexRef.current;
    if (pendingIndex >= 0 && pendingIndex < sectionCount) {
      previewPanelRef.current?.setSelectedSectionIndex(pendingIndex);
      setSelectedSectionIndex(pendingIndex);
      restoredSectionIndexRef.current = pendingIndex; // Track target for state verification
      pendingSectionIndexRef.current = -1; // Clear pending
      // Note: isRestoringStateRef will be cleared in useEffect after state updates
    } else if (isRestoringStateRef.current) {
      // Restoring but no pending section to restore (savedState had no section selected)
      // — clear the flag so the app becomes fully interactive
      isRestoringStateRef.current = false;
    } else if (autoSelectedIndex >= 0) {
      setSelectedSectionIndex(autoSelectedIndex);
    }
  }, []);

  // Clear isRestoringStateRef after section selection has been restored
  // This must be a separate effect to ensure state has been updated before allowing saves
  useEffect(() => {
    // Only clear when:
    // 1. We're still in restoring mode
    // 2. Pending section has been applied (pendingRef is -1)
    // 3. We have a target section to restore (restoredSectionIndexRef >= 0)
    // 4. The actual state matches the target (React state update has completed)
    if (
      isRestoringStateRef.current &&
      pendingSectionIndexRef.current < 0 &&
      restoredSectionIndexRef.current >= 0 &&
      selectedSectionIndex === restoredSectionIndexRef.current
    ) {
      restoredSectionIndexRef.current = -1; // Clear target
      isRestoringStateRef.current = false;
    }
  }, [selectedSectionIndex]);

  // Callback when section selection changes in PreviewPanel
  const handleSelectedSectionIndexChange = useCallback((index: number) => {
    // Don't allow PreviewPanel to override section during restoration
    if (isRestoringStateRef.current) {
      return;
    }
    setSelectedSectionIndex(index);
  }, []);

  // Get original song text from database (single source of truth)
  // For new songs (not yet in DB), returns "" so any typed content is detected as a change.
  const getOriginalSongText = useCallback((): string | undefined => {
    const song = getEditedSong();
    if (!song) return undefined;
    const db = Database.getInstance();
    return db.getSongById(song.Id)?.Text ?? "";
  }, []);

  // Check if current song text differs from database version
  const checkCanSaveSong = useCallback((): boolean => {
    const song = getEditedSong();
    if (!song) return false;
    const db = Database.getInstance();
    const dbSong = db.getSongById(song.Id);
    // If song is not in database (new song), check if it has been modified from the initial prompt
    if (!dbSong) {
      // New song - consider it "dirty" if it has real content beyond just whitespace
      const hasContent = song.Text.trim().length > 0;
      return hasContent;
    }
    const isDifferent = song.Text !== dbSong.Text;
    return isDifferent;
  }, []);

  // Memoized version for UI (toolbar button state)
  const _triggerRecalc = currentSongText;
  const canSaveSong = editedSong ? checkCanSaveSong() : false;

  // Load button: enabled when a song is loaded
  const canLoadSong = !!editedSong;

  // Handle line selection from editor (matching C# Editor_LineSel)
  const handleLineSelect = (lineNumber: number) => {
    const editedSong = getEditedSong();
    const projectedSong = getProjectedSong();
    // Only call onLineSelect if edited and projected songs are the same
    if (settings?.sectionSelByEditorLineSel && editedSong?.Id === projectedSong?.Id) {
      if (previewPanelRef.current) {
        previewPanelRef.current.selectSectionByLine(lineNumber);
        previewPanelRef.current.setSectionListFocused();
      }
    }
  };

  // Initialize ChordPro editor and database on mount, then restore app state
  // Wait for auth loading to complete before accessing database (auth may switch users)
  useEffect(() => {
    // Don't run until auth loading is complete
    if (isAuthLoading) {
      return;
    }

    const initializeAndLoad = async () => {
      // Guard against React Strict Mode double-execution - check BEFORE any await
      // If we've already started restoring, don't do anything on the second run
      if (hasRestoredStateRef.current) {
        return;
      }
      // Mark immediately to prevent second Strict Mode call from proceeding
      hasRestoredStateRef.current = true;

      // Wait for database to be ready
      const db = await Database.waitForReady();

      // Database will be loaded with known chord modifiers when editor is ready
      // This happens in EditorPanel's handleWysiwygLoad
      console.info("App", `Database ready with ${db.getSongs().length} songs`);
      setEditorInitialized(true);

      // Now restore app state from localStorage (after database is ready)
      const savedState = loadAppState();

      if (savedState) {
        // isRestoringStateRef already true from initialization

        // Store pending section index to restore via callback when sections are ready
        if (savedState.selectedSectionIndex >= 0) {
          pendingSectionIndexRef.current = savedState.selectedSectionIndex;
        }

        // Restore playlist selection through LeftPanel's imperative setter.
        // The actual song loading happens when the selection change callback fires.
        if (savedState.selectedPlaylistIndex >= 0) {
          pendingPlaylistSelectionIndexRef.current = savedState.selectedPlaylistIndex;

          // Also restore song tree selection and editor to the saved selectedSongId (may be different from playlist item)
          if (savedState.selectedSongId) {
            setSelectedSongId(savedState.selectedSongId);

            // Load the savedState.selectedSongId into the editor (not the playlist item's song)
            const editorSong = db.getSongById(savedState.selectedSongId);
            if (editorSong) {
              const clonedEditorSong = editorSong.clone();
              setEditedSong(clonedEditorSong);
              updateCurrentSongText(clonedEditorSong.Text);
            }

            // Use setTimeout to ensure leftPanelRef is ready after render
            setTimeout(() => {
              leftPanelRef.current?.setSelectedSongId(savedState.selectedSongId!);
            }, 100);
          }
        } else if (savedState.selectedSongId) {
          // Restore song selection only if no playlist item was selected
          const song = db.getSongById(savedState.selectedSongId);
          if (song) {
            const cloned = song.clone();
            setEditedSong(cloned);
            setProjectedSong(cloned);
            updateCurrentSongText(cloned.Text);
            setSelectedSongId(savedState.selectedSongId);
            setPlaylistSelection(null);
            // Also sync the song tree selection via ref
            leftPanelRef.current?.setSelectedSongId(savedState.selectedSongId);
          } else {
            // Song not found in database - clear the restoring flag
            isRestoringStateRef.current = false;
          }
        } else {
          // No song or playlist to restore - clear the restoring flag
          isRestoringStateRef.current = false;
        }

        // Note: isRestoringStateRef will be set to false in handleSectionsReady callback
        // when sections are generated for the restored song
      } else {
        // No saved state - allow saving
        isRestoringStateRef.current = false;
      }
    };

    initializeAndLoad();
  }, [isAuthLoading]);

  const remoteDisplayUpdateHandler = async (data: DisplayUpdateRequest) => {
    console.info("App", "Received remote display update", data);
    const db = Database.getInstance();
    const leader = selectedLeaderRef.current;
    const settings = settingsRef.current;

    const updateLeaderPreferenceFromPlaylist = (songId: string) => {
      if (!leader) return;
      const mode = settings?.leaderProfileUpdateMode || "allSources";
      if (mode !== "allSources") {
        console.debug("App", `Skipping profile update from remote playlist change (mode: ${mode})`);
        return;
      }
      const pref = leftPanelRef.current?.getPreferencesForSongId(songId);
      if (!pref) return;
      const song = db.getSongById(songId);
      const titleToSave = song && pref.title === song.Title ? "" : pref.title || "";
      leader.updatePreference(
        songId,
        {
          title: titleToSave,
          transpose: pref.transpose ?? 0,
          capo: pref.capo ?? -1,
          instructions: pref.instructions || "",
        },
        db
      );
      db.updateLeader(leader);
    };

    const updateLeaderPreferenceFromRequest = (request: DisplayUpdateRequest) => {
      if (!leader) return;
      // Check if this update source is allowed by the current settings
      const mode = settings?.leaderProfileUpdateMode || "allSources";
      if (mode !== "allSources") {
        // Don't update profile from client requests unless explicitly enabled.
        // uiChangesAlso means local UI only; allSources also includes remote clients.
        console.debug("App", `Skipping profile update from client request (mode: ${mode})`);
        return;
      }

      const song = db.getSongById(request.id);
      const titleToSave = song && request.title === song.Title ? "" : request.title || "";
      const transpose = request.transpose;
      const capo = request.capo;
      leader.updatePreference(request.id, { title: titleToSave, transpose, capo, instructions: request.instructions }, db);
      db.updateLeader(leader);
    };

    const currentDisplay = getCurrentDisplay();
    if (data.command === "song_update") {
      updateLeaderPreferenceFromRequest(data);
      const playlist = leftPanelRef.current?.updatePlaylistItemPreferences(data.id, data.transpose, data.capo, data.instructions);
      updateCurrentDisplay({
        transpose: data.transpose ?? currentDisplay.transpose,
        capo: data.capo ?? currentDisplay.capo,
        instructions: data.instructions ?? currentDisplay.instructions,
        playlist: playlist?.items ?? currentDisplay.playlist,
      });
      return;
    }
    if (data.command === "display_update") {
      if (data.playlist) {
        leftPanelRef.current?.updatePlaylist(data.playlist);
      } else if (currentDisplay.songId !== data.id) {
        const _db = Database.getInstance();
        const song = _db.getSongById(data.id);
        if (song) {
          setSelectedSectionIndex(-1);
          const selection = leftPanelRef.current?.setPlaylistSelection({ songId: song.Id, emitChange: false });
          if (selection?.item) {
            // Keep backend display state in sync for remote song changes.
            // Without this, Electron changeDisplay is not triggered until a section is selected.
            updateCurrentDisplay({
              songId: song.Id,
              song: song.Text,
              system: song.System,
              from: data.from ?? 0,
              to: data.to ?? 0,
              section: -1,
              transpose: data.transpose ?? selection.item.transpose ?? 0,
              capo: data.capo ?? selection.item.capo,
              instructions: data.instructions ?? selection.item.instructions,
            });

            // Set playlist item directly without auto-selecting first section
            setPlaylistSelection(selection);
            leftPanelRef.current?.setSelectedSongId(selection.item.songId);
          }
        }
      } else {
        // Same song - simulate user interaction: update preferences and select section
        // 1. Update playlist item preferences (transpose, capo, instructions)
        const playlist = leftPanelRef.current?.updatePlaylistItemPreferences(data.id, data.transpose, data.capo, data.instructions);
        updateLeaderPreferenceFromPlaylist(data.id);
        // 2. Select the section matching the requested line range - this drives
        //    PreviewPanel's updateDisplayState → updateCurrentDisplay → backend sync
        previewPanelRef.current?.selectSectionByLine(data.from);
        // 3. Ensure correct transpose/capo/instructions (selectedPlaylistItem props may be stale)
        updateCurrentDisplay({
          transpose: data.transpose ?? currentDisplay.transpose,
          capo: data.capo ?? currentDisplay.capo,
          instructions: data.instructions ?? currentDisplay.instructions,
          playlist: playlist?.items ?? currentDisplay.playlist,
        });
      }
    }
  };

  useEffect(() => {
    if (!window.electronAPI?.onRemoteDisplayUpdate) return;
    const unsubscribe = window.electronAPI.onRemoteDisplayUpdate((data) => {
      enqueue(() => remoteDisplayUpdateHandler(data));
    });
    return () => unsubscribe?.();
  }, []);

  // Set up general webserver API handler
  useEffect(() => {
    if (!window.electronAPI?.onWebserverApiRequest) {
      console.warn("App", "Electron API onWebserverApiRequest not available: cannot handle webserver API requests");
      return;
    }

    const handleWebserverApiRequest = async (apiRequest: {
      method: string;
      path: string;
      query: Record<string, unknown>;
      body: unknown;
      headers: Record<string, unknown>;
    }) => {
      console.debug("App", "Received webserver API request", apiRequest);
      try {
        const db = Database.getInstance();
        const leader = selectedLeaderRef.current;

        let response: { status?: number; data: unknown; headers?: Record<string, string> } = {
          status: 404,
          data: { error: "Not found" },
        };

        // Route handling
        if (apiRequest.method === "GET" && apiRequest.path === "/songs") {
          const songId = apiRequest.query.id as string;
          const songs = songId
            ? songId
                .split(",")
                .map((s) => db.getSongById(s))
                .filter((s) => s != null)
            : db.getSongs();

          const entries: SongDBEntryWithData[] = songs.map((song) => {
            const pref = leftPanelRef.current?.getPreferencesForSongId(song.Id) ?? leader?.getPreference(song.Id);
            return {
              ...song.toJSON(),
              title: pref?.title || song.Title,
              capo: pref?.capo == null || pref?.capo < 0 ? undefined : pref?.capo,
              transpose: pref?.transpose || undefined,
              instructions: pref?.instructions || undefined,
            };
          });

          response = {
            status: 200,
            data: entries,
            headers: { "Content-Type": "application/json" },
          };
        } else if (apiRequest.method === "GET" && apiRequest.path === "/leaders") {
          const data: LeadersResponse = db.getAllLeaders().map((leader) => leader.toJSON());
          response = {
            status: 200,
            data,
            headers: { "Content-Type": "application/json" },
          };
        } else if (apiRequest.method === "GET" && apiRequest.path === "/search") {
          const text = (apiRequest.query.text as string) || "";
          const limit = (apiRequest.query.limit as string) || "";
          const maxResults = limit ? parseInt(limit) : 30;
          const results = await db.filter(text, leader);
          const data: SongFound[] = results.slice(0, maxResults > 0 ? maxResults : undefined).map((found) => ({
            songId: found.song.Id,
            title: found.song.Title,
            found: { type: FormatFoundReason(found.reason), cost: found.cost },
          }));
          response = {
            status: 200,
            data,
            headers: { "Content-Type": "application/json" },
          };
        }
        // Add more routes here as needed...

        // Send response back to webserver
        window.electronAPI?.sendWebserverApiResponse?.(response);
      } catch (error) {
        console.error("API", "Error handling webserver API request", error);
        window.electronAPI?.sendWebserverApiResponse?.({
          status: 500,
          data: { error: "Internal server error" },
        });
      }
    };

    // Listen for general API requests
    const unsubscribe = window.electronAPI.onWebserverApiRequest(handleWebserverApiRequest);
    console.debug("App", "Webserver API request handler set up");
    // Cleanup listener on unmount
    return () => {
      unsubscribe?.();
    };
  }, []);

  // Initialize remote highlight controller state from backend (only once on mount)
  useEffect(() => {
    if (!window.electronAPI?.getRemoteHighlightController) return;

    window.electronAPI.getRemoteHighlightController().then((controller) => {
      setRemoteHighlightController(controller || "");
    });
  }, []);

  // Set up highlight access control handlers - matching C# HighlightAccessReqAsync/HighlightChangedRemotelyAsync
  useEffect(() => {
    if (!window.electronAPI) return;

    const unsubscribers: (() => void)[] = [];

    // Handle highlight access request - matching C# HighlightAccessVerify
    if (window.electronAPI.onHighlightAccessRequest) {
      const unsubscribe = window.electronAPI.onHighlightAccessRequest((data) => {
        // Show confirmation dialog - matching C# MessageBoxEx.Show with AskRemoteHighlightModifyPermission
        showConfirm(
          t("RemoteHighlight"),
          t("AskRemoteHighlightModifyPermission"),
          () => {
            // User granted access
            window.electronAPI?.respondHighlightAccess?.(data.clientId, true);
          },
          () => {
            // User denied access
            window.electronAPI?.respondHighlightAccess?.(data.clientId, false);
          },
          { confirmText: t("AllowRemoteControl") }
        );
      });
      unsubscribers.push(unsubscribe);
    }

    // Handle highlight line changes - matching C# RemoteChangeHighlightByLine
    if (window.electronAPI.onHighlightChanged) {
      const unsubscribe = window.electronAPI.onHighlightChanged((data) => {
        // Call selectSectionByLine on PreviewPanel - matching C# ChangeHighlightByLine
        previewPanelRef.current?.selectSectionByLine(data.line);
      });
      unsubscribers.push(unsubscribe);
    }

    // Handle remote highlight controller changes - matching C# sectionListBox.Remote update
    if (window.electronAPI.onRemoteHighlightControllerChanged) {
      const unsubscribe = window.electronAPI.onRemoteHighlightControllerChanged((data) => {
        setRemoteHighlightController(data.clientId || "");
      });
      unsubscribers.push(unsubscribe);
    }

    return () => {
      unsubscribers.forEach((unsub) => unsub());
    };
  }, [showConfirm, t]);

  // Handle playlist item selection - sets projectedSong and (if not editing) editedSong
  useEffect(() => {
    console.debug("App", `selectedPlaylistItem effect: item=${selectedPlaylistItem?.songId}, isEditing=${isEditing}, isAuthLoading=${isAuthLoading}`);
    // Don't try to load song while auth is still loading (database might switch)
    if (isAuthLoading) {
      console.debug("App", "Skipping song load - auth still loading");
      return;
    }
    if (selectedPlaylistItem) {
      const targetSongId = selectedPlaylistItem.songId;
      playlistLoadTargetSongIdRef.current = targetSongId;

      const loadSong = async () => {
        const db = await Database.waitForReady();
        if (playlistLoadTargetSongIdRef.current !== targetSongId) {
          return;
        }
        console.debug("App", `Database has ${db.getSongs().length} songs`);
        const song = db.getSongById(targetSongId);
        console.debug("App", `Loading song from playlist selection: songId=${targetSongId}, found=${song?.Title || "NOT FOUND"}`);
        if (song) {
          const clonedSong = song.clone();
          // Always set projected song from playlist
          setProjectedSong(clonedSong);

          // Only update edited song if we're not currently editing AND not restoring
          // During restoration, we preserve the editor's song from savedState.selectedSongId
          if (!isEditing && !isRestoringStateRef.current) {
            setEditedSong(clonedSong);
            updateCurrentSongText(clonedSong.Text);
          } else if (isRestoringStateRef.current) {
            console.debug("App", "Skipping editor song update during restoration");
          }

          // Sync song tree selection - but NOT during restoration (we restore to savedState.selectedSongId instead)
          if (!isRestoringStateRef.current) {
            console.debug("App", `Syncing song tree selection: ${targetSongId}`);
            leftPanelRef.current?.setSelectedSongId(targetSongId);
          } else {
            console.debug("App", "Skipping song tree sync during restoration");
          }
        }
      };

      void loadSong();
    }
  }, [selectedPlaylistItem, isEditing, isAuthLoading]);

  // Handle song tree selection - sets editedSong (with confirmation if editing)
  const handleSongSelected = async (song: Song | null) => {
    if (!song) {
      if (!isEditing && !canSaveSong) {
        setEditedSong(null);
        updateCurrentSongText("");
        setSelectedSongId(null);
      }
      return;
    }

    // Check if we have unsaved changes (whether in edit mode or not)
    if (canSaveSong) {
      showConfirm(
        t("UnsavedChanges"),
        t("AskDiscardChangesAndLoadNewSong"),
        () => {
          editorPanelRef.current?.leaveEditMode?.();
          setIsEditing(false);
          const cloned = song.clone();
          setEditedSong(cloned);
          updateCurrentSongText(cloned.Text);
          setSelectedSongId(song.Id);
          // Clear playlist selection when manually selecting a song from tree
          setPlaylistSelection(null);
        },
        undefined,
        { confirmText: t("DiscardAndLoad"), confirmDanger: true }
      );
      return;
    }

    const cloned = song.clone();
    setEditedSong(cloned);
    updateCurrentSongText(cloned.Text);
    setSelectedSongId(song.Id);
    // Clear playlist selection when manually selecting a song from tree
    setPlaylistSelection(null);
  };

  const handleEditModeChange = useCallback((editing: boolean) => {
    setIsEditing(editing);
  }, []);

  // Called before entering edit mode - check if sync is needed (matching C# Editor_EnterEditMode)
  const handleBeforeEnterEditMode = useCallback(async (): Promise<boolean> => {
    if (remoteChangeCount <= 0 || isGuest) {
      return true;
    }

    const now = Date.now();
    const syncDeclineTimeoutMinutes = Math.max(0, settings?.syncDeclineTimeoutMinutes ?? 15);
    const syncDeclineCooldownMs = syncDeclineTimeoutMinutes * 60 * 1000;
    if (syncDeclineCooldownMs > 0 && syncDeclinedAtRef.current !== null && now - syncDeclinedAtRef.current < syncDeclineCooldownMs) {
      return true;
    }

    // Cloud is ahead of local db version, ask before entering edit mode.
    return new Promise((resolve) => {
      showConfirm(
        t("OldSyncWarning"),
        t("AskOldSync"),
        () => {
          // User chose to sync - open sync dialog
          setShowDBSync(true);
          // Don't enter edit mode immediately - user can click edit again after sync
          resolve(false);
        },
        () => {
          // User chose not to sync - proceed with edit mode
          syncDeclinedAtRef.current = Date.now();
          resolve(true);
        },
        { confirmText: t("SyncNow") }
      );
    });
  }, [isAuthenticated, remoteChangeCount, settings?.lastSyncDate, settings?.syncDeclineTimeoutMinutes, showConfirm, t]);

  // Called after leaving edit mode with changed text - prompt to save (matching C# Editor_LeaveEditMode)
  const handleAfterLeaveEditMode = useCallback(
    async (currentText: string, originalText: string): Promise<boolean | void> => {
      // If text was changed, ask user if they want to save.
      // Returning false cancels edit-mode exit so the editor stays editable.
      if (currentText.trim() !== originalText.trim() && currentText.trim() !== "") {
        const confirmed = await showConfirmAsync(t("UnsavedChanges"), t("AskSaveSongChanges"), { confirmText: t("SaveChanges") });
        if (confirmed) {
          const current = getEditedSong();
          if (current) {
            // Require a title before saving — cancel exit so user can fill it in
            if (!current.Title || !current.Title.trim()) {
              showMessage(t("SongTitleRequired"), t("SongTitleRequiredMessage"), () => {
                editorPanelRef.current?.focusMetaTitle?.();
              });
              return false;
            }

            const db = Database.getInstance();
            const existsInDb = !!db.getSongById(current.Id);

            // For new songs, perform similarity check before saving
            if (!existsInDb) {
              const similarSongs = db.findSimilarSongs(current, true);
              if (similarSongs.length > 0) {
                // Show CompareDialog — the save will complete via the onDecision callback
                setCompareDialogState({
                  song: current,
                  similarSongs,
                  onDecision: (decision) => {
                    setCompareDialogState(null);
                    current.version = 0;
                    db.updateSong(current);
                    if (decision.action === "import-and-group" && decision.groupWithSong) {
                      db.MakeGroup(current, decision.groupWithSong);
                    }
                    setEditedSong(current);
                    const projected = getProjectedSong();
                    if (projected && projected.Id === current.Id) {
                      setProjectedSong(current);
                    }
                  },
                });
                return;
              }
            }

            current.version = 0;
            db.updateSong(current);
            setEditedSong(current);

            // If this is also the projected song, update it too
            const projected = getProjectedSong();
            if (projected && projected.Id === current.Id) {
              setProjectedSong(current);
            }
          }
        }
      }
    },
    [showConfirmAsync, showMessage, t]
  );

  const handleReloadSong = useCallback(() => {
    if (!editedSong) return;

    const db = Database.getInstance();
    const dbSong = db.getSongById(editedSong.Id);
    if (!dbSong) return;

    // Ask for confirmation if song has been altered
    if (canSaveSong) {
      showConfirm(
        t("UnsavedChanges"),
        t("AskDiscardChangesAndReload"),
        () => {
          const reloaded = dbSong.clone();
          setEditedSong(reloaded);
          updateCurrentSongText(reloaded.Text);
          editorPanelRef.current?.leaveEditMode?.(true);
          setIsEditing(false);
        },
        undefined,
        { confirmText: t("DiscardAndReload"), confirmDanger: true }
      );
      return;
    }

    const reloaded = dbSong.clone();
    setEditedSong(reloaded);
    updateCurrentSongText(reloaded.Text);
    editorPanelRef.current?.leaveEditMode?.();
    setIsEditing(false);
  }, [editedSong, canSaveSong, showConfirm, t]);

  const handleSaveSong = useCallback(() => {
    if (!editedSong) return;

    // Require a title before saving
    if (!editedSong.Title || !editedSong.Title.trim()) {
      showMessage(t("SongTitleRequired"), t("SongTitleRequiredMessage"), () => {
        // Navigate to meta tab and focus the title input
        editorPanelRef.current?.focusMetaTitle?.();
      });
      return;
    }

    const doSave = (groupWithSong?: Song) => {
      console.debug("App", "handleSaveSong - BEFORE save", {
        editedSongText: editedSong.Text.substring(0, 100),
        currentSongText: currentSongText.substring(0, 100),
      });

      const db = Database.getInstance();
      editedSong.version = 0;
      db.updateSong(editedSong);

      // If user chose to group with an existing song, create the group
      if (groupWithSong) {
        db.MakeGroup(editedSong, groupWithSong);
      }

      // Database now has the saved version - no need to track separately
      setEditedSong(editedSong);
      // Sync currentSongText with saved text so canSaveSong becomes false
      updateCurrentSongText(editedSong.Text);

      console.debug("App", "handleSaveSong - AFTER save", {
        editedSongText: editedSong.Text.substring(0, 100),
        dbSongText: db.getSongById(editedSong.Id)?.Text.substring(0, 100),
        willSetCurrentSongTextTo: editedSong.Text.substring(0, 100),
      });

      // If this is also the projected song, update it too
      if (projectedSong && projectedSong.Id === editedSong.Id) {
        setProjectedSong(editedSong);
      }
    };

    const promptSaveConfirmation = () => {
      const songTitle = editedSong.Title || t("UntitledSong");
      const db = Database.getInstance();
      const existsInDb = !!db.getSongById(editedSong.Id);
      if (existsInDb) {
        showConfirm(t("ConfirmSave"), t("AskConfirmOverwriteSong").replace("{0}", songTitle), () => doSave(), undefined, {
          confirmText: t("OverwriteSong"),
        });
      } else {
        showConfirm(t("ConfirmSave"), t("AskConfirmSaveNewSong").replace("{0}", songTitle), () => doSave(), undefined, {
          confirmText: t("SaveSong"),
        });
      }
    };

    // For new songs, check for similar songs in the database before saving
    const db = Database.getInstance();
    const existsInDb = !!db.getSongById(editedSong.Id);
    if (!existsInDb) {
      const similarSongs = db.findSimilarSongs(editedSong, true);
      if (similarSongs.length > 0) {
        // Show CompareDialog in Import mode so user can decide
        setCompareDialogState({
          song: editedSong,
          similarSongs,
          onDecision: (decision) => {
            setCompareDialogState(null);
            if (decision.action === "import-and-group" && decision.groupWithSong) {
              doSave(decision.groupWithSong);
            } else {
              // "import" — save as independent song, still ask for confirmation
              promptSaveConfirmation();
            }
          },
        });
        return;
      }
    }

    promptSaveConfirmation();
  }, [editedSong, projectedSong, showConfirm, showMessage, t, currentSongText]);

  // Create new song (matching C# OnNewSong)
  const handleNewSong = useCallback(() => {
    const createNew = () => {
      // Create a new empty song with prompt text (matching C# LoadSong(new Song(Properties.Strings.EmptySongPrompt)))
      const newSong = new Song(t("EmptySongPrompt"));
      setEditedSong(newSong);
      updateCurrentSongText(newSong.Text);
      // Enter edit mode and focus (matching C# if(editor.MakeEditable(true)) editor.Focus())
      setIsEditing(true);
      // Trigger editor to enter edit mode after a short delay to allow state to update
      setTimeout(() => {
        editorPanelRef.current?.enterEditMode?.();
      }, 100);
    };

    // Check if we have unsaved changes (matching C# IsLoadedSongUnmodified)
    if (canSaveSong) {
      showConfirm(
        t("UnsavedChanges"),
        t("AskDiscardChangesAndCreateNew"),
        () => {
          editorPanelRef.current?.leaveEditMode?.();
          setIsEditing(false);
          createNew();
        },
        undefined,
        { confirmText: t("DiscardAndCreateNew"), confirmDanger: true }
      );
      return;
    }

    createNew();
  }, [canSaveSong, showConfirm, t]);

  // Print current song – opens a dedicated print window/tab
  const handlePrint = useCallback(() => {
    // Only print if there's content in the editor
    if (!currentSongText || currentSongText.trim() === "") return;

    const song = getEditedSong();

    // Pass song data via localStorage so the print window can reconstruct it
    const printData = {
      songText: currentSongText,
      songTitle: song?.Title ?? "Song",
      chordSystem: song?.System ?? "G",
    };
    localStorage.setItem("pp-print-data", JSON.stringify(printData));

    const openWebPrintWindow = () => {
      const printUrl = new URL(window.location.href);
      printUrl.hash = "/print";
      window.open(printUrl.toString(), "_blank", "noopener,noreferrer");
    };

    if (window.electronAPI?.print?.openWindow) {
      void window.electronAPI.print.openWindow().catch(() => {
        openWebPrintWindow();
      });
      return;
    }

    openWebPrintWindow();
  }, [currentSongText]);

  const handleImportClick = () => {
    setImportWizardInitialFiles(null);
    setShowImportWizard(true);
  };

  const handleSongTreeExternalFilesDropped = useCallback((files: File[]) => {
    if (!files || files.length === 0) return;
    setImportWizardInitialFiles(files);
    setShowImportWizard(true);
  }, []);

  // Check if current playlist has unsaved changes for a remembered schedule date
  // and offer to save before syncing. Returns true to proceed with sync, false to cancel.
  const checkAndSaveScheduledPlaylist = useCallback(async (): Promise<boolean> => {
    const scheduleDate = leftPanelRef.current?.getScheduleDate();
    if (!scheduleDate || !selectedLeader) return true;

    const currentPlaylist = leftPanelRef.current?.getCurrentPlaylist();
    if (!currentPlaylist) return true;

    const savedPlaylist = selectedLeader.getPlaylist(scheduleDate);
    if (savedPlaylist && currentPlaylist.equals(savedPlaylist)) return true; // No changes

    const dateStr = formatLocalDateLabel(scheduleDate);
    const result = await showYesNoCancelAsync(t("UpdateScheduledPlaylist"), t("AskUpdateScheduledPlaylist").replace("{0}", dateStr), {
      confirmText: t("UpdatePlaylistConfirm"),
    });
    if (result === "yes") {
      Database.getInstance().schedule(selectedLeader, scheduleDate, currentPlaylist);
    }
    return result !== "cancel";
  }, [selectedLeader, showYesNoCancelAsync, t]);

  // Check if user can start sync (matching C# IsLoadedSongUnmodified and SyncDatabase)
  const handleSyncClick = useCallback(async () => {
    saveErrorNotifiedRef.current = false;
    // Snapshot scheduled leaders before sync (matching C# prev = CollectScheduledLeaders())
    preSyncScheduledLeadersRef.current = collectScheduledLeaders();

    // If in edit mode with unsaved changes, ask to discard first
    if (isEditing && canSaveSong) {
      showConfirm(
        t("UnsavedChanges"),
        t("AskDiscardChangesBeforeSync"),
        async () => {
          // User chose to discard - leave edit mode and start sync
          editorPanelRef.current?.leaveEditMode?.();
          setIsEditing(false);
          if (await checkAndSaveScheduledPlaylist()) {
            setShowDBSync(true);
          }
        },
        undefined,
        { confirmText: t("DiscardAndSync"), confirmDanger: true }
      );
      return;
    }

    // If in edit mode but no changes, just leave edit mode
    if (isEditing) {
      editorPanelRef.current?.leaveEditMode?.();
      setIsEditing(false);
    }

    // If in guest mode, ask about guest sync before opening dialog
    if (isGuest) {
      showConfirm(
        t("AuthenticationRequired"),
        t("NotLoggedInFetchPublicSongs"),
        async () => {
          if (await checkAndSaveScheduledPlaylist()) {
            setShowDBSync(true);
          }
        },
        undefined,
        { confirmText: t("DownloadPublicSongs") }
      );
      return;
    }

    if (!isAuthenticated) {
      window.dispatchEvent(new CustomEvent("pp-open-auth-dialog"));
      return;
    }

    if (await checkAndSaveScheduledPlaylist()) {
      setShowDBSync(true);
    }
  }, [isEditing, canSaveSong, showConfirm, t, isAuthenticated, isGuest, checkAndSaveScheduledPlaylist]);

  const handleSongCheckClick = useCallback(() => {
    if (isGuest) return; // Song check not available for guests
    if (!isAuthenticated) {
      window.dispatchEvent(new CustomEvent("pp-open-auth-dialog", { detail: { action: "songCheck" } }));
      return;
    }
    setShowSongCheck(true);
  }, [isAuthenticated, isGuest]);

  // Watched display state for tracking changes (matching C# watchedDisplay field)
  const watchedDisplayRef = useRef<(Display & { message?: string }) | null>(null);
  const remoteStylesRevRef = useRef<string>("");

  const syncRemoteStyles = useCallback(
    async (leaderId: string, stylesRev: string | undefined) => {
      if (!stylesRev || remoteStylesRevRef.current === stylesRev) return;
      const response = await cloudApi.fetchDisplayStylesQuery({
        leaderId,
        rev: remoteStylesRevRef.current,
      });
      remoteStylesRevRef.current = response.rev;
      if (!response.styles) return;
      updateSetting("chordProStyles", response.styles as Settings["chordProStyles"]);
    },
    [updateSetting]
  );

  /**
   * Apply display update from any source (HTTP cloud or UDP local)
   * Unified display handling matching web client's applyDisplay pattern
   * Only updates state when changes are detected
   */
  const applyDisplay = useCallback(
    (display: Partial<Display> | null) => {
      if (!display || !watchedDisplayRef.current) return;

      const currentDisplay = watchedDisplayRef.current;

      // Only update song if songId changed (matching C# if (watchedDisplay.songId != display.songId))
      if (display.songId && currentDisplay.songId !== display.songId) {
        if (display.song) {
          const remoteSong = new Song(display.song, display.system || "G");
          remoteSong.Id = display.songId;
          setEditedSong(remoteSong);
          setProjectedSong(remoteSong);
          updateCurrentSongText(display.song);
        }
      }

      // Update playlist if playlist_id changed (matching web client applyDisplay behavior)
      if (display.playlist_id && currentDisplay.playlist_id !== display.playlist_id) {
        if (display.playlist) {
          const playlistItems = display.playlist.map((ple: DisplayPlaylistEntry) => PlaylistEntry.fromSynced(ple));
          const remotePlaylist = new Playlist("Remote", playlistItems, display.playlist_id);
          setWatchedPlaylist(remotePlaylist);
        }
      }

      // Update tracked display state for future comparisons
      const emtyDisplay = getEmptyDisplay();
      watchedDisplayRef.current = {
        songId: display.songId ?? emtyDisplay.songId,
        song: display.song ?? emtyDisplay.song,
        system: display.system ?? emtyDisplay.system,
        from: display.from ?? emtyDisplay.from,
        to: display.to ?? emtyDisplay.to,
        transpose: display.transpose ?? emtyDisplay.transpose,
        capo: display.capo ?? emtyDisplay.capo,
        playlist_id: display.playlist_id ?? emtyDisplay.playlist_id,
        section: display.section ?? emtyDisplay.section,
        instructions: display.instructions ?? emtyDisplay.instructions,
        message: display.message ?? emtyDisplay.message,
        chordProStylesRev: display.chordProStylesRev,
      };

      // Keep the global display store in sync so backend subscriber pushes updates
      updateCurrentDisplay(watchedDisplayRef.current);
    },
    [updateCurrentSongText]
  );

  // Watch online display - polling loop for cloud sessions matching C# ProjectorForm.WatchOnlineDisplay
  const watchOnlineDisplay = useCallback(
    async (leaderId: string, _cloudBasePath: string, abortSignal: AbortSignal) => {
      try {
        // Initialize watched display state (matching C# watchedDisplay = new Display())
        watchedDisplayRef.current = getEmptyDisplay();

        let forced = true;

        while (!abortSignal.aborted) {
          const started = Date.now();

          try {
            // Build query URL matching C# format exactly
            const wd: NonNullable<typeof watchedDisplayRef.current> = watchedDisplayRef.current!;

            // Use cloudApi for authenticated request - response matches Display type from display.ts
            const display = (await cloudApi.fetchDisplayQuery(wd, { leaderId, forced })).display;

            if (abortSignal.aborted || !watchedDisplayRef.current) return;

            // Apply display update using unified handler
            applyDisplay(display);
            await syncRemoteStyles(leaderId, display.chordProStylesRev);

            forced = false;
          } catch (error) {
            if (abortSignal.aborted) break;
            console.warn("App", "Watch polling error:", error);
          }

          // Wait for remainder of 1 second interval (matching C# if(elapsed.TotalMilliseconds < 1000))
          const elapsed = Date.now() - started;
          if (elapsed < 1000) {
            await new Promise((resolve) => setTimeout(resolve, 1000 - elapsed));
          }
        }
      } finally {
        // Matching C# finally block that exits watch mode
        watchedDisplayRef.current = null;
      }
    },
    [applyDisplay, syncRemoteStyles]
  );

  // Handle UDP display update from electron main process - uses unified applyDisplay
  const handleUdpDisplayUpdate = useCallback(
    (display: Display) => {
      // Initialize watchedDisplayRef if not already (shouldn't happen, but safety check)
      if (!watchedDisplayRef.current) {
        watchedDisplayRef.current = getEmptyDisplay();
      }

      // Use unified display handler
      applyDisplay(display);
    },
    [applyDisplay]
  );

  // Use ref for exit function to avoid circular dependency
  const exitWatchModeRef = useRef<() => void>(() => {});

  // Handle UDP session ended from electron main process
  const handleUdpSessionEnded = useCallback(() => {
    console.warn("App", "UDP session ended");
    exitWatchModeRef.current();
    // Could show a message to user here
  }, []);

  // Exit session watching mode - matching C# ProjectorForm.ExitSessionWatchingMode
  const exitWatchMode = useCallback(() => {
    console.info("App", "Exiting watch mode");

    // Stop cloud polling
    if (watchPollingAbortRef.current) {
      watchPollingAbortRef.current.abort();
      watchPollingAbortRef.current = null;
    }

    // Stop local UDP watching via HostDevice bridge
    stopHostDeviceWatching();

    // Clear watched display state (matching C# watchedDisplay = null in ExitSessionWatchingMode)
    watchedDisplayRef.current = null;

    // Clear watched session state
    setWatchedSessionId(null);
    setWatchedSessionUrl(null);
    setWatchedPlaylist(null); // Clear remote playlist

    // Only clear song display if we were actually watching (matching C# behavior)
    if (watchedSessionId !== null) {
      setEditedSong(null);
      setProjectedSong(null);
      updateCurrentSongText("");
    }
  }, [updateCurrentSongText, watchedSessionId]);

  // Update ref when exitWatchMode changes
  useEffect(() => {
    exitWatchModeRef.current = exitWatchMode;
  }, [exitWatchMode]);

  // Enter session watching mode - matching C# ProjectorForm.EnterSessionWatchingMode
  // When watching a remote session, the playlist becomes read-only and song changes come from the remote session
  const enterWatchMode = useCallback(
    (
      sessionId: string,
      _sessionUrl: string,
      sessionType: "local" | "cloud" = "cloud",
      udpDetails?: { address: string; port: number; hostId: string }
    ) => {
      console.info("App", `Entering watch mode for ${sessionType} session: ${sessionId}`);

      // Set watched session state
      setWatchedSessionId(sessionId);
      setWatchedSessionUrl(_sessionUrl);

      // Clear current song display (matching C# LoadSong(null, true))
      setEditedSong(null);
      setProjectedSong(null);
      updateCurrentSongText("");

      if (sessionType === "local" && udpDetails) {
        // UDP session watching via HostDevice bridge (Android/Electron parity).
        watchedDisplayRef.current = getEmptyDisplay();
        if (!isHostDevicePpdAvailable()) {
          console.warn("App", "HostDevice unavailable for local watch mode");
          exitWatchModeRef.current();
          return;
        }
        void initHostDevicePpd();
        void startHostDeviceWatching(sessionId, udpDetails, handleUdpDisplayUpdate, handleUdpSessionEnded).then((started) => {
          if (!started) {
            console.warn("App", "HostDevice local watch start failed");
            exitWatchModeRef.current();
          }
        });
      } else {
        // Cloud session watching - polling loop (matching C# WatchOnlineDisplay)
        watchPollingAbortRef.current = new AbortController();
        watchOnlineDisplay(sessionId, cloudApi.getBaseUrl(), watchPollingAbortRef.current.signal);
      }
    },
    [updateCurrentSongText, watchOnlineDisplay, handleUdpDisplayUpdate, handleUdpSessionEnded]
  );

  // Launch viewer - show sessions dialog (matching C# OnDeviceButtonClicked)
  // C# pattern: ExitSessionWatchingMode first, then show SessionsForm dialog
  const handleLaunchViewer = useCallback(() => {
    // Exit current watch mode first (matching C# OnDeviceButtonClicked calling ExitSessionWatchingMode)
    exitWatchMode();
    setShowSessionsForm(true);
  }, [exitWatchMode]);

  // Export database to file - export from IndexedDB storage
  const handleExportDatabase = useCallback(async () => {
    saveErrorNotifiedRef.current = false;
    try {
      // Get raw database content from IndexedDB
      const dbContent = await databaseStorage.getRaw(Database.getCurrentUsername());
      if (!dbContent) {
        showMessage(t("Error"), t("ExportFailed"));
        return;
      }

      const username = Database.getCurrentUsername();
      const exportEnvelope: DatabaseExportEnvelope = {
        format: "ppdb-export-v2.1",
        username,
        exportedAt: new Date().toISOString(),
        database: import.meta.env.DEV ? parseAndDecode(Database.importExportCodec, dbContent) : JSON.parse(dbContent),
      };
      const exportJson = JSON.stringify(exportEnvelope);
      const fileName = `ppdb_${new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19)}.ppdb`;
      const blob = compressDatabaseToZip(exportJson);

      if (window.electronAPI?.saveDatabaseFile) {
        const data = await blob.arrayBuffer();
        const result = await window.electronAPI.saveDatabaseFile(data, fileName);
        if (result.success) {
          showMessage(t("ExportDatabaseTitle"), t("ExportSuccess"));
        } else if (result.error !== "Cancelled") {
          showMessage(t("Error"), t("ExportFailed"));
        }
        return;
      }

      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = url;
      link.download = fileName;
      document.body.appendChild(link);
      link.click();
      document.body.removeChild(link);
      URL.revokeObjectURL(url);
      showMessage(t("ExportDatabaseTitle"), t("ExportSuccess"));
    } catch (error) {
      console.error("App", "Failed to export database", error);
      showMessage(t("Error"), t("ExportFailed"));
    }
  }, [showMessage, t]);

  // Import database from file - import to IndexedDB storage then reload
  const handleImportDatabase = useCallback(() => {
    saveErrorNotifiedRef.current = false;
    const input = document.createElement("input");
    input.type = "file";
    input.accept = ".ppdb,.json";
    input.onchange = async (event) => {
      const file = (event.target as HTMLInputElement).files?.[0];
      if (!file) return;

      try {
        // Accept current JSON exports and legacy C# XML .ppdb files (plain text or ZIP-compressed).
        // Load and verify the data before showing confirmation dialog
        const envelope = await normalizeImportedDatabase(file);

        if (!envelope) {
          showMessage(t("Error"), t("ImportInvalidData"));
          return;
        }

        const currentUsername = Database.getCurrentUsername();
        const isGuestMode = !currentUsername;
        const username = envelope?.username.trim() ?? "";

        // Validate username matches (if not in guest mode)
        if (!isGuestMode) {
          if (!username) {
            showMessage(t("ImportDatabaseTitle"), t("ImportUserMetadataMissing"));
            return;
          }
          if (username !== currentUsername) {
            showMessage(t("ImportDatabaseTitle"), t("ImportUserMismatch").replace("{0}", username).replace("{1}", currentUsername));
            return;
          }
        }

        // Data is valid - now show confirmation dialog
        showConfirm(
          t("ImportDatabaseTitle"),
          t("AskImportDatabase"),
          async () => {
            setIsImporting(true);
            try {
              const normalizedDatabaseJson = JSON.stringify(envelope.database);

              // Import to IndexedDB storage
              await databaseStorage.setRaw(normalizedDatabaseJson, currentUsername);

              setIsImporting(false);
              showMessage(t("ImportDatabaseTitle"), t("ImportSuccess"), () => {
                // Reload the page to load the new database
                window.location.reload();
              });
            } catch (error) {
              setIsImporting(false);
              console.error("App", "Failed to import database", error);
              showMessage(t("Error"), t("ImportFailed"));
            }
          },
          undefined,
          { confirmText: t("ClearAndReplace"), confirmDanger: true }
        );
      } catch (error) {
        console.error("App", "Failed to load import file", error);
        showMessage(t("Error"), t("ImportFailed"));
      }
    };
    input.click();
  }, [showConfirm, showMessage, t]);

  // Replace database with online data (matching C# OnReplaceDatabaseMenuItemClicked)
  const handleReplaceDatabase = useCallback(() => {
    saveErrorNotifiedRef.current = false;
    showConfirm(
      t("Warning"),
      t("AskClearLocalDatabase"),
      async () => {
        const db = Database.getInstance();
        db.clear();
        saveErrorNotifiedRef.current = false;
        await db.forceSaveAsync();
        setShowDBSync(true);
      },
      undefined,
      { confirmText: t("ClearAndReplace"), confirmDanger: true }
    );
  }, [showConfirm, t]);

  // Recheck and reload songs after sync if they were changed (matching C# RecheckLoadedSong)
  const recheckLoadedSongs = useCallback(() => {
    const db = Database.getInstance();

    // Check if edited song was changed in database
    const currentEditedSong = getEditedSong();
    if (currentEditedSong) {
      const dbSong = db.getSongById(currentEditedSong.Id);
      if (dbSong && dbSong.Text !== currentEditedSong.Text) {
        // Song was modified in sync - reload it
        const reloaded = dbSong.clone();
        setEditedSong(reloaded);
        updateCurrentSongText(reloaded.Text);
      }
    }

    // Check if projected song was changed in database
    const currentProjectedSong = getProjectedSong();
    if (currentProjectedSong) {
      const dbSong = db.getSongById(currentProjectedSong.Id);
      if (dbSong && dbSong.Text !== currentProjectedSong.Text) {
        // Projected song was modified in sync - reload it
        setProjectedSong(dbSong.clone());
      }
    }
  }, []);

  /**
   * After sync completes, check if any NEW scheduled playlist appeared for today.
   * If exactly one new leader has a today-playlist, ask to load it (matching C# SyncDatabase AskLoadTodayPlaylist).
   */
  const checkAndOfferTodayPlaylist = useCallback(async () => {
    const prev = preSyncScheduledLeadersRef.current;
    const actual = collectScheduledLeaders();

    // Remove entries that already existed before sync
    for (const id of prev.keys()) {
      actual.delete(id);
    }

    if (actual.size !== 1) return;

    // Exactly one new scheduled playlist - ask user
    const [leaderId, playlist] = actual.entries().next().value as [string, Playlist];
    const confirmed = await showConfirmAsync(t("LoadTodayPlaylistTitle"), t("AskLoadTodayPlaylist"), { confirmText: t("LoadPlaylistConfirm") });
    if (!confirmed) return;

    // Select the leader and load the playlist.
    // These are independent: updatePlaylist() sets playlist items directly via ref,
    // while the leader context propagates asynchronously through React state.
    // PlaylistPanel.componentDidUpdate does not react to selectedLeader changes,
    // so there is no race condition or ordering dependency.
    updateSettingWithAutoSave("selectedLeader", leaderId);
    leftPanelRef.current?.updatePlaylist(playlist.items);
  }, [showConfirmAsync, t, updateSettingWithAutoSave]);

  // Use paging mode whenever the client area is portrait or width is small.
  // Always use 3-panel layout in landscape mode.
  const usePagingMode = orientation === "portrait" || width < 768;

  // Refresh editor display when switching to editor tab in paging mode
  // This fixes dark mode rendering issues when the editor canvas was hidden
  useEffect(() => {
    if (usePagingMode && activePanel === "editor") {
      // Use requestAnimationFrame + small delay to ensure the DOM has fully rendered
      // and the canvas has proper dimensions after display: none is removed
      const timer = setTimeout(() => {
        requestAnimationFrame(() => {
          editorPanelRef.current?.refreshDisplay();
        });
      }, 100);
      return () => clearTimeout(timer);
    }
  }, [activePanel, usePagingMode]);

  function handleTextChange(newText: string): void {
    const current = getEditedSong();
    if (current) updateEditedSong((song: Song) => song.updateChordProText(newText));
  }

  return (
    <>
      <ResponsiveFontSizeManager />
      <UpdateNotification />
      <DndProvider backend={HTML5Backend}>
        <div className="container-fluid vh-100 d-flex flex-column pp-app-shell">
          {/* Paging mode layout (mobile portrait) - show/hide with CSS to preserve state */}
          <div style={{ display: usePagingMode ? "flex" : "none", flexDirection: "column", flexGrow: 1, minHeight: 0 }}>
            <div className="btn-group mb-2">
              <button className={`btn ${activePanel === "side" ? "btn-primary" : "btn-secondary"}`} onClick={() => setActivePanel("side")}>
                {t("TabSongs")}
              </button>
              <button className={`btn ${activePanel === "editor" ? "btn-primary" : "btn-secondary"}`} onClick={() => setActivePanel("editor")}>
                {t("TabEditor")}
              </button>
              <button className={`btn ${activePanel === "preview" ? "btn-primary" : "btn-secondary"}`} onClick={() => setActivePanel("preview")}>
                {t("TabProjection")}
              </button>
            </div>
            <div className="flex-grow-1 min-height-0">
              <div style={{ display: activePanel === "side" ? "block" : "none", height: "100%" }}>
                {usePagingMode && (
                  <LeftPanel
                    ref={leftPanelRef}
                    onPlaylistSelectionChange={handlePlaylistSelectionChange}
                    onSongSelected={handleSongSelected}
                    onOpenLeaderSettings={openLeaderSettings}
                    onSyncClick={handleSyncClick}
                    onRemoteChangeCountChange={setRemoteChangeCount}
                    onSettingsClick={openSettings}
                    onExportDatabase={handleExportDatabase}
                    onImportDatabase={handleImportDatabase}
                    onReplaceDatabase={handleReplaceDatabase}
                    onSongCheckClick={handleSongCheckClick}
                    onExternalFilesDropped={handleSongTreeExternalFilesDropped}
                    selectedSong={editedSong}
                    disabled={isWatching}
                    remotePlaylist={watchedPlaylist}
                    playlistPanelSize={playlistPanelSize}
                    songListPanelSize={songListPanelSize}
                    onPlaylistPanelSizeChange={setPlaylistPanelSize}
                    onSongListPanelSizeChange={setSongListPanelSize}
                    songFilter={songFilter}
                    onSongFilterChange={setSongFilter}
                    onPlaylistLoaded={handlePlaylistLoaded}
                    settings={settings}
                  />
                )}
              </div>
              <div style={{ display: activePanel === "editor" ? "flex" : "none", flexDirection: "column", height: "100%" }}>
                {usePagingMode && (
                  <>
                    <Toolbar
                      onSettingsClick={openSettings}
                      onLoadSong={handleReloadSong}
                      onSaveSong={handleSaveSong}
                      onNewSong={handleNewSong}
                      onPrint={handlePrint}
                      onImport={handleImportClick}
                      onLaunchViewer={handleLaunchViewer}
                      canLoadSong={canLoadSong}
                      canSaveSong={canSaveSong}
                    />
                    <div className="flex-grow-1 mt-2 editor-wrapper">
                      <EditorPanel
                        ref={editorPanelRef}
                        song={editedSong}
                        onLineSelect={handleLineSelect}
                        onEditModeChange={handleEditModeChange}
                        onTextChange={handleTextChange}
                        settings={settings}
                        setProjectedSongText={updateCurrentSongText}
                        onBeforeEnterEditMode={handleBeforeEnterEditMode}
                        onAfterLeaveEditMode={handleAfterLeaveEditMode}
                        originalText={getOriginalSongText()}
                      />
                    </div>
                  </>
                )}
              </div>
              <div style={{ display: activePanel === "preview" ? "block" : "none", height: "100%" }}>
                {usePagingMode && (
                  <PreviewPanel
                    ref={previewPanelRef}
                    editorRef={editorPanelRef}
                    selectedPlaylistItem={selectedPlaylistItem}
                    enableHighlight={projectedSong?.Id === editedSong?.Id}
                    currentSongText={currentSongText}
                    remoteHighlightController={remoteHighlightController}
                    selectedSectionIndex={selectedSectionIndex}
                    onSelectedSectionIndexChange={handleSelectedSectionIndexChange}
                    onSectionsReady={handleSectionsReady}
                    previewSplitSize={previewSplitSize}
                    onPreviewSplitSizeChange={setPreviewSplitSize}
                    onSettingsClick={openSettings}
                    initialTab={previewTab}
                    onActiveTabChange={setPreviewTab}
                  />
                )}
              </div>
            </div>
          </div>

          {/* 3-panel mode layout (desktop/landscape) - show/hide with CSS to preserve state */}
          <PanelGroup
            direction="horizontal"
            className="flex-grow-1 min-h-0"
            style={{ display: usePagingMode ? "none" : "flex" }}
            onLayout={(sizes) => {
              setLeftPanelSize(sizes[0]);
              setEditorPanelSize(sizes[1]);
              setPreviewPanelSize(sizes[2]);
            }}
          >
            <Panel defaultSize={leftPanelSize} minSize={20}>
              <div className="d-flex flex-column h-100">
                <div className="flex-grow-1 min-h-0">
                  {!usePagingMode && (
                    <LeftPanel
                      ref={leftPanelRef}
                      onPlaylistSelectionChange={handlePlaylistSelectionChange}
                      onSongSelected={handleSongSelected}
                      onOpenLeaderSettings={openLeaderSettings}
                      onSyncClick={handleSyncClick}
                      onRemoteChangeCountChange={setRemoteChangeCount}
                      onExportDatabase={handleExportDatabase}
                      onImportDatabase={handleImportDatabase}
                      onReplaceDatabase={handleReplaceDatabase}
                      onSongCheckClick={handleSongCheckClick}
                      onExternalFilesDropped={handleSongTreeExternalFilesDropped}
                      selectedSong={editedSong}
                      disabled={isWatching}
                      remotePlaylist={watchedPlaylist}
                      playlistPanelSize={playlistPanelSize}
                      songListPanelSize={songListPanelSize}
                      onPlaylistPanelSizeChange={setPlaylistPanelSize}
                      onSongListPanelSizeChange={setSongListPanelSize}
                      songFilter={songFilter}
                      onSongFilterChange={setSongFilter}
                      onPlaylistLoaded={handlePlaylistLoaded}
                      settings={settings}
                    />
                  )}
                </div>
              </div>
            </Panel>
            <ResizeHandle />
            <Panel defaultSize={editorPanelSize} minSize={30}>
              {!usePagingMode && (
                <div className="d-flex flex-column h-100">
                  <Toolbar
                    onSettingsClick={openSettings}
                    onLoadSong={handleReloadSong}
                    onSaveSong={handleSaveSong}
                    onNewSong={handleNewSong}
                    onPrint={handlePrint}
                    onImport={handleImportClick}
                    onLaunchViewer={handleLaunchViewer}
                    canLoadSong={canLoadSong}
                    canSaveSong={canSaveSong}
                  />
                  <div className="flex-grow-1 mt-2 editor-wrapper">
                    <EditorPanel
                      ref={editorPanelRef}
                      song={editedSong}
                      onLineSelect={handleLineSelect}
                      onEditModeChange={handleEditModeChange}
                      onTextChange={handleTextChange}
                      settings={settings}
                      setProjectedSongText={updateCurrentSongText}
                      onBeforeEnterEditMode={handleBeforeEnterEditMode}
                      onAfterLeaveEditMode={handleAfterLeaveEditMode}
                      originalText={getOriginalSongText()}
                    />
                  </div>
                </div>
              )}
            </Panel>
            <ResizeHandle />
            <Panel defaultSize={previewPanelSize} minSize={25}>
              {!usePagingMode && (
                <PreviewPanel
                  ref={previewPanelRef}
                  editorRef={editorPanelRef}
                  selectedPlaylistItem={selectedPlaylistItem}
                  enableHighlight={projectedSong?.Id === editedSong?.Id}
                  currentSongText={currentSongText}
                  remoteHighlightController={remoteHighlightController}
                  selectedSectionIndex={selectedSectionIndex}
                  onSelectedSectionIndexChange={handleSelectedSectionIndexChange}
                  onSectionsReady={handleSectionsReady}
                  previewSplitSize={previewSplitSize}
                  onPreviewSplitSizeChange={setPreviewSplitSize}
                  onSettingsClick={openSettings}
                  showSettingsButton={false}
                  initialTab={previewTab}
                  onActiveTabChange={setPreviewTab}
                />
              )}
            </Panel>
          </PanelGroup>
          {showSettings && (
            <Suspense
              fallback={
                <div className="loading-overlay">
                  <div className="loading-spinner" />
                </div>
              }
            >
              <SettingsForm onClose={closeSettings} initialTab={settingsInitialTab || undefined} initialLeaderId={settingsInitialLeaderId} />
            </Suspense>
          )}
          {showSessionsForm && (
            <Suspense
              fallback={
                <div className="loading-overlay">
                  <div className="loading-spinner" />
                </div>
              }
            >
              <SessionsForm onClose={() => setShowSessionsForm(false)} cloudHostBasePath={cloudApi.getBaseUrl()} onConnect={enterWatchMode} />
            </Suspense>
          )}
          {showDBSync && (
            <Suspense
              fallback={
                <div className="loading-overlay">
                  <div className="loading-spinner" />
                </div>
              }
            >
              <DBSyncDialog
                onClose={() => setShowDBSync(false)}
                onComplete={async () => {
                  // Update lastSyncDate when sync completes (matching C# DBSyncForm.SyncComplete)
                  updateSettingWithAutoSave("lastSyncDate", new Date().toISOString());
                  // Reload songs if they were changed during sync (matching C# RecheckLoadedSong)
                  recheckLoadedSongs();
                  // Check for newly available scheduled playlists (matching C# SyncDatabase - AskLoadTodayPlaylist)
                  await checkAndOfferTodayPlaylist();
                }}
                database={Database.getInstance()}
                updateableLeaders={updateableLeadersRef.current}
                cloudHostBasePath={cloudApi.getBaseUrl()}
                clientId="electron-client"
                autoStart={true}
              />
            </Suspense>
          )}
          {showImportWizard && (
            <Suspense
              fallback={
                <div className="loading-overlay">
                  <div className="loading-spinner" />
                </div>
              }
            >
              <SongImporterWizard
                database={Database.getInstance()}
                initialFiles={importWizardInitialFiles ?? undefined}
                onClose={() => {
                  setShowImportWizard(false);
                  setImportWizardInitialFiles(null);
                }}
                onSongImported={(song) => {
                  setEditedSong(song);
                  updateCurrentSongText(song.Text);
                }}
              />
            </Suspense>
          )}
          {/* CompareDialog for similarity check when saving new songs */}
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
          {/* Loading overlay for database import */}
          {isImporting && (
            <div className="loading-overlay">
              <div className="loading-spinner">
                <div className="spinner-border text-primary" role="status">
                  <span className="visually-hidden">Loading...</span>
                </div>
                <div className="mt-2">{t("ImportDatabaseTitle")}...</div>
              </div>
            </div>
          )}
          {showSongCheck && (
            <Suspense
              fallback={
                <div className="loading-overlay">
                  <div className="loading-spinner" />
                </div>
              }
            >
              <SongCheckDialog onClose={() => setShowSongCheck(false)} />
            </Suspense>
          )}
          {!eulaAccepted && (
            <EulaDialog
              onAccept={() => {
                localStorage.setItem("pp-eula-accepted", EULA_DATE);
                setEulaAccepted(true);
              }}
              // If user declines the EULA, close the app in Electron or navigate to cloudapihost
              onDecline={() => {
                if (window.electronAPI) {
                  window.close();
                } else {
                  window.location.href = cloudApiHost;
                }
              }}
            />
          )}
          {showEulaView && <EulaDialog viewOnly onClose={() => setShowEulaView(false)} />}
        </div>
      </DndProvider>
    </>
  );
};

const App: React.FC = () => {
  const [messageBox, setMessageBox] = useState<MessageBoxConfig | null>(null);

  return (
    <LocalizationProvider>
      <ThemeProvider>
        <SettingsProvider>
          <TooltipProvider>
            <AuthProvider>
              <LeaderProvider>
                <UpdateProvider>
                  <MessageBoxProvider onMessageBoxChange={setMessageBox}>
                    <ToastProvider>
                      <AppContent />
                    </ToastProvider>
                    {messageBox && (
                      <MessageBox
                        title={messageBox.title}
                        message={messageBox.message}
                        onConfirm={messageBox.onConfirm}
                        onNo={messageBox.onNo}
                        onCancel={messageBox.showCancel ? messageBox.onCancel || (() => setMessageBox(null)) : undefined}
                        showCancel={messageBox.showCancel ?? true}
                        confirmText={messageBox.confirmText}
                        confirmDanger={messageBox.confirmDanger}
                      />
                    )}
                  </MessageBoxProvider>
                </UpdateProvider>
              </LeaderProvider>
            </AuthProvider>
          </TooltipProvider>
        </SettingsProvider>
      </ThemeProvider>
    </LocalizationProvider>
  );
};

export default App;
