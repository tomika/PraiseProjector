import { Display as PPDisplay } from "../../common/pp-types";
import { PlaylistEntry } from "../classes/PlaylistEntry";
import { Settings } from "../types";

export type Display = PPDisplay;

export interface MonitorDisplay {
  id: string;
  bounds: { x: number; y: number; width: number; height: number };
  workArea: { x: number; y: number; width: number; height: number };
  scaleFactor: number;
  rotation: number;
  internal: boolean;
}

export type DisplayUpdateRequest = {
  command: "song_update" | "display_update";
  id: string;
  from: number;
  to: number;
  transpose?: number;
  capo?: number;
  instructions?: string;
  title?: string;
  playlist?: PlaylistEntry[];
};

export type WindowBounds = {
  x: number;
  y: number;
  width: number;
  height: number;
  isMaximized: boolean;
};

export interface IElectronAPI {
  // Window bounds management
  getWindowBounds?: () => Promise<WindowBounds | null>;
  setWindowBounds?: (bounds: WindowBounds) => Promise<void>;

  // Playlist file operations (optional - falls back to browser APIs)
  savePlaylistFile?: (content: string) => Promise<{ success: boolean; filePath?: string; error?: string }>;
  loadPlaylistFile?: () => Promise<{ success: boolean; content?: string; error?: string }>;
  saveDatabaseFile?: (data: ArrayBuffer, defaultFileName?: string) => Promise<{ success: boolean; filePath?: string; error?: string }>;

  // Display/Monitor management (optional - for Electron projector functionality)
  getAllDisplays?: () => Promise<MonitorDisplay[]>;
  showDisplayWindow?: (displayId: string, imageData: string) => Promise<void>;
  hideDisplayWindow?: () => Promise<void>;
  isDisplayWindowOpen?: () => Promise<boolean>;

  // Current display state management (uses pp-types Display)
  setCurrentDisplay?: (display: Display) => Promise<void>;
  getMainWindowDisplayId?: () => Promise<string | null>;

  // Proxy operations
  proxyGet?: (
    baseUrl: string,
    path: string,
    headers?: Record<string, string>
  ) => Promise<{ data: unknown; ppHeaders: Record<string, string> } | { error: { message: string; status?: number; data?: unknown } }>;
  proxyPost?: (
    baseUrl: string,
    path: string,
    data: unknown,
    headers?: Record<string, string>
  ) => Promise<{ data: unknown; ppHeaders: Record<string, string> } | { error: { message: string; status?: number; data?: unknown } }>;

  // General WebServer API request handler
  onWebserverApiRequest?: (
    callback: (apiRequest: { method: string; path: string; query: Record<string, unknown>; body: unknown; headers: Record<string, unknown> }) => void
  ) => () => void;
  sendWebserverApiResponse?: (response: { status?: number; data: unknown; headers?: Record<string, string> }) => void;

  // Settings sync - frontend pushes settings to backend
  syncSettings?: (settings: Settings) => void;

  // Localization sync - frontend pushes language change (and string tables on first call) to backend
  updateLocalization?: (payload: { language: "en" | "hu"; strings?: Record<string, Record<string, string>> }) => void;

  // Sync leader name (for UDP offer - C# uses cmbLeader.Text which is the name, not ID)
  syncLeaderName?: (leaderName: string) => void;

  // Internal Electron display window update (lossless frame)
  setDisplayWindowImage?: (
    imageDataUrl: string | null,
    options?: { jpegQuality?: number; imageScale?: number; bgColor?: string; transient?: number }
  ) => void;

  // Get connected clients from webserver (for leader-mode client selection)
  getConnectedClients?: () => Promise<Array<{ id: string; deviceName: string; isLeaderModeClient: boolean }>>;

  // Highlight access control - matching C# WebServer HighlightAccessRequest/HighlightChanged pattern
  onHighlightAccessRequest?: (callback: (data: { clientId: string }) => void) => () => void;
  onHighlightChanged?: (callback: (data: { line: number }) => void) => () => void;
  respondHighlightAccess?: (clientId: string, grant: boolean) => void;
  getRemoteHighlightController?: () => Promise<string>;
  onRemoteHighlightControllerChanged?: (callback: (data: { clientId: string }) => void) => () => void;

  // Remote display/song update from web clients (matching C# SongChanged/PlayListItemChanged)
  onRemoteDisplayUpdate?: (callback: (data: DisplayUpdateRequest) => void) => () => void;

  // UDP/P2P session scanning (for local network discovery)
  // These methods now use unified P2P transport (UDP + Bluetooth)
  udpGetBroadcastAddress?: () => Promise<string>;
  udpScanSessions?: (broadcastAddress?: string) => Promise<{ success: boolean; address?: string; error?: string }>;
  udpGetDiscoveredSessions?: () => Promise<P2PSessionInfo[]>;

  // P2P watch mode - matching C# EnterSessionWatchingMode/ExitSessionWatchingMode
  // Accepts either prefixed endpoint IDs (udp_xxx, bt_xxx) or legacy raw parameters
  udpStartWatching?: (deviceIdOrEndpoint: string, hostId?: string, address?: string, port?: number) => Promise<{ success: boolean; error?: string }>;
  udpStopWatching?: () => Promise<{ success: boolean }>;
  onUdpDisplayUpdate?: (callback: (display: Display) => void) => () => void;
  onUdpSessionEnded?: (callback: () => void) => () => void;

  // P2P transport status
  p2pGetStatus?: () => Promise<P2PStatus>;

  // Bluetooth settings helper (opens OS Bluetooth settings for device pairing)
  openBluetoothSettings?: () => Promise<{ success: boolean; error?: string }>;

  // Auto-updater
  getAppVersion?: () => Promise<string>;
  checkForUpdates?: () => Promise<{ available?: boolean; updateAvailable?: boolean; version?: string; error?: string }>;
  downloadUpdate?: () => Promise<{ success: boolean; error?: string }>;
  installUpdate?: () => void;
  onUpdateAvailable?: (callback: (info: { version: string }) => void) => () => void;
  onUpdateNotAvailable?: (callback: () => void) => () => void;
  onUpdateDownloadProgress?: (callback: (progress: { percent: number }) => void) => () => void;
  onUpdateDownloaded?: (callback: (info: { version: string }) => void) => () => void;

  // File/folder operations for image management
  selectFolder?: () => Promise<string | null>;
  listImagesInFolder?: (folderPath: string) => Promise<{ path: string; name: string; dataUrl?: string }[]>;
  readImageAsDataUrl?: (imagePath: string) => Promise<string | null>;

  // Cloud API host from proxy-config.json (main process)
  getCloudApiHost?: () => Promise<string>;

  // Cookie persistence for "Remember Me" feature
  persistCookies?: () => Promise<boolean>;
  clearPersistedCookies?: () => Promise<boolean>;

  // Network addresses for domain name combobox
  getNetworkAddresses?: () => Promise<string[]>;
  getHostname?: () => Promise<string>;

  // UFW firewall management (Linux only; returns { supported: false } on other platforms)
  ufwManage?: (
    action: "status" | "apply" | "remove",
    port?: number
  ) => Promise<{
    supported?: boolean;
    installed?: boolean;
    enabled?: boolean;
    success?: boolean;
    error?: string;
  }>;

  // Backend logging access
  logs?: {
    get: () => Promise<LogEntry[]>;
    clear: () => Promise<boolean>;
    openWindow: () => Promise<boolean>;
    onEntry: (callback: (entry: LogEntry) => void) => () => void;
    sendEntry: (entry: { timestamp: number; level: string; message: string; args?: unknown[] }) => void;
  };

  // Print preview window
  print?: {
    openWindow: () => Promise<boolean>;
  };
}

/**
 * Log entry from the Electron backend
 */
export interface LogEntry {
  timestamp: number;
  level: "log" | "warn" | "error" | "info" | "debug";
  message: string;
  args?: unknown[];
  source?: "frontend" | "backend";
}

/**
 * Unified P2P session info (works across UDP and Bluetooth transports)
 */
export interface P2PSessionInfo {
  id: string; // Prefixed endpoint ID (udp_ or bt_)
  name: string;
  deviceId: string;
  hostId: string;
  url: string;
  transport: "udp" | "bluetooth";
  address?: string;
  port?: number;
  detected: number;
}

/**
 * P2P transport status
 */
export interface P2PStatus {
  udpAvailable: boolean;
  bluetoothAvailable: boolean;
  isAdvertising: boolean;
  isDiscovering: boolean;
}

/**
 * @deprecated Use P2PSessionInfo instead
 * Local session discovered via UDP broadcast (legacy interface)
 */
export interface LocalSessionInfo {
  id: string;
  name: string;
  deviceId: string;
  hostId: string; // hostname from offer's "id" field
  url: string;
  address: string;
  port: number;
  detected: number;
}

declare global {
  interface Window {
    electronAPI?: IElectronAPI;
  }
}
