#!/usr/bin/env node
/*
 * PraiseProjector MCP stdio bridge.
 *
 * MCP clients that can only start a command (stdio transport) run this script; it
 * relays every JSON-RPC message to the MCP endpoint of the running PraiseProjector
 * application (loopback HTTP, see electron/mcp-http.ts).
 *
 *   <PraiseProjector executable> praiseprojector-mcp-stdio.cjs <connection file>
 *   (with ELECTRON_RUN_AS_NODE=1, or with any Node.js 18+)
 *
 * The connection file (url + token) is written by the application while its MCP server
 * is enabled, and read again for every message, so a new port or token needs no client
 * reconfiguration. While the application is not running the bridge stays connected and
 * offers a single status tool; clients that did the `initialize` handshake are told to
 * reload the tool list as soon as the application answers.
 *
 * Plain CommonJS without dependencies: it is shipped as a resource, not bundled.
 */
"use strict";

const fs = require("fs");
const http = require("http");
const readline = require("readline");

const STATELESS_VERSION = "2026-07-28";
const LEGACY_VERSIONS = ["2025-11-25", "2025-06-18", "2025-03-26", "2024-11-05"];
const SERVER_INFO = { name: "praiseprojector", title: "PraiseProjector", version: "bridge" };
const META_VERSION = "io.modelcontextprotocol/protocolVersion";
const META_SERVER = "io.modelcontextprotocol/serverInfo";
const OFFLINE_TEXT =
  "PraiseProjector is not reachable. Start the PraiseProjector desktop application and enable the MCP server in Settings → MCP, then try again.";
const POLL_MS = 3000;

const connectionFile = process.argv[2] || process.env.PRAISEPROJECTOR_MCP_CONNECTION || "";
let legacyClient = false; // did an `initialize` handshake: may receive notifications
let offline = false;
let pollTimer = null;

function write(message) {
  process.stdout.write(JSON.stringify(message) + "\n");
}

function log(text) {
  process.stderr.write("[praiseprojector-mcp] " + text + "\n");
}

function readConnection() {
  try {
    const data = JSON.parse(fs.readFileSync(connectionFile, "utf8"));
    if (typeof data.url === "string" && typeof data.token === "string") return data;
  } catch (_error) {
    /* the application is not running, or its MCP server is disabled */
  }
  return null;
}

/** Resolves { status, body } or rejects when the application cannot be reached. */
function post(message) {
  return new Promise((resolve, reject) => {
    const connection = readConnection();
    if (!connection) {
      reject(new Error("no connection file"));
      return;
    }
    const body = Buffer.from(JSON.stringify(message), "utf8");
    const headers = {
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
      Authorization: "Bearer " + connection.token,
      "Content-Length": body.length,
    };
    const meta = message && message.params && message.params._meta;
    if (meta && typeof meta[META_VERSION] === "string") headers["MCP-Protocol-Version"] = meta[META_VERSION];
    if (message && typeof message.method === "string") headers["Mcp-Method"] = message.method;
    const request = http.request(connection.url, { method: "POST", headers }, (response) => {
      const chunks = [];
      response.on("data", (chunk) => chunks.push(chunk));
      response.on("end", () => resolve({ status: response.statusCode || 0, body: Buffer.concat(chunks).toString("utf8") }));
    });
    request.on("error", reject);
    request.setTimeout(125000, () => request.destroy(new Error("timeout")));
    request.end(body);
  });
}

function complete(result) {
  return Object.assign({ resultType: "complete", _meta: { [META_SERVER]: SERVER_INFO } }, result);
}

/** Answers given while the application cannot be reached. */
function offlineResult(message) {
  const params = message.params || {};
  switch (message.method) {
    case "initialize":
      return {
        protocolVersion: LEGACY_VERSIONS.includes(params.protocolVersion) ? params.protocolVersion : LEGACY_VERSIONS[0],
        capabilities: { tools: { listChanged: true }, resources: { listChanged: true }, prompts: {} },
        serverInfo: SERVER_INFO,
        instructions: OFFLINE_TEXT,
      };
    case "server/discover":
      return complete({
        supportedVersions: [STATELESS_VERSION].concat(LEGACY_VERSIONS),
        capabilities: { tools: {}, resources: {}, prompts: {} },
        instructions: OFFLINE_TEXT,
        ttlMs: POLL_MS,
        cacheScope: "public",
      });
    case "ping":
      return {};
    case "tools/list":
      return complete({
        tools: [
          {
            name: "praiseprojector_status",
            title: "PraiseProjector connection status",
            description:
              "PraiseProjector is currently not reachable, so its tools are unavailable. Call this to check again and to learn what the user has to do.",
            inputSchema: { type: "object", additionalProperties: false },
          },
        ],
        ttlMs: POLL_MS,
        cacheScope: "public",
      });
    case "tools/call":
      return complete({ content: [{ type: "text", text: OFFLINE_TEXT }], isError: true });
    case "resources/list":
      return complete({ resources: [], ttlMs: POLL_MS, cacheScope: "public" });
    case "prompts/list":
      return complete({ prompts: [], ttlMs: POLL_MS, cacheScope: "public" });
    case "resources/templates/list":
      return complete({ resourceTemplates: [], ttlMs: POLL_MS, cacheScope: "public" });
    default:
      return null;
  }
}

function setOffline(value) {
  if (offline === value) return;
  offline = value;
  if (value) {
    if (!pollTimer) pollTimer = setInterval(probe, POLL_MS);
    return;
  }
  if (pollTimer) clearInterval(pollTimer);
  pollTimer = null;
  if (legacyClient) {
    write({ jsonrpc: "2.0", method: "notifications/tools/list_changed" });
    write({ jsonrpc: "2.0", method: "notifications/resources/list_changed" });
  }
}

function probe() {
  post({ jsonrpc: "2.0", id: "bridge-probe", method: "ping" }).then(
    (response) => {
      if (response.status === 200 && response.body.includes('"result"')) setOffline(false);
    },
    () => {}
  );
}

async function handle(line) {
  let message;
  try {
    message = JSON.parse(line);
  } catch (_error) {
    write({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } });
    return;
  }
  if (!message || typeof message !== "object" || Array.isArray(message)) return;
  const isRequest = typeof message.method === "string" && message.id !== undefined;
  if (message.method === "initialize") legacyClient = true;
  try {
    const response = await post(message);
    if (response.status === 401 || response.status === 403) throw new Error("access denied (HTTP " + response.status + ")");
    setOffline(false);
    if (isRequest && response.body) write(JSON.parse(response.body));
  } catch (error) {
    setOffline(true);
    if (!isRequest) return;
    const result = offlineResult(message);
    if (result) write({ jsonrpc: "2.0", id: message.id, result });
    else write({ jsonrpc: "2.0", id: message.id, error: { code: -32000, message: OFFLINE_TEXT } });
    log("not reachable: " + (error && error.message ? error.message : String(error)));
  }
}

if (!connectionFile) {
  log("usage: praiseprojector-mcp-stdio.cjs <connection file>");
  process.exit(2);
}

const input = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
input.on("line", (line) => {
  if (line.trim()) void handle(line);
});
input.on("close", () => process.exit(0));
