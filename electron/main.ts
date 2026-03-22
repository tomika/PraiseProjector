// The bare minimum code required for an Electron main process

import { app, BrowserWindow, ipcMain, screen, dialog, shell, powerSaveBlocker, type MessageBoxOptions, type MessageBoxReturnValue } from "electron";
import { autoUpdater } from "electron-updater";
import path from "node:path";
import fs from "node:fs";
import { exec as execCb } from "node:child_process";
import { promisify } from "node:util";
import os from "node:os";
const execAsync = promisify(execCb);
import { getProxyConfigValue, initializeProxy } from "./proxy";
import { UdpServer, getUdpServerInstance } from "./udp";
import { P2PTransport, getP2PTransportInstance } from "./p2p-transport";
import { initializeWebServer, getWebServerInstance } from "./webserver";
import { Settings } from "../src/types";
import { setupBLEPeripheralIPC } from "./blePeripheral";
import { installLoggerInterceptor, setupLoggerIPC, closeLogViewerWindow } from "./logger";
import { changeDisplay } from "./display";
import { WindowBounds } from "../src/types/electron";

const APPWINDOW_MIN_WIDTH = 360;
const APPWINDOW_MIN_HEIGHT = 695;

// Ensure the userData path is stable across versions and name changes.
// Electron derives this from package.json "name" / electron-builder "productName".
// Hardcoding it here prevents accidental data loss if those fields ever change.
const stableAppName = "PraiseProjector";
app.setName(stableAppName);
// On Windows: %APPDATA%\PraiseProjector
// On macOS:   ~/Library/Application Support/PraiseProjector
// On Linux:   ~/.config/PraiseProjector

// Single-instance lock to prevent multiple app instances
// Uses Electron's built-in lock (doesn't rely on file flags, survives process crashes)
const gotTheLock = app.requestSingleInstanceLock();

if (!gotTheLock) {
  // Another instance is already running, exit this one
  app.quit();
}

// Handle attempts to start a second instance
app.on("second-instance", () => {
  // Someone tried to run a second instance, we should focus our window
  if (mainWindow) {
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.focus();
  }
});

// Track powerSaveBlocker ID to prevent duplicate blockers
let powerSaveBlockerId: number | null = null;

// Install logger interceptor early to capture all console output
installLoggerInterceptor();
setupLoggerIPC();

console.log(`[Main] userData path: ${app.getPath("userData")}`);

// Suppress bleno exit errors on Windows when Bluetooth adapter isn't properly configured
// The @abandonware/bleno native bindings register an exit handler that crashes if the HCI socket isn't available
process.on("uncaughtException", (error) => {
  // Ignore bleno-related errors during exit (controlTransfer undefined on HCI socket)
  if (error.message?.includes("controlTransfer") && error.stack?.includes("BlenoBindings")) {
    console.log("[Main] Suppressed bleno exit error (Bluetooth not available)");
    return;
  }
  // Re-throw other errors
  console.error("[Main] Uncaught exception:", error);
  throw error;
});

let mainWindow: BrowserWindow | null = null;

// Localization strings loaded from JSON files, keyed by language code.
const mainLocStrings: Record<string, Record<string, string>> = {};

const getMainLanguage = (): string => {
  const locale = app.getLocale() || "en";
  const match = locale.match(/^([a-zA-Z]{2})/);
  return match ? match[1].toLowerCase() : "en";
};

const getMainLocalizedString = (key: string): string => {
  const lang = getMainLanguage();
  return mainLocStrings[lang]?.[key] || mainLocStrings["en"]?.[key] || key;
};

const loadMainLocalizationStrings = (): void => {
  const locDir = app.isPackaged ? path.join(process.resourcesPath, "localization") : path.join(__dirname, "..", "..", "src", "localization");
  for (const lang of ["en", "hu"]) {
    try {
      const filePath = path.join(locDir, `strings.${lang}.json`);
      const content = fs.readFileSync(filePath, "utf8");
      mainLocStrings[lang] = JSON.parse(content);
    } catch (err) {
      console.warn(`[Main] Could not load localization for '${lang}':`, err);
    }
  }
};

const parseHostList = (rawValue: string): Set<string> => {
  return new Set(
    rawValue
      .split(",")
      .map((host) => host.trim().toLowerCase())
      .filter((host) => host.length > 0)
  );
};

const getTrustedExternalDomains = (): Set<string> => {
  // Source: proxy-config.json -> proxyAllowedHosts
  const fromProxyList = getProxyConfigValue("PP_PROXY_ALLOWED_HOSTS");
  if (fromProxyList) return parseHostList(fromProxyList);

  // Fallback: derive from proxy-config.json cloudApiHost.
  const cloudApiHost = getProxyConfigValue("VITE_CLOUD_API_HOST");
  if (!cloudApiHost) return new Set();
  try {
    const host = new URL(cloudApiHost).hostname.toLowerCase();
    return host ? new Set([host]) : new Set();
  } catch {
    return new Set();
  }
};

const TRUSTED_EXTERNAL_DOMAINS = getTrustedExternalDomains();

const isProductionRuntime = () => app.isPackaged && !process.env.VITE_DEV_SERVER_URL;

const isTrustedDomain = (hostname: string): boolean => {
  const host = hostname.toLowerCase();
  if (TRUSTED_EXTERNAL_DOMAINS.has(host)) return true;
  for (const trusted of TRUSTED_EXTERNAL_DOMAINS) {
    if (host.endsWith(`.${trusted}`)) return true;
  }
  return false;
};

const isLoopbackOrLanHost = (hostname: string): boolean => {
  const host = hostname.toLowerCase();
  if (host === "localhost" || host === "127.0.0.1" || host === "::1") return true;
  if (host.endsWith(".local") || host.endsWith(".lan")) return true;
  // Single-label hostnames are typically local network names (e.g. "my-pc").
  if (/^[a-z0-9-]+$/.test(host) && !host.includes(".")) return true;
  if (/^10\./.test(host)) return true;
  if (/^192\.168\./.test(host)) return true;
  const m = host.match(/^172\.(\d{1,2})\./);
  if (m) {
    const second = parseInt(m[1], 10);
    if (second >= 16 && second <= 31) return true;
  }
  return false;
};

const parseExternalUrl = (value: string): URL | null => {
  try {
    const parsed = new URL(value);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return null;
    return parsed;
  } catch {
    return null;
  }
};

const openExternalUrlSafely = async (value: string): Promise<void> => {
  const parsed = parseExternalUrl(value);
  if (!parsed) return;

  const protocol = parsed.protocol;
  const host = parsed.hostname;
  const trustedDomain = isTrustedDomain(host);
  const localAddress = isLoopbackOrLanHost(host);
  const inProduction = isProductionRuntime();

  // Reject deceptive URLs carrying embedded credentials.
  if (parsed.username || parsed.password) {
    await showMainMessageBox({
      type: "warning",
      title: getMainLocalizedString("ExternalLinkBlockedTitle"),
      message: getMainLocalizedString("ExternalLinkBlockedCredentialsMessage"),
      detail: `${value}`,
      buttons: [getMainLocalizedString("OK")],
      defaultId: 0,
      cancelId: 0,
      noLink: true,
    });
    return;
  }

  // In production, unknown/non-local URLs must use HTTPS.
  if (inProduction && protocol !== "https:" && !localAddress) {
    await showMainMessageBox({
      type: "warning",
      title: getMainLocalizedString("InsecureLinkBlockedTitle"),
      message: getMainLocalizedString("InsecureLinkBlockedMessage"),
      detail: `${value}`,
      buttons: [getMainLocalizedString("OK")],
      defaultId: 0,
      cancelId: 0,
      noLink: true,
    });
    return;
  }

  if (trustedDomain || localAddress) {
    await shell.openExternal(value);
    return;
  }

  // Unknown domain: phishing-safe confirmation.
  const confirm = await showMainMessageBox({
    type: "warning",
    title: getMainLocalizedString("ExternalLinkConfirmTitle"),
    message: getMainLocalizedString("ExternalLinkConfirmMessage"),
    detail: `${getMainLocalizedString("ExternalLinkDomainLabel")}: ${host}\n${getMainLocalizedString("ExternalLinkUrlLabel")}: ${value}`,
    buttons: [getMainLocalizedString("Open"), getMainLocalizedString("Cancel")],
    defaultId: 1,
    cancelId: 1,
    noLink: true,
  });

  if (confirm.response === 0) {
    await shell.openExternal(value);
  }
};

const showMainMessageBox = (options: MessageBoxOptions): Promise<MessageBoxReturnValue> => {
  const parentWindow = mainWindow && !mainWindow.isDestroyed() ? mainWindow : null;
  return parentWindow ? dialog.showMessageBox(parentWindow, options) : dialog.showMessageBox(options);
};

const resolveAppIcon = (): string | undefined => {
  const appPath = app.getAppPath();
  const candidates: string[] = [];

  if (process.platform === "win32") {
    candidates.push(path.join(appPath, "dist/build/icon.ico"));
    candidates.push(path.join(appPath, "public/assets/projector.ico"));
  } else if (process.platform === "darwin") {
    candidates.push(path.join(appPath, "dist/build/icon.icns"));
  } else {
    // Linux: in a packaged AppImage, dist/build/ is not bundled; public/ lands in extraResources
    if (app.isPackaged) {
      candidates.push(path.join(process.resourcesPath, "public", "assets", "pp-512.png"));
    }
    candidates.push(path.join(appPath, "dist/build/icon.png"));
  }

  candidates.push(path.join(appPath, "public/assets/pp-512.png"));

  for (const fullPath of candidates) {
    if (fs.existsSync(fullPath)) return fullPath;
  }

  return undefined;
};

export function getMainWindow(): BrowserWindow | null {
  return mainWindow && !mainWindow.isDestroyed() ? mainWindow : null;
}

// Configure auto-updater
autoUpdater.autoDownload = false;
autoUpdater.autoInstallOnAppQuit = true;
autoUpdater.allowPrerelease = false; // Use stable releases (latest.yml)
// Disable signature verification for unsigned builds in dev, but enforce in production.
autoUpdater.forceDevUpdateConfig = !isProductionRuntime();
// Note: channel defaults to "latest" which uses latest.yml
autoUpdater.logger = console;

function setupAutoUpdater() {
  // Log info after a delay to ensure feed URL is populated from app-update.yml
  console.log("=== AUTO-UPDATER SETUP ===");
  console.log("Current app version:", app.getVersion());
  console.log("Update channel:", autoUpdater.channel);
  console.log("Feed URL:", autoUpdater.getFeedURL());

  // Check for updates after app is ready
  autoUpdater
    .checkForUpdates()
    .then((result) => {
      console.log("Update check completed");
      console.log("Server version:", result?.updateInfo?.version);
      console.log("Update available:", result?.updateInfo?.version !== app.getVersion());
    })
    .catch((err) => {
      console.error("Auto-update check failed:", err.message);
      console.error("Full error:", err);
    });

  autoUpdater.on("update-available", (info) => {
    console.log("Update available:", info.version);
    // Notify renderer about available update
    mainWindow?.webContents.send("update-available", info);
  });

  autoUpdater.on("update-not-available", () => {
    console.log("No updates available");
  });

  autoUpdater.on("download-progress", (progress) => {
    mainWindow?.webContents.send("update-download-progress", progress);
  });

  autoUpdater.on("update-downloaded", (info) => {
    console.log("Update downloaded:", info.version);
    mainWindow?.webContents.send("update-downloaded", info);
  });

  autoUpdater.on("error", (err) => {
    console.error("Auto-updater error:", err);
  });
}

// IPC handlers for auto-update
ipcMain.handle("check-for-updates", async () => {
  try {
    const result = await autoUpdater.checkForUpdates();
    return { available: !!result?.updateInfo, version: result?.updateInfo?.version };
  } catch (err) {
    console.error("Update check failed:", err);
    return { available: false, error: (err as Error).message };
  }
});

ipcMain.handle("download-update", async () => {
  try {
    await autoUpdater.downloadUpdate();
    return { success: true };
  } catch (err) {
    console.error("Update download failed:", err);
    return { success: false, error: (err as Error).message };
  }
});

ipcMain.handle("install-update", () => {
  autoUpdater.quitAndInstall(false, true);
});

ipcMain.handle("get-app-version", () => {
  return app.getVersion();
});

const createWindow = () => {
  // Create the browser window.
  mainWindow = new BrowserWindow({
    width: 1024,
    height: 695,
    minWidth: APPWINDOW_MIN_WIDTH,
    minHeight: APPWINDOW_MIN_HEIGHT,
    autoHideMenuBar: true,
    icon: resolveAppIcon(),
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
      webSecurity: true,
    },
  });

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    void openExternalUrlSafely(url).catch(() => {});
    return { action: "deny" };
  });

  mainWindow.webContents.on("will-navigate", (event, navigationUrl) => {
    const currentUrl = mainWindow?.webContents.getURL();
    if (currentUrl && navigationUrl !== currentUrl) {
      event.preventDefault();
      void openExternalUrlSafely(navigationUrl).catch(() => {});
    }
  });

  // Enable Web Bluetooth API - provides hassle-free BLE communication
  // Users select devices from a browser-style dialog, no OS pairing required
  mainWindow.webContents.on("select-bluetooth-device", (event, devices, callback) => {
    event.preventDefault();

    // If there are devices, show them in a selection dialog
    if (devices.length > 0) {
      // For now, auto-select the first PraiseProjector device if found
      const ppDevice = devices.find((d) => d.deviceName?.includes("PraiseProjector"));
      if (ppDevice) {
        callback(ppDevice.deviceId);
      } else {
        // Let the user see all devices - Web Bluetooth will show its own dialog
        callback("");
      }
    } else {
      callback("");
    }
  });

  // and load the index.html of the app.
  // VITE_DEV_SERVER_URL will be set by the vite-plugin-electron during development
  if (process.env.VITE_DEV_SERVER_URL) {
    mainWindow.loadURL(process.env.VITE_DEV_SERVER_URL);
  } else {
    // Load the index.html when not in development
    // __dirname is dist/electron, so we need to go up one level to dist/, then into webapp/
    mainWindow.loadFile(path.join(__dirname, `../webapp/index.html`));
  }

  mainWindow.on("closed", () => {
    // Close the log viewer window when main window closes
    closeLogViewerWindow();
    // Close the projector display window when main window closes
    if (displayWindow && !displayWindow.isDestroyed()) {
      displayWindow.close();
      displayWindow = null;
    }
    mainWindow = null;
  });

  // Open the DevTools.
  // mainWindow.webContents.openDevTools();

  // Ensure the native menu bar stays hidden
  mainWindow.setMenu(null);
  mainWindow.setMenuBarVisibility(false);

  // Hide the menu bar in child windows opened via window.open()
  mainWindow.webContents.on("did-create-window", (childWindow) => {
    childWindow.setMenu(null);
    childWindow.setMenuBarVisibility(false);
    childWindow.setAutoHideMenuBar(true);

    // Enable F12 / Ctrl+Shift+I for DevTools in child windows
    childWindow.webContents.on("before-input-event", (_event, input) => {
      if (input.key === "F12" || (input.control && input.shift && input.key.toLowerCase() === "i")) {
        childWindow?.webContents.toggleDevTools();
      }
    });
  });

  // Open DevTools with F12 or Ctrl+Shift+I
  mainWindow.webContents.on("before-input-event", (_event, input) => {
    if (input.type !== "keyDown") return; // Ignore keyUp to avoid double-toggling
    if (input.key === "F12" || (input.control && input.shift && input.key.toLowerCase() === "i")) {
      mainWindow?.webContents.toggleDevTools();
    } else if (input.key === "F5" || (input.control && input.key.toLowerCase() === "r")) {
      mainWindow?.webContents.reload();
    } else if (input.key === "F11") {
      mainWindow?.setFullScreen(!mainWindow.isFullScreen());
    }
  });
};

// This method will be called when Electron has finished
// initialization and is ready to create browser windows.
// Some APIs can only be used after this event occurs.
app.on("ready", () => {
  // Log storage paths for diagnostics - helps debug data loss reports
  console.log(`[Main] App version: ${app.getVersion()}`);
  console.log(`[Main] App name: ${app.name}`);
  console.log(`[Main] userData: ${app.getPath("userData")}`);
  console.log(`[Main] appData: ${app.getPath("appData")}`);
  console.log(`[Main] exe: ${app.getPath("exe")}`);
  console.log(
    `[Main] trusted external domains: ${TRUSTED_EXTERNAL_DOMAINS.size > 0 ? Array.from(TRUSTED_EXTERNAL_DOMAINS).join(", ") : "(none configured)"}`
  );

  loadMainLocalizationStrings();

  createWindow();
  initializeProxy();

  // Setup BLE Peripheral IPC handlers (works if @abandonware/bleno is installed)
  // DISABLED: Bluetooth support is untested - re-enable when ready
  // if (mainWindow) setupBLEPeripheralIPC(mainWindow);

  // Setup auto-updater after window content is loaded (only in production)
  // This ensures the renderer has subscribed to update events before we emit them
  if (!process.env.VITE_DEV_SERVER_URL) {
    mainWindow?.webContents.on("did-finish-load", () => {
      // Additional delay to ensure React components have mounted
      setTimeout(() => {
        setupAutoUpdater();
      }, 2000);
    });
  }

  const webServer = initializeWebServer();
  UdpServer.initialize(webServer).then((udpServer) => {
    if (!udpServer) {
      console.error("Failed to initialize UDP server");
      return;
    }
    // Initialize P2P transport with both UDP and Bluetooth
    P2PTransport.initialize(webServer, udpServer).then((p2p) => {
      console.log(`P2P Transport initialized - Status: ${JSON.stringify(p2p.getStatus())}`);
    });
  });
});

// Quit when all windows are closed, except on macOS. There, it's common
// for applications and their menu bar to stay active until the user quits
// explicitly with Cmd + Q.
app.on("window-all-closed", () => {
  if (process.platform !== "darwin") {
    app.quit();
  }
});

app.on("activate", () => {
  // On OS X it's common to re-create a window in the app when the
  // dock icon is clicked and there are no other windows open.
  if (BrowserWindow.getAllWindows().length === 0) {
    createWindow();
  }
});

// IPC handlers for display state

ipcMain.handle("set-current-display", async (_event, display) => {
  await changeDisplay(display);
});

// IPC handlers for window bounds persistence
ipcMain.handle("get-window-bounds", () => {
  const win = mainWindow;
  if (!win) return null;
  const isMaximized = win.isMaximized();
  // When maximized, return the restore bounds (normal window position/size before maximize)
  // so we don't persist the maximized dimensions as the normal window size
  const bounds = isMaximized ? win.getNormalBounds() : win.getBounds();
  return { ...bounds, isMaximized };
});

ipcMain.handle("set-window-bounds", (_event, bounds: WindowBounds) => {
  const win = mainWindow;
  if (!win) return;

  // Validate that bounds are within visible screen area
  const displays = screen.getAllDisplays();
  const isVisible = displays.some((display) => {
    const db = display.bounds;
    // Check if window overlaps with this display
    return bounds.x < db.x + db.width && bounds.x + bounds.width > db.x && bounds.y < db.y + db.height && bounds.y + bounds.height > db.y;
  });

  if (isVisible) {
    // Enforce minimum size – setBounds() bypasses minWidth/minHeight
    bounds.width = Math.max(bounds.width, APPWINDOW_MIN_WIDTH);
    bounds.height = Math.max(bounds.height, APPWINDOW_MIN_HEIGHT);
    // Always restore normal bounds first, then maximize if needed
    win.setBounds(bounds);
  }

  if (bounds.isMaximized) win.maximize();
});

ipcMain.handle("get-main-window-display-id", () => {
  const win = mainWindow;
  if (!win) return null;

  const display = screen.getDisplayMatching(win.getBounds());
  return display?.id ? display.id.toString() : null;
});

// IPC handlers for display/monitor management
let displayWindow: BrowserWindow | null = null;

ipcMain.handle("get-all-displays", () => {
  const displays = screen.getAllDisplays();
  return displays.map((display) => ({
    id: display.id.toString(),
    bounds: display.bounds,
    workArea: display.workArea,
    scaleFactor: display.scaleFactor,
    rotation: display.rotation,
    internal: display.internal,
  }));
});

ipcMain.handle("show-display-window", async (_event, displayId: string, imageData: string) => {
  const displays = screen.getAllDisplays();
  const targetDisplay = displays.find((d) => d.id.toString() === displayId);

  if (!targetDisplay) {
    console.error("Display not found:", displayId);
    return;
  }

  // Close existing display window if any
  if (displayWindow && !displayWindow.isDestroyed()) {
    displayWindow.close();
  }

  // Create new display window on target display
  displayWindow = new BrowserWindow({
    x: targetDisplay.bounds.x,
    y: targetDisplay.bounds.y,
    width: targetDisplay.bounds.width,
    height: targetDisplay.bounds.height,
    fullscreen: true,
    frame: false,
    alwaysOnTop: true,
    skipTaskbar: true,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
      webSecurity: true,
    },
  });

  // Load HTML with the image — subsequent updates are pushed via
  // the set-net-display-image handler which calls updateDisplayWindowImage()
  const html = `
    <!DOCTYPE html>
    <html>
    <head>
      <style>
        body { 
          margin: 0; 
          padding: 0; 
          background: black; 
          display: flex; 
          align-items: center; 
          justify-content: center;
          overflow: hidden;
        }
        img { 
          max-width: 100%; 
          max-height: 100vh; 
          object-fit: contain;
        }
      </style>
    </head>
    <body>
      <img src="${imageData}" />
    </body>
    </html>
  `;

  displayWindow.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`);
});

ipcMain.handle("hide-display-window", () => {
  if (displayWindow && !displayWindow.isDestroyed()) {
    displayWindow.close();
    displayWindow = null;
  }
});

ipcMain.handle("is-display-window-open", () => {
  return !!(displayWindow && !displayWindow.isDestroyed());
});

// IPC handlers for playlist file operations
ipcMain.handle("save-playlist-file", async (_event, content: string) => {
  try {
    const result = await dialog.showSaveDialog({
      title: "Save Playlist",
      defaultPath: "playlist.ppl",
      filters: [
        { name: "Playlist Files", extensions: ["ppl"] },
        { name: "All Files", extensions: ["*"] },
      ],
    });

    if (result.canceled || !result.filePath) {
      return { success: false, error: "Cancelled" };
    }

    await fs.promises.writeFile(result.filePath, content, "utf-8");
    return { success: true, filePath: result.filePath };
  } catch (error) {
    return { success: false, error: (error as Error).message };
  }
});

ipcMain.handle("load-playlist-file", async () => {
  try {
    const result = await dialog.showOpenDialog({
      title: "Load Playlist",
      filters: [
        { name: "Playlist Files", extensions: ["ppl"] },
        { name: "All Files", extensions: ["*"] },
      ],
      properties: ["openFile"],
    });

    if (result.canceled || result.filePaths.length === 0) {
      return { success: false, error: "Cancelled" };
    }

    const content = await fs.promises.readFile(result.filePaths[0], "utf-8");
    return { success: true, content };
  } catch (error) {
    return { success: false, error: (error as Error).message };
  }
});

// Settings sync from renderer - update webserver settings
ipcMain.on("sync-settings", (_event, settings: Settings) => {
  console.log("Settings synced from renderer:", settings);
  const webServer = getWebServerInstance();
  if (webServer) {
    webServer.updateSettings({
      webServerPort: settings.webServerPort,
      webServerPath: settings.webServerPath,
      webServerDomainName: settings.webServerDomainName,
      webServerAcceptLanClientsOnly: settings.webServerAcceptLanClientsOnly,
      longPollTimeout: settings.longPollTimeout,
      allClientsCanUseLeaderMode: settings.allClientsCanUseLeaderMode,
      leaderModeClients: settings.leaderModeClients,
    });
  }

  // Handle keepAwake via powerSaveBlocker
  if (settings.keepAwake) {
    if (powerSaveBlockerId === null || !powerSaveBlocker.isStarted(powerSaveBlockerId)) {
      powerSaveBlockerId = powerSaveBlocker.start("prevent-display-sleep");
      console.log(`[Main] powerSaveBlocker started (id: ${powerSaveBlockerId})`);
    }
  } else {
    if (powerSaveBlockerId !== null && powerSaveBlocker.isStarted(powerSaveBlockerId)) {
      powerSaveBlocker.stop(powerSaveBlockerId);
      console.log(`[Main] powerSaveBlocker stopped (id: ${powerSaveBlockerId})`);
      powerSaveBlockerId = null;
    }
  }
});

// Update the Electron display window image directly from the main process
function updateDisplayWindowImage(pngDataUrl: string | null): void {
  if (!displayWindow || displayWindow.isDestroyed()) return;
  if (pngDataUrl) {
    displayWindow.webContents.executeJavaScript(`document.querySelector('img').src = ${JSON.stringify(pngDataUrl)};`).catch(() => {});
  } else {
    displayWindow.webContents.executeJavaScript(`document.querySelector('img').removeAttribute('src');`).catch(() => {});
  }
}

// Net display image update from renderer (matching C# SetImage)
ipcMain.on("set-net-display-image", (_event, imageDataUrl: string | null) => {
  const webServer = getWebServerInstance();
  if (webServer) {
    webServer.setImage(imageDataUrl);
  }
});

// Internal Electron display window image update (lossless frame)
ipcMain.on("set-display-window-image", (_event, imageDataUrl: string | null) => {
  updateDisplayWindowImage(imageDataUrl);
});

// Sync leader name (for UDP offer - C# uses cmbLeader.Text which is the name, not ID)
ipcMain.on("sync-leader-name", (_event, leaderName: string) => {
  console.log("Leader name synced:", leaderName);
  const webServer = getWebServerInstance();
  if (webServer) {
    webServer.updateSettings({ currentLeader: leaderName });
  }
});

// Get connected clients from webserver (for leader-mode client selection)
ipcMain.handle("get-connected-clients", () => {
  const webServer = getWebServerInstance();
  return webServer?.getConnectedClients() ?? [];
});

// Highlight access control - respond to user's permission decision
ipcMain.on("respond-highlight-access", (_event, data: { clientId: string; grant: boolean }) => {
  const webServer = getWebServerInstance();
  if (webServer) {
    webServer.respondHighlightControllerRequest(data.clientId, data.grant);
    // Notify renderer about the new controller state
    if (mainWindow) {
      mainWindow.webContents.send("remote-highlight-controller-changed", {
        clientId: data.grant ? data.clientId : webServer.getRemoteHighlightController(),
      });
    }
  }
});

// Get current remote highlight controller
ipcMain.handle("get-remote-highlight-controller", () => {
  const webServer = getWebServerInstance();
  return webServer?.getRemoteHighlightController() || "";
});

// General API proxy - no specific handlers needed, webserver uses direct IPC communication

// P2P session scanning IPC handlers (unified UDP + Bluetooth)
// These handlers maintain the same "udp-" prefix for backwards compatibility
// but internally use the P2P transport layer for both UDP and Bluetooth
ipcMain.handle("udp-get-broadcast-address", () => {
  const udpServer = getUdpServerInstance();
  return udpServer?.getBroadcastAddress() || "255.255.255.255";
});

ipcMain.handle("udp-scan-sessions", async (_event, broadcastAddress?: string) => {
  const p2p = getP2PTransportInstance();
  if (!p2p) {
    // Fallback to UDP-only if P2P not initialized
    const udpServer = getUdpServerInstance();
    if (!udpServer) {
      return { success: false, error: "P2P transport not initialized" };
    }
    return udpServer.scanForSessions(broadcastAddress);
  }
  return p2p.startDiscovery(broadcastAddress);
});

ipcMain.handle("udp-get-discovered-sessions", () => {
  const p2p = getP2PTransportInstance();
  if (p2p) {
    // Return unified sessions from both UDP and Bluetooth
    return p2p.getDiscoveredSessions();
  }
  // Fallback to UDP-only
  const udpServer = getUdpServerInstance();
  if (!udpServer) {
    return [];
  }
  return udpServer.getDiscoveredSessions();
});

// P2P watch mode IPC handlers - matching C# EnterSessionWatchingMode/ExitSessionWatchingMode
// Accepts either raw session parameters (legacy UDP) or prefixed endpoint IDs (P2P)
ipcMain.handle(
  "udp-start-watching",
  (_event, deviceIdOrEndpoint: string, hostId?: string, address?: string, port?: number): { success: boolean; error?: string } => {
    const p2p = getP2PTransportInstance();

    // Check if this is a prefixed P2P endpoint ID
    if (deviceIdOrEndpoint.startsWith("udp_") || deviceIdOrEndpoint.startsWith("bt_")) {
      if (!p2p) {
        return { success: false, error: "P2P transport not initialized" };
      }

      const success = p2p.startWatching(
        deviceIdOrEndpoint,
        (display) => {
          getMainWindow()?.webContents.send("udp-display-update", display);
        },
        () => {
          getMainWindow()?.webContents.send("udp-session-ended");
        }
      );

      return { success };
    }

    // Legacy mode: raw session parameters (for backwards compatibility)
    const udpServer = getUdpServerInstance();
    if (!udpServer) {
      return { success: false, error: "UDP server not initialized" };
    }

    // Set up callbacks that will send IPC messages to renderer
    udpServer.startWatching(
      deviceIdOrEndpoint, // deviceId
      hostId || deviceIdOrEndpoint,
      address || "",
      port || 0,
      (display) => {
        // Send display update to renderer process
        getMainWindow()?.webContents.send("udp-display-update", display);
      },
      () => {
        // Notify renderer that watched session ended
        getMainWindow()?.webContents.send("udp-session-ended");
      }
    );

    return { success: true };
  }
);

ipcMain.handle("udp-stop-watching", () => {
  const p2p = getP2PTransportInstance();
  if (p2p) {
    p2p.stopWatching();
  } else {
    const udpServer = getUdpServerInstance();
    if (udpServer) {
      udpServer.stopWatching();
    }
  }
  return { success: true };
});

// P2P transport status handler
ipcMain.handle("p2p-get-status", () => {
  const p2p = getP2PTransportInstance();
  if (!p2p) {
    return { udpAvailable: false, bluetoothAvailable: false, isAdvertising: false, isDiscovering: false };
  }
  return p2p.getStatus();
});

// Open OS Bluetooth settings for device pairing
ipcMain.handle("open-bluetooth-settings", async () => {
  try {
    const { openBluetoothSettings } = await import("./bluetooth");
    openBluetoothSettings();
    return { success: true };
  } catch (e) {
    console.error("Failed to open Bluetooth settings:", e);
    return { success: false, error: (e as Error).message };
  }
});

// Image folder management IPC handlers
ipcMain.handle("select-folder", async () => {
  try {
    const result = await dialog.showOpenDialog({
      title: "Select Images Folder",
      properties: ["openDirectory"],
    });

    if (result.canceled || result.filePaths.length === 0) {
      return null;
    }

    return result.filePaths[0];
  } catch (error) {
    console.error("Error selecting folder:", error);
    return null;
  }
});

// List images in a folder
ipcMain.handle("list-images-in-folder", async (_event, folderPath: string) => {
  try {
    if (!folderPath || !fs.existsSync(folderPath)) {
      return [];
    }

    const files = await fs.promises.readdir(folderPath);
    const imageExtensions = [".jpg", ".jpeg", ".png", ".gif", ".bmp", ".webp", ".svg"];

    const images = files
      .filter((file) => {
        const ext = path.extname(file).toLowerCase();
        return imageExtensions.includes(ext);
      })
      .map((file) => ({
        path: path.join(folderPath, file),
        name: file,
      }));

    return images;
  } catch (error) {
    console.error("Error listing images in folder:", error);
    return [];
  }
});

// Read image as data URL
ipcMain.handle("read-image-as-data-url", async (_event, imagePath: string) => {
  try {
    if (!imagePath || !fs.existsSync(imagePath)) {
      return null;
    }

    const data = await fs.promises.readFile(imagePath);
    const ext = path.extname(imagePath).toLowerCase();

    const mimeTypes: Record<string, string> = {
      ".jpg": "image/jpeg",
      ".jpeg": "image/jpeg",
      ".png": "image/png",
      ".gif": "image/gif",
      ".bmp": "image/bmp",
      ".webp": "image/webp",
      ".svg": "image/svg+xml",
    };

    const mimeType = mimeTypes[ext] || "image/png";
    const base64 = data.toString("base64");
    return `data:${mimeType};base64,${base64}`;
  } catch (error) {
    console.error("Error reading image:", error);
    return null;
  }
});

ipcMain.handle("get-hostname", () => os.hostname());

// Return all useful network addresses for the domain name combobox, sorted by
// descending likelihood of being the right choice for a LAN web server:
//   192.168.x.x > hostname > 10.x.x > 172.16-31.x.x > other > 127.x.x.x > localhost
ipcMain.handle("get-network-addresses", () => {
  const hostname = os.hostname();
  const seen = new Set<string>();
  const collected: string[] = [];

  const add = (v: string) => {
    if (v && !seen.has(v)) {
      seen.add(v);
      collected.push(v);
    }
  };

  add(hostname);
  for (const iface of Object.values(os.networkInterfaces())) {
    for (const addr of iface ?? []) {
      if (addr.family === "IPv4") add(addr.address);
    }
  }
  add("localhost");

  const priority = (addr: string): number => {
    if (addr === "localhost") return 6; // loopback name — last
    if (/^127\./.test(addr)) return 5; // loopback IP
    if (/^192\.168\./.test(addr)) return 0; // home/office LAN — first
    if (!/^\d+\.\d+\.\d+\.\d+$/.test(addr)) return 1; // hostname
    if (/^10\./.test(addr)) return 2; // corporate LAN
    if (/^172\.(1[6-9]|2\d|3[01])\./.test(addr)) return 3; // less common private
    return 4; // other (VPN, docker…)
  };

  return collected.sort((a, b) => priority(a) - priority(b));
});

// UFW firewall management (Linux only)
// Uses pkexec to request elevated privileges via polkit (one auth dialog per action).
ipcMain.handle("ufw-manage", async (_event, action: "status" | "apply" | "remove", port?: number) => {
  if (process.platform !== "linux") return { supported: false };

  if (action === "status") {
    try {
      await execAsync("which ufw");
    } catch {
      return { supported: true, installed: false, enabled: false };
    }
    let enabled = false;
    try {
      const conf = await fs.promises.readFile("/etc/ufw/ufw.conf", "utf8");
      enabled = /^ENABLED=yes/im.test(conf);
    } catch {
      // unreadable — leave enabled=false
    }
    return { supported: true, installed: true, enabled };
  }

  if (action === "apply" || action === "remove") {
    const tcpPort = typeof port === "number" && Number.isInteger(port) && port >= 1 && port <= 65535 ? port : 19740;
    const op = action === "apply" ? "allow" : "delete allow";
    // Single pkexec invocation → one polkit auth dialog for both rules
    const innerCmd = `ufw ${op} ${tcpPort}/tcp && ufw ${op} 1974:1983/udp`;
    try {
      await execAsync(`pkexec bash -c '${innerCmd}'`);
      return { success: true };
    } catch (err: unknown) {
      const e = err as { stderr?: string; message?: string };
      const msg = e.stderr?.trim() || e.message || "Failed";
      const cancelled = msg.includes("Not authorized") || msg.includes("dismissed");
      return { success: false, error: cancelled ? "Cancelled" : msg };
    }
  }

  return { success: false, error: "Unknown action" };
});

// In this file you can include the rest of your app's specific main process
// code. You can also put them in separate files and import them here.
