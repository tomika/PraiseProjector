/** The MCP transport: access rules, both protocol generations, and the stdio bridge end to end. */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";
import type { JsonRpcRequest, JsonRpcResponse } from "../../common/mcp-bridge";
import { McpHttpServer, checkMcpAccess } from "../mcp-http";

const TOKEN = "t".repeat(43);
const seen: JsonRpcRequest[] = [];
const server = new McpHttpServer({
  port: 0,
  getToken: () => TOKEN,
  forward: async (message): Promise<JsonRpcResponse | null> => {
    seen.push(message);
    if (message.id === undefined) return null;
    if (message.method === "boom") throw new Error("window not ready");
    if (message.method === "no/such") return { jsonrpc: "2.0", id: message.id, error: { code: -32601, message: "Method not found" } };
    return { jsonrpc: "2.0", id: message.id, result: { echo: message.method } };
  },
});
let url = "";

before(async () => {
  assert.equal(await server.start(), true);
  url = `http://127.0.0.1:${server.port}/mcp`;
});
after(() => server.stop());

const post = (body: unknown, headers: Record<string, string> = {}, target = url) =>
  fetch(target, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${TOKEN}`, ...headers },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });

test("only loopback requests with the token get in", () => {
  const ok = { remoteAddress: "127.0.0.1", host: "127.0.0.1:19741", origin: undefined, authorization: `Bearer ${TOKEN}` };
  assert.equal(checkMcpAccess(ok, TOKEN), 0);
  assert.equal(checkMcpAccess({ ...ok, remoteAddress: "::ffff:127.0.0.1", host: "localhost:19741" }, TOKEN), 0);
  assert.equal(checkMcpAccess({ ...ok, origin: "http://localhost:6274" }, TOKEN), 0);
  assert.equal(checkMcpAccess({ ...ok, remoteAddress: "192.168.1.5" }, TOKEN), 403);
  // DNS rebinding: a page of another site resolving to 127.0.0.1.
  assert.equal(checkMcpAccess({ ...ok, host: "evil.example:19741" }, TOKEN), 403);
  assert.equal(checkMcpAccess({ ...ok, origin: "https://evil.example" }, TOKEN), 403);
  assert.equal(checkMcpAccess({ ...ok, origin: "null" }, TOKEN), 403);
  assert.equal(checkMcpAccess({ ...ok, authorization: undefined }, TOKEN), 401);
  assert.equal(checkMcpAccess({ ...ok, authorization: "Bearer wrong" }, TOKEN), 401);
  assert.equal(checkMcpAccess(ok, ""), 401);
});

test("a request is relayed and answered as JSON; a notification is accepted without a body", async () => {
  const response = await post({ jsonrpc: "2.0", id: 1, method: "tools/list" });
  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type") ?? "", /^application\/json/);
  assert.deepEqual(await response.json(), { jsonrpc: "2.0", id: 1, result: { echo: "tools/list" } });

  const notification = await post({ jsonrpc: "2.0", method: "notifications/initialized" });
  assert.equal(notification.status, 202);
  assert.equal(await notification.text(), "");
  assert.equal(seen.at(-1)?.method, "notifications/initialized");
});

test("requests without the token, with another origin or on another path are refused", async () => {
  assert.equal((await post({ jsonrpc: "2.0", id: 1, method: "x" }, { Authorization: "Bearer nope" })).status, 401);
  assert.equal((await post({ jsonrpc: "2.0", id: 1, method: "x" }, { Origin: "https://evil.example" })).status, 403);
  assert.equal((await post({ jsonrpc: "2.0", id: 1, method: "x" }, {}, url.replace("/mcp", "/other"))).status, 404);
  const get = await fetch(url, { headers: { Authorization: `Bearer ${TOKEN}` } });
  assert.equal(get.status, 405);
});

test("malformed bodies and a renderer that cannot answer become JSON-RPC errors", async () => {
  const parse = await post("{nope");
  assert.equal(parse.status, 400);
  assert.equal(((await parse.json()) as JsonRpcResponse).error?.code, -32700);
  assert.equal((await post({ id: 1 })).status, 400);
  const unavailable = (await (await post({ jsonrpc: "2.0", id: 7, method: "boom" })).json()) as JsonRpcResponse;
  assert.equal(unavailable.id, 7);
  assert.equal(unavailable.error?.code, -32000);
  assert.match(unavailable.error?.message ?? "", /window not ready/);
});

test("the stateless revision gets header checks and HTTP statuses, older clients plain 200s", async () => {
  const unsupported = await post({ jsonrpc: "2.0", id: 1, method: "tools/list" }, { "MCP-Protocol-Version": "1900-01-01" });
  assert.equal(unsupported.status, 400);
  const error = ((await unsupported.json()) as JsonRpcResponse).error!;
  assert.equal(error.code, -32022);
  assert.ok((error.data as { supported: string[] }).supported.includes("2026-07-28"));

  const mismatch = await post({ jsonrpc: "2.0", id: 1, method: "tools/list" }, { "MCP-Protocol-Version": "2026-07-28", "Mcp-Method": "tools/call" });
  assert.equal(mismatch.status, 400);
  assert.equal(((await mismatch.json()) as JsonRpcResponse).error?.code, -32020);

  const modern = await post({ jsonrpc: "2.0", id: 1, method: "no/such" }, { "MCP-Protocol-Version": "2026-07-28", "Mcp-Method": "no/such" });
  assert.equal(modern.status, 404);
  const legacy = await post({ jsonrpc: "2.0", id: 1, method: "no/such" }, { "MCP-Protocol-Version": "2025-06-18" });
  assert.equal(legacy.status, 200);
  assert.equal(((await legacy.json()) as JsonRpcResponse).error?.code, -32601);
});

test("a 2025-03-26 batch is answered as a batch", async () => {
  const response = await post([
    { jsonrpc: "2.0", id: 1, method: "a" },
    { jsonrpc: "2.0", method: "notifications/x" },
    { jsonrpc: "2.0", id: 2, method: "b" },
  ]);
  assert.deepEqual(
    ((await response.json()) as JsonRpcResponse[]).map((entry) => entry.id),
    [1, 2]
  );
});

/** Runs the stdio bridge, feeds it lines and collects what it prints. */
function bridge(connectionFile: string) {
  const script = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "public", "mcp", "praiseprojector-mcp-stdio.cjs");
  const child = spawn(process.execPath, [script, connectionFile], { stdio: ["pipe", "pipe", "ignore"] });
  const lines: Record<string, unknown>[] = [];
  let buffer = "";
  child.stdout.on("data", (chunk: Buffer) => {
    buffer += chunk.toString("utf8");
    let end: number;
    while ((end = buffer.indexOf("\n")) >= 0) {
      lines.push(JSON.parse(buffer.slice(0, end)));
      buffer = buffer.slice(end + 1);
    }
  });
  const next = async (match: (line: Record<string, unknown>) => boolean): Promise<Record<string, unknown>> => {
    const deadline = Date.now() + 15000;
    for (;;) {
      const index = lines.findIndex(match);
      if (index >= 0) return lines.splice(index, 1)[0];
      if (Date.now() > deadline) throw new Error("the bridge did not answer");
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  };
  return {
    send: (message: unknown) => child.stdin.write(JSON.stringify(message) + "\n"),
    next,
    stop: () => child.kill(),
  };
}

test("the stdio bridge relays to the running app", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pp-mcp-"));
  const file = path.join(dir, "mcp-connection.json");
  fs.writeFileSync(file, JSON.stringify({ url, token: TOKEN }));
  const client = bridge(file);
  try {
    client.send({ jsonrpc: "2.0", id: 1, method: "tools/list", params: { _meta: { "io.modelcontextprotocol/protocolVersion": "2026-07-28" } } });
    assert.deepEqual(await client.next((line) => line.id === 1), { jsonrpc: "2.0", id: 1, result: { echo: "tools/list" } });
    client.send({ jsonrpc: "2.0", method: "notifications/initialized" });
    client.send({ jsonrpc: "2.0", id: 2, method: "ping" });
    assert.equal((await client.next((line) => line.id === 2)).id, 2);
    assert.ok(seen.some((message) => message.method === "notifications/initialized"));
  } finally {
    client.stop();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("while the app is not running the bridge stays up, explains, and announces the app when it appears", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pp-mcp-"));
  const file = path.join(dir, "mcp-connection.json");
  const client = bridge(file);
  try {
    client.send({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {} } });
    const init = (await client.next((line) => line.id === 1)).result as { protocolVersion: string; instructions: string };
    assert.equal(init.protocolVersion, "2025-06-18");
    assert.match(init.instructions, /not reachable/);

    client.send({ jsonrpc: "2.0", id: 2, method: "tools/list" });
    const tools = ((await client.next((line) => line.id === 2)).result as { tools: { name: string }[] }).tools;
    assert.deepEqual(
      tools.map((tool) => tool.name),
      ["praiseprojector_status"]
    );
    client.send({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "praiseprojector_status" } });
    const call = (await client.next((line) => line.id === 3)).result as { isError: boolean; content: { text: string }[] };
    assert.equal(call.isError, true);
    assert.match(call.content[0].text, /Settings → MCP/);
    client.send({ jsonrpc: "2.0", id: 4, method: "resources/read", params: { uri: "praiseprojector://guide/en" } });
    assert.equal(((await client.next((line) => line.id === 4)).error as { code: number }).code, -32000);

    // The app starts: the handshake client is told to fetch the real tool list.
    fs.writeFileSync(file, JSON.stringify({ url, token: TOKEN }));
    assert.ok(await client.next((line) => line.method === "notifications/tools/list_changed"));
    client.send({ jsonrpc: "2.0", id: 5, method: "tools/list" });
    assert.deepEqual((await client.next((line) => line.id === 5)).result, { echo: "tools/list" });
  } finally {
    client.stop();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
