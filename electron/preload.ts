import { contextBridge, ipcRenderer, IpcRendererEvent } from "electron";
import { Display, PlaylistEntry } from "../common/pp-types";
import { Settings } from "../src/types";
import { ApiResponse } from "../common/ipc-types";
import type {
  WebServerApiRequest,
  WebServerEvent,
  WebServerInterface,
  WebServerQuery,
  WebServerQueryResult,
  WebServerResponse,
  WebServerSyncUpdate,
} from "../common/webserver-interface";
import { WindowBounds } from "../src/types/electron";

type HostDeviceMessage = {
  op: string;
  param: unknown;
};

const hostDeviceMessageListeners = new Set<(message: HostDeviceMessage) => void>();
const webServerEventListeners = new Set<(event: WebServerEvent) => void>();

const randomRequestId = () => `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;

const emitHostDeviceMessage = (message: HostDeviceMessage) => {
  // Legacy client pages consume a global handleDeviceMessage callback.
  const globalWindow = window as unknown as {
    handleDeviceMessage?: (raw: string) => void;
    dispatchEvent?: (event: Event) => boolean;
  };
  if (typeof globalWindow.handleDeviceMessage === "function") {
    globalWindow.handleDeviceMessage(JSON.stringify(message));
  }
  if (typeof globalWindow.dispatchEvent === "function") {
    globalWindow.dispatchEvent(new CustomEvent("pp-hostdevice-message", { detail: message }));
  }
  for (const listener of hostDeviceMessageListeners) {
    try {
      listener(message);
    } catch (error) {
      console.error("[preload] hostDevice listener error", error);
    }
  }
};

const emitWebServerEvent = (event: WebServerEvent) => {
  for (const listener of webServerEventListeners) {
    try {
      listener(event);
    } catch (error) {
      console.error("[preload] webServer listener error", error);
    }
  }
};

ipcRenderer.on("hostdevice-message", (_event, payload: HostDeviceMessage) => {
  if (!payload || typeof payload.op !== "string") return;
  emitHostDeviceMessage(payload);
});

ipcRenderer.on(
  "remote-display-update",
  (
    _event,
    data: {
      command: "song_update" | "display_update";
      id: string;
      from: number;
      to: number;
      section?: number;
      sectionRepeatCounts?: Display["sectionRepeatCounts"];
      sectionRepeatNonce?: number;
      transpose?: number;
      capo?: number;
      instructions?: string;
      title?: string;
      playlist?: PlaylistEntry[];
    }
  ) => {
    emitWebServerEvent({ kind: "remoteDisplayUpdate", update: data });
  }
);

ipcRenderer.on(
  "webserver-api-request",
  (
    _event,
    payload: {
      requestId?: string;
      method: string;
      path: string;
      query: Record<string, unknown>;
      body: unknown;
      headers: Record<string, unknown>;
    }
  ) => {
    const request: WebServerApiRequest = {
      requestId: typeof payload?.requestId === "string" && payload.requestId.length > 0 ? payload.requestId : randomRequestId(),
      method: payload?.method || "GET",
      path: payload?.path || "/",
      query: payload?.query || {},
      body: payload?.body,
      headers: payload?.headers || {},
    };
    emitWebServerEvent({ kind: "apiRequest", request });
  }
);

ipcRenderer.on("highlight-access-request", (_event, data: { clientId: string }) => {
  emitWebServerEvent({ kind: "highlightAccessRequest", clientId: data?.clientId || "" });
});

ipcRenderer.on("highlight-changed", (_event, data: { line: number; section?: number }) => {
  emitWebServerEvent({ kind: "highlightChanged", line: data?.line ?? -1, section: data?.section });
});

ipcRenderer.on("remote-highlight-controller-changed", (_event, data: { clientId: string }) => {
  emitWebServerEvent({ kind: "highlightControllerChanged", clientId: data?.clientId || "" });
});

const webServerBridge: WebServerInterface = {
  sync: async (update: WebServerSyncUpdate) => {
    switch (update.kind) {
      case "display":
        await ipcRenderer.invoke("set-current-display", update.display);
        return;
      case "frame":
        ipcRenderer.send("set-display-window-image", update.imageDataUrl, update.options);
        return;
      case "leader":
        ipcRenderer.send("sync-leader-name", update.leaderName);
        return;
      case "config":
        ipcRenderer.send("webserver-sync-config", update.config);
        return;
      case "appAssets":
        return;
    }
  },
  query: async (request: WebServerQuery): Promise<WebServerQueryResult> => {
    switch (request.kind) {
      case "clients": {
        if (request.projectingOnly) {
          const count = await ipcRenderer.invoke("get-connected-clients", true);
          return {
            kind: "clients",
            clients: [],
            count: typeof count === "number" ? count : 0,
          };
        }
        const clients = await ipcRenderer.invoke("get-connected-clients", false);
        const safeClients = Array.isArray(clients) ? clients : [];
        return {
          kind: "clients",
          clients: safeClients,
          count: safeClients.length,
        };
      }
      case "highlightController": {
        const clientId = await ipcRenderer.invoke("get-remote-highlight-controller");
        return {
          kind: "highlightController",
          clientId: typeof clientId === "string" ? clientId : "",
        };
      }
    }
  },
  respond: async (response: WebServerResponse) => {
    switch (response.kind) {
      case "api":
        ipcRenderer.send("webserver-api-response", response.response);
        return;
      case "highlightAccess":
        ipcRenderer.send("respond-highlight-access", { clientId: response.clientId, grant: response.grant });
        return;
    }
  },
  onEvent: (callback: (event: WebServerEvent) => void) => {
    webServerEventListeners.add(callback);
    return () => {
      webServerEventListeners.delete(callback);
    };
  },
};

contextBridge.exposeInMainWorld("webServer", webServerBridge);

contextBridge.exposeInMainWorld("electronAPI", {
  // Window bounds management
  getWindowBounds: () => ipcRenderer.invoke("get-window-bounds"),
  setWindowBounds: (bounds: WindowBounds) => ipcRenderer.invoke("set-window-bounds", bounds),

  // Display/Monitor management
  getAllDisplays: () => ipcRenderer.invoke("get-all-displays"),
  showDisplayWindow: (displayId: string, imageData: string) => ipcRenderer.invoke("show-display-window", displayId, imageData),
  hideDisplayWindow: () => ipcRenderer.invoke("hide-display-window"),
  isDisplayWindowOpen: () => ipcRenderer.invoke("is-display-window-open"),

  // Playlist file operations
  savePlaylistFile: (content: string) => ipcRenderer.invoke("save-playlist-file", content),
  loadPlaylistFile: () => ipcRenderer.invoke("load-playlist-file"),
  saveDatabaseFile: (data: ArrayBuffer, defaultFileName?: string) => ipcRenderer.invoke("save-database-file", { data, defaultFileName }),

  // Proxy operations
  proxyGet: (baseUrl: string, path: string, headers?: Record<string, string>) => ipcRenderer.invoke("proxy-get", baseUrl, path, headers),
  proxyPost: (baseUrl: string, path: string, data: unknown, headers?: Record<string, string>) =>
    ipcRenderer.invoke("proxy-post", baseUrl, path, data, headers),

  // Current display state management
  setCurrentDisplay: (display: Display) => ipcRenderer.invoke("set-current-display", display),
  getMainWindowDisplayId: () => ipcRenderer.invoke("get-main-window-display-id"),

  // General WebServer API request handler
  onWebserverApiRequest: (
    callback: (apiRequest: {
      requestId?: string;
      method: string;
      path: string;
      query: Record<string, unknown>;
      body: unknown;
      headers: Record<string, unknown>;
    }) => void
  ) => {
    const subscription = (
      _event: IpcRendererEvent,
      apiRequest: {
        requestId?: string;
        method: string;
        path: string;
        query: Record<string, unknown>;
        body: unknown;
        headers: Record<string, unknown>;
      }
    ) => callback(apiRequest);
    ipcRenderer.on("webserver-api-request", subscription);
    return () => {
      ipcRenderer.removeListener("webserver-api-request", subscription);
    };
  },

  sendWebserverApiResponse: (response: ApiResponse) => {
    ipcRenderer.send("webserver-api-response", response);
  },

  // Settings sync - frontend pushes settings to backend
  syncSettings: (settings: Settings) => {
    ipcRenderer.send("sync-settings", settings);
  },

  // Localization sync - frontend pushes language (and optionally string tables) to backend
  updateLocalization: (payload: { language: "en" | "hu"; strings?: Record<string, Record<string, string>> }) => {
    ipcRenderer.send("update-localization", payload);
  },

  // Sync leader name (for UDP offer - C# uses cmbLeader.Text which is the name, not ID)
  syncLeaderName: (leaderName: string) => {
    ipcRenderer.send("sync-leader-name", leaderName);
  },

  // Internal Electron display window update (lossless frame)
  setDisplayWindowImage: (
    imageDataUrl: string | null,
    options?: { jpegQuality?: number; imageScale?: number; bgColor?: string; transient?: number }
  ) => {
    ipcRenderer.send("set-display-window-image", imageDataUrl, options);
  },

  // Get connected clients from webserver (for admin client selection)
  getProjectingClientsCount: () => ipcRenderer.invoke("get-connected-clients", true),
  getConnectedClients: () => ipcRenderer.invoke("get-connected-clients", false),

  // Highlight access control
  onHighlightAccessRequest: (callback: (data: { clientId: string }) => void) => {
    const subscription = (_event: IpcRendererEvent, data: { clientId: string }) => callback(data);
    ipcRenderer.on("highlight-access-request", subscription);
    return () => {
      ipcRenderer.removeListener("highlight-access-request", subscription);
    };
  },

  onHighlightChanged: (callback: (data: { line: number }) => void) => {
    const subscription = (_event: IpcRendererEvent, data: { line: number; section?: number }) => callback(data);
    ipcRenderer.on("highlight-changed", subscription);
    return () => {
      ipcRenderer.removeListener("highlight-changed", subscription);
    };
  },

  // Remote display/song update from web clients (matching C# SongChanged/PlayListItemChanged)
  onRemoteDisplayUpdate: (
    callback: (data: {
      command: "song_update" | "display_update";
      id: string;
      from: number;
      to: number;
      section?: number;
      sectionRepeatCounts?: Display["sectionRepeatCounts"];
      sectionRepeatNonce?: number;
      transpose: number;
      capo: number;
      instructions: string;
      title: string;
      playlist?: PlaylistEntry[];
    }) => void
  ) => {
    const subscription = (
      _event: IpcRendererEvent,
      data: {
        command: "song_update" | "display_update";
        id: string;
        from: number;
        to: number;
        section?: number;
        sectionRepeatCounts?: Display["sectionRepeatCounts"];
        sectionRepeatNonce?: number;
        transpose: number;
        capo: number;
        instructions: string;
        title: string;
        playlist?: PlaylistEntry[];
      }
    ) => callback(data);
    ipcRenderer.on("remote-display-update", subscription);
    return () => {
      ipcRenderer.removeListener("remote-display-update", subscription);
    };
  },

  respondHighlightAccess: (clientId: string, grant: boolean) => {
    ipcRenderer.send("respond-highlight-access", { clientId, grant });
  },

  getRemoteHighlightController: () => ipcRenderer.invoke("get-remote-highlight-controller"),

  // P2P session scanning (unified UDP + Bluetooth)
  // Methods maintain "udp" prefix for backwards compatibility
  udpScanSessions: (broadcastAddress?: string) => ipcRenderer.invoke("udp-scan-sessions", broadcastAddress),
  udpGetDiscoveredSessions: () => ipcRenderer.invoke("udp-get-discovered-sessions"),

  // P2P watch mode - supports both prefixed endpoint IDs and legacy parameters
  udpStartWatching: (deviceIdOrEndpoint: string, hostId?: string, address?: string, port?: number) =>
    ipcRenderer.invoke("udp-start-watching", deviceIdOrEndpoint, hostId, address, port),
  udpStopWatching: () => ipcRenderer.invoke("udp-stop-watching"),
  onUdpDisplayUpdate: (callback: (display: unknown) => void) => {
    const subscription = (_event: IpcRendererEvent, display: unknown) => callback(display);
    ipcRenderer.on("udp-display-update", subscription);
    return () => {
      ipcRenderer.removeListener("udp-display-update", subscription);
    };
  },
  onUdpSessionEnded: (callback: () => void) => {
    const subscription = () => callback();
    ipcRenderer.on("udp-session-ended", subscription);
    return () => {
      ipcRenderer.removeListener("udp-session-ended", subscription);
    };
  },

  // P2P transport status
  p2pGetStatus: () => ipcRenderer.invoke("p2p-get-status"),

  // Bluetooth settings helper (opens OS Bluetooth settings for pairing)
  openBluetoothSettings: () => ipcRenderer.invoke("open-bluetooth-settings"),

  onRemoteHighlightControllerChanged: (callback: (data: { clientId: string }) => void) => {
    const subscription = (_event: IpcRendererEvent, data: { clientId: string }) => callback(data);
    ipcRenderer.on("remote-highlight-controller-changed", subscription);
    return () => {
      ipcRenderer.removeListener("remote-highlight-controller-changed", subscription);
    };
  },

  // Auto-updater
  getAppVersion: () => ipcRenderer.invoke("get-app-version"),
  checkForUpdates: () => ipcRenderer.invoke("check-for-updates"),
  downloadUpdate: () => ipcRenderer.invoke("download-update"),
  installUpdate: () => ipcRenderer.invoke("install-update"),
  onUpdateAvailable: (callback: (info: { version: string }) => void) => {
    const subscription = (_event: IpcRendererEvent, info: { version: string }) => callback(info);
    ipcRenderer.on("update-available", subscription);
    return () => {
      ipcRenderer.removeListener("update-available", subscription);
    };
  },
  onUpdateNotAvailable: (callback: () => void) => {
    const subscription = () => callback();
    ipcRenderer.on("update-not-available", subscription);
    return () => {
      ipcRenderer.removeListener("update-not-available", subscription);
    };
  },
  onUpdateDownloadProgress: (callback: (progress: { percent: number }) => void) => {
    const subscription = (_event: IpcRendererEvent, progress: { percent: number }) => callback(progress);
    ipcRenderer.on("update-download-progress", subscription);
    return () => {
      ipcRenderer.removeListener("update-download-progress", subscription);
    };
  },
  onUpdateDownloaded: (callback: (info: { version: string }) => void) => {
    const subscription = (_event: IpcRendererEvent, info: { version: string }) => callback(info);
    ipcRenderer.on("update-downloaded", subscription);
    return () => {
      ipcRenderer.removeListener("update-downloaded", subscription);
    };
  },

  // Image folder management
  selectFolder: () => ipcRenderer.invoke("select-folder"),
  listImagesInFolder: (folderPath: string) => ipcRenderer.invoke("list-images-in-folder", folderPath),
  readImageAsDataUrl: (imagePath: string) => ipcRenderer.invoke("read-image-as-data-url", imagePath),

  // BLE Peripheral mode (requires @abandonware/bleno module)
  // Allows Android devices to discover and connect to this computer
  blePeripheral: {
    isAvailable: () => ipcRenderer.invoke("ble-peripheral:is-available"),
    getState: () => ipcRenderer.invoke("ble-peripheral:get-state"),
    startAdvertising: (name?: string) => ipcRenderer.invoke("ble-peripheral:start-advertising", name),
    stopAdvertising: () => ipcRenderer.invoke("ble-peripheral:stop-advertising"),
    send: (deviceId: string, message: unknown) => ipcRenderer.invoke("ble-peripheral:send", deviceId, message),
    broadcast: (message: unknown) => ipcRenderer.invoke("ble-peripheral:broadcast", message),
    getConnectedDevices: () => ipcRenderer.invoke("ble-peripheral:get-connected-devices"),
    onConnection: (callback: (deviceId: string, connected: boolean) => void) => {
      const subscription = (_event: IpcRendererEvent, deviceId: string, connected: boolean) => callback(deviceId, connected);
      ipcRenderer.on("ble-peripheral:connection", subscription);
      return () => {
        ipcRenderer.removeListener("ble-peripheral:connection", subscription);
      };
    },
    onMessage: (callback: (deviceId: string, message: unknown) => void) => {
      const subscription = (_event: IpcRendererEvent, deviceId: string, message: unknown) => callback(deviceId, message);
      ipcRenderer.on("ble-peripheral:message", subscription);
      return () => {
        ipcRenderer.removeListener("ble-peripheral:message", subscription);
      };
    },
  },

  // Cloud API host from proxy-config.json (main process)
  getCloudApiHost: () => ipcRenderer.invoke("get-cloud-api-host") as Promise<string>,

  // Cookie persistence for "Remember Me" feature
  persistCookies: () => ipcRenderer.invoke("persist-cookies") as Promise<boolean>,
  clearPersistedCookies: () => ipcRenderer.invoke("clear-persisted-cookies") as Promise<boolean>,

  // Network addresses for domain name combobox
  getNetworkAddresses: () => ipcRenderer.invoke("get-network-addresses"),
  getHostname: () => ipcRenderer.invoke("get-hostname") as Promise<string>,

  // UFW firewall management (Linux only)
  ufwManage: (action: "status" | "apply" | "remove", port?: number) => ipcRenderer.invoke("ufw-manage", action, port),

  // Backend logging access
  logs: {
    get: () => ipcRenderer.invoke("logs:get"),
    clear: () => ipcRenderer.invoke("logs:clear"),
    openWindow: () => ipcRenderer.invoke("logs:open-window"),
    onEntry: (callback: (entry: { timestamp: number; level: string; message: string; args?: unknown[]; source?: string }) => void) => {
      const subscription = (
        _event: IpcRendererEvent,
        entry: { timestamp: number; level: string; message: string; args?: unknown[]; source?: string }
      ) => callback(entry);
      ipcRenderer.on("logs:entry", subscription);
      return () => {
        ipcRenderer.removeListener("logs:entry", subscription);
      };
    },
    sendEntry: (entry: { timestamp: number; level: string; message: string; args?: unknown[] }) => {
      ipcRenderer.send("logs:frontend-entry", entry);
    },
  },

  // Print preview window management
  print: {
    openWindow: () => ipcRenderer.invoke("print:open-window"),
  },
});

contextBridge.exposeInMainWorld("hostDevice", {
  debugLog: (tag: string, message: string) => ipcRenderer.invoke("hostdevice-debug-log", tag, message),
  showToast: (toast: string) => ipcRenderer.invoke("hostdevice-show-toast", toast),
  getErrors: () => ipcRenderer.invoke("hostdevice-get-errors"),
  sendUdpMessage: (message: string, host: string, port: string) => ipcRenderer.invoke("hostdevice-send-udp-message", message, host, port),
  listenOnUdpPort: (port: string) => ipcRenderer.invoke("hostdevice-listen-on-udp-port", port),
  closeUdpPort: (port: string) => ipcRenderer.invoke("hostdevice-close-udp-port", port),
  getHome: () => ipcRenderer.invoke("hostdevice-get-home"),
  goHome: () => ipcRenderer.invoke("hostdevice-go-home"),
  setFullScreen: (fs?: boolean) => ipcRenderer.invoke("hostdevice-set-fullscreen", fs),
  isFullScreen: () => ipcRenderer.invoke("hostdevice-is-fullscreen"),
  dialog: (message: string, title: string, positiveLabel: string, negativeLabel: string) =>
    ipcRenderer.invoke("hostdevice-dialog", message, title, positiveLabel, negativeLabel),
  storePreference: (key: string, value: string) => ipcRenderer.invoke("hostdevice-store-preference", key, value),
  retrievePreference: (key: string) => ipcRenderer.invoke("hostdevice-retrieve-preference", key),
  getName: () => ipcRenderer.invoke("hostdevice-get-name"),
  getModel: () => ipcRenderer.invoke("hostdevice-get-model"),
  exit: () => ipcRenderer.invoke("hostdevice-exit"),
  version: () => ipcRenderer.invoke("hostdevice-version"),
  info: (flags: number) => ipcRenderer.invoke("hostdevice-info", flags),
  getNetworkInterfaces: () => ipcRenderer.invoke("hostdevice-get-network-interfaces"),
  enableNotification: (sessionId: string, name: string, descriptionText: string, checkIntervalMinutes: number, acquire: boolean) =>
    ipcRenderer.invoke("hostdevice-enable-notification", sessionId, name, descriptionText, checkIntervalMinutes, acquire),
  getCacheSize: () => ipcRenderer.invoke("hostdevice-get-cache-size"),
  clearCache: (includeDiskFiles: boolean) => ipcRenderer.invoke("hostdevice-clear-cache", includeDiskFiles),
  startNavigationTimeout: (navigationTimeoutMs: number, message: string) =>
    ipcRenderer.invoke("hostdevice-start-navigation-timeout", navigationTimeoutMs, message),
  pageLoadedSuccessfully: () => ipcRenderer.invoke("hostdevice-page-loaded-successfully"),
  keepScreenOn: (enabled: boolean) => ipcRenderer.invoke("hostdevice-keep-screen-on", enabled),
  // No `share`: Electron desktop has no native share sheet, so `hostDevice.share` is intentionally
  // absent here. The renderer's shareService then degrades to the Web Share API / clipboard instead
  // of (previously) opening the public page in the browser, which is not a share.
  openLinkExternal: (url: string) => ipcRenderer.invoke("hostdevice-open-link-external", url),
  getThirdPartyLicenseSections: () => ipcRenderer.invoke("hostdevice-get-third-party-license-sections"),
  checkNearbyPermissions: (acquire: boolean) => ipcRenderer.invoke("hostdevice-check-nearby-permissions", acquire),
  advertiseNearby: (enabled: boolean) => ipcRenderer.invoke("hostdevice-advertise-nearby", enabled),
  discoverNearby: (enabled: boolean) => ipcRenderer.invoke("hostdevice-discover-nearby", enabled),
  connectNearby: (endpointId: string) => ipcRenderer.invoke("hostdevice-connect-nearby", endpointId),
  sendNearbyMessage: (endpointId: string, message: string) => ipcRenderer.invoke("hostdevice-send-nearby-message", endpointId, message),
  closeNearby: (endpointId: string) => ipcRenderer.invoke("hostdevice-close-nearby", endpointId),
  getNearbyState: () => ipcRenderer.invoke("hostdevice-get-nearby-state"),
});
