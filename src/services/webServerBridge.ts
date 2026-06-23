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
// Authoritative list of files the host webserver serves for the new client-view, emitted by
// build:client-view (vite.client-view.config.ts). Preferred over scraping the legacy sw.js.
const CLIENT_VIEW_PRECACHE_PATH = "/app/client-view/precache.json";
const REQUIRED_NATIVE_WIRE_METHODS: NativeWireMethod[] = ["syncJson", "queryJson", "respondJson"];

let cachedWebServer: WebServerInterface | undefined;
let assetListPromise: Promise<string[] | null> | null = null;
let lastSyncedAppAssetSignature = "";

const getErrorMessage = (error: unknown) => {
  if (error instanceof Error) return error.message;
  if (typeof error === "string") return error;
  return String(error ?? "unknown error");
};

const hasWebServerInterfaceShape = (candidate: unknown): candidate is WebServerInterface => {
  if (!candidate || typeof candidate !== "object") return false;
  const maybe = candidate as Partial<WebServerInterface>;
  return (
    typeof maybe.sync === "function" &&
    typeof maybe.query === "function" &&
    typeof maybe.respond === "function" &&
    typeof maybe.onEvent === "function"
  );
};

const hasNativeWireShape = (wire: WebServerNativeWireInterface): boolean => {
  const missing = REQUIRED_NATIVE_WIRE_METHODS.filter((method) => typeof wire[method] !== "function");
  if (missing.length === 0) return true;

  console.warn("WebServer native wire validation failed", { missing });
  return false;
};

const defaultQueryResult = (request: WebServerQuery): WebServerQueryResult => {
  if (request.kind === "clients") return { kind: "clients", clients: [], count: 0 };
  return { kind: "highlightController", clientId: "" };
};

const createNativeWireAdapter = (wire: WebServerNativeWireInterface, fallback?: WebServerInterface): WebServerInterface => {
  const callWire = async (method: NativeWireMethod, payloadJson: string): Promise<string | null> => {
    const invoke = wire[method];
    if (typeof invoke !== "function") {
      console.warn("WebServer native wire method missing", { method });
      return null;
    }

    try {
      const result = await resolvePromise(invoke.call(wire, payloadJson));
      if (typeof result !== "string") {
        console.warn("WebServer native wire returned non-string payload", { method, type: typeof result });
        return null;
      }
      return result;
    } catch (error) {
      console.warn("WebServer native wire call failed", { method, error: getErrorMessage(error) });
      return null;
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
      const registerSink = wire.registerEventSink;
      if (typeof registerSink === "function") {
        void resolvePromise(registerSink.call(wire, WEB_SERVER_EVENT_NAME)).catch((error) => {
          console.warn("WebServer event sink registration failed", { error: getErrorMessage(error) });
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

export const isWebServerRuntimeAvailable = (): boolean => {
  if (typeof window === "undefined") return false;
  return !!(window.webServer || window.webServerNativeWire || window.electronAPI);
};

export const getWebServerInterface = (): WebServerInterface | null => {
  if (typeof window === "undefined") return null;
  if (cachedWebServer) return cachedWebServer;

  const fallback = window.electronAPI ? createLegacyElectronAdapter(window.electronAPI) : undefined;

  if (window.webServer) {
    if (hasWebServerInterfaceShape(window.webServer as unknown)) {
      cachedWebServer = window.webServer;
      return cachedWebServer;
    }
    console.warn("WebServer interface validation failed for window.webServer");
  }

  if (window.webServerNativeWire) {
    if (hasNativeWireShape(window.webServerNativeWire)) {
      cachedWebServer = createNativeWireAdapter(window.webServerNativeWire, fallback);
      return cachedWebServer;
    }
    console.warn("WebServer native wire validation failed; falling back if available");
  }

  if (fallback) {
    cachedWebServer = fallback;
    return cachedWebServer;
  }

  // Do not cache null: runtime bridges can appear later in app startup.
  return null;
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

const sanitizeAssetPath = (rawPath: string): string | null => {
  const trimmed = rawPath.trim();
  if (!trimmed.startsWith(APP_ASSET_PREFIX)) return null;
  const sanitized = trimmed.split("?")[0]?.split("#")[0] || "";
  if (!sanitized || sanitized.includes("..")) return null;
  return sanitized;
};

const parsePrecacheManifest = (source: string): string[] => {
  const parsed = parseJsonOrNull<unknown>(source);
  if (!Array.isArray(parsed)) return [];
  const paths = new Set<string>();
  for (const entry of parsed) {
    if (typeof entry !== "string") continue;
    const sanitized = sanitizeAssetPath(entry);
    if (sanitized) paths.add(sanitized);
  }
  return Array.from(paths);
};

const fetchServedClientAssetList = async (): Promise<string[] | null> => {
  // Prefer the new client-view precache manifest (the build-emitted source of truth for the
  // served client). Fall back to scraping the legacy /app/sw.js when it's absent (pre-deploy).
  try {
    const response = await fetch(CLIENT_VIEW_PRECACHE_PATH, { cache: "no-store" });
    if (response.ok) {
      const assets = parsePrecacheManifest(await response.text());
      if (assets.length > 0) return assets;
      console.warn("WebServer", "client-view precache manifest empty; falling back to sw.js");
    } else if (response.status !== 404) {
      console.warn("WebServer", "Unable to load client-view precache manifest", { status: response.status });
    }
  } catch (error) {
    console.warn("WebServer", "Failed to read client-view precache manifest", error);
  }

  try {
    const response = await fetch(APP_SW_PATH, { cache: "no-store" });
    if (!response.ok) {
      console.warn("WebServer", "Unable to load app service worker asset list", { status: response.status });
      return null;
    }

    const assets = parseAppAssetListFromSw(await response.text());
    if (assets.length === 0) {
      console.warn("WebServer", "No /app assets found in service worker script");
      return null;
    }

    return assets;
  } catch (error) {
    console.warn("WebServer", "Failed to read app service worker asset list", error);
    return null;
  }
};

const loadServedClientAssetList = async (): Promise<string[] | null> => {
  if (typeof window === "undefined") return null;

  if (!assetListPromise) {
    assetListPromise = fetchServedClientAssetList();
  }

  const assets = await assetListPromise;
  if (!assets || assets.length === 0) {
    assetListPromise = null;
  }

  return assets;
};

export const syncAndroidServedClientAssets = async (): Promise<void> => {
  if (typeof window === "undefined") return;
  if (!window.webServerNativeWire) return;

  const webServer = getWebServerInterface();
  if (!webServer) return;

  const assets = await loadServedClientAssetList();
  if (!assets || assets.length === 0) return;

  const signature = assets.join("\n");
  if (signature === lastSyncedAppAssetSignature) return;

  await webServer.sync({ kind: "appAssets", assets });
  lastSyncedAppAssetSignature = signature;
};

export const toWebServerConfig = (settings: Settings): WebServerConfig => {
  return {
    webServerEnabled: settings.iWebEnabled,
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
