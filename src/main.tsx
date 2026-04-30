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
      <App />
    )}
  </React.StrictMode>
);
