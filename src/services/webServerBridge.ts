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

const createNativeWireAdapter = (wire: WebServerNativeWireInterface): WebServerInterface => {
  return {
    sync: async (update: WebServerSyncUpdate) => {
      await resolvePromise(wire.syncJson(JSON.stringify(update)));
    },
    query: async (request: WebServerQuery) => {
      const responseJson = await resolvePromise(wire.queryJson(JSON.stringify(request)));
      const parsed = parseJsonOrNull<WebServerQueryResult>(responseJson);
      if (parsed) return parsed;
      if (request.kind === "clients") return { kind: "clients", clients: [], count: 0 };
      return { kind: "highlightController", clientId: "" };
    },
    respond: async (response: WebServerResponse) => {
      await resolvePromise(wire.respondJson(JSON.stringify(response)));
    },
    onEvent: (_callback: (event: WebServerEvent) => void) => {
      // Native event sink registration is handled by Android runtime bootstrap.
      return () => {
        // no-op
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

export const getWebServerInterface = (): WebServerInterface | null => {
  if (cachedWebServer !== undefined) return cachedWebServer;

  if (window.webServer) {
    cachedWebServer = window.webServer;
    return cachedWebServer;
  }

  if (window.webServerNativeWire) {
    cachedWebServer = createNativeWireAdapter(window.webServerNativeWire);
    return cachedWebServer;
  }

  if (window.electronAPI) {
    cachedWebServer = createLegacyElectronAdapter(window.electronAPI);
    return cachedWebServer;
  }

  cachedWebServer = null;
  return cachedWebServer;
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
