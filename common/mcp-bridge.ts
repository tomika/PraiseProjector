/**
 * Shared contract of the built-in MCP (Model Context Protocol) server.
 *
 * The Electron main process owns the transport (a loopback-only HTTP endpoint with a
 * bearer token) and is otherwise a pipe: it forwards every JSON-RPC message to the
 * renderer, where the tools live next to the data they act on (`src/services/mcp`).
 * This module is the only part both sides import, so it stays free of Electron, DOM
 * and app imports.
 */

/** Revisions that still use the `initialize` handshake. */
export const MCP_LEGACY_PROTOCOL_VERSIONS = ["2025-11-25", "2025-06-18", "2025-03-26", "2024-11-05"] as const;
/** The stateless revision: no handshake, every request carries its version. */
export const MCP_STATELESS_PROTOCOL_VERSION = "2026-07-28";
export const MCP_SUPPORTED_PROTOCOL_VERSIONS: readonly string[] = [MCP_STATELESS_PROTOCOL_VERSION, ...MCP_LEGACY_PROTOCOL_VERSIONS];

export const MCP_SERVER_NAME = "praiseprojector";
export const MCP_DEFAULT_PORT = 19741;
export const MCP_ENDPOINT_PATH = "/mcp";

export const MCP_META_PROTOCOL_VERSION = "io.modelcontextprotocol/protocolVersion";
export const MCP_META_SERVER_INFO = "io.modelcontextprotocol/serverInfo";

export const McpErrorCode = {
  ParseError: -32700,
  InvalidRequest: -32600,
  MethodNotFound: -32601,
  InvalidParams: -32602,
  InternalError: -32603,
  /** Implementation-defined: the app window is not ready to answer. */
  ServerUnavailable: -32000,
  HeaderMismatch: -32020,
  UnsupportedProtocolVersion: -32022,
} as const;

export type JsonRpcId = string | number | null;

export interface JsonRpcRequest {
  jsonrpc: "2.0";
  id?: JsonRpcId;
  method: string;
  params?: Record<string, unknown>;
}

export interface JsonRpcError {
  code: number;
  message: string;
  data?: unknown;
}

export interface JsonRpcResponse {
  jsonrpc: "2.0";
  id: JsonRpcId;
  result?: unknown;
  error?: JsonRpcError;
}

export function jsonRpcError(id: JsonRpcId, code: number, message: string, data?: unknown): JsonRpcResponse {
  return { jsonrpc: "2.0", id, error: data === undefined ? { code, message } : { code, message, data } };
}

export function isJsonRpcRequest(value: unknown): value is JsonRpcRequest {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const message = value as Record<string, unknown>;
  return message.jsonrpc === "2.0" && typeof message.method === "string";
}

/** A request without an id is a notification: it gets no response. */
export function isJsonRpcNotification(message: JsonRpcRequest): boolean {
  return message.id === undefined;
}

/** Main → renderer: one JSON-RPC request to answer. */
export interface McpBridgeRequest {
  requestId: string;
  message: JsonRpcRequest;
}

/** Renderer → main. `message` is null for a notification. */
export interface McpBridgeResponse {
  requestId: string;
  message: JsonRpcResponse | null;
}

/** What the settings page shows about the transport. */
export interface McpServerStatus {
  enabled: boolean;
  running: boolean;
  port: number;
  /** Full endpoint URL, e.g. http://127.0.0.1:19741/mcp */
  url: string;
  /** Bearer token clients must send. */
  token: string;
  error?: string;
  /** Launch data of the stdio bridge for clients that can only start a command. */
  stdio: { command: string; args: string[]; env: Record<string, string> };
}

/** Settings subset the main process needs. */
export interface McpServerConfig {
  enabled: boolean;
  port: number;
}

export function normalizeMcpPort(value: unknown): number {
  const port = typeof value === "number" ? Math.trunc(value) : Number.parseInt(String(value ?? ""), 10);
  return Number.isFinite(port) && port >= 1024 && port <= 65535 ? port : MCP_DEFAULT_PORT;
}
