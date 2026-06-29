import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import LogViewerPage from "./components/LogViewerPage";
import PrintWindow from "./components/PrintWindow";
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
import { useCallback, useEffect, useState } from "react";
import { ClientViewApp } from "./client-view/boot/ClientViewApp";
import { AuthProvider } from "./contexts/AuthContext";

/** Remembers whether the renderer was last showing the embedded new client view,
 *  so a reload (F5 / Ctrl+R) returns to the same UI instead of the full app. */
const SHOW_CLIENT_KEY = "pp-show-client-view";

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
    const toClient = () => setShowClient(true);
    const toMain = () => setShowClient(false);
    window.addEventListener("pp-show-client-view", toClient);
    window.addEventListener("pp-show-main-view", toMain);
    return () => {
      window.removeEventListener("pp-show-client-view", toClient);
      window.removeEventListener("pp-show-main-view", toMain);
    };
  }, [setShowClient]);
  // App stays mounted (hidden) while the client view is shown, so its state —
  // selection, projection, webserver/projector wiring — is preserved and the
  // embedded view can drive it through the shared CurrentSongStore.
  return (
    <>
      <div hidden={showClient}>
        <App />
      </div>
      {showClient && <ClientViewApp onHome={() => setShowClient(false)} />}
    </>
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
              <PrintWindow />
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
