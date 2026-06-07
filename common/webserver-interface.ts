import { Display, PlaylistEntry } from "./pp-types";
import { ApiResponse } from "./ipc-types";

export type WebServerRemoteDisplayUpdate = {
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
};

export type WebServerFrameOptions = {
  jpegQuality?: number;
  imageScale?: number;
  bgColor?: string;
  transient?: number;
};

export type WebServerConfig = {
  webServerPort: number;
  webServerPath: string;
  webServerDomainName: string;
  webServerAcceptLanClientsOnly: boolean;
  longPollTimeout: number;
  allClientsCanUseLeaderMode: boolean;
  leaderModeClients: string[];
  stylesToClients: boolean;
  chordProStyles?: unknown;
};

export type WebServerSyncUpdate =
  | { kind: "config"; config: WebServerConfig }
  | { kind: "display"; display: Display }
  | { kind: "frame"; imageDataUrl: string | null; options?: WebServerFrameOptions }
  | { kind: "leader"; leaderName: string }
  | { kind: "appAssets"; assets: string[] };

export type WebServerConnectedClient = {
  id: string;
  deviceName: string;
  isLeaderModeClient: boolean;
};

export type WebServerQuery = { kind: "clients"; projectingOnly?: boolean } | { kind: "highlightController" };

export type WebServerQueryResult =
  | {
      kind: "clients";
      clients: WebServerConnectedClient[];
      count: number;
    }
  | {
      kind: "highlightController";
      clientId: string;
    };

export type WebServerApiRequest = {
  requestId: string;
  method: string;
  path: string;
  query: Record<string, unknown>;
  body: unknown;
  headers: Record<string, unknown>;
};

export type WebServerApiResponse = ApiResponse & {
  requestId: string;
};

export type WebServerResponse =
  | {
      kind: "api";
      response: WebServerApiResponse;
    }
  | {
      kind: "highlightAccess";
      clientId: string;
      grant: boolean;
    };

export type WebServerEvent =
  | {
      kind: "remoteDisplayUpdate";
      update: WebServerRemoteDisplayUpdate;
    }
  | {
      kind: "apiRequest";
      request: WebServerApiRequest;
    }
  | {
      kind: "highlightAccessRequest";
      clientId: string;
    }
  | {
      kind: "highlightChanged";
      line: number;
    }
  | {
      kind: "highlightControllerChanged";
      clientId: string;
    };

export interface WebServerInterface {
  sync(update: WebServerSyncUpdate): Promise<void>;
  query(request: WebServerQuery): Promise<WebServerQueryResult>;
  respond(response: WebServerResponse): Promise<void>;
  onEvent(callback: (event: WebServerEvent) => void): () => void;
}

// Kotlin/JavascriptInterface-friendly wire contract.
export interface WebServerNativeWireInterface {
  syncJson(payloadJson: string): string | Promise<string>;
  queryJson(payloadJson: string): string | Promise<string>;
  respondJson(payloadJson: string): string | Promise<string>;
  registerEventSink?(sinkName: string): boolean | Promise<boolean>;
}
