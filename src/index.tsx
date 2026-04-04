import { createRoot } from "react-dom/client";
import App from "./App";
import { installConsoleInterceptor, subscribeToLogs } from "../common/logger";
import type { LogEntry } from "../common/logger";
import { Database } from "../db-common/Database";

// Install console interceptor early to capture all logs
installConsoleInterceptor();

// Forward frontend log entries to backend so both the dialog and
// the separate log viewer window can show them tagged as "frontend"
if (window.electronAPI?.logs?.sendEntry) {
  subscribeToLogs((entry: LogEntry) => {
    window.electronAPI!.logs!.sendEntry({
      timestamp: entry.timestamp,
      level: entry.level,
      message: entry.message,
      args: entry.args,
    });
  });
}

// Initialize database before rendering the app
// This ensures IndexedDB is ready and data is migrated from localStorage if needed.
// We initialize with guest mode (empty username) - AuthContext.loadInitialCredentials()
// will switch to the logged-in user's database when it verifies saved credentials.
Database.initialize()
  .then(() => {
    const rootEl = document.getElementById("root");
    if (!rootEl) {
      throw new Error("Root element not found");
    }
    createRoot(rootEl).render(<App />);
  })
  .catch((error) => {
    console.error("Failed to initialize database:", error);
    const rootEl = document.getElementById("root");
    if (!rootEl) {
      console.error("Root element not found; unable to render app");
      return;
    }
    // Render anyway with empty database
    createRoot(rootEl).render(<App />);
  });
