/**
 * MCP message handling for the tools of this folder. Transport-free: it maps one
 * JSON-RPC request to one response.
 *
 * Two protocol generations are answered by the same code. Clients up to 2025-11-25
 * start with `initialize`; 2026-07-28 clients send no handshake and may ask
 * `server/discover`. The newer result fields (`resultType`, `ttlMs`, `cacheScope`,
 * server info in `_meta`) are always present: older clients ignore them.
 */
import {
  JsonRpcRequest,
  JsonRpcResponse,
  MCP_LEGACY_PROTOCOL_VERSIONS,
  MCP_META_SERVER_INFO,
  MCP_SERVER_NAME,
  MCP_SUPPORTED_PROTOCOL_VERSIONS,
  McpErrorCode,
  isJsonRpcNotification,
  jsonRpcError,
} from "../../../common/mcp-bridge";
import { McpHost, McpPrompt, McpResource, McpTool, McpToolError } from "./types";

/** Tool and resource lists only change with an application update. */
const LIST_TTL_MS = 5 * 60 * 1000;

export const MCP_INSTRUCTIONS = [
  "PraiseProjector is a worship-song projection application: a song database (ChordPro), playlists for services, projection of song sections to a second screen, and sessions that tablets and phones join over the local network or the cloud.",
  "This server lets you help the person using it. Start with get_app_status. For how-to questions call search_help first: it returns the application's own tutorial texts, so name the buttons and settings as they appear there. list_settings gives every setting with the label and the settings page the user sees.",
  "Answer in the user's language (the app UI is English or Hungarian; get_app_status reports which).",
  "The playlist in the app (the working list, which tablets see) is a copy: a leader's stored playlists (calendar days and favorites) and playlist files are loaded into it and saved from it, and changing one never changes the other. Users often expect otherwise; explain it when it matters, and offer to save a changed working list where it came from.",
  "How a song is performed on a playlist item (which sections, how often, in which key) is set by its instructions; read check_instructions before writing them.",
  "Tools that change something need 'Allow changes' and tools that drive the live projection need 'Allow live control' in Settings → MCP; the user may also be asked to confirm a change inside the app. If a tool reports that it is not allowed, tell the user which switch to turn on instead of retrying.",
  "During a service be careful with live-control tools: what you select is shown to the congregation.",
].join("\n");

export interface McpPermissions {
  allowChanges: boolean;
  allowLiveControl: boolean;
  confirmChanges: boolean;
}

export interface McpDispatcherOptions {
  tools: readonly McpTool[];
  resources: readonly McpResource[];
  prompts?: readonly McpPrompt[];
  host: McpHost;
  permissions: () => McpPermissions;
}

function textContent(value: unknown): { type: "text"; text: string } {
  return { type: "text", text: typeof value === "string" ? value : JSON.stringify(value, null, 1) };
}

export function createMcpDispatcher(options: McpDispatcherOptions) {
  const { tools, resources, host } = options;
  const prompts = options.prompts ?? [];
  const serverInfo = () => ({ name: MCP_SERVER_NAME, title: "PraiseProjector", version: host.appVersion() });
  const capabilities = { tools: { listChanged: true }, resources: { listChanged: true }, prompts: {} };
  const complete = (result: Record<string, unknown>) => ({ resultType: "complete", ...result, _meta: { [MCP_META_SERVER_INFO]: serverInfo() } });
  const cached = (result: Record<string, unknown>) => complete({ ...result, ttlMs: LIST_TTL_MS, cacheScope: "public" });

  async function callTool(params: Record<string, unknown>): Promise<Record<string, unknown>> {
    const tool = tools.find((candidate) => candidate.name === params.name);
    if (!tool) throw new InvalidParams(`Unknown tool: ${String(params.name)}`);
    const args = params.arguments && typeof params.arguments === "object" && !Array.isArray(params.arguments) ? params.arguments : {};
    const fail = (text: string) => complete({ content: [textContent(text)], isError: true });

    const permissions = options.permissions();
    if (tool.access === "write" && !permissions.allowChanges) {
      return fail("Not allowed: changes are turned off. The user can enable 'Allow changes' in Settings → MCP of PraiseProjector.");
    }
    if (tool.access === "control" && !permissions.allowLiveControl) {
      return fail("Not allowed: live control is turned off. The user can enable 'Allow live control' in Settings → MCP of PraiseProjector.");
    }
    try {
      if (tool.access === "write" && permissions.confirmChanges && tool.confirmation) {
        const question = tool.confirmation(args as Record<string, unknown>, host);
        if (question && !(await host.confirm("MCP", question))) return fail("The user declined this change in PraiseProjector.");
      }
      const value = await tool.run(args as Record<string, unknown>, host);
      return complete({ content: [textContent(value ?? "OK")], isError: false });
    } catch (error) {
      if (error instanceof McpToolError) return fail(error.message);
      console.error("MCP", `Tool ${tool.name} failed`, error);
      return fail(`The tool failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  async function dispatch(message: JsonRpcRequest): Promise<unknown> {
    const params = message.params ?? {};
    switch (message.method) {
      case "initialize": {
        const requested = typeof params.protocolVersion === "string" ? params.protocolVersion : "";
        const legacy: readonly string[] = MCP_LEGACY_PROTOCOL_VERSIONS;
        return {
          protocolVersion: legacy.includes(requested) ? requested : legacy[0],
          capabilities,
          serverInfo: serverInfo(),
          instructions: MCP_INSTRUCTIONS,
        };
      }
      case "server/discover":
        return complete({
          supportedVersions: MCP_SUPPORTED_PROTOCOL_VERSIONS,
          capabilities,
          instructions: MCP_INSTRUCTIONS,
          ttlMs: LIST_TTL_MS,
          cacheScope: "public",
        });
      case "ping":
        return {};
      case "tools/list":
        return cached({
          tools: tools.map((tool) => ({
            name: tool.name,
            title: tool.title,
            description: tool.description,
            inputSchema: tool.inputSchema,
            annotations: { title: tool.title, readOnlyHint: tool.access === "read", destructiveHint: false, openWorldHint: false },
          })),
        });
      case "tools/call":
        return callTool(params);
      case "resources/list":
        return cached({
          resources: resources.map(({ uri, name, title, description, mimeType }) => ({ uri, name, title, description, mimeType })),
        });
      case "prompts/list": {
        const language = host.language();
        return cached({
          prompts: prompts.map((prompt) => ({
            name: prompt.name,
            title: prompt.title[language],
            description: prompt.description[language],
            arguments: prompt.arguments.map((argument) => ({
              name: argument.name,
              description: argument.description[language],
              required: argument.required,
            })),
          })),
        });
      }
      case "prompts/get": {
        const prompt = prompts.find((candidate) => candidate.name === params.name);
        if (!prompt) throw new InvalidParams(`Unknown prompt: ${String(params.name)}`);
        const given = params.arguments && typeof params.arguments === "object" ? (params.arguments as Record<string, unknown>) : {};
        const args: Record<string, string> = {};
        for (const argument of prompt.arguments) {
          const value = given[argument.name];
          if (typeof value === "string" && value.trim()) args[argument.name] = value.trim().slice(0, 2000);
          else if (argument.required) throw new InvalidParams(`Missing prompt argument: ${argument.name}`);
        }
        return complete({
          description: prompt.description[host.language()],
          messages: [{ role: "user", content: { type: "text", text: prompt.build(args, host) } }],
        });
      }
      case "resources/templates/list":
        return cached({ resourceTemplates: [] });
      case "resources/read": {
        const resource = resources.find((candidate) => candidate.uri === params.uri);
        if (!resource) throw new InvalidParams(`Unknown resource: ${String(params.uri)}`);
        return cached({ contents: [{ uri: resource.uri, mimeType: resource.mimeType, text: resource.read(host) }] });
      }
      default:
        throw new MethodNotFound(message.method);
    }
  }

  /** Answers one message; null for a notification. Never throws. */
  return async function handle(message: JsonRpcRequest): Promise<JsonRpcResponse | null> {
    if (isJsonRpcNotification(message)) return null;
    const id = message.id ?? null;
    try {
      return { jsonrpc: "2.0", id, result: await dispatch(message) };
    } catch (error) {
      if (error instanceof MethodNotFound) return jsonRpcError(id, McpErrorCode.MethodNotFound, `Method not found: ${error.message}`);
      if (error instanceof InvalidParams) return jsonRpcError(id, McpErrorCode.InvalidParams, error.message);
      console.error("MCP", "Request failed", error);
      return jsonRpcError(id, McpErrorCode.InternalError, error instanceof Error ? error.message : "Internal error");
    }
  };
}

class MethodNotFound extends Error {}
class InvalidParams extends Error {}
