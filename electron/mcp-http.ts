/**
 * Transport of the built-in MCP server: Streamable HTTP on a loopback-only socket.
 *
 * It answers every POST with one `application/json` body (never an SSE stream), which
 * both the handshake revisions (2024-11-05 … 2025-11-25) and the stateless 2026-07-28
 * revision allow. The messages themselves are answered by `forward` (the renderer), so
 * this file has no Electron import and runs under plain Node in the tests.
 *
 * Access is limited three ways: the socket is bound to 127.0.0.1, the Host and Origin
 * headers must be loopback (DNS rebinding), and every request needs the bearer token.
 */
import * as crypto from "crypto";
import * as http from "http";
import type { AddressInfo } from "net";
import {
  JsonRpcId,
  JsonRpcRequest,
  JsonRpcResponse,
  MCP_ENDPOINT_PATH,
  MCP_STATELESS_PROTOCOL_VERSION,
  MCP_SUPPORTED_PROTOCOL_VERSIONS,
  McpErrorCode,
  isJsonRpcNotification,
  isJsonRpcRequest,
  jsonRpcError,
} from "../common/mcp-bridge";

const MAX_BODY_BYTES = 8 * 1024 * 1024;
const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "[::1]"]);

export type McpForward = (message: JsonRpcRequest) => Promise<JsonRpcResponse | null>;

export interface McpHttpOptions {
  port: number;
  getToken: () => string;
  forward: McpForward;
  log?: (level: "info" | "warn" | "error", message: string) => void;
}

export interface McpAccessInput {
  remoteAddress: string | undefined;
  host: string | undefined;
  origin: string | undefined;
  authorization: string | undefined;
}

function hostNameOf(hostHeader: string): string {
  const value = hostHeader.trim().toLowerCase();
  if (value.startsWith("[")) return value.slice(0, value.indexOf("]") + 1);
  const colon = value.lastIndexOf(":");
  return colon >= 0 ? value.slice(0, colon) : value;
}

function isLoopbackAddress(address: string | undefined): boolean {
  if (!address) return false;
  const value = address.startsWith("::ffff:") ? address.slice(7) : address;
  return value === "::1" || value.startsWith("127.");
}

function safeEqual(a: string, b: string): boolean {
  const left = crypto.createHash("sha256").update(a).digest();
  const right = crypto.createHash("sha256").update(b).digest();
  return crypto.timingSafeEqual(left, right);
}

/** HTTP status that rejects the request, or 0 when it may proceed. */
export function checkMcpAccess(input: McpAccessInput, token: string): 0 | 401 | 403 {
  if (!isLoopbackAddress(input.remoteAddress)) return 403;
  if (!input.host || !LOOPBACK_HOSTS.has(hostNameOf(input.host))) return 403;
  if (input.origin !== undefined) {
    // Native MCP clients send no Origin. A browser page does, and only a loopback page
    // (a local inspector) is accepted.
    let originHost = "";
    try {
      originHost = new URL(input.origin).hostname.toLowerCase();
    } catch {
      return 403;
    }
    if (!LOOPBACK_HOSTS.has(originHost) && originHost !== "::1") return 403;
  }
  const match = /^Bearer\s+(.+)$/i.exec(input.authorization ?? "");
  if (!token || !match || !safeEqual(match[1].trim(), token)) return 401;
  return 0;
}

function headerValue(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

/** The stateless revision maps protocol errors to HTTP statuses; older clients expect 200. */
function statusFor(response: JsonRpcResponse | null, stateless: boolean): number {
  if (!response) return 202;
  if (!stateless || !response.error) return 200;
  switch (response.error.code) {
    case McpErrorCode.MethodNotFound:
      return 404;
    case McpErrorCode.InvalidParams:
    case McpErrorCode.InvalidRequest:
    case McpErrorCode.HeaderMismatch:
    case McpErrorCode.UnsupportedProtocolVersion:
      return 400;
    default:
      return 200;
  }
}

export class McpHttpServer {
  private server: http.Server | null = null;
  private listeningPort = 0;
  private lastError: string | undefined;

  constructor(private options: McpHttpOptions) {}

  get running(): boolean {
    return !!this.server?.listening;
  }

  get port(): number {
    return this.listeningPort || this.options.port;
  }

  get error(): string | undefined {
    return this.lastError;
  }

  /** Starts listening. Resolves false (with `error` set) when the port is taken. */
  start(): Promise<boolean> {
    if (this.server) return Promise.resolve(this.running);
    return new Promise((resolve) => {
      const server = http.createServer((req, res) => {
        void this.handle(req, res).catch((error) => {
          this.log("error", `request failed: ${error instanceof Error ? error.message : String(error)}`);
          if (!res.headersSent) this.sendJson(res, 500, jsonRpcError(null, McpErrorCode.InternalError, "Internal error"));
          else res.end();
        });
      });
      server.once("error", (error: NodeJS.ErrnoException) => {
        this.lastError = error.code === "EADDRINUSE" ? `Port ${this.options.port} is already in use` : error.message;
        this.log("error", `could not start: ${this.lastError}`);
        this.server = null;
        resolve(false);
      });
      // 127.0.0.1 only: never reachable from the network, unlike the client webserver.
      server.listen(this.options.port, "127.0.0.1", () => {
        this.server = server;
        this.listeningPort = (server.address() as AddressInfo).port;
        this.lastError = undefined;
        this.log("info", `listening on http://127.0.0.1:${this.listeningPort}${MCP_ENDPOINT_PATH}`);
        resolve(true);
      });
    });
  }

  stop(): Promise<void> {
    const server = this.server;
    this.server = null;
    this.listeningPort = 0;
    if (!server) return Promise.resolve();
    return new Promise((resolve) => {
      server.close(() => resolve());
      server.closeAllConnections?.();
    });
  }

  setPort(port: number): void {
    this.options = { ...this.options, port };
  }

  private log(level: "info" | "warn" | "error", message: string): void {
    this.options.log?.(level, `[MCP] ${message}`);
  }

  private sendJson(res: http.ServerResponse, status: number, body: unknown): void {
    const text = JSON.stringify(body);
    res.writeHead(status, {
      "Content-Type": "application/json; charset=utf-8",
      "Content-Length": Buffer.byteLength(text),
      "Cache-Control": "no-store",
    });
    res.end(text);
  }

  private readBody(req: http.IncomingMessage): Promise<string | null> {
    return new Promise((resolve) => {
      const chunks: Buffer[] = [];
      let size = 0;
      let done = false;
      const finish = (value: string | null) => {
        if (done) return;
        done = true;
        resolve(value);
      };
      req.on("data", (chunk: Buffer) => {
        size += chunk.length;
        if (size > MAX_BODY_BYTES) {
          finish(null);
          req.destroy();
          return;
        }
        chunks.push(chunk);
      });
      req.on("end", () => finish(Buffer.concat(chunks).toString("utf8")));
      req.on("error", () => finish(null));
    });
  }

  private async handle(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const denied = checkMcpAccess(
      {
        remoteAddress: req.socket.remoteAddress,
        host: headerValue(req.headers.host),
        origin: headerValue(req.headers.origin),
        authorization: headerValue(req.headers.authorization),
      },
      this.options.getToken()
    );
    if (denied) {
      if (denied === 401) res.setHeader("WWW-Authenticate", "Bearer");
      this.sendJson(res, denied, jsonRpcError(null, McpErrorCode.InvalidRequest, denied === 401 ? "Missing or wrong access token" : "Forbidden"));
      return;
    }

    const path = (req.url ?? "").split("?")[0].replace(/\/+$/, "");
    if (path !== MCP_ENDPOINT_PATH) {
      this.sendJson(res, 404, jsonRpcError(null, McpErrorCode.InvalidRequest, "Not found"));
      return;
    }
    if (req.method !== "POST") {
      // No server-initiated stream and no session to delete.
      res.writeHead(405, { Allow: "POST" });
      res.end();
      return;
    }

    const text = await this.readBody(req);
    if (text === null) {
      this.sendJson(res, 413, jsonRpcError(null, McpErrorCode.InvalidRequest, "Request body too large"));
      return;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      this.sendJson(res, 400, jsonRpcError(null, McpErrorCode.ParseError, "Parse error"));
      return;
    }

    const versionHeader = headerValue(req.headers["mcp-protocol-version"]);
    const stateless = versionHeader === MCP_STATELESS_PROTOCOL_VERSION;
    if (versionHeader && !MCP_SUPPORTED_PROTOCOL_VERSIONS.includes(versionHeader)) {
      const id = isJsonRpcRequest(parsed) ? (parsed.id ?? null) : null;
      this.sendJson(
        res,
        400,
        jsonRpcError(id, McpErrorCode.UnsupportedProtocolVersion, "Unsupported protocol version", {
          supported: MCP_SUPPORTED_PROTOCOL_VERSIONS,
          requested: versionHeader,
        })
      );
      return;
    }

    // 2025-03-26 allowed batches; later revisions send one message per POST.
    if (Array.isArray(parsed)) {
      if (!parsed.length || !parsed.every(isJsonRpcRequest)) {
        this.sendJson(res, 400, jsonRpcError(null, McpErrorCode.InvalidRequest, "Invalid request"));
        return;
      }
      const responses: JsonRpcResponse[] = [];
      for (const message of parsed) {
        const response = await this.answer(message);
        if (response) responses.push(response);
      }
      if (responses.length) this.sendJson(res, 200, responses);
      else res.writeHead(202).end();
      return;
    }

    if (!isJsonRpcRequest(parsed)) {
      this.sendJson(res, 400, jsonRpcError(null, McpErrorCode.InvalidRequest, "Invalid request"));
      return;
    }

    const methodHeader = headerValue(req.headers["mcp-method"]);
    if (methodHeader !== undefined && methodHeader !== parsed.method) {
      this.sendJson(
        res,
        400,
        jsonRpcError(
          parsed.id ?? null,
          McpErrorCode.HeaderMismatch,
          `Header mismatch: Mcp-Method header value '${methodHeader}' does not match body value '${parsed.method}'`
        )
      );
      return;
    }

    const response = await this.answer(parsed);
    if (!response) {
      res.writeHead(202).end();
      return;
    }
    this.sendJson(res, statusFor(response, stateless), response);
  }

  private async answer(message: JsonRpcRequest): Promise<JsonRpcResponse | null> {
    const notification = isJsonRpcNotification(message);
    const id: JsonRpcId = message.id ?? null;
    try {
      const response = await this.options.forward(message);
      return notification ? null : (response ?? jsonRpcError(id, McpErrorCode.InternalError, "No response"));
    } catch (error) {
      if (notification) return null;
      return jsonRpcError(id, McpErrorCode.ServerUnavailable, error instanceof Error ? error.message : String(error));
    }
  }
}
