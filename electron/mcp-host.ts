/**
 * Electron side of the built-in MCP server: owns the access token and the HTTP
 * transport, and relays every JSON-RPC message to the renderer over IPC
 * (`mcp-request` / `mcp-response`), where `src/services/mcp` answers it.
 */
import { app, ipcMain, BrowserWindow } from "electron";
import * as crypto from "crypto";
import * as fs from "fs";
import * as path from "path";
import {
  JsonRpcRequest,
  JsonRpcResponse,
  MCP_ENDPOINT_PATH,
  McpBridgeRequest,
  McpBridgeResponse,
  McpServerConfig,
  McpServerStatus,
  normalizeMcpPort,
} from "../common/mcp-bridge";
import { McpHttpServer } from "./mcp-http";
// Embedded verbatim: the bridge is run by an external MCP client, never by this
// process, so it ships inside the main bundle instead of as a packaged resource.
import stdioScriptSource from "./praiseprojector-mcp-stdio.cjs?raw";

/** A tool call may wait for the user to confirm a change in the app. */
const RENDERER_TIMEOUT_MS = 120_000;
const ACCESS_FILE = "mcp-access.json";
const CONNECTION_FILE = "mcp-connection.json";
const STDIO_SCRIPT = "praiseprojector-mcp-stdio.cjs";

let getWindow: () => BrowserWindow | null = () => null;
let server: McpHttpServer | null = null;
/** The configuration the transport runs with. */
let config: McpServerConfig = { enabled: false, port: normalizeMcpPort(undefined) };
/** The latest one asked for; queued applies may not have reached it yet. */
let requested: McpServerConfig = config;
let token = "";
let applying: Promise<void> = Promise.resolve();
const pending = new Map<string, (response: JsonRpcResponse | null) => void>();

const userFile = (name: string) => path.join(app.getPath("userData"), name);

function writePrivateFile(file: string, content: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content, { encoding: "utf8", mode: 0o600 });
  try {
    fs.chmodSync(file, 0o600);
  } catch {
    /* not supported on every file system */
  }
}

function loadToken(): string {
  try {
    const stored = JSON.parse(fs.readFileSync(userFile(ACCESS_FILE), "utf8")) as { token?: unknown };
    if (typeof stored.token === "string" && stored.token.length >= 32) return stored.token;
  } catch {
    /* first use */
  }
  return newToken();
}

function newToken(): string {
  const value = crypto.randomBytes(32).toString("base64url");
  writePrivateFile(userFile(ACCESS_FILE), JSON.stringify({ token: value }));
  return value;
}

function endpointUrl(port: number): string {
  return `http://127.0.0.1:${port}${MCP_ENDPOINT_PATH}`;
}

/** The stdio bridge reads this file, so a token or port change needs no client reconfiguration. */
function writeConnectionFile(): void {
  try {
    if (config.enabled) writePrivateFile(userFile(CONNECTION_FILE), JSON.stringify({ url: endpointUrl(server?.port ?? config.port), token }));
    else fs.rmSync(userFile(CONNECTION_FILE), { force: true });
  } catch (error) {
    console.warn("[MCP] could not update the connection file", error);
  }
}

/** Keeps a copy of the bridge script at a path that survives application updates. */
function installStdioScript(): string {
  const target = path.join(app.getPath("userData"), "mcp", STDIO_SCRIPT);
  try {
    const content = Buffer.from(stdioScriptSource, "utf8");
    if (!fs.existsSync(target) || !fs.readFileSync(target).equals(content)) {
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, content);
    }
  } catch (error) {
    console.warn("[MCP] could not install the stdio bridge script", error);
  }
  return target;
}

function stdioLaunch(): McpServerStatus["stdio"] {
  const args = [installStdioScript(), userFile(CONNECTION_FILE)];
  // The application binary doubles as a Node runtime. An AppImage is mounted at a
  // different path on every start, so there a system Node has to run the bridge.
  if (process.env.APPIMAGE) return { command: "node", args, env: {} };
  return { command: process.execPath, args, env: { ELECTRON_RUN_AS_NODE: "1" } };
}

function status(): McpServerStatus {
  const port = server?.port ?? config.port;
  return {
    enabled: config.enabled,
    running: !!server?.running,
    port,
    url: endpointUrl(port),
    token,
    error: config.enabled ? server?.error : undefined,
    stdio: stdioLaunch(),
  };
}

function forwardToRenderer(message: JsonRpcRequest, protocolVersion?: string): Promise<JsonRpcResponse | null> {
  const window = getWindow();
  if (!window || window.isDestroyed() || window.webContents.isLoading()) {
    return Promise.reject(new Error("The PraiseProjector window is not ready yet"));
  }
  const requestId = crypto.randomUUID();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pending.delete(requestId);
      reject(new Error("PraiseProjector did not answer in time"));
    }, RENDERER_TIMEOUT_MS);
    pending.set(requestId, (response) => {
      clearTimeout(timer);
      pending.delete(requestId);
      resolve(response);
    });
    const request: McpBridgeRequest = { requestId, message, protocolVersion };
    window.webContents.send("mcp-request", request);
  });
}

async function apply(next: McpServerConfig): Promise<void> {
  const portChanged = next.port !== config.port;
  config = next;
  // A server that failed to start (e.g. its port was taken) is replaced as well.
  if (server && (!config.enabled || portChanged || !server.running)) {
    await server.stop();
    server = null;
  }
  if (config.enabled && !server) {
    server = new McpHttpServer({
      port: config.port,
      getToken: () => token,
      forward: forwardToRenderer,
      log: (level, message) => console[level](message),
    });
    await server.start();
  }
  writeConnectionFile();
}

/** Called with every settings sync; only an actual change restarts the transport. */
export function applyMcpSettings(settings: { mcpEnabled?: unknown; mcpPort?: unknown }): void {
  const next: McpServerConfig = { enabled: settings.mcpEnabled === true, port: normalizeMcpPort(settings.mcpPort) };
  const unchanged = next.enabled === requested.enabled && next.port === requested.port;
  // Saving the same settings again retries a server that could not start.
  if (unchanged && !(next.enabled && server && !server.running)) return;
  requested = next;
  applying = applying.then(() => apply(next)).catch((error) => console.error("[MCP] could not apply settings", error));
}

export function initializeMcpHost(getMainWindow: () => BrowserWindow | null): void {
  getWindow = getMainWindow;
  token = loadToken();

  ipcMain.on("mcp-response", (_event, response: McpBridgeResponse) => {
    if (response && typeof response.requestId === "string") pending.get(response.requestId)?.(response.message ?? null);
  });
  ipcMain.handle("mcp-get-status", async () => {
    await applying;
    return status();
  });
  ipcMain.handle("mcp-regenerate-token", async () => {
    await applying;
    token = newToken();
    writeConnectionFile();
    return status();
  });
}

export function shutdownMcpHost(): void {
  void server?.stop();
  server = null;
  try {
    fs.rmSync(userFile(CONNECTION_FILE), { force: true });
  } catch {
    /* best effort */
  }
}
