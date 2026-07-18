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
import { AuthProvider } from "./contexts/AuthContext";
import { readPersistedSettings } from "./services/settingsStore";
import type { Settings } from "./types";
import { disableDefaultZoom } from "./utils/disableDefaultZoom";
import { shouldUsePagingLayout } from "./utils/viewLayout";

/** Remembers whether the renderer was last showing the embedded new client view,
 *  so a reload (F5 / Ctrl+R) returns to the same UI instead of the full app. */
const SHOW_CLIENT_KEY = "pp-show-client-view";
type AutomaticViewSwitch = Settings["automaticViewSwitch"];

disableDefaultZoom();

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
  const [openOptionsOnClientEntry, setOpenOptionsOnClientEntry] = useState(false);
  const [automaticViewSwitch, setAutomaticViewSwitch] = useState<AutomaticViewSwitch>(() => readAutomaticViewSwitch());
  const [isPagingLayout, setIsPagingLayout] = useState(() => isPagingViewport());
  const previousPagingLayoutRef = useRef(isPagingLayout);
  // Single setter that also persists, so every switch path (events + the client
  // view's home button) keeps the saved UI choice in sync.
  const setShowClient = useCallback((value: boolean) => {
    setShowClientState(value);
    try {
      localStorage.setItem(SHOW_CLIENT_KEY, value ? "1" : "0");
    } catch {
      /* storage may be unavailable (private mode) — non-fatal */
    }
  }, []);
  useEffect(() => {
    // Clear the one-shot "open options on entry" flag whenever the client view
    // is left; deliberate dependent-state reset tied to showClient.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    if (!showClient) setOpenOptionsOnClientEntry(false);
  }, [showClient]);
  const refreshAutomaticViewSwitch = useCallback(() => {
    setAutomaticViewSwitch(readAutomaticViewSwitch());
  }, []);
  const refreshOrientation = useCallback(() => {
    setIsPagingLayout(isPagingViewport());
  }, []);
  useEffect(() => {
    const toClient = () => {
      if (!showClient) setOpenOptionsOnClientEntry(!isPagingViewport());
      setShowClient(true);
    };
    const toMain = () => {
      setOpenOptionsOnClientEntry(false);
      setShowClient(false);
    };
    window.addEventListener("pp-show-client-view", toClient);
    window.addEventListener("pp-show-main-view", toMain);
    return () => {
      window.removeEventListener("pp-show-client-view", toClient);
      window.removeEventListener("pp-show-main-view", toMain);
    };
  }, [setShowClient, showClient]);
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
      setShowClient(isPagingLayout);
      return;
    }
    if (automaticViewSwitch === "portraitToClient" && isPagingLayout) {
      setShowClient(true);
    }
  }, [automaticViewSwitch, isPagingLayout, setShowClient]);
  const embeddedClientConfig = useMemo(
    () => ({
      openOptionsOnWideEmbeddedEntry: openOptionsOnClientEntry,
    }),
    [openOptionsOnClientEntry]
  );
  // App stays mounted (hidden) while the client view is shown, so its state —
  // selection, projection, webserver/projector wiring — is preserved and the
  // embedded view can drive it through the shared CurrentSongStore.
  return (
    <>
      <div hidden={showClient}>
        <App />
      </div>
      {showClient && (
        <ClientViewApp
          config={embeddedClientConfig}
          onHome={() => {
            setOpenOptionsOnClientEntry(false);
            setShowClient(false);
          }}
        />
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
        <RootView />
      </AuthProvider>
    )}
  </React.StrictMode>
);
