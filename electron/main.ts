// The bare minimum code required for an Electron main process

import {
  app,
  BrowserWindow,
  ipcMain,
  screen,
  dialog,
  shell,
  powerSaveBlocker,
  session,
  nativeImage,
  type MessageBoxOptions,
  type MessageBoxReturnValue,
} from "electron";
import { autoUpdater } from "electron-updater";
import path from "node:path";
import fs from "node:fs";
import { exec as execCb, execFile } from "node:child_process";
import { promisify } from "node:util";
import os from "node:os";
const execAsync = promisify(execCb);
import { getProxyConfigValue, initializeProxy } from "./proxy";
import { UdpServer, getUdpServerInstance } from "./udp";
import { P2PTransport, getP2PTransportInstance } from "./p2p-transport";
import { initializeWebServer, getWebServerInstance } from "./webserver";
import { Settings } from "../src/types";
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

// Fix: mouse events stop working after ~30 min of inactivity; pressing F11 (resize) restores them.
//
// Root cause (Windows): Chromium's CalculateNativeWinOcclusion feature uses the Win32 occlusion
// API to detect when a window is covered by another native window.  Even a brief occlusion by a
// tooltip, system notification, or taskbar popup is enough to make Chromium suspend the compositor.
// With the compositor suspended the GPU hit-test tree goes stale, so mouse events are no longer
// delivered to the correct element — but keyboard events still work because they bypass the
// compositor.  A window resize (F11 → setFullScreen) forces a full recompose and restores
// hit-testing until the next occlusion event.
//
// CalculateNativeWinOcclusion: disables the Windows occlusion tracker (primary fix).
// disable-renderer-backgrounding: prevents the renderer from being deprioritized on idle
//   (belt-and-suspenders — harmless on all platforms).
app.commandLine.appendSwitch("disable-features", "CalculateNativeWinOcclusion");
app.commandLine.appendSwitch("disable-renderer-backgrounding");

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

type NetDisplayEncodeSettings = {
  jpegQuality?: number;
  imageScale: number;
  bgColor: string;
  transient: number;
};

const netDisplayEncodeSettings: NetDisplayEncodeSettings = {
  jpegQuality: 70,
  imageScale: 1,
  bgColor: "#000000",
  transient: 200,
};

let lastNetDisplaySourceImageDataUrl: string | null = null;
let hostDeviceDiscovering = false;

const HOSTDEVICE_PREFS_FILE = "hostdevice-preferences.json";

const parsePortSpec = (portSpec: string): number[] => {
  const rv = new Set<number>();
  for (const tokenRaw of (portSpec || "").split(",")) {
    const token = tokenRaw.trim();
    if (!token) continue;
    const range = token.match(/^(\d+)\s*-\s*(\d+)$/);
    if (range) {
      const start = parseInt(range[1], 10);
      const end = parseInt(range[2], 10);
      if (Number.isInteger(start) && Number.isInteger(end)) {
        const min = Math.min(start, end);
        const max = Math.max(start, end);
        for (let p = min; p <= max; p++) {
          if (p >= 1 && p <= 65535) rv.add(p);
        }
      }
      continue;
    }
    const value = parseInt(token, 10);
    if (Number.isInteger(value) && value >= 1 && value <= 65535) {
      rv.add(value);
    }
  }
  return Array.from(rv.values()).sort((a, b) => a - b);
};

const hostDevicePrefsPath = () => path.join(app.getPath("userData"), HOSTDEVICE_PREFS_FILE);

const readHostDevicePrefs = (): Record<string, string> => {
  try {
    const filePath = hostDevicePrefsPath();
    if (!fs.existsSync(filePath)) return {};
    const data = JSON.parse(fs.readFileSync(filePath, "utf8")) as Record<string, unknown>;
    const safe: Record<string, string> = {};
    for (const [k, v] of Object.entries(data)) {
      if (typeof v === "string") safe[k] = v;
    }
    return safe;
  } catch {
    return {};
  }
};

const writeHostDevicePrefs = (prefs: Record<string, string>) => {
  try {
    fs.writeFileSync(hostDevicePrefsPath(), JSON.stringify(prefs, null, 2), "utf8");
  } catch (error) {
    console.error("[HostDevice] Failed writing preferences", error);
  }
};

const sendHostDeviceMessage = (op: string, param: unknown) => {
  getMainWindow()?.webContents.send("hostdevice-message", { op, param });
};

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function updateNetDisplayEncodeSettings(settings: Settings): boolean {
  const nextJpegQuality =
    (settings.netDisplayUseJpegCompression ?? true) ? clamp(Math.round(settings.netDisplayJpegQuality ?? 70), 1, 100) : undefined;
  const nextImageScale = clamp(settings.netDisplayImageScale ?? 1, 0.1, 1);
  const nextBgColor = settings.backgroundColor || "#000000";
  const nextTransient =
    typeof settings.netDisplayTransient === "boolean"
      ? settings.netDisplayTransient
        ? 500
        : 0
      : clamp(Math.round(settings.netDisplayTransient ?? 200), 0, 500);
  const changed =
    nextJpegQuality !== netDisplayEncodeSettings.jpegQuality ||
    nextImageScale !== netDisplayEncodeSettings.imageScale ||
    nextBgColor !== netDisplayEncodeSettings.bgColor ||
    nextTransient !== netDisplayEncodeSettings.transient;
  netDisplayEncodeSettings.jpegQuality = nextJpegQuality;
  netDisplayEncodeSettings.imageScale = nextImageScale;
  netDisplayEncodeSettings.bgColor = nextBgColor;
  netDisplayEncodeSettings.transient = nextTransient;
  return changed;
}

function encodeNetDisplayImage(imageDataUrl: string | null): { data: string | null; mimeType: "image/jpeg" | "image/png" } {
  const mimeType = netDisplayEncodeSettings.jpegQuality == null ? "image/png" : "image/jpeg";
  if (!imageDataUrl) return { data: null, mimeType };
  try {
    let image = nativeImage.createFromDataURL(imageDataUrl);
    if (image.isEmpty()) return { data: null, mimeType };

    const scale = netDisplayEncodeSettings.imageScale;
    if (scale < 1) {
      const size = image.getSize();
      const width = Math.max(1, Math.round(size.width * scale));
      const height = Math.max(1, Math.round(size.height * scale));
      image = image.resize({ width, height, quality: "best" });
    }

    if (netDisplayEncodeSettings.jpegQuality == null) {
      return { data: image.toPNG().toString("base64"), mimeType };
    }

    return { data: image.toJPEG(netDisplayEncodeSettings.jpegQuality).toString("base64"), mimeType };
  } catch (error) {
    console.error("[Main] Failed to encode net display image", error);
    return { data: null, mimeType };
  }
}

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
let printWindow: BrowserWindow | null = null;

// Localization strings loaded from JSON files, keyed by language code.
const mainLocStrings: Record<string, Record<string, string>> = {};
let mainCurrentLanguage: string | null = null;

const getMainLanguage = (): string => {
  if (mainCurrentLanguage) return mainCurrentLanguage;
  const locale = app.getLocale() || "en";
  const match = locale.match(/^([a-zA-Z]{2})/);
  return match ? match[1].toLowerCase() : "en";
};

const getMainLocalizedString = (key: string): string => {
  const lang = getMainLanguage();
  return mainLocStrings[lang]?.[key] || mainLocStrings["en"]?.[key] || key;
};

ipcMain.on("update-localization", (_event, payload: { language?: string; strings?: Record<string, Record<string, string>> }) => {
  const language = payload?.language?.toLowerCase();
  if (language === "en" || language === "hu") {
    mainCurrentLanguage = language;
  }

  const tables = payload?.strings;
  if (!tables || typeof tables !== "object") return;

  for (const [lang, table] of Object.entries(tables)) {
    if ((lang === "en" || lang === "hu") && table && typeof table === "object") {
      const safe: Record<string, string> = {};
      for (const [k, v] of Object.entries(table)) {
        if (typeof v === "string") safe[k] = v;
      }
      mainLocStrings[lang] = safe;
    }
  }
});

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

/**
 * In dev mode, detect the default browser and open URLs in private/incognito mode.
 * Returns true if the URL was opened, false if it should fall through to shell.openExternal.
 */
const openInPrivateBrowser = async (url: string): Promise<boolean> => {
  if (process.platform !== "win32") return false;
  try {
    // Read the default HTTP handler ProgId from the registry
    const { stdout: progIdOut } = await new Promise<{ stdout: string; stderr: string }>((resolve, reject) => {
      execFile(
        "reg",
        ["query", "HKEY_CURRENT_USER\\Software\\Microsoft\\Windows\\Shell\\Associations\\UrlAssociations\\http\\UserChoice", "/v", "ProgId"],
        (err, stdout, stderr) => (err ? reject(err) : resolve({ stdout, stderr }))
      );
    });
    const progIdMatch = progIdOut.match(/ProgId\s+REG_SZ\s+(\S+)/);
    if (!progIdMatch) return false;

    // Read the browser command line from the ProgId
    const { stdout: cmdOut } = await new Promise<{ stdout: string; stderr: string }>((resolve, reject) => {
      execFile("reg", ["query", `HKEY_CLASSES_ROOT\\${progIdMatch[1]}\\shell\\open\\command`, "/ve"], (err, stdout, stderr) =>
        err ? reject(err) : resolve({ stdout, stderr })
      );
    });
    const cmdMatch = cmdOut.match(/REG_SZ\s+"([^"]+\.exe)"/i) || cmdOut.match(/REG_SZ\s+(\S+\.exe)/i);
    if (!cmdMatch) return false;
    const exePath = cmdMatch[1];

    // Map browser executable to its private-mode flag
    const exeLower = exePath.toLowerCase();
    let flag: string | undefined;
    if (exeLower.includes("chrome") || exeLower.includes("brave")) flag = "--incognito";
    else if (exeLower.includes("msedge") || exeLower.includes("edge")) flag = "--inPrivate";
    else if (exeLower.includes("firefox")) flag = "--private-window";
    else if (exeLower.includes("opera")) flag = "--private";
    if (!flag) return false;

    execFile(exePath, [flag, url]);
    return true;
  } catch {
    return false;
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
    if (!isProductionRuntime() && (await openInPrivateBrowser(value))) return;
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
  const iconPath = resolveAppIcon();
  const withIcon = !options.icon && iconPath ? { ...options, icon: nativeImage.createFromPath(iconPath) } : options;
  return parentWindow ? dialog.showMessageBox(parentWindow, withIcon) : dialog.showMessageBox(withIcon);
};

const resolveAppIcon = (): string | undefined => {
  const appPath = app.getAppPath();
  const candidates: string[] = [];

  if (process.platform === "win32") {
    candidates.push(path.join(appPath, "dist/build/icon.ico"));
    candidates.push(path.join(appPath, "public/assets/projector.ico"));
  } else if (process.platform === "darwin") {
    if (app.isPackaged) {
      candidates.push(path.join(process.resourcesPath, "public", "assets", "pp-512.png"));
    }
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

function openPrintWindow(): void {
  if (printWindow && !printWindow.isDestroyed()) {
    printWindow.focus();
    return;
  }

  printWindow = new BrowserWindow({
    width: 1100,
    height: 760,
    minWidth: 420,
    minHeight: 500,
    title: "Print Preview",
    autoHideMenuBar: true,
    parent: mainWindow ?? undefined,
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
      webSecurity: true,
    },
  });

  if (process.env.VITE_DEV_SERVER_URL) {
    printWindow.loadURL(`${process.env.VITE_DEV_SERVER_URL}#/print`);
  } else {
    printWindow.loadFile(path.join(__dirname, "../webapp/index.html"), { hash: "/print" });
  }

  printWindow.setMenu(null);
  printWindow.setMenuBarVisibility(false);

  printWindow.on("closed", () => {
    printWindow = null;
  });

  printWindow.webContents.on("before-input-event", (_event, input) => {
    if (input.key === "F12" || (input.control && input.shift && input.key.toLowerCase() === "i")) {
      printWindow?.webContents.toggleDevTools();
    }
  });
}

// Configure auto-updater
autoUpdater.autoDownload = false;
autoUpdater.autoInstallOnAppQuit = true;
autoUpdater.allowPrerelease = false; // Use stable releases (latest.yml)
autoUpdater.allowDowngrade = true; // Allow downgrade when switching from testing to stable
// Disable signature verification for unsigned builds in dev, but enforce in production.
autoUpdater.forceDevUpdateConfig = !isProductionRuntime();
// Note: channel defaults to "latest" which uses latest.yml
autoUpdater.logger = console;

// The releases page URL, read from app-update.yml at startup.
// electron-updater v6's getFeedURL() is deprecated and returns a useless string,
// so we read the YAML directly instead.
let releasesBaseUrl: string | null = null;

function loadReleasesUrl(): void {
  const ymlPath = app.isPackaged ? path.join(process.resourcesPath, "app-update.yml") : path.join(app.getAppPath(), "dev-app-update.yml");
  try {
    const content = fs.readFileSync(ymlPath, "utf8");
    const match = content.match(/^url:\s*(\S.*)/m);
    if (match) releasesBaseUrl = match[1].trim();
  } catch {
    // Will fall back to cloudApiHost in openManualMacUpdateDialog.
  }
}

// Track the current update channel (stable or testing)
let currentUpdateChannel: string = "stable";

/**
 * Apply update channel by setting the appropriate feed URL.
 * Stable channel uses default latest.yml, testing uses testing/latest.yml subfolder.
 */
function applyUpdateChannel(channel: string): void {
  if (!releasesBaseUrl) {
    console.warn("Releases base URL not loaded, cannot apply channel:", channel);
    return;
  }

  currentUpdateChannel = channel;
  const feedUrl = channel === "testing" ? `${releasesBaseUrl}/testing` : releasesBaseUrl;

  console.log(`Applying update channel: ${channel}`);
  console.log(`Feed base URL: ${feedUrl}`);

  autoUpdater.setFeedURL({ provider: "generic", url: feedUrl });
}

function getMetadataFileName(): string {
  return process.platform === "linux" ? "latest-linux.yml" : process.platform === "darwin" ? "latest-mac.yml" : "latest.yml";
}

/**
 * Compare two semantic versions (e.g., "1.2.3" vs "1.2.4").
 * Returns: positive if v1 > v2, negative if v1 < v2, 0 if equal.
 */
function compareVersions(v1: string, v2: string): number {
  const parts1 = v1.split(".").map((x) => parseInt(x, 10) || 0);
  const parts2 = v2.split(".").map((x) => parseInt(x, 10) || 0);
  const maxLen = Math.max(parts1.length, parts2.length);

  for (let i = 0; i < maxLen; i++) {
    const diff = (parts1[i] ?? 0) - (parts2[i] ?? 0);
    if (diff !== 0) return diff;
  }

  return 0;
}

function buildChannelMetadataUrl(channel: string): string | null {
  if (!releasesBaseUrl) return null;
  const metadataFileName = getMetadataFileName();
  return channel === "testing" ? `${releasesBaseUrl}/testing/${metadataFileName}` : `${releasesBaseUrl}/${metadataFileName}`;
}

async function fetchChannelVersionFromMetadata(channel: string): Promise<string | null> {
  const metadataUrl = buildChannelMetadataUrl(channel);
  if (!metadataUrl) return null;

  try {
    const response = await fetch(metadataUrl, { cache: "no-store" });
    if (!response.ok) return null;

    const content = await response.text();
    const match = content.match(/^version:\s*(\S+)/m);
    return match ? match[1].trim() : null;
  } catch (err) {
    console.warn("Failed to fetch channel metadata version:", err);
    return null;
  }
}

async function checkForUpdatesWithFallback(): Promise<{ available: boolean; version?: string; error?: string }> {
  try {
    const result = await autoUpdater.checkForUpdates();
    let serverVersion = result?.updateInfo?.version;

    // In downgrade scenarios some updater/provider combinations may not return updateInfo.
    // Fall back to reading version from channel metadata so UI can still offer the update.
    if (!serverVersion) {
      serverVersion = (await fetchChannelVersionFromMetadata(currentUpdateChannel)) ?? undefined;
    }

    // If on testing channel, also check stable channel for newer versions
    if (currentUpdateChannel === "testing" && serverVersion) {
      const stableVersion = await fetchChannelVersionFromMetadata("stable");
      if (stableVersion && compareVersions(stableVersion, serverVersion) > 0) {
        console.log(`Newer stable version available: ${stableVersion} (testing has ${serverVersion})`);
        serverVersion = stableVersion;
      }
    }

    const available = !!serverVersion && serverVersion !== app.getVersion();
    return { available, version: serverVersion };
  } catch (err) {
    console.error("Update check failed:", err);
    return { available: false, error: (err as Error).message };
  }
}

let macAutoInstallSupported: boolean | null = null;

async function isMacAutoInstallSupported(): Promise<boolean> {
  if (process.platform !== "darwin") return true;
  if (macAutoInstallSupported !== null) return macAutoInstallSupported;

  try {
    // electron-updater on macOS requires a signed running app for quitAndInstall().
    await execAsync(`codesign --display --verbose=2 ${JSON.stringify(app.getPath("exe"))}`);
    macAutoInstallSupported = true;
  } catch {
    macAutoInstallSupported = false;
    console.warn("Auto-update install is disabled on macOS for unsigned builds; manual update will be used.");
  }

  return macAutoInstallSupported;
}

async function openManualMacUpdateDialog(reason?: string): Promise<void> {
  // releasesBaseUrl is loaded from app-update.yml at startup.
  // Fall back to cloud API host + hardcoded path if the YAML wasn't found.
  const releasesUrl =
    releasesBaseUrl ??
    (() => {
      const cloudApiHost = getProxyConfigValue("VITE_CLOUD_API_HOST");
      if (cloudApiHost) {
        try {
          return new URL("/releases/electron", cloudApiHost).toString();
        } catch {
          console.warn("Invalid cloud API host URL:", cloudApiHost);
        }
      }
      return null;
    })();

  const result = await showMainMessageBox({
    type: "info",
    title: getMainLocalizedString("UpdateManualInstallRequired"),
    message: getMainLocalizedString("UpdateAutoInstallNotAvailable"),
    detail: getMainLocalizedString("UpdateAutoInstallDetail") + (reason ? `\n\n${getMainLocalizedString("TechnicalDetail")} ${reason}` : ""),
    buttons: releasesUrl
      ? [getMainLocalizedString("UpdateOpenReleasesPage"), getMainLocalizedString("UpdateLater")]
      : [getMainLocalizedString("UpdateLater")],
    defaultId: 0,
    cancelId: releasesUrl ? 1 : 0,
    noLink: true,
  });

  if (releasesUrl && result.response === 0) {
    try {
      await shell.openExternal(releasesUrl);
    } catch (err) {
      console.error("Failed to open releases page:", err);
    }
  }
}

async function setupAutoUpdater() {
  if (process.platform === "darwin") {
    const canAutoInstall = await isMacAutoInstallSupported();
    autoUpdater.autoInstallOnAppQuit = canAutoInstall;
  }

  // Apply the current update channel before checking for updates
  applyUpdateChannel(currentUpdateChannel);

  // Log updater setup details (avoid deprecated getFeedURL)
  console.log("=== AUTO-UPDATER SETUP ===");
  console.log("Current app version:", app.getVersion());
  console.log("Update channel:", currentUpdateChannel);
  const metadataFileName = getMetadataFileName();
  const expectedMetadataPath = currentUpdateChannel === "testing" ? `testing/${metadataFileName}` : metadataFileName;
  console.log("Releases base URL:", releasesBaseUrl);
  console.log("Expected metadata path:", expectedMetadataPath);

  // Check for updates after app is ready
  checkForUpdatesWithFallback()
    .then((result) => {
      console.log("Update check completed");
      console.log("Server version:", result.version);
      console.log("Update available:", result.available);
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
    mainWindow?.webContents.send("update-not-available");
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
  return checkForUpdatesWithFallback();
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
  const install = async () => {
    if (process.platform === "darwin" && !(await isMacAutoInstallSupported())) {
      try {
        await openManualMacUpdateDialog();
      } catch (err) {
        console.error("Failed to show/open manual macOS update dialog:", err);
      }
      return { success: false, manualRequired: true };
    }

    try {
      autoUpdater.quitAndInstall(false, true);
      return { success: true };
    } catch (err) {
      const error = err as Error;
      const msg = error?.message || "Unknown update install error";
      console.error("Install update failed:", error);

      if (process.platform === "darwin" && /code signature/i.test(msg)) {
        await openManualMacUpdateDialog(msg);
        return { success: false, manualRequired: true, error: msg };
      }

      return { success: false, error: msg };
    }
  };

  return install();
});

ipcMain.handle("get-app-version", () => {
  return app.getVersion();
});

ipcMain.handle("print:open-window", () => {
  openPrintWindow();
  return true;
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
    if (printWindow && !printWindow.isDestroyed()) {
      printWindow.close();
      printWindow = null;
    }
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

  loadReleasesUrl();
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
        void setupAutoUpdater();
      }, 2000);
    });
  }

  const webServer = initializeWebServer();
  UdpServer.initialize(webServer).then((udpServer) => {
    if (!udpServer) {
      console.error("Failed to initialize UDP server");
      return;
    }
    udpServer.onRawPacket((packet) => {
      sendHostDeviceMessage("udp", packet);
    });
    udpServer.onSessionChanged((type, sessionId, name) => {
      sendHostDeviceMessage("nearby", {
        id: `udp_${sessionId}`,
        name,
        event: type === "discovered" ? "discovered" : "disappeared",
      });
    });
    // Initialize P2P transport with both UDP and Bluetooth
    P2PTransport.initialize(webServer, udpServer).then((p2p) => {
      console.log(`P2P Transport initialized - Status: ${JSON.stringify(p2p.getStatus())}`);
      // Forward Bluetooth peer messages as HostDevice nearby-message events
      p2p.onNearbyMessage((endpointId, message) => {
        sendHostDeviceMessage("nearby", {
          id: endpointId,
          event: "message",
          payload: typeof message === "string" ? message : JSON.stringify(message),
        });
      });
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
let pendingDisplayWindowImageDataUrl: string | null = null;

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
    backgroundColor: "#000000",
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

  // Load a minimal shell; image frames are pushed after DOM is ready.
  pendingDisplayWindowImageDataUrl = imageData || lastNetDisplaySourceImageDataUrl || null;
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
      <img />
    </body>
    </html>
  `;

  displayWindow.webContents.on("did-fail-load", (_event, errorCode, errorDescription) => {
    console.error("[DisplayWindow] Failed to load projector shell", { errorCode, errorDescription });
  });

  // Ensure the latest frame is applied once the display window DOM is ready.
  displayWindow.webContents.once("did-finish-load", () => {
    const latest = pendingDisplayWindowImageDataUrl ?? lastNetDisplaySourceImageDataUrl;
    updateDisplayWindowImage(latest);

    // Windows can lag during fullscreen/open transitions; re-apply latest frame a few times.
    const retryDelays = [50, 150, 350, 700, 1200];
    for (const delayMs of retryDelays) {
      setTimeout(() => {
        if (!displayWindow || displayWindow.isDestroyed()) return;
        updateDisplayWindowImage(pendingDisplayWindowImageDataUrl ?? lastNetDisplaySourceImageDataUrl);
      }, delayMs);
    }
  });

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

// IPC handler for database export file save
ipcMain.handle("save-database-file", async (_event, payload: { data: ArrayBuffer; defaultFileName?: string }) => {
  try {
    const result = await dialog.showSaveDialog({
      title: "Export Database",
      defaultPath: payload?.defaultFileName || "database.ppdb",
      filters: [
        { name: "PraiseProjector Database", extensions: ["ppdb"] },
        { name: "All Files", extensions: ["*"] },
      ],
    });

    if (result.canceled || !result.filePath) {
      return { success: false, error: "Cancelled" };
    }

    const data = payload?.data ? Buffer.from(new Uint8Array(payload.data)) : Buffer.alloc(0);
    await fs.promises.writeFile(result.filePath, data);
    return { success: true, filePath: result.filePath };
  } catch (error) {
    return { success: false, error: (error as Error).message };
  }
});

// Settings sync from renderer - update webserver settings
ipcMain.on("sync-settings", (_event, settings: Settings) => {
  console.log("Settings synced from renderer:", settings);
  const netDisplayEncodeChanged = updateNetDisplayEncodeSettings(settings);
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
      chordProStyles: settings.chordProStyles,
    });

    // Re-encode and republish the latest net display frame when encode settings change.
    if (netDisplayEncodeChanged) {
      const encoded = encodeNetDisplayImage(lastNetDisplaySourceImageDataUrl);
      webServer.setImage(encoded.data, {
        mimeType: encoded.mimeType,
        bgColor: netDisplayEncodeSettings.bgColor,
        transient: netDisplayEncodeSettings.transient,
      });
    }
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

  // Handle update channel changes
  if (settings.updateChannel && settings.updateChannel !== currentUpdateChannel) {
    console.log(`Update channel changed: ${currentUpdateChannel} -> ${settings.updateChannel}`);
    applyUpdateChannel(settings.updateChannel);
    // Automatically check for updates after channel change
    checkForUpdatesWithFallback()
      .then((result) => {
        if (result.available && result.version) {
          mainWindow?.webContents.send("update-available", { version: result.version });
        } else {
          mainWindow?.webContents.send("update-not-available");
        }
      })
      .catch((err) => {
        console.error("Auto-update check after channel change failed:", err);
      });
  }
});

// Update the Electron display window image directly from the main process
function updateDisplayWindowImage(pngDataUrl: string | null): void {
  if (!displayWindow || displayWindow.isDestroyed()) return;
  if (displayWindow.webContents.isLoadingMainFrame()) {
    pendingDisplayWindowImageDataUrl = pngDataUrl;
    return;
  }
  pendingDisplayWindowImageDataUrl = pngDataUrl;

  const js = `(() => {
    const img = document.querySelector('img');
    if (!img) return false;
    const src = ${JSON.stringify(pngDataUrl)};
    if (src) {
      img.src = src;
    } else {
      img.removeAttribute('src');
    }
    return true;
  })();`;

  const tryApply = (attempt = 0) => {
    if (!displayWindow || displayWindow.isDestroyed()) return;
    displayWindow.webContents
      .executeJavaScript(js)
      .then((applied) => {
        if (applied) return;
        if (attempt >= 20) return;
        setTimeout(() => tryApply(attempt + 1), 50);
      })
      .catch(() => {
        if (attempt >= 20) return;
        setTimeout(() => tryApply(attempt + 1), 50);
      });
  };

  tryApply();
}

// Internal Electron display window image update (lossless frame)
ipcMain.on(
  "set-display-window-image",
  (_event, imageDataUrl: string | null, options?: { jpegQuality?: number; imageScale?: number; bgColor?: string; transient?: number }) => {
    if (options) {
      if (typeof options.imageScale === "number") {
        netDisplayEncodeSettings.imageScale = clamp(options.imageScale, 0.1, 1);
      }
      netDisplayEncodeSettings.jpegQuality = typeof options.jpegQuality === "number" ? clamp(Math.round(options.jpegQuality), 1, 100) : undefined;
      if (typeof options.bgColor === "string" && options.bgColor.trim() !== "") {
        netDisplayEncodeSettings.bgColor = options.bgColor;
      }
      if (typeof options.transient === "number" && Number.isFinite(options.transient)) {
        netDisplayEncodeSettings.transient = clamp(Math.round(options.transient), 0, 500);
      }
    }

    lastNetDisplaySourceImageDataUrl = imageDataUrl;

    updateDisplayWindowImage(imageDataUrl);
    const encoded = encodeNetDisplayImage(imageDataUrl);
    getWebServerInstance()?.setImage(encoded.data, {
      mimeType: encoded.mimeType,
      bgColor: netDisplayEncodeSettings.bgColor,
      transient: netDisplayEncodeSettings.transient,
    });
  }
);

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

// HostDevice bridge handlers (Android-compatible surface for Electron frontend)
ipcMain.handle("hostdevice-send-udp-message", (_event, message: string, host: string, portSpec: string) => {
  const udpServer = getUdpServerInstance();
  if (!udpServer) return "";
  const ports = parsePortSpec(portSpec);
  if (ports.length < 1) return "";

  let target = host;
  let sent = false;
  if (host === "*") {
    target = udpServer.getBroadcastAddress() || "255.255.255.255";
  }
  for (const port of ports) {
    try {
      udpServer.sendRawMessage(message, port, target);
      sent = true;
    } catch (error) {
      console.error("[HostDevice] UDP send failed", { target, port, error });
    }
  }
  return sent ? target : "";
});

ipcMain.handle("hostdevice-listen-on-udp-port", (_event, portSpec: string) => {
  const udpServer = getUdpServerInstance();
  const port = udpServer?.getPort() || 0;
  if (!port) return 0;
  const ports = parsePortSpec(portSpec);
  if (ports.length < 1) return port;
  return ports.includes(port) ? port : 0;
});

ipcMain.handle("hostdevice-close-udp-port", () => {
  // Electron keeps a single shared UDP socket for app lifetime.
  return true;
});

ipcMain.handle("hostdevice-check-nearby-permissions", () => true);

ipcMain.handle("hostdevice-advertise-nearby", (_event, enabled: boolean) => {
  const p2p = getP2PTransportInstance();
  if (!p2p) return false;
  if (enabled) return p2p.startAdvertising();
  p2p.stopAdvertising();
  return true;
});

ipcMain.handle("hostdevice-discover-nearby", (_event, enabled: boolean) => {
  const p2p = getP2PTransportInstance();
  if (!p2p) return false;
  hostDeviceDiscovering = enabled;
  if (enabled) {
    const result = p2p.startDiscovery();
    if (result.success) {
      for (const session of p2p.getDiscoveredSessions()) {
        sendHostDeviceMessage("nearby", { id: session.id, name: session.name, event: "discovered" });
      }
    }
    return result.success;
  }
  p2p.stopDiscovery();
  return true;
});

ipcMain.handle("hostdevice-connect-nearby", async (_event, endpointId: string) => {
  const p2p = getP2PTransportInstance();
  if (!p2p) return false;
  const connected = await p2p.connect(endpointId);
  if (connected) sendHostDeviceMessage("nearby", { id: endpointId, event: "connected" });
  return connected;
});

ipcMain.handle("hostdevice-send-nearby-message", (_event, endpointId: string, message: string) => {
  const p2p = getP2PTransportInstance();
  if (!p2p) return false;
  return p2p.sendMessage(endpointId, message);
});

ipcMain.handle("hostdevice-close-nearby", (_event, endpointId?: string) => {
  const p2p = getP2PTransportInstance();
  if (!p2p) return false;
  const endpoint = typeof endpointId === "string" ? endpointId.trim() : "";
  p2p.disconnect(endpoint || undefined);
  if (endpoint) sendHostDeviceMessage("nearby", { id: endpoint, event: "disconnected" });
  return true;
});

ipcMain.handle("hostdevice-get-nearby-state", () => {
  const p2p = getP2PTransportInstance();
  const sessions = p2p?.getDiscoveredSessions() || [];
  return {
    discovering: hostDeviceDiscovering,
    sessions: sessions.map((session) => ({ id: session.id, name: session.name, transport: session.transport })),
  };
});

ipcMain.handle("hostdevice-debug-log", (_event, tag: string, message: string) => {
  console.log(`[${tag}] ${message}`);
  return true;
});

ipcMain.handle("hostdevice-show-toast", (_event, message: string) => {
  console.log(`[HostDeviceToast] ${message}`);
  return true;
});

ipcMain.handle("hostdevice-get-errors", () => "");

ipcMain.handle("hostdevice-get-home", () => {
  if (process.env.VITE_DEV_SERVER_URL) return process.env.VITE_DEV_SERVER_URL;
  return "";
});

ipcMain.handle("hostdevice-go-home", () => {
  if (mainWindow && !mainWindow.isDestroyed()) {
    if (process.env.VITE_DEV_SERVER_URL) {
      void mainWindow.loadURL(process.env.VITE_DEV_SERVER_URL);
    } else {
      void mainWindow.loadFile(path.join(__dirname, "../webapp/index.html"));
    }
  }
  return true;
});

ipcMain.handle("hostdevice-set-fullscreen", (_event, fs?: boolean) => {
  if (!mainWindow || mainWindow.isDestroyed()) return false;
  const next = fs == null ? !mainWindow.isFullScreen() : !!fs;
  mainWindow.setFullScreen(next);
  return next;
});

ipcMain.handle("hostdevice-is-fullscreen", () => {
  return !!(mainWindow && !mainWindow.isDestroyed() && mainWindow.isFullScreen());
});

ipcMain.handle("hostdevice-dialog", async (_event, message: string, title: string, positiveLabel: string, negativeLabel: string) => {
  const buttons = [positiveLabel || "OK"];
  if (negativeLabel) buttons.push(negativeLabel);
  const result = await showMainMessageBox({
    type: "question",
    title: title || "PraiseProjector",
    message,
    buttons,
    defaultId: 0,
    cancelId: buttons.length > 1 ? 1 : 0,
    noLink: true,
  });
  sendHostDeviceMessage("dialog", result.response === 0);
  return true;
});

ipcMain.handle("hostdevice-store-preference", (_event, key: string, value: string) => {
  const prefs = readHostDevicePrefs();
  prefs[key] = value;
  writeHostDevicePrefs(prefs);
  return true;
});

ipcMain.handle("hostdevice-retrieve-preference", (_event, key: string) => {
  const prefs = readHostDevicePrefs();
  return prefs[key] || "";
});

ipcMain.handle("hostdevice-get-name", () => os.hostname());
ipcMain.handle("hostdevice-get-model", () => `${os.platform()}-${os.arch()}`);
ipcMain.handle("hostdevice-exit", () => {
  app.quit();
  return true;
});
ipcMain.handle("hostdevice-version", () => app.getVersion());
ipcMain.handle("hostdevice-info", (_event, flags = -1) => {
  const info: Record<string, unknown> = {
    deviceName: os.hostname(),
    modelName: `${os.platform()}-${os.arch()}`,
    versionName: app.getVersion(),
  };
  if ((flags & 1) !== 0 || flags < 0) {
    info.totalMemory = os.totalmem();
    info.freeMemory = os.freemem();
  }
  if ((flags & 2) !== 0 || flags < 0) {
    const udpServer = getUdpServerInstance();
    info.ipAddress = udpServer?.getAddress() || "";
    info.gateway = "";
    info.broadcast = udpServer?.getBroadcastAddress() || "";
  }
  return JSON.stringify(info);
});

ipcMain.handle("hostdevice-keep-screen-on", (_event, keep: boolean) => {
  if (keep) {
    if (powerSaveBlockerId === null || !powerSaveBlocker.isStarted(powerSaveBlockerId)) {
      powerSaveBlockerId = powerSaveBlocker.start("prevent-display-sleep");
    }
  } else if (powerSaveBlockerId !== null && powerSaveBlocker.isStarted(powerSaveBlockerId)) {
    powerSaveBlocker.stop(powerSaveBlockerId);
    powerSaveBlockerId = null;
  }
  return true;
});

ipcMain.handle("hostdevice-open-link-external", async (_event, url: string) => {
  await openExternalUrlSafely(url);
  return true;
});

ipcMain.handle("hostdevice-get-third-party-license-sections", async () => {
  return "[]";
});

ipcMain.handle("hostdevice-enable-notification", () => false);

ipcMain.handle("hostdevice-get-cache-size", async () => {
  try {
    return await session.defaultSession.getCacheSize();
  } catch {
    return -1;
  }
});

ipcMain.handle("hostdevice-clear-cache", async (_event, _includeDiskFiles: boolean) => {
  try {
    await session.defaultSession.clearCache();
    return true;
  } catch {
    return false;
  }
});

ipcMain.handle("hostdevice-start-navigation-timeout", () => true);

ipcMain.handle("hostdevice-page-loaded-successfully", () => true);

ipcMain.handle("hostdevice-share", async (_event, url: string) => {
  if (url) await openExternalUrlSafely(url);
  return true;
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
