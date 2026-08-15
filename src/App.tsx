import React, { useState, useEffect, useRef, useCallback, useMemo, Suspense, lazy } from "react";
import { DndProvider } from "react-dnd";
import { HTML5Backend } from "react-dnd-html5-backend";
import { Panel, PanelGroup } from "react-resizable-panels";
import LeftPanel, { LeftPanelMethods } from "./components/LeftPanel";
import { PlaylistSelectionEvent } from "./components/PlaylistPanel";
import PreviewPanel, { PreviewPanelMethods } from "./components/PreviewPanel";
import EditorPanel from "./components/EditorPanel";
import Toolbar from "./components/Toolbar";
import MessageBox from "./components/MessageBox";
import { ShareDialogHost } from "./components/ShareDialog";
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
import { useAuth } from "./contexts/AuthContext";
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
import { setSharedSongFilter, subscribeSharedSongFilter } from "./state/SongFilterStore";
import { useSettings } from "./hooks/useSettings";
import { useSessionUrl } from "./hooks/useSessionUrl";
import { useWakeLock } from "./hooks/useWakeLock";
import { useLocalization } from "./localization/LocalizationContext";
import { cloudApi, type DisplaySessionTarget, type DisplayUpdateResult } from "./../common/cloudApi";
import { useOnlineSession } from "./contexts/OnlineSessionContext";
import { cloudApiHost } from "./config";
import { Display, PlaylistEntry as DisplayPlaylistEntry, SongFound, SongDBEntryWithData, LeaderDBProfile } from "../common/pp-types";
import * as t from "io-ts";
import { isRight } from "fp-ts/lib/Either";
import { DisplayUpdateRequest, WindowBounds } from "./types/electron";
import { Settings } from "./types";
import { enqueue } from "./utils/asyncQueue";
import { Database, FormatFoundReason, SongOrder } from "../db-common/Database";
import type { ImportDecision } from "./components/CompareDialog";
import { databaseStorage } from "../db-common/DatabaseStorage";
import { normalizeImportedDatabase, compressDatabaseToZip, DatabaseExportEnvelope } from "./services/DatabaseImportNormalizer";
import { findScheduledPlaylist, ScheduledPlaylist } from "./services/playlistOrigin";
import { formatLocalDateKey, formatLocalDateLabel, parseScheduleDate } from "../common/date-only";
import { getEmptyDisplay } from "../common/pp-utils";
import { parseAndDecode } from "../common/io-utils";
import {
  initHostDevicePpd,
  isHostDevicePpdAvailable,
  PPD_HIGHLIGHT_ACCESS_REQUEST_EVENT,
  PPD_HIGHLIGHT_CHANGED_EVENT,
  PPD_HIGHLIGHT_CONTROLLER_CHANGED_EVENT,
  requestHostDevicePpdSongData,
  sendHostDevicePpdDisplayUpdate,
  startHostDevicePpdHosting,
  startHostDeviceWatching,
  stopHostDevicePpdHosting,
  stopHostDeviceWatching,
  type PpdHighlightAccessRequestDetail,
} from "./services/hostDevicePpd";
import type { PpdSessionAccess } from "../common/ppd-control";
import type { WebServerApiRequest } from "../common/webserver-interface";
import { getWebServerInterface, syncAndroidServedClientAssets } from "./services/webServerBridge";
import { shouldSuppressCloudNetworkToast, suppressCloudNetworkToast } from "./utils/cloudNetworkToastSuppression";
import { shouldUsePagingLayoutForOrientation } from "./utils/viewLayout";
import { TutorialHost } from "./tutorial/TutorialHost";
import { requestTutorialContinueWhenUnblocked, requestVisibleTutorialStart } from "./tutorial/tutorialEvents";
import type { TutorialCommand } from "./tutorial/tutorialTypes";
import { PullRefreshSpinner } from "./shared/PullRefreshSpinner";
import { usePullToRefresh } from "./shared/usePullToRefresh";
import { deriveFullViewPpdFollowUi } from "./services/ppdFollowUi";

type LeadersResponse = LeaderDBProfile[];
type PanelType = "side" | "editor" | "preview";

/** Opaque local revision for the JS-hosted PPD transport. The REST endpoint may
 * use a different hash; RestCore deliberately caches its response under this
 * announced revision so unchanged PPD displays do not refetch it. */
function getLocalChordProStylesRev(styles: Display["chordProStyles"]): string {
  const serialized = JSON.stringify(styles);
  let hash = 0x811c9dc5;
  for (let i = 0; i < serialized.length; i++) {
    hash ^= serialized.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return `ppd-${(hash >>> 0).toString(16).padStart(8, "0")}-${serialized.length.toString(16)}`;
}

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
  previewTab: t.union([t.literal("format"), t.literal("image"), t.literal("message"), t.literal("controls"), t.undefined]),
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
const CLOUD_NETWORK_TOAST_COOLDOWN_MS = 60_000;

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
 * Returns the exact date and playlist for each leader.
 */
function collectScheduledLeaders(): Map<string, ScheduledPlaylist> {
  const db = Database.getInstance();
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const dayMs = 24 * 60 * 60 * 1000; // 1 day in ms

  const result = new Map<string, ScheduledPlaylist>();
  for (const leader of db.getAllLeaders()) {
    const scheduled = findScheduledPlaylist(leader, today, dayMs);
    if (scheduled) {
      result.set(leader.id, scheduled);
    }
  }
  return result;
}

const AppContent: React.FC = () => {
  const width = useWindowWidth();
  const orientation = useOrientation();
  const { settings, syncToBackend, updateSetting, updateSettingWithAutoSave } = useSettings();
  const { selectedLeader } = useLeader();
  const {
    loadInitialCredentials,
    networkUnavailable,
    recheckNetworkAvailability,
    restoreStoredSession,
    isAuthenticated,
    isGuest,
    authStatus,
    user,
    isLoading: isAuthLoading,
  } = useAuth();
  const { t } = useLocalization();
  const { showToast } = useToast();
  const {
    guestSessionId,
    state: onlineSessionState,
    ensureGuestSession,
    clearGuestSession,
    setStarting: setOnlineSessionStarting,
    setActive: setOnlineSessionActive,
    setError: setOnlineSessionError,
    setDisabled: setOnlineSessionDisabled,
  } = useOnlineSession();
  const hasSyncedSettingsRef = useRef(false);
  const lastCloudNetworkToastAtRef = useRef(0);
  const lastDisplayFailureToastAtRef = useRef(0);
  const ppdHostingSyncRef = useRef<Promise<void>>(Promise.resolve());
  const ppdSessionEnabled = settings?.ppdSessionEnabled;
  const ppdSharedStylesRef = useRef<{ styles: Display["chordProStyles"]; rev?: string }>({ styles: undefined });

  useEffect(() => {
    const styles = settings?.stylesToClients ? (settings.chordProStyles as unknown as Display["chordProStyles"]) : undefined;
    ppdSharedStylesRef.current = {
      styles,
      rev: styles ? getLocalChordProStylesRev(styles) : undefined,
    };
  }, [settings?.stylesToClients, settings?.chordProStyles]);

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

  useEffect(() => {
    if (settings?.showCloudNetworkErrorToasts === false) {
      return;
    }

    const handleCloudNetworkError = () => {
      // Defer by one tick so message-box handlers can mark suppression first.
      setTimeout(() => {
        const now = Date.now();
        if (shouldSuppressCloudNetworkToast(now)) {
          return;
        }
        if (now - lastCloudNetworkToastAtRef.current < CLOUD_NETWORK_TOAST_COOLDOWN_MS) {
          return;
        }
        lastCloudNetworkToastAtRef.current = now;
        showToast(t("CloudNetworkErrorToast"), "warning");
      }, 0);
    };

    window.addEventListener("pp-cloud-network-error", handleCloudNetworkError);
    return () => window.removeEventListener("pp-cloud-network-error", handleCloudNetworkError);
  }, [settings?.showCloudNetworkErrorToasts, showToast, t]);

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

  const cancelAllHostNotifications = useCallback(() => {
    const hostDevice = window.hostDevice;
    if (!hostDevice?.cancelAllNotifications) return;
    void Promise.resolve(hostDevice.cancelAllNotifications()).catch((error) => {
      console.warn("[Notifications] cancelAllNotifications failed:", error);
    });
  }, []);

  // Clear stale device notifications as soon as app is ready.
  useEffect(() => {
    cancelAllHostNotifications();
  }, [cancelAllHostNotifications]);

  // Clear notifications when app is brought to foreground.
  useEffect(() => {
    const handleVisibilityChange = () => {
      if (document.visibilityState === "visible") {
        cancelAllHostNotifications();
      }
    };
    const handleWindowFocus = () => {
      cancelAllHostNotifications();
    };

    document.addEventListener("visibilitychange", handleVisibilityChange);
    window.addEventListener("focus", handleWindowFocus);
    return () => {
      document.removeEventListener("visibilitychange", handleVisibilityChange);
      window.removeEventListener("focus", handleWindowFocus);
    };
  }, [cancelAllHostNotifications]);

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

  // Electron owns the legacy display-stream responder in the main process, while
  // Android hosts it here. PPD v2 control is intentionally handled in this shared
  // web runtime on both platforms, so keep the bridge aligned with the feature
  // toggle; startHostDevicePpdHosting avoids starting a duplicate display loop on
  // Electron and only enables its control-plane/raw-packet adapter.
  // Serialize changes so rapid toggles cannot leave an older async start/stop as
  // the final state.
  useEffect(() => {
    if (ppdSessionEnabled == null || !isHostDevicePpdAvailable()) return;

    const shouldHost = ppdSessionEnabled;
    ppdHostingSyncRef.current = ppdHostingSyncRef.current
      .catch(() => {
        // A previous bridge failure must not prevent a later setting change from
        // reconciling the host.
      })
      .then(async () => {
        if (shouldHost) {
          await startHostDevicePpdHosting(
            () => {
              const display = getCurrentDisplay();
              const { styles: chordProStyles, rev: chordProStylesRev } = ppdSharedStylesRef.current;
              return {
                ...display,
                chordProStylesRev,
                chordProStyles,
              };
            },
            (songId) => {
              const song = Database.getInstance().getSongById(songId);
              return song ? { text: song.Text, system: song.System } : undefined;
            }
          );
        } else {
          await stopHostDevicePpdHosting();
        }
      })
      .catch((error) => {
        console.warn("[PPD] Failed to reconcile Android hosting state:", error);
      });
  }, [ppdSessionEnabled]);

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
  const continueTutorialAfterSyncRef = useRef(false);
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
  const preserveLoadedSongOnPlaylistSelectionRef = useRef(false);
  const playlistLoadTargetSongIdRef = useRef<string | null>(null);
  const pendingPlaylistSelectionIndexRef = useRef<number | null>(null);
  const [isEditing, setIsEditing] = useState(false);
  const [_editorInitialized, setEditorInitialized] = useState(false);
  // Remote highlight controller state - matching C# ProjectorForm.sectionListBox.Remote
  const [remoteHighlightController, setRemoteHighlightController] = useState<string>("");
  const [remoteHighlightActivityActive, setRemoteHighlightActivityActive] = useState(false);
  const remoteHighlightActivityTimerRef = useRef<number | null>(null);
  // Session watching mode state - matching C# ProjectorForm.watchedSessionOrDeviceId and related
  const [watchedSessionId, setWatchedSessionId] = useState<string | null>(null);
  const [_watchedSessionUrl, setWatchedSessionUrl] = useState<string | null>(null);
  const [watchedPlaylist, setWatchedPlaylist] = useState<Playlist | null>(null);
  const [ppdWatchAccess, setPpdWatchAccess] = useState<PpdSessionAccess | null>(null);
  const [ppdLeaderMode, setPpdLeaderMode] = useState(false);
  const [ppdRemoteSongs, setPpdRemoteSongs] = useState<Map<string, Song>>(() => new Map());
  const watchPollingAbortRef = useRef<AbortController | null>(null);
  const selectedLeaderRef = useRef<Leader | null>(selectedLeader);
  const settingsRef = useRef<Settings | null>(settings);
  const isWatching = watchedSessionId !== null;
  const ppdFollowUi = deriveFullViewPpdFollowUi(isWatching, ppdWatchAccess?.leaderModeAvailable === true, ppdLeaderMode);
  const ppdLeaderModeAvailable = ppdFollowUi.leaderModeAvailable;
  const ppdLeaderModeActive = ppdFollowUi.leaderModeActive;
  const previewPanelRef = useRef<PreviewPanelMethods>(null);
  const syncDeclinedAtRef = useRef<number | null>(null);
  const leftPanelRef = useRef<LeftPanelMethods>(null);
  const editorPanelRef = useRef<EditorPanel>(null);
  const editedSong = useEditedSong();
  const projectedSong = useProjectedSong();
  const [currentSongText, updateCurrentSongText] = useState<string>("");
  const { showConfirm, showConfirmAsync, showYesNoCancelAsync, showMessage } = useMessageBox();
  const tutorialStartupSuggestionCheckedRef = useRef(false);

  useEffect(() => {
    if (!settings || !eulaAccepted || tutorialStartupSuggestionCheckedRef.current) return;
    tutorialStartupSuggestionCheckedRef.current = true;
    if (!settings.suggestTutorialAtStartup) return;

    void showYesNoCancelAsync(t("TutorialStartupSuggestionTitle"), t("TutorialStartupSuggestionMessage"), {
      confirmText: t("TutorialStartupStart"),
      noText: t("TutorialStartupSkip"),
      cancelText: t("TutorialStartupDisable"),
    }).then((choice) => {
      if (choice === "yes") requestVisibleTutorialStart();
      if (choice === "cancel") updateSettingWithAutoSave("suggestTutorialAtStartup", false);
    });
  }, [eulaAccepted, settings, showYesNoCancelAsync, t, updateSettingWithAutoSave]);

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

  const markRemoteHighlightActivity = useCallback(() => {
    if (remoteHighlightActivityTimerRef.current !== null) {
      window.clearTimeout(remoteHighlightActivityTimerRef.current);
    }

    setRemoteHighlightActivityActive(true);
    const configuredSeconds = settingsRef.current?.remoteHighlightActivityTimeoutSeconds ?? 120;
    const timeoutSeconds = Number.isFinite(configuredSeconds) ? Math.max(1, Math.min(86400, Math.round(configuredSeconds))) : 120;
    remoteHighlightActivityTimerRef.current = window.setTimeout(() => {
      remoteHighlightActivityTimerRef.current = null;
      setRemoteHighlightActivityActive(false);
    }, timeoutSeconds * 1000);
  }, []);

  useEffect(() => {
    return () => {
      if (remoteHighlightActivityTimerRef.current !== null) {
        window.clearTimeout(remoteHighlightActivityTimerRef.current);
      }
    };
  }, []);

  // Track selected song ID for state persistence - initialized to null, restored after database loads
  const [_selectedSongId, setSelectedSongId] = useState<string | null>(null);
  // Song-tree neighbours of the current selection, pushed up by LeftPanel whenever
  // they change (see getAdjacentSongForFlip). Used to pre-render the page-turn.
  const [songTreeNeighbours, setSongTreeNeighbours] = useState<{ prev: Song | null; next: Song | null }>({ prev: null, next: null });
  const handleAdjacentSongsChange = useCallback((prev: Song | null, next: Song | null) => {
    setSongTreeNeighbours({ prev, next });
  }, []);
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
  const preSyncScheduledLeadersRef = useRef<Map<string, ScheduledPlaylist>>(new Map());

  // Persist updateable leaders across sync sessions
  const updateableLeadersRef = useRef<Set<string>>(new Set());

  // Panel layout state for persistence - use initial cached state for first render
  const [leftPanelSize, setLeftPanelSize] = useState<number>(initialAppState?.leftPanelSize ?? 25);
  const [editorPanelSize, setEditorPanelSize] = useState<number>(initialAppState?.editorPanelSize ?? 45);
  const [previewPanelSize, setPreviewPanelSize] = useState<number>(initialAppState?.previewPanelSize ?? 30);
  const [playlistPanelSize, setPlaylistPanelSize] = useState<number>(initialAppState?.playlistPanelSize ?? 60);
  const [songListPanelSize, setSongListPanelSize] = useState<number>(initialAppState?.songListPanelSize ?? 40);
  const [previewSplitSize, setPreviewSplitSize] = useState<number>(initialAppState?.previewSplitSize ?? 60);
  const [previewTab, setPreviewTab] = useState<"format" | "image" | "message" | "controls">(initialAppState?.previewTab ?? "format");
  const lastScheduledDisplayRef = useRef<Display>(getEmptyDisplay());

  // Song filter state for persistence
  const [songFilter, setSongFilter] = useState<string>(initialAppState?.songFilter ?? "");

  // Mirror the filter to the in-process shared store so the embedded client view's
  // filter box stays in lockstep with this LeftPanel (App-mode sync). Both sides
  // dedupe on equality, so this push/subscribe pair never loops.
  useEffect(() => {
    setSharedSongFilter(songFilter);
  }, [songFilter]);
  useEffect(() => subscribeSharedSongFilter(setSongFilter), []);

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
  const applyPlaylistSelection = useCallback(
    (selection: PlaylistSelectionEvent) => {
      playlistSelectionSourceRef.current = selection.source;
      setPlaylistSelection(selection);

      // A full-view PPD leader projects the selected remote row back to the host.
      // The local PlaylistPanel selection remains optimistic for instant feedback;
      // the normal display stream then confirms it with the host's canonical song.
      if (ppdLeaderModeActive && selection.item && selection.settled) {
        const item = selection.item;
        void sendHostDevicePpdDisplayUpdate({
          command: "display_update",
          id: item.songId,
          from: 0,
          to: 0,
          transpose: item.transpose,
          capo: item.capo,
          instructions: item.instructions,
        }).catch((error) => console.warn("[PPD] Failed to project full-view playlist selection:", error));
      }

      // Also update song tree to show the same song (visual consistency)
      // But NOT during restoration - we restore to savedState.selectedSongId instead
      if (selection.item && !isRestoringStateRef.current) {
        leftPanelRef.current?.setSelectedSongId(selection.item.songId);
        // Auto-select first section when user selects a new playlist item from UI
        setSelectedSectionIndex(0);
        previewPanelRef.current?.setSelectedSectionIndex(0);
      }
    },
    [ppdLeaderModeActive]
  );

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

  const cloudDisplayTarget = useMemo<DisplaySessionTarget | undefined>(
    () =>
      authStatus === "authenticated" && user?.leaderId
        ? { leaderId: user.leaderId }
        : authStatus === "guest" && guestSessionId
          ? { sessionId: guestSessionId }
          : undefined,
    [authStatus, user?.leaderId, guestSessionId]
  );

  const sendCloudDisplay = useCallback((display: Display, target: DisplaySessionTarget, force = false) => {
    return cloudApi.sendDisplayUpdate(
      {
        songId: display.songId,
        from: display.from,
        to: display.to,
        section: display.section,
        sectionRepeatNonce: display.sectionRepeatNonce,
        sectionRepeatCounts: display.sectionRepeatCounts,
        transpose: display.transpose,
        playlist: display.playlist,
        song: display.song,
        message: display.message,
        instructions: display.instructions,
      },
      { ...target, force }
    );
  }, []);

  const displayFailureMessage = useCallback(
    (result: Exclude<DisplayUpdateResult, "DONE" | "SKIPPED">) => {
      switch (result) {
        case "NO_SESSION":
          return t("OnlineSessionNoSession");
        case "UNAUTHORIZED":
          return t("OnlineSessionUnauthorized");
        case "UNKNOWN_LEADER":
          return t("OnlineSessionUnknownLeader");
        default:
          return t("OnlineSessionError");
      }
    },
    [t]
  );

  const handleDisplayUpdateFailure = useCallback(
    (result: Exclude<DisplayUpdateResult, "DONE" | "SKIPPED">, initial: boolean) => {
      setOnlineSessionError(result);
      const now = Date.now();
      if (initial || now - lastDisplayFailureToastAtRef.current >= CLOUD_NETWORK_TOAST_COOLDOWN_MS) {
        lastDisplayFailureToastAtRef.current = now;
        showToast(displayFailureMessage(result), "warning");
      }
      if (initial) updateSettingWithAutoSave("externalWebDisplayEnabled", false);
    },
    [displayFailureMessage, setOnlineSessionError, showToast, updateSettingWithAutoSave]
  );

  useEffect(() => {
    if (!settings?.externalWebDisplayEnabled && onlineSessionState.phase !== "error") {
      setOnlineSessionDisabled();
    }
  }, [settings?.externalWebDisplayEnabled, onlineSessionState.phase, setOnlineSessionDisabled]);

  useEffect(() => {
    if (authStatus === "authenticated" && guestSessionId) clearGuestSession();
  }, [authStatus, guestSessionId, clearGuestSession]);

  // Enabling cloud projection, logging in/out, or changing user always starts by
  // publishing a complete snapshot to the session owner's target. The QR URL is
  // withheld until this request returns DONE.
  useEffect(() => {
    if (!settings?.externalWebDisplayEnabled || isAuthLoading) return;
    let cancelled = false;

    if (authStatus === "authenticated" && !user?.leaderId) {
      handleDisplayUpdateFailure("UNKNOWN_LEADER", true);
      return;
    }

    if (authStatus === "guest" && !guestSessionId) {
      setOnlineSessionStarting();
      ensureGuestSession();
      return;
    }

    if (!cloudDisplayTarget) return;
    setOnlineSessionStarting();
    void sendCloudDisplay(getCurrentDisplay(), cloudDisplayTarget, true)
      .then((result) => {
        if (cancelled) return;
        if (result === "DONE" || result === "SKIPPED") setOnlineSessionActive();
        else handleDisplayUpdateFailure(result, true);
      })
      .catch(() => {
        if (cancelled) return;
        setOnlineSessionError("ERROR");
        updateSettingWithAutoSave("externalWebDisplayEnabled", false);
      });

    return () => {
      cancelled = true;
    };
  }, [
    settings?.externalWebDisplayEnabled,
    isAuthLoading,
    authStatus,
    user?.leaderId,
    guestSessionId,
    cloudDisplayTarget,
    ensureGuestSession,
    handleDisplayUpdateFailure,
    sendCloudDisplay,
    setOnlineSessionActive,
    setOnlineSessionError,
    setOnlineSessionStarting,
    updateSettingWithAutoSave,
  ]);

  useEffect(() => {
    if (!settings?.externalWebDisplayEnabled || onlineSessionState.phase !== "active" || !settings.stylesToClients || !settings.chordProStyles)
      return;
    if (!cloudDisplayTarget) return;

    cloudApi
      .sendDisplayStylesUpdate({ chordProStyles: settings.chordProStyles }, cloudDisplayTarget)
      .catch((err) => console.error("Cloud display styles update failed:", err));
  }, [settings?.externalWebDisplayEnabled, settings?.stylesToClients, settings?.chordProStyles, onlineSessionState.phase, cloudDisplayTarget]);

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

        const webServer = getWebServerInterface();
        if (webServer) {
          console.debug("API", "Syncing display to backend");
          void webServer.sync({ kind: "display", display });
        } else if (window.electronAPI?.setCurrentDisplay) {
          // Fallback for runtimes that have not wired the new webServer API yet.
          window.electronAPI.setCurrentDisplay(display);
        }

        // Send display update to cloud when external web display is enabled
        if (settings?.externalWebDisplayEnabled && onlineSessionState.phase === "active" && cloudDisplayTarget) {
          void sendCloudDisplay(display, cloudDisplayTarget)
            .then((result) => {
              if (result === "DONE" || result === "SKIPPED") {
                setOnlineSessionActive();
              } else if (result === "NO_SESSION" && "sessionId" in cloudDisplayTarget) {
                clearGuestSession();
                setOnlineSessionStarting();
              } else {
                handleDisplayUpdateFailure(result, false);
              }
            })
            .catch((err) => console.error("Cloud display update failed:", err));
        }
      };
      setTimeout(update, 50);
    },
    [
      settings?.externalWebDisplayEnabled,
      onlineSessionState.phase,
      cloudDisplayTarget,
      sendCloudDisplay,
      setOnlineSessionActive,
      clearGuestSession,
      setOnlineSessionStarting,
      handleDisplayUpdateFailure,
    ]
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

    const applyLeaderPreferencesToRemotePlaylist = (playlist: NonNullable<DisplayUpdateRequest["playlist"]>) => {
      if (!playlist || !leader) return playlist;

      return playlist.map((entry) => {
        const pref = leader.getPreference(entry.songId);
        if (!pref) return entry;

        const song = db.getSongById(entry.songId);
        const incomingTitle = entry.title || "";
        const usesDefaultTitle = !!song && incomingTitle === song.Title;

        return {
          ...entry,
          title: usesDefaultTitle && pref.title ? pref.title : incomingTitle,
          transpose: entry.transpose ?? pref.transpose ?? 0,
          capo: entry.capo ?? pref.capo ?? -1,
          instructions: entry.instructions == null ? (pref.instructions ?? "") : entry.instructions,
        };
      });
    };

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
        sectionRepeatNonce: data.sectionRepeatNonce ?? currentDisplay.sectionRepeatNonce,
        sectionRepeatCounts: data.sectionRepeatCounts ?? currentDisplay.sectionRepeatCounts,
        playlist: playlist?.items ?? currentDisplay.playlist,
      });
      return;
    }
    if (data.command === "display_update") {
      if (data.playlist) {
        leftPanelRef.current?.updatePlaylist(applyLeaderPreferencesToRemotePlaylist(data.playlist));
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
              sectionRepeatNonce: data.sectionRepeatNonce,
              sectionRepeatCounts: data.sectionRepeatCounts,
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
        if (data.section != null) previewPanelRef.current?.selectSectionByLine(data.from ?? 0, data.section);
        else if (data.from) previewPanelRef.current?.selectSectionByLine(data.from);
        // from=0, to=0 means "clear highlight" — deselect section to clear the projector,
        // mirroring the Escape key path (selectSectionIndex(-1)).
        else if (data.from === 0 && data.to === 0) previewPanelRef.current?.setSelectedSectionIndex(-1);
        // 3. Ensure correct transpose/capo/instructions (selectedPlaylistItem props may be stale)
        updateCurrentDisplay({
          transpose: data.transpose ?? currentDisplay.transpose,
          capo: data.capo ?? currentDisplay.capo,
          instructions: data.instructions ?? currentDisplay.instructions,
          sectionRepeatNonce: data.sectionRepeatNonce ?? currentDisplay.sectionRepeatNonce,
          sectionRepeatCounts: data.sectionRepeatCounts ?? currentDisplay.sectionRepeatCounts,
          playlist: playlist?.items ?? currentDisplay.playlist,
        });
      }
    }
  };

  const syncHostSelectionFromClientView = useCallback(
    (loadedSongId: string | null) => {
      const db = Database.getInstance();
      const projectedSongId = getCurrentDisplay().songId || null;

      if (projectedSongId) {
        const selection = leftPanelRef.current?.setPlaylistSelection({ songId: projectedSongId, emitChange: false }) ?? null;
        if (selection?.item) {
          preserveLoadedSongOnPlaylistSelectionRef.current = !!loadedSongId && loadedSongId !== projectedSongId;
          setPlaylistSelection(selection);
        } else {
          leftPanelRef.current?.setPlaylistSelection(null);
          setPlaylistSelection(null);
        }

        const projected = db.getSongById(projectedSongId);
        if (projected) {
          setProjectedSong(projected.clone());
        }
      } else {
        leftPanelRef.current?.setPlaylistSelection(null);
        setPlaylistSelection(null);
        setProjectedSong(null);
      }

      if (loadedSongId) {
        const loaded = db.getSongById(loadedSongId);
        if (loaded) {
          const cloned = loaded.clone();
          setEditedSong(cloned);
          updateCurrentSongText(cloned.Text);
          setSelectedSongId(loaded.Id);
          leftPanelRef.current?.setSelectedSongId(loaded.Id);
        }
      }
    },
    [updateCurrentSongText]
  );

  useEffect(() => {
    void syncAndroidServedClientAssets();
  }, []);

  useEffect(() => {
    // Route the embedded client view's display changes through the same handler
    // used for remote webserver clients, so selection/preview/projector stay in sync.
    const cvHandler = (e: Event) => {
      const detail = (e as CustomEvent<DisplayUpdateRequest>).detail;
      if (detail) enqueue(() => remoteDisplayUpdateHandler(detail));
    };
    window.addEventListener("pp-cv-display-update", cvHandler);
    const cvSelectionHandler = (e: Event) => {
      const detail = (e as CustomEvent<string | null>).detail ?? null;
      syncHostSelectionFromClientView(detail);
    };
    window.addEventListener("pp-cv-sync-host-selection", cvSelectionHandler);

    const webServer = getWebServerInterface();
    const unsubscribe = webServer?.onEvent((event) => {
      if (event.kind !== "remoteDisplayUpdate") return;
      enqueue(() => remoteDisplayUpdateHandler(event.update));
    });
    return () => {
      window.removeEventListener("pp-cv-display-update", cvHandler);
      window.removeEventListener("pp-cv-sync-host-selection", cvSelectionHandler);
      unsubscribe?.();
    };
  }, [syncHostSelectionFromClientView]);

  // Set up general webserver API handler
  useEffect(() => {
    const webServer = getWebServerInterface();
    if (!webServer) {
      console.warn("App", "WebServer interface not available: cannot handle webserver API requests");
      return;
    }

    const handleWebserverApiRequest = async (apiRequest: WebServerApiRequest) => {
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
          // Own (synced) leaders plus the read-only public mirror, tagged so
          // REST clients can group them without a local database.
          const data: LeadersResponse = [
            ...db.getAllLeaders().map((leader) => ({ ...leader.toJSON(), access: "own" as const })),
            ...db.getPublicLeaders().map((leader) => ({ ...leader.toJSON(), access: "public" as const })),
          ];
          response = {
            status: 200,
            data,
            headers: { "Content-Type": "application/json" },
          };
        } else if (apiRequest.method === "POST" && apiRequest.path === "/store_list") {
          type StoreListBody = {
            label?: string;
            scheduled?: number | string;
            songs?: DisplayPlaylistEntry[];
          };
          const body = (apiRequest.body ?? {}) as StoreListBody;
          const scheduledNumber = typeof body.scheduled === "number" ? body.scheduled : body.scheduled ? Number(body.scheduled) : 0;
          const date =
            scheduledNumber > 0
              ? new Date(new Date(scheduledNumber).setHours(0, 0, 0, 0))
              : (parseScheduleDate(body.label) ?? new Date(new Date().setHours(0, 0, 0, 0)));
          const forced = apiRequest.query.forced === true || apiRequest.query.forced === "true";

          if (!leader) {
            response = {
              status: 400,
              data: "No leader selected",
              headers: { "Content-Type": "application/json" },
            };
          } else {
            const exists = leader.getSchedule().some((d) => formatLocalDateKey(d) === formatLocalDateKey(date));
            if (exists && !forced) {
              response = {
                status: 200,
                data: "OVERWRITE",
                headers: { "Content-Type": "application/json" },
              };
            } else {
              const entries = (body.songs ?? []).map((entry) => PlaylistEntry.fromJSON(entry));
              db.schedule(leader, date, new Playlist(formatLocalDateLabel(date), entries));
              response = {
                status: 200,
                data: "OK",
                headers: { "Content-Type": "application/json" },
              };
            }
          }
        } else if (apiRequest.method === "GET" && apiRequest.path === "/search") {
          const text = (apiRequest.query.text as string) || "";
          const limit = (apiRequest.query.limit as string) || "";
          const songIdQuery = apiRequest.query.songId ?? apiRequest.query.songIds;
          const songIds = (Array.isArray(songIdQuery) ? songIdQuery : [songIdQuery])
            .flatMap((value) => (typeof value === "string" ? value.split(",") : []))
            .map((value) => value.trim())
            .filter(Boolean);
          const parsedLimit = limit ? parseInt(limit) : NaN;
          const maxResults = Number.isNaN(parsedLimit) ? (songIds.length > 0 ? songIds.length : 30) : parsedLimit;
          const results = await db.filter(
            text,
            leader,
            true,
            true,
            true,
            SongOrder.LessCostMatch,
            settingsRef.current,
            songIds.length > 0 ? songIds : undefined
          );
          const data: SongFound[] = results.slice(0, maxResults > 0 ? maxResults : undefined).map((found) => ({
            songId: found.song.Id,
            title: found.song.Title,
            found: { type: FormatFoundReason(found.reason), cost: found.cost, snippet: found.snippet },
          }));
          response = {
            status: 200,
            data,
            headers: { "Content-Type": "application/json" },
          };
        }
        // Add more routes here as needed...

        // Send response back to webserver
        await webServer.respond({
          kind: "api",
          response: {
            requestId: apiRequest.requestId,
            ...response,
          },
        });
      } catch (error) {
        console.error("API", "Error handling webserver API request", error);
        await webServer.respond({
          kind: "api",
          response: {
            requestId: apiRequest.requestId,
            status: 500,
            data: { error: "Internal server error" },
          },
        });
      }
    };

    // Listen for general API requests
    const unsubscribe = webServer.onEvent((event) => {
      if (event.kind !== "apiRequest") return;
      void handleWebserverApiRequest(event.request);
    });
    console.debug("App", "Webserver API request handler set up");
    // Cleanup listener on unmount
    return () => {
      unsubscribe();
    };
  }, []);

  // Initialize remote highlight controller state from backend (only once on mount)
  useEffect(() => {
    const webServer = getWebServerInterface();
    if (!webServer) return;

    webServer.query({ kind: "highlightController" }).then((result) => {
      if (result.kind === "highlightController") {
        setRemoteHighlightController(result.clientId || "");
      }
    });
  }, []);

  // Set up highlight access control handlers - matching C# HighlightAccessReqAsync/HighlightChangedRemotelyAsync
  useEffect(() => {
    const webServer = getWebServerInterface();
    if (!webServer) return;

    const unsubscribe = webServer.onEvent((event) => {
      if (event.kind === "highlightAccessRequest") {
        // Show confirmation dialog - matching C# MessageBoxEx.Show with AskRemoteHighlightModifyPermission
        showConfirm(
          t("RemoteHighlight"),
          t("AskRemoteHighlightModifyPermission"),
          () => {
            // User granted access
            void webServer.respond({ kind: "highlightAccess", clientId: event.clientId, grant: true });
          },
          () => {
            // User denied access
            void webServer.respond({ kind: "highlightAccess", clientId: event.clientId, grant: false });
          },
          { confirmText: t("AllowRemoteControl") }
        );
        return;
      }

      if (event.kind === "highlightChanged") {
        markRemoteHighlightActivity();
        // Keep authorized client activity visible even while remote execution is
        // disabled, but only apply the requested section when the persisted host
        // switch allows it.
        if (settingsRef.current?.remoteHighlightControlEnabled !== false) {
          previewPanelRef.current?.selectSectionByLine(event.line, event.section);
        } else {
          console.info("App", "Ignored remote highlight section change while remote control is disabled", {
            line: event.line,
            section: event.section,
          });
        }
        return;
      }

      if (event.kind === "highlightControllerChanged") {
        setRemoteHighlightController(event.clientId || "");
      }
    });

    return () => {
      unsubscribe();
    };
  }, [markRemoteHighlightActivity, showConfirm, t]);

  // PPD v2 reuses the same host UI and projection logic as HTTP remote control.
  // Only the transport differs: hostDevicePpd emits DOM events because Android's
  // PPD loop already runs in this renderer, while Electron forwards raw packets
  // here through the host-device bridge.
  useEffect(() => {
    const onAccessRequest = (event: Event) => {
      const detail = (event as CustomEvent<PpdHighlightAccessRequestDetail>).detail;
      if (!detail?.clientId || typeof detail.respond !== "function") return;
      showConfirm(
        t("RemoteHighlight"),
        t("AskRemoteHighlightModifyPermission"),
        () => detail.respond(true),
        () => detail.respond(false),
        { confirmText: t("AllowRemoteControl") }
      );
    };
    const onHighlightChanged = (event: Event) => {
      const detail = (event as CustomEvent<{ from: number; to: number; section?: number }>).detail;
      if (!detail || typeof detail.from !== "number" || typeof detail.to !== "number") return;
      markRemoteHighlightActivity();
      if (settingsRef.current?.remoteHighlightControlEnabled === false) return;
      if (detail.from === 0 && detail.to === 0) previewPanelRef.current?.setSelectedSectionIndex(-1);
      else previewPanelRef.current?.selectSectionByLine(detail.from, detail.section);
    };
    const onControllerChanged = (event: Event) => {
      setRemoteHighlightController((event as CustomEvent<string>).detail || "");
    };

    window.addEventListener(PPD_HIGHLIGHT_ACCESS_REQUEST_EVENT, onAccessRequest);
    window.addEventListener(PPD_HIGHLIGHT_CHANGED_EVENT, onHighlightChanged);
    window.addEventListener(PPD_HIGHLIGHT_CONTROLLER_CHANGED_EVENT, onControllerChanged);
    return () => {
      window.removeEventListener(PPD_HIGHLIGHT_ACCESS_REQUEST_EVENT, onAccessRequest);
      window.removeEventListener(PPD_HIGHLIGHT_CHANGED_EVENT, onHighlightChanged);
      window.removeEventListener(PPD_HIGHLIGHT_CONTROLLER_CHANGED_EVENT, onControllerChanged);
    };
  }, [markRemoteHighlightActivity, showConfirm, t]);

  // Handle playlist item selection - sets projectedSong and (if not editing) editedSong
  useEffect(() => {
    console.debug("App", `selectedPlaylistItem effect: item=${selectedPlaylistItem?.songId}, isEditing=${isEditing}, isAuthLoading=${isAuthLoading}`);
    const preserveLoadedSong = preserveLoadedSongOnPlaylistSelectionRef.current;
    if (preserveLoadedSong) {
      preserveLoadedSongOnPlaylistSelectionRef.current = false;
    }
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
        const song = db.getSongById(targetSongId) ?? ppdRemoteSongs.get(targetSongId);
        console.debug("App", `Loading song from playlist selection: songId=${targetSongId}, found=${song?.Title || "NOT FOUND"}`);
        if (song) {
          const clonedSong = song.clone();
          // Always set projected song from playlist
          setProjectedSong(clonedSong);

          // Only update edited song if we're not currently editing AND not restoring
          // During restoration, we preserve the editor's song from savedState.selectedSongId
          if (!isEditing && !isRestoringStateRef.current && !preserveLoadedSong) {
            setEditedSong(clonedSong);
            updateCurrentSongText(clonedSong.Text);
          } else if (preserveLoadedSong) {
            console.debug("App", "Skipping editor song update during client-view handoff");
          } else if (isRestoringStateRef.current) {
            console.debug("App", "Skipping editor song update during restoration");
          }

          // Sync song tree selection - but NOT during restoration (we restore to savedState.selectedSongId instead)
          if (!isRestoringStateRef.current && !preserveLoadedSong) {
            console.debug("App", `Syncing song tree selection: ${targetSongId}`);
            leftPanelRef.current?.setSelectedSongId(targetSongId);
          } else if (preserveLoadedSong) {
            console.debug("App", "Skipping song tree sync during client-view handoff");
          } else {
            console.debug("App", "Skipping song tree sync during restoration");
          }
        }
      };

      void loadSong();
    }
  }, [selectedPlaylistItem, isEditing, isAuthLoading, ppdRemoteSongs]);

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
  }, [isGuest, remoteChangeCount, settings?.syncDeclineTimeoutMinutes, showConfirm, t]);

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
                    const savedSong = current.clone();
                    db.updateSong(savedSong);
                    if (decision.action === "import-and-group" && decision.groupWithSong) {
                      db.MakeGroup(savedSong, decision.groupWithSong);
                      current.GroupId = savedSong.GroupId;
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
            const savedSong = current.clone();
            db.updateSong(savedSong);
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
      const savedSong = editedSong.clone();
      db.updateSong(savedSong);

      // If user chose to group with an existing song, create the group
      if (groupWithSong) {
        db.MakeGroup(savedSong, groupWithSong);
        editedSong.GroupId = savedSong.GroupId;
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

  const navigateSongByDelta = (delta: 1 | -1) => {
    if (selectedPlaylistItem) {
      const playlist = leftPanelRef.current?.getCurrentPlaylist();
      if (!playlist) return;
      const idx = playlist.items.findIndex((item) => item.songId === selectedPlaylistItem.songId);
      const nextIdx = idx + delta;
      if (nextIdx >= 0 && nextIdx < playlist.items.length) {
        leftPanelRef.current?.setPlaylistSelection({ songId: playlist.items[nextIdx].songId, emitChange: true });
      }
    } else {
      const song = leftPanelRef.current?.getAdjacentSong(delta);
      if (song) void handleSongSelected(song);
    }
  };

  const handleSwipePrev = () => navigateSongByDelta(-1);
  const handleSwipeNext = () => navigateSongByDelta(1);

  // Keep the local database as the zero-latency page-turn source. Only missing
  // PPD neighbours are fetched from the host, then cached for subsequent turns.
  useEffect(() => {
    if (!isWatching || !ppdWatchAccess?.capabilities.includes("song.fetch") || !watchedPlaylist || !projectedSong) {
      if (!isWatching && ppdRemoteSongs.size) setPpdRemoteSongs(new Map());
      return;
    }
    const currentIndex = watchedPlaylist.items.findIndex((item) => item.songId === projectedSong.Id);
    if (currentIndex < 0) return;
    const ids = [watchedPlaylist.items[currentIndex - 1]?.songId, watchedPlaylist.items[currentIndex + 1]?.songId].filter(
      (songId): songId is string => !!songId && !Database.getInstance().getSongById(songId) && !ppdRemoteSongs.has(songId)
    );
    if (!ids.length) return;
    let cancelled = false;
    void Promise.allSettled(
      ids.map(async (songId) => {
        const data = await requestHostDevicePpdSongData(songId);
        const song = new Song(data.text, data.system);
        song.Id = songId;
        return song;
      })
    ).then((results) => {
      if (cancelled) return;
      const loaded = results.flatMap((result) => (result.status === "fulfilled" ? [result.value] : []));
      if (!loaded.length) return;
      setPpdRemoteSongs((current) => {
        const next = new Map(current);
        for (const song of loaded) next.set(song.Id, song);
        return next;
      });
    });
    return () => {
      cancelled = true;
    };
  }, [isWatching, ppdRemoteSongs, ppdWatchAccess, projectedSong, watchedPlaylist]);

  // Resolve the adjacent song (without navigating) so the editor can pre-render
  // it behind the current page for the page-turn reveal. Uses playlist order
  // when a playlist item is selected, otherwise the song-tree order.
  //
  // The song-tree half is pushed up by LeftPanel instead of read off the ref here:
  // the tree's selection and its visible order both settle in a later commit than
  // this render (on startup the restore sets them after App's last render), so a
  // ref read returned null and the editor kept blank neighbour pages until the
  // next re-render — i.e. until the song was re-picked in the list by hand.
  const getAdjacentSongForFlip = (delta: 1 | -1): Song | null => {
    if (isWatching && watchedPlaylist && projectedSong) {
      const currentIndex = watchedPlaylist.items.findIndex((item) => item.songId === projectedSong.Id);
      const adjacent = watchedPlaylist.items[currentIndex + delta];
      if (!adjacent) return null;
      return Database.getInstance().getSongById(adjacent.songId) ?? ppdRemoteSongs.get(adjacent.songId) ?? null;
    }
    if (selectedPlaylistItem) {
      const playlist = leftPanelRef.current?.getCurrentPlaylist();
      if (!playlist) return null;
      const idx = playlist.items.findIndex((item) => item.songId === selectedPlaylistItem.songId);
      if (idx < 0) return null;
      const nextIdx = idx + delta;
      if (nextIdx < 0 || nextIdx >= playlist.items.length) return null;
      return Database.getInstance().getSongById(playlist.items[nextIdx].songId) ?? null;
    }
    return delta < 0 ? songTreeNeighbours.prev : songTreeNeighbours.next;
  };
  const prevSongForFlip = getAdjacentSongForFlip(-1);
  const nextSongForFlip = getAdjacentSongForFlip(1);

  // Check if current playlist has unsaved changes for a remembered schedule date
  // and offer to save before syncing. Returns true to proceed with sync, false to cancel.
  const checkAndSaveScheduledPlaylist = useCallback(async (): Promise<boolean> => {
    const origin = leftPanelRef.current?.getPlaylistOrigin();
    if (!origin) return true;

    // Public playlist sources are read-only. For own sources, update the exact
    // leader/date the working copy came from, independently of the selected leader.
    const sourceLeader = Database.getInstance().getLeaderById(origin.leaderId);
    if (!sourceLeader) return true;
    const scheduleDate = new Date(origin.scheduledAt);

    const currentPlaylist = leftPanelRef.current?.getCurrentPlaylist();
    if (!currentPlaylist) return true;

    const savedPlaylist = sourceLeader.getPlaylist(scheduleDate);
    if (savedPlaylist && currentPlaylist.equals(savedPlaylist)) return true; // No changes

    const dateStr = formatLocalDateLabel(scheduleDate);
    const result = await showYesNoCancelAsync(t("UpdateScheduledPlaylist"), t("AskUpdateScheduledPlaylist").replace("{0}", dateStr), {
      confirmText: t("UpdatePlaylistConfirm"),
    });
    if (result === "yes") {
      Database.getInstance().schedule(sourceLeader, scheduleDate, currentPlaylist);
    }
    return result !== "cancel";
  }, [showYesNoCancelAsync, t]);

  const openDBSyncDialog = useCallback((continueTutorialAfterSync: boolean) => {
    continueTutorialAfterSyncRef.current = continueTutorialAfterSync;
    setShowDBSync(true);
  }, []);

  const continueTutorialAfterSyncFlow = useCallback((shouldContinue: boolean) => {
    if (!shouldContinue) return;
    requestAnimationFrame(() => {
      requestTutorialContinueWhenUnblocked("full", ".dbsync-dialog-backdrop, .auth-dialog-backdrop, .messagebox-overlay");
    });
  }, []);

  // Check if user can start sync (matching C# IsLoadedSongUnmodified and SyncDatabase)
  const handleSyncRequest = useCallback(
    async (continueTutorialAfterSync: boolean) => {
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
              openDBSyncDialog(continueTutorialAfterSync);
            } else {
              continueTutorialAfterSyncFlow(continueTutorialAfterSync);
            }
          },
          () => continueTutorialAfterSyncFlow(continueTutorialAfterSync),
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
              openDBSyncDialog(continueTutorialAfterSync);
            } else {
              continueTutorialAfterSyncFlow(continueTutorialAfterSync);
            }
          },
          () => continueTutorialAfterSyncFlow(continueTutorialAfterSync),
          { confirmText: t("DownloadPublicSongs") }
        );
        return;
      }

      if (!isAuthenticated) {
        if (networkUnavailable) {
          const reachable = await recheckNetworkAvailability();
          if (!reachable) {
            suppressCloudNetworkToast();
            showMessage(t("SyncError"), t("CloudNetworkErrorMessage"));
            continueTutorialAfterSyncFlow(continueTutorialAfterSync);
            return;
          }
        }

        const restored = await restoreStoredSession();
        if (restored) {
          if (await checkAndSaveScheduledPlaylist()) {
            openDBSyncDialog(continueTutorialAfterSync);
          } else {
            continueTutorialAfterSyncFlow(continueTutorialAfterSync);
          }
          return;
        }

        window.dispatchEvent(new CustomEvent("pp-open-auth-dialog", { detail: { continueTutorialAfterSync } }));
        return;
      }

      if (await checkAndSaveScheduledPlaylist()) {
        openDBSyncDialog(continueTutorialAfterSync);
      } else {
        continueTutorialAfterSyncFlow(continueTutorialAfterSync);
      }
    },
    [
      isEditing,
      canSaveSong,
      showConfirm,
      showMessage,
      t,
      networkUnavailable,
      recheckNetworkAvailability,
      restoreStoredSession,
      isAuthenticated,
      isGuest,
      checkAndSaveScheduledPlaylist,
      continueTutorialAfterSyncFlow,
      openDBSyncDialog,
    ]
  );

  const handleSyncClick = useCallback(
    (continueTutorialAfterSync = false) => {
      void handleSyncRequest(continueTutorialAfterSync);
    },
    [handleSyncRequest]
  );

  const handleSongCheckClick = useCallback(async () => {
    if (isGuest) return; // Song check not available for guests
    if (!isAuthenticated) {
      if (networkUnavailable) {
        const reachable = await recheckNetworkAvailability();
        if (!reachable) {
          suppressCloudNetworkToast();
          showMessage(t("SyncError"), t("CloudNetworkErrorMessage"));
          return;
        }
      }

      const restored = await restoreStoredSession();
      if (restored) {
        setShowSongCheck(true);
        return;
      }

      window.dispatchEvent(new CustomEvent("pp-open-auth-dialog", { detail: { action: "songCheck" } }));
      return;
    }
    setShowSongCheck(true);
  }, [networkUnavailable, recheckNetworkAvailability, restoreStoredSession, isAuthenticated, isGuest, showMessage, t]);

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
        // Keep the followed playlist in CurrentSongStore as well as the full
        // view's watchedPlaylist state. The embedded client-view subscribes to
        // CurrentSongStore, so dropping this field made its read-only list keep
        // the old local playlist while remote song changes arrived.
        playlist: display.playlist ?? currentDisplay.playlist,
        playlist_id: display.playlist_id ?? emtyDisplay.playlist_id,
        section: display.section ?? emtyDisplay.section,
        sectionRepeatNonce: display.sectionRepeatNonce ?? emtyDisplay.sectionRepeatNonce,
        sectionRepeatCounts: display.sectionRepeatCounts,
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

  const handlePpdAccessUpdate = useCallback((access: PpdSessionAccess) => {
    setPpdWatchAccess(access);
    if (!access.leaderModeAvailable) setPpdLeaderMode(false);
  }, []);

  const togglePpdLeaderMode = useCallback(() => {
    if (!ppdLeaderModeAvailable) return;
    setPpdLeaderMode((enabled) => !enabled);
  }, [ppdLeaderModeAvailable]);

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
    setPpdWatchAccess(null);
    setPpdLeaderMode(false);
    setPpdRemoteSongs(new Map());

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

  // Project displays from a session the EMBEDDED client view is following. The
  // embed's DirectClientApi runs the follow loop (PPD / cloud long-poll) and
  // dispatches each display here, where the SAME applyDisplay path the full view's
  // watch mode uses projects it (handles an arbitrary remote song via display.song,
  // not just working-playlist songs). "pp-cv-watch-stop" exits watch mode.
  useEffect(() => {
    const onWatchDisplay = (e: Event) => {
      const display = (e as CustomEvent<Display>).detail;
      if (!display) return;
      if (!watchedDisplayRef.current) watchedDisplayRef.current = getEmptyDisplay();
      applyDisplay(display);
    };
    const onWatchStop = () => {
      // The embed-follow path projects via applyDisplay without entering the formal
      // watch-mode state machine (watchedSessionId stays null), so exitWatchMode's
      // guarded song-clear is skipped. This event only fires when the embed stops
      // following, so clear the followed projection here — otherwise the last remote
      // song lingers on the projector after Stop.
      setEditedSong(null);
      setProjectedSong(null);
      updateCurrentSongText("");
      exitWatchModeRef.current();
    };
    window.addEventListener("pp-cv-watch-display", onWatchDisplay);
    window.addEventListener("pp-cv-watch-stop", onWatchStop);
    return () => {
      window.removeEventListener("pp-cv-watch-display", onWatchDisplay);
      window.removeEventListener("pp-cv-watch-stop", onWatchStop);
    };
  }, [applyDisplay, updateCurrentSongText]);

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

      setPpdWatchAccess(null);
      setPpdLeaderMode(false);
      setPpdRemoteSongs(new Map());

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
        void startHostDeviceWatching(sessionId, udpDetails, handleUdpDisplayUpdate, handleUdpSessionEnded, handlePpdAccessUpdate).then((started) => {
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
    [updateCurrentSongText, watchOnlineDisplay, handleUdpDisplayUpdate, handleUdpSessionEnded, handlePpdAccessUpdate]
  );

  // Launch viewer - show sessions dialog (matching C# OnDeviceButtonClicked)
  // C# pattern: ExitSessionWatchingMode first, then show SessionsForm dialog
  const handleLaunchViewer = useCallback(() => {
    // Exit current watch mode first (matching C# OnDeviceButtonClicked calling ExitSessionWatchingMode)
    exitWatchMode();
    setShowSessionsForm(true);
  }, [exitWatchMode]);

  const handleSwitchToMobileView = useCallback(() => {
    window.dispatchEvent(new Event("pp-show-client-view"));
  }, []);

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
    const [leaderId, scheduled] = actual.entries().next().value as [string, ScheduledPlaylist];
    const confirmed = await showConfirmAsync(t("LoadTodayPlaylistTitle"), t("AskLoadTodayPlaylist"), { confirmText: t("LoadPlaylistConfirm") });
    if (!confirmed) return;

    // Select the leader and load the playlist.
    // These are independent: loadScheduledPlaylist() sets the working copy and its source via ref,
    // while the leader context propagates asynchronously through React state.
    // PlaylistPanel.componentDidUpdate does not react to selectedLeader changes,
    // so there is no race condition or ordering dependency.
    updateSettingWithAutoSave("selectedLeader", leaderId);
    leftPanelRef.current?.loadScheduledPlaylist(leaderId, scheduled.date, scheduled.playlist);
  }, [showConfirmAsync, t, updateSettingWithAutoSave]);

  // Use paging mode whenever the client area is portrait or width is small.
  // Always use 3-panel layout in landscape mode.
  const usePagingMode = shouldUsePagingLayoutForOrientation(width, orientation);

  // Pull-down-from-the-tab-header refresh (paging mode only): same gesture and
  // single-level "just reload" behaviour as the client-view main-toolbar pull
  // (see ClientView.tsx / ClientViewStore.pullRefresh) — the same outcome F5 /
  // Ctrl+R already produce unconditionally (see electron/main.ts's before-input-event).
  const pagingPull = usePullToRefresh({ maxLevel: 1, onRelease: () => window.location.reload() });

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

  const prepareFullTutorial = useCallback(() => {
    if (
      showSessionsForm ||
      showDBSync ||
      showImportWizard ||
      compareDialogState !== null ||
      showSongCheck ||
      showEulaView ||
      isImporting ||
      !eulaAccepted ||
      document.querySelector(".auth-dialog-backdrop")
    ) {
      return false;
    }
    const previousPanel = activePanel;
    const previousPreviewTab = previewTab;
    const editorTabs = Array.from(document.querySelectorAll<HTMLAnchorElement>(".editor-tabs-header .nav-link"));
    const previousEditorTab = editorTabs.findIndex((tab) => tab.classList.contains("active"));
    if (showSettings) closeSettings();
    return () => {
      setActivePanel(previousPanel);
      setPreviewTab(previousPreviewTab);
      if (previousEditorTab >= 0) {
        const tabs = Array.from(document.querySelectorAll<HTMLAnchorElement>(".editor-tabs-header .nav-link"));
        const tab = tabs[previousEditorTab];
        if (tab && !tab.classList.contains("active")) tab.click();
      }
    };
  }, [
    activePanel,
    closeSettings,
    compareDialogState,
    eulaAccepted,
    isImporting,
    previewTab,
    showDBSync,
    showEulaView,
    showImportWizard,
    showSessionsForm,
    showSettings,
    showSongCheck,
  ]);

  const handleTutorialCommand = useCallback(
    (command: TutorialCommand) => {
      if (command === "sync-now") {
        void handleSyncRequest(true).catch((error) => {
          console.error("Tutorial", "Synchronization request failed", error);
          continueTutorialAfterSyncFlow(true);
        });
      }
      if (command === "switch-client") handleSwitchToMobileView();
    },
    [continueTutorialAfterSyncFlow, handleSwitchToMobileView, handleSyncRequest]
  );

  return (
    <>
      <TutorialHost view="full" onBeforeStart={prepareFullTutorial} onCommand={handleTutorialCommand} />
      <ResponsiveFontSizeManager />
      <UpdateNotification />
      <ShareDialogHost />
      <DndProvider backend={HTML5Backend}>
        <div className="container-fluid vh-100 d-flex flex-column pp-app-shell p-1">
          {/* Paging mode layout (mobile portrait) - show/hide with CSS to preserve state */}
          <div style={{ display: usePagingMode ? "flex" : "none", flexDirection: "column", flexGrow: 1, minHeight: 0 }}>
            <div className="main-paging-buttons btn-group mb-2" ref={pagingPull.containerRef}>
              <button className={`btn ${activePanel === "side" ? "btn-primary" : "btn-secondary"}`} onClick={() => setActivePanel("side")}>
                {t("TabSongs")}
              </button>
              <button className={`btn ${activePanel === "editor" ? "btn-primary" : "btn-secondary"}`} onClick={() => setActivePanel("editor")}>
                {t("TabEditor")}
              </button>
              <button className={`btn ${activePanel === "preview" ? "btn-primary" : "btn-secondary"}`} onClick={() => setActivePanel("preview")}>
                {t("TabProjection")}
              </button>
              <PullRefreshSpinner phase={pagingPull.phase} offset={pagingPull.offset} progress={pagingPull.progress} level={pagingPull.level} />
            </div>
            <div className="flex-grow-1 min-height-0">
              <div style={{ display: activePanel === "side" ? "block" : "none", height: "100%" }}>
                {usePagingMode && (
                  <LeftPanel
                    ref={leftPanelRef}
                    onPlaylistSelectionChange={handlePlaylistSelectionChange}
                    onSongSelected={handleSongSelected}
                    onOpenLeaderSettings={openLeaderSettings}
                    following={isWatching}
                    ppdLeaderModeAvailable={ppdLeaderModeAvailable}
                    ppdLeaderMode={ppdLeaderModeActive}
                    onTogglePpdLeaderMode={togglePpdLeaderMode}
                    onOpenSessions={handleLaunchViewer}
                    onSyncClick={handleSyncClick}
                    onRemoteChangeCountChange={setRemoteChangeCount}
                    onSettingsClick={openSettings}
                    onExportDatabase={handleExportDatabase}
                    onImportDatabase={handleImportDatabase}
                    onReplaceDatabase={handleReplaceDatabase}
                    onSongCheckClick={handleSongCheckClick}
                    onExternalFilesDropped={handleSongTreeExternalFilesDropped}
                    selectedSong={editedSong}
                    onAdjacentSongsChange={handleAdjacentSongsChange}
                    disabled={ppdFollowUi.playlistDisabled}
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
                      onSwitchToMobileView={handleSwitchToMobileView}
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
                        onSwipePrev={handleSwipePrev}
                        onSwipeNext={handleSwipeNext}
                        prevSong={prevSongForFlip}
                        nextSong={nextSongForFlip}
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
                    remoteHighlightActive={!!remoteHighlightController || remoteHighlightActivityActive}
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
              leftPanelRef.current?.refreshLayout();
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
                      following={isWatching}
                      ppdLeaderModeAvailable={ppdLeaderModeAvailable}
                      ppdLeaderMode={ppdLeaderModeActive}
                      onTogglePpdLeaderMode={togglePpdLeaderMode}
                      onOpenSessions={handleLaunchViewer}
                      onSyncClick={handleSyncClick}
                      onRemoteChangeCountChange={setRemoteChangeCount}
                      onExportDatabase={handleExportDatabase}
                      onImportDatabase={handleImportDatabase}
                      onReplaceDatabase={handleReplaceDatabase}
                      onSongCheckClick={handleSongCheckClick}
                      onExternalFilesDropped={handleSongTreeExternalFilesDropped}
                      selectedSong={editedSong}
                      onAdjacentSongsChange={handleAdjacentSongsChange}
                      disabled={ppdFollowUi.playlistDisabled}
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
            <ResizeHandle className="mr-1 ml-1" />
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
                    onSwitchToMobileView={handleSwitchToMobileView}
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
                      onSwipePrev={handleSwipePrev}
                      onSwipeNext={handleSwipeNext}
                      prevSong={prevSongForFlip}
                      nextSong={nextSongForFlip}
                    />
                  </div>
                </div>
              )}
            </Panel>
            <ResizeHandle className="ml-1 mr-1" />
            <Panel defaultSize={previewPanelSize} minSize={25}>
              {!usePagingMode && (
                <PreviewPanel
                  ref={previewPanelRef}
                  editorRef={editorPanelRef}
                  selectedPlaylistItem={selectedPlaylistItem}
                  enableHighlight={projectedSong?.Id === editedSong?.Id}
                  currentSongText={currentSongText}
                  remoteHighlightActive={!!remoteHighlightController || remoteHighlightActivityActive}
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
                onClose={() => {
                  const continueTutorial = continueTutorialAfterSyncRef.current;
                  continueTutorialAfterSyncRef.current = false;
                  setShowDBSync(false);
                  continueTutorialAfterSyncFlow(continueTutorial);
                }}
                onComplete={async () => {
                  const continueTutorial = continueTutorialAfterSyncRef.current;
                  continueTutorialAfterSyncRef.current = false;
                  try {
                    // Update lastSyncDate when sync completes (matching C# DBSyncForm.SyncComplete)
                    updateSettingWithAutoSave("lastSyncDate", new Date().toISOString());
                    // Reload songs if they were changed during sync (matching C# RecheckLoadedSong)
                    recheckLoadedSongs();
                    // Check for newly available scheduled playlists (matching C# SyncDatabase - AskLoadTodayPlaylist)
                    await checkAndOfferTodayPlaylist();
                  } finally {
                    continueTutorialAfterSyncFlow(continueTutorial);
                  }
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
                      onCancel={messageBox.showCancel ? messageBox.onCancel : undefined}
                      showCancel={messageBox.showCancel ?? true}
                      confirmText={messageBox.confirmText}
                      noText={messageBox.noText}
                      cancelText={messageBox.cancelText}
                      confirmDanger={messageBox.confirmDanger}
                    />
                  )}
                </MessageBoxProvider>
              </UpdateProvider>
            </LeaderProvider>
          </TooltipProvider>
        </SettingsProvider>
      </ThemeProvider>
    </LocalizationProvider>
  );
};

export default App;
