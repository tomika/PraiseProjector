import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import LogViewerPage from "./components/LogViewerPage";
import MessageBox from "./components/MessageBox";
import PrintWindow from "./components/PrintWindow";
import { MessageBoxProvider, type MessageBoxConfig } from "./contexts/MessageBoxContext";
import { LocalizationProvider } from "./localization/LocalizationContext";
import { ThemeProvider } from "./contexts/ThemeContext";
import { SettingsProvider } from "./contexts/SettingsContext";
import { TooltipProvider } from "./localization/TooltipContext";
import { installConsoleInterceptor, subscribeToLogs } from "../common/logger";
import "./index.css";
import "bootstrap/dist/css/bootstrap.min.css";
import "font-awesome/css/font-awesome.min.css";
import "./App.css";
import { cloudApi } from "../common/cloudApi";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ClientViewApp } from "./client-view/boot/ClientViewApp";
import { AuthProvider, useAuth } from "./contexts/AuthContext";
import { Database } from "../db-common/Database";
import { consumeClientViewHandoff } from "./services/clientViewHandoff";
import { OnlineSessionProvider } from "./contexts/OnlineSessionContext";
import { readPersistedSettings } from "./services/settingsStore";
import type { Settings } from "./types";
import { disableDefaultZoom } from "./utils/disableDefaultZoom";
import { shouldUsePagingLayout } from "./utils/viewLayout";
import { installUiAnimationPreference } from "./shared/performanceSettings";
import { reportPageLoadedSuccessfully } from "./services/webAppLaunchReport";
import { requestClientViewSwitch } from "./services/clientViewSwitchGuard";
import { WebAppUpdateActivityBar } from "./components/WebAppUpdateActivityBar";
import "./shared/performance.css";

/** Remembers whether the renderer was last showing the embedded new client view,
 *  so a reload (F5 / Ctrl+R) returns to the same UI instead of the full app. */
const SHOW_CLIENT_KEY = "pp-show-client-view";

/** How long the handoff gate waits for the local database before giving up and
 *  opening the full view. Storage that never resolves (a blocked IndexedDB in a
 *  private window, a full disk) must not leave the user on a spinner. */
const HANDOFF_DB_TIMEOUT_MS = 5000;
type AutomaticViewSwitch = Settings["automaticViewSwitch"];

disableDefaultZoom();
installUiAnimationPreference();

// Install console interceptor early to capture all logs
installConsoleInterceptor();

// Forward frontend log entries to backend so both the dialog and
// the separate log viewer window can show them tagged as "frontend"
if (window.electronAPI?.logs?.sendEntry) {
  subscribeToLogs((entry) => {
    window.electronAPI!.logs!.sendEntry({
      timestamp: entry.timestamp,
      level: entry.level,
      message: entry.message,
      args: entry.args,
    });
  });
}

if (window.electronAPI?.proxyGet && window.electronAPI?.proxyPost) {
  cloudApi.setProxy({
    proxyGet: window.electronAPI.proxyGet,
    proxyPost: window.electronAPI.proxyPost,
    proxyAbort: window.electronAPI.proxyAbort,
  });
}

function isAutomaticViewSwitch(value: unknown): value is AutomaticViewSwitch {
  return value === "none" || value === "portraitToClient" || value === "orientation";
}

function readAutomaticViewSwitch(): AutomaticViewSwitch {
  const value = readPersistedSettings().automaticViewSwitch;
  return isAutomaticViewSwitch(value) ? value : "none";
}

function isPagingViewport(): boolean {
  return shouldUsePagingLayout(window.innerWidth, window.innerHeight);
}

/**
 * Switches the desktop renderer between the main app and the embedded new client
 * view. The toolbar dispatches `pp-show-client-view`; the client view's home
 * button switches back via the `onHome` callback.
 */
function RootView() {
  const [showClient, setShowClientState] = useState(() => {
    try {
      return localStorage.getItem(SHOW_CLIENT_KEY) === "1";
    } catch {
      return false;
    }
  });
  // `showClient` can already be true on the very first render only when the page
  // is reloading an active embedded client view. A later in-page switch is a
  // fresh entry and must continue to seed from the live full-view host state.
  const [restorePersistedClientOnEntry, setRestorePersistedClientOnEntry] = useState(showClient);
  const [openOptionsOnClientEntry, setOpenOptionsOnClientEntry] = useState(false);
  // A standalone client view (a shared link opened in the Android app, a served
  // follower page) sent us here through the native host's goHome(). It asks for
  // this app's OWN client view, but that view is worth opening only if there is
  // something in the local database to show — so hold the choice until the
  // database of the RESOLVED user is readable. See services/clientViewHandoff.
  const [decidingHandoff, setDecidingHandoff] = useState(() => consumeClientViewHandoff());
  const { isLoading: isAuthLoading } = useAuth();
  const [automaticViewSwitch, setAutomaticViewSwitch] = useState<AutomaticViewSwitch>(() => readAutomaticViewSwitch());
  const [isPagingLayout, setIsPagingLayout] = useState(() => isPagingViewport());
  const previousPagingLayoutRef = useRef(isPagingLayout);
  const clientEntryRequestRef = useRef(0);
  const clientEntryAbortRef = useRef<AbortController | null>(null);

  useEffect(() => {
    reportPageLoadedSuccessfully();
  }, []);
  useEffect(
    () => () => {
      clientEntryAbortRef.current?.abort();
    },
    []
  );

  // Single setter that also persists, so every switch path (events + the client
  // view's home button) keeps the saved UI choice in sync. `persist: false` is for
  // a view chosen FOR the user rather than BY them (the handoff below), which must
  // not silently become their remembered choice.
  const setShowClient = useCallback((value: boolean, persist = true) => {
    setShowClientState(value);
    if (!value) {
      setOpenOptionsOnClientEntry(false);
      setRestorePersistedClientOnEntry(false);
    }
    if (!persist) return;
    try {
      localStorage.setItem(SHOW_CLIENT_KEY, value ? "1" : "0");
    } catch {
      /* storage may be unavailable (private mode) — non-fatal */
    }
  }, []);
  // Close the handoff gate exactly once, on whichever arrives first: the song
  // count, a failure, or the deadline. The flag is a ref so the two effects below
  // share it (and so StrictMode's remount cannot decide twice).
  const handoffSettledRef = useRef(false);
  const finishHandoff = useCallback(
    (hasSongs: boolean) => {
      if (handoffSettledRef.current) return;
      handoffSettledRef.current = true;
      // Songs → the client view this entry asked for. None → the full view, the
      // only place a synchronizable, empty database can be filled. Either way this
      // is the destination of ONE navigation, not a new view preference — the user
      // asked to leave a borrowed view, not to change which UI their app opens in.
      setShowClient(hasSongs, false);
      // A handoff is a FRESH entry into this app's client view, even when the
      // stored preference happens to be "client view": seed it from the live
      // full-view state, not from a snapshot of some earlier session.
      setRestorePersistedClientOnEntry(false);
      setDecidingHandoff(false);
    },
    [setShowClient]
  );
  // The deadline is armed when the GATE opens, not when auth settles: the auth
  // context clears isLoading only after Database.switchUser, so a database that
  // never loads would otherwise keep the read below from ever starting — and with
  // it the timeout — leaving the whole UI covered by the gate indefinitely.
  useEffect(() => {
    if (!decidingHandoff) return;
    const timer = setTimeout(() => finishHandoff(false), HANDOFF_DB_TIMEOUT_MS);
    return () => clearTimeout(timer);
  }, [decidingHandoff, finishHandoff]);
  // Read the song count once the database of the RESOLVED user is readable. The
  // auth context owns Database.switchUser and clears isLoading only after that
  // switch, so waiting on it is what keeps this from reading a logged-in user's
  // anonymous database (Database.waitForReady would happily initialize one).
  // App stays mounted underneath the gate, so its own startup runs meanwhile.
  useEffect(() => {
    if (!decidingHandoff || isAuthLoading) return;
    let cancelled = false;
    Database.waitForReady()
      .then((database) => {
        if (!cancelled) finishHandoff(database.getSongs().length > 0);
      })
      .catch(() => {
        if (!cancelled) finishHandoff(false);
      });
    return () => {
      cancelled = true;
    };
  }, [decidingHandoff, isAuthLoading, finishHandoff]);
  const refreshAutomaticViewSwitch = useCallback(() => {
    setAutomaticViewSwitch(readAutomaticViewSwitch());
  }, []);
  const refreshOrientation = useCallback(() => {
    setIsPagingLayout(isPagingViewport());
  }, []);
  const enterClientView = useCallback(
    async (openOptionsOnWideEntry: boolean) => {
      if (showClient) return;
      clientEntryAbortRef.current?.abort();
      const abortController = new AbortController();
      clientEntryAbortRef.current = abortController;
      const requestId = ++clientEntryRequestRef.current;
      const allowed = await requestClientViewSwitch(abortController.signal);
      if (clientEntryAbortRef.current === abortController) clientEntryAbortRef.current = null;
      if (!allowed || requestId !== clientEntryRequestRef.current) return;
      setOpenOptionsOnClientEntry(openOptionsOnWideEntry);
      setShowClient(true);
    },
    [setShowClient, showClient]
  );
  const enterMainView = useCallback(() => {
    clientEntryAbortRef.current?.abort();
    clientEntryAbortRef.current = null;
    clientEntryRequestRef.current += 1;
    setOpenOptionsOnClientEntry(false);
    setShowClient(false);
  }, [setShowClient]);
  useEffect(() => {
    const toClient = () => {
      void enterClientView(!isPagingViewport());
    };
    window.addEventListener("pp-show-client-view", toClient);
    window.addEventListener("pp-show-main-view", enterMainView);
    return () => {
      window.removeEventListener("pp-show-client-view", toClient);
      window.removeEventListener("pp-show-main-view", enterMainView);
    };
  }, [enterClientView, enterMainView]);
  useEffect(() => {
    const handleStorage = (event: StorageEvent) => {
      if (event.key === "pp-settings") refreshAutomaticViewSwitch();
    };
    window.addEventListener("pp-settings-changed", refreshAutomaticViewSwitch);
    window.addEventListener("storage", handleStorage);
    return () => {
      window.removeEventListener("pp-settings-changed", refreshAutomaticViewSwitch);
      window.removeEventListener("storage", handleStorage);
    };
  }, [refreshAutomaticViewSwitch]);
  useEffect(() => {
    window.addEventListener("resize", refreshOrientation);
    window.addEventListener("orientationchange", refreshOrientation);
    return () => {
      window.removeEventListener("resize", refreshOrientation);
      window.removeEventListener("orientationchange", refreshOrientation);
    };
  }, [refreshOrientation]);
  useEffect(() => {
    if (previousPagingLayoutRef.current === isPagingLayout) return;
    previousPagingLayoutRef.current = isPagingLayout;

    if (automaticViewSwitch === "orientation") {
      // Syncing the visible view to the device orientation (external system);
      // gated by the previousPagingLayoutRef check above so it runs once per flip.
      // eslint-disable-next-line react-hooks/set-state-in-effect
      if (isPagingLayout) void enterClientView(false);
      else enterMainView();
      return;
    }
    if (automaticViewSwitch === "portraitToClient" && isPagingLayout) {
      void enterClientView(false);
    }
  }, [automaticViewSwitch, enterClientView, enterMainView, isPagingLayout]);
  const embeddedClientConfig = useMemo(
    () => ({
      openOptionsOnWideEmbeddedEntry: openOptionsOnClientEntry,
      restorePersistedViewOnEntry: restorePersistedClientOnEntry,
    }),
    [openOptionsOnClientEntry, restorePersistedClientOnEntry]
  );
  // App stays mounted (hidden) while the client view is shown, so its state —
  // selection, projection, webserver/projector wiring — is preserved and the
  // embedded view can drive it through the shared CurrentSongStore.
  const showClientView = showClient && !decidingHandoff;
  return (
    <>
      <WebAppUpdateActivityBar />
      <div hidden={showClientView}>
        <App />
      </div>
      {showClientView && <ClientViewApp config={embeddedClientConfig} onHome={enterMainView} />}
      {/* Opaque while the handoff decides: the view underneath is the one that may
          still be replaced, and a half-second flash of the wrong UI reads as a bug. */}
      {decidingHandoff && (
        <div className="pp-view-gate loading-overlay" role="status" aria-busy="true">
          <div className="loading-spinner" />
        </div>
      )}
    </>
  );
}

/** Supplies the editor's dialog context in the standalone print route. */
function PrintWindowShell() {
  const [messageBox, setMessageBox] = useState<MessageBoxConfig | null>(null);

  return (
    <MessageBoxProvider onMessageBoxChange={setMessageBox}>
      <PrintWindow />
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
  );
}

// Check if this is the log viewer window (opened with #/logs hash)
const isLogViewer = window.location.hash === "#/logs";
const isPrintWindow = window.location.hash === "#/print";

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    {isLogViewer ? (
      <ThemeProvider>
        <LocalizationProvider>
          <LogViewerPage />
        </LocalizationProvider>
      </ThemeProvider>
    ) : isPrintWindow ? (
      <ThemeProvider>
        <LocalizationProvider>
          <SettingsProvider>
            <TooltipProvider>
              <PrintWindowShell />
            </TooltipProvider>
          </SettingsProvider>
        </LocalizationProvider>
      </ThemeProvider>
    ) : (
      <AuthProvider>
        <OnlineSessionProvider>
          <RootView />
        </OnlineSessionProvider>
      </AuthProvider>
    )}
  </React.StrictMode>
);
