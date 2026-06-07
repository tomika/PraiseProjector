import type {
  WebServerApiRequest,
  WebServerConfig,
  WebServerEvent,
  WebServerInterface,
  WebServerNativeWireInterface,
  WebServerQuery,
  WebServerQueryResult,
  WebServerResponse,
  WebServerSyncUpdate,
} from "../../common/webserver-interface";
import type { IElectronAPI } from "../types/electron";
import type { Settings } from "../types";

const resolvePromise = async <T>(value: T | Promise<T>) => value;

const newRequestId = () => `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;

const parseJsonOrNull = <T>(json: string): T | null => {
  try {
    return JSON.parse(json) as T;
  } catch {
    return null;
  }
};

type NativeWireMethod = "syncJson" | "queryJson" | "respondJson";
const WEB_SERVER_EVENT_NAME = "pp-webserver-event";
const APP_SW_PATH = "/app/sw.js";
const APP_ASSET_PREFIX = "/app/";

let nativeWireUnavailable = false;
let swAssetListPromise: Promise<string[] | null> | null = null;
let lastSyncedAppAssetSignature = "";

const getErrorMessage = (error: unknown) => {
  if (error instanceof Error) return error.message;
  if (typeof error === "string") return error;
  return String(error ?? "unknown error");
};

const isNativeWireRecoverableError = (error: unknown) => {
  const message = getErrorMessage(error);
  return /non-injected object|missing hostdevice|can't be invoked on a non-injected object/i.test(message);
};

const disableNativeWire = (method: NativeWireMethod, error: unknown) => {
  if (nativeWireUnavailable) return;
  nativeWireUnavailable = true;
  console.warn("WebServer native wire disabled after bridge error", { method, error: getErrorMessage(error) });
};

const defaultQueryResult = (request: WebServerQuery): WebServerQueryResult => {
  if (request.kind === "clients") return { kind: "clients", clients: [], count: 0 };
  return { kind: "highlightController", clientId: "" };
};

const createNativeWireAdapter = (wire: WebServerNativeWireInterface, fallback?: WebServerInterface): WebServerInterface => {
  const callWire = async (method: NativeWireMethod, payloadJson: string): Promise<string | null> => {
    if (nativeWireUnavailable) return null;

    const invoke = wire[method];
    if (typeof invoke !== "function") {
      disableNativeWire(method, `Missing native method ${method}`);
      return null;
    }

    try {
      return await resolvePromise(invoke.call(wire, payloadJson));
    } catch (error) {
      if (isNativeWireRecoverableError(error)) {
        disableNativeWire(method, error);
        return null;
      }
      throw error;
    }
  };

  return {
    sync: async (update: WebServerSyncUpdate) => {
      const payloadJson = JSON.stringify(update);
      const result = await callWire("syncJson", payloadJson);
      if (result === null && fallback) {
        await fallback.sync(update);
      }
    },
    query: async (request: WebServerQuery) => {
      const payloadJson = JSON.stringify(request);
      const responseJson = await callWire("queryJson", payloadJson);
      if (responseJson === null) {
        if (fallback) return fallback.query(request);
        return defaultQueryResult(request);
      }
      const parsed = parseJsonOrNull<WebServerQueryResult>(responseJson);
      if (parsed) return parsed;
      return defaultQueryResult(request);
    },
    respond: async (response: WebServerResponse) => {
      const payloadJson = JSON.stringify(response);
      const result = await callWire("respondJson", payloadJson);
      if (result === null && fallback) {
        await fallback.respond(response);
      }
    },
    onEvent: (callback: (event: WebServerEvent) => void) => {
      if (nativeWireUnavailable && fallback) {
        return fallback.onEvent(callback);
      }

      const registerSink = wire.registerEventSink;
      if (typeof registerSink === "function") {
        void resolvePromise(registerSink.call(wire, WEB_SERVER_EVENT_NAME)).catch((error) => {
          if (isNativeWireRecoverableError(error)) {
            disableNativeWire("queryJson", error);
          }
        });
      }

      const domEventListener = (e: Event) => {
        const detail = (e as CustomEvent<WebServerEvent>).detail;
        if (!detail || typeof detail !== "object" || !("kind" in detail)) return;
        callback(detail);
      };

      window.addEventListener(WEB_SERVER_EVENT_NAME, domEventListener);
      return () => {
        window.removeEventListener(WEB_SERVER_EVENT_NAME, domEventListener);
      };
    },
  };
};

const createLegacyElectronAdapter = (electronAPI: IElectronAPI): WebServerInterface => {
  return {
    sync: async (update: WebServerSyncUpdate) => {
      switch (update.kind) {
        case "display":
          await electronAPI.setCurrentDisplay?.(update.display);
          return;
        case "frame":
          electronAPI.setDisplayWindowImage?.(update.imageDataUrl, update.options);
          return;
        case "leader":
          electronAPI.syncLeaderName?.(update.leaderName);
          return;
        case "config":
          return;
        case "appAssets":
          return;
      }
    },
    query: async (request: WebServerQuery): Promise<WebServerQueryResult> => {
      if (request.kind === "clients") {
        if (request.projectingOnly) {
          const count = (await electronAPI.getProjectingClientsCount?.()) ?? 0;
          return { kind: "clients", clients: [], count };
        }
        const clients = (await electronAPI.getConnectedClients?.()) ?? [];
        return {
          kind: "clients",
          clients,
          count: clients.length,
        };
      }
      return {
        kind: "highlightController",
        clientId: (await electronAPI.getRemoteHighlightController?.()) || "",
      };
    },
    respond: async (response: WebServerResponse) => {
      switch (response.kind) {
        case "api":
          electronAPI.sendWebserverApiResponse?.(response.response);
          return;
        case "highlightAccess":
          electronAPI.respondHighlightAccess?.(response.clientId, response.grant);
          return;
      }
    },
    onEvent: (callback: (event: WebServerEvent) => void) => {
      const unsubs: Array<() => void> = [];

      if (electronAPI.onRemoteDisplayUpdate) {
        unsubs.push(
          electronAPI.onRemoteDisplayUpdate((update) => {
            callback({ kind: "remoteDisplayUpdate", update });
          })
        );
      }

      if (electronAPI.onWebserverApiRequest) {
        unsubs.push(
          electronAPI.onWebserverApiRequest((request) => {
            const apiRequest: WebServerApiRequest = {
              requestId: typeof request.requestId === "string" && request.requestId.length > 0 ? request.requestId : newRequestId(),
              method: request.method,
              path: request.path,
              query: request.query,
              body: request.body,
              headers: request.headers,
            };
            callback({ kind: "apiRequest", request: apiRequest });
          })
        );
      }

      if (electronAPI.onHighlightAccessRequest) {
        unsubs.push(
          electronAPI.onHighlightAccessRequest((data) => {
            callback({ kind: "highlightAccessRequest", clientId: data.clientId || "" });
          })
        );
      }

      if (electronAPI.onHighlightChanged) {
        unsubs.push(
          electronAPI.onHighlightChanged((data) => {
            callback({ kind: "highlightChanged", line: data.line });
          })
        );
      }

      if (electronAPI.onRemoteHighlightControllerChanged) {
        unsubs.push(
          electronAPI.onRemoteHighlightControllerChanged((data) => {
            callback({ kind: "highlightControllerChanged", clientId: data.clientId || "" });
          })
        );
      }

      return () => {
        for (const unsub of unsubs) unsub();
      };
    },
  };
};

let cachedWebServer: WebServerInterface | null | undefined;

export const isWebServerRuntimeAvailable = (): boolean => {
  if (typeof window === "undefined") return false;
  return !!(window.webServer || window.webServerNativeWire || window.electronAPI);
};

export const getWebServerInterface = (): WebServerInterface | null => {
  if (cachedWebServer !== undefined) return cachedWebServer;

  const fallback = window.electronAPI ? createLegacyElectronAdapter(window.electronAPI) : undefined;

  if (window.webServer) {
    cachedWebServer = window.webServer;
    return cachedWebServer;
  }

  if (window.webServerNativeWire && !nativeWireUnavailable) {
    cachedWebServer = createNativeWireAdapter(window.webServerNativeWire, fallback);
    return cachedWebServer;
  }

  if (fallback) {
    cachedWebServer = fallback;
    return cachedWebServer;
  }

  cachedWebServer = null;
  return cachedWebServer;
};

const parseAppAssetListFromSw = (source: string): string[] => {
  const paths = new Set<string>();
  const pathPattern = /["'](\/app\/[^"']+)["']/g;
  let match: RegExpExecArray | null;

  while ((match = pathPattern.exec(source)) !== null) {
    const rawPath = match[1]?.trim() || "";
    if (!rawPath.startsWith(APP_ASSET_PREFIX)) continue;
    const sanitizedPath = rawPath.split("?")[0]?.split("#")[0] || "";
    if (!sanitizedPath || sanitizedPath.includes("..")) continue;
    paths.add(sanitizedPath);
  }

  // Ensure primary entry points are always available even if omitted from sw.js.
  paths.add("/app/index.html");
  paths.add("/app/main.html");

  return Array.from(paths);
};

const loadAppAssetListFromSw = async (): Promise<string[] | null> => {
  if (typeof window === "undefined") return null;

  if (!swAssetListPromise) {
    swAssetListPromise = (async () => {
      try {
        const response = await fetch(APP_SW_PATH, { cache: "no-store" });
        if (!response.ok) {
          console.warn("WebServer", "Unable to load app service worker asset list", { status: response.status });
          return null;
        }

        const source = await response.text();
        const assets = parseAppAssetListFromSw(source);
        if (assets.length === 0) {
          console.warn("WebServer", "No /app assets found in service worker script");
          return null;
        }

        return assets;
      } catch (error) {
        console.warn("WebServer", "Failed to read app service worker asset list", error);
        return null;
      }
    })();
  }

  const assets = await swAssetListPromise;
  if (!assets || assets.length === 0) {
    swAssetListPromise = null;
  }

  return assets;
};

export const syncAndroidAppAssetsFromServiceWorker = async (): Promise<void> => {
  if (typeof window === "undefined") return;
  if (!window.webServerNativeWire) return;

  const webServer = getWebServerInterface();
  if (!webServer) return;

  const assets = await loadAppAssetListFromSw();
  if (!assets || assets.length === 0) return;

  const signature = assets.join("\n");
  if (signature === lastSyncedAppAssetSignature) return;

  await webServer.sync({ kind: "appAssets", assets });
  lastSyncedAppAssetSignature = signature;
};

export const toWebServerConfig = (settings: Settings): WebServerConfig => {
  return {
    webServerPort: settings.webServerPort,
    webServerPath: settings.webServerPath,
    webServerDomainName: settings.webServerDomainName,
    webServerAcceptLanClientsOnly: settings.webServerAcceptLanClientsOnly,
    longPollTimeout: settings.longPollTimeout,
    allClientsCanUseLeaderMode: settings.allClientsCanUseLeaderMode,
    leaderModeClients: settings.leaderModeClients,
    stylesToClients: settings.stylesToClients,
    chordProStyles: settings.chordProStyles,
  };
};
