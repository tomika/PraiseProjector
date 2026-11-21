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
  MCP_META_PROTOCOL_VERSION,
  MCP_META_SERVER_INFO,
  MCP_SERVER_NAME,
  MCP_STATELESS_PROTOCOL_VERSION,
  MCP_SUPPORTED_PROTOCOL_VERSIONS,
  McpErrorCode,
  isJsonRpcNotification,
  jsonRpcError,
} from "../../../common/mcp-bridge";
import { AsyncJobQueue } from "../../../common/asyncQueue";
import { McpHost, McpPrompt, McpResource, McpTool, McpToolError } from "./types";

/** Tool and resource lists only change with an application update. */
const LIST_TTL_MS = 5 * 60 * 1000;

export const MCP_INSTRUCTIONS = [
  "PraiseProjector is a worship-song projection application: a song database (ChordPro), playlists for services, projection of song sections to a second screen, and sessions that tablets and phones join over the local network or the cloud.",
  "For how-to questions use search_help, then get_help_topic for details. Use the tutorial's labels and use open_view or show_in_app when asked to open or point at a control. For troubleshooting use get_app_status or diagnose, and get_ui_state for the current screen.",
  "Answer in the user's language (the app UI is English or Hungarian; get_app_status reports which).",
  "Find a title or known lyric fragment with search_songs, a lyric pattern with find_songs, or song metadata with query_songs. Resolve ambiguous titles and obtain actual song IDs before writing.",
  "A favorite song means a leader's preferred song (Hungarian: kedvelt dal). Read list_song_preferences with type preferred, use query_songs to combine filters, and set_song_preference to mark songs. A favorite playlist is a named stored list. A note mark is separate from preferences, and the star beside a song indicates a local change awaiting sync.",
  "Use get_playlist for the working playlist open in the app. Follow it with insert_playlist_items for one or several songs, edit_playlist for row moves, removals and updates, or replace_playlist for an entire replacement. After a timeout or disconnection, read the list again before considering another write.",
  "Use create_stored_playlist to prepare a leader's calendar or named favorite playlist, or get_stored_playlist then edit_stored_playlist for an existing one. Keep the named target from the conversation and ask which list if the target is ambiguous. Load or save the working copy only on request.",
  "How a song is performed on a playlist item (which sections, how often, in which key) is set by its instructions; read check_instructions before writing them.",
  "Tools that change something need 'Allow changes' and tools that drive the live projection need 'Allow live control' in Settings → MCP; the user may also be asked to confirm a change inside the app. If a tool reports that it is not allowed, tell the user which switch to turn on instead of retrying.",
  "During a service be careful with live-control tools: what you select is shown to the congregation.",
].join("\n");

const ERROR_META = "praiseprojector/error";
const DEFAULT_PROTOCOL_VERSION = "2025-03-26";

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
  const commitQueues = { "working-playlist": new AsyncJobQueue(), "song-preferences": new AsyncJobQueue() };
  const serverInfo = () => ({ name: MCP_SERVER_NAME, title: "PraiseProjector", version: host.appVersion() });
  const capabilities = { tools: { listChanged: true }, resources: { listChanged: true }, prompts: {} };
  const complete = (result: Record<string, unknown>, meta: Record<string, unknown> = {}) => ({
    resultType: "complete",
    ...result,
    _meta: { [MCP_META_SERVER_INFO]: serverInfo(), ...meta },
  });
  const cached = (result: Record<string, unknown>) => complete({ ...result, ttlMs: LIST_TTL_MS, cacheScope: "public" });

  async function callTool(params: Record<string, unknown>, supportsStructuredContent: boolean): Promise<Record<string, unknown>> {
    const tool = tools.find((candidate) => candidate.name === params.name);
    if (!tool) throw new InvalidParams(`Unknown tool: ${String(params.name)}`);
    const given = params.arguments;
    const isObject = given !== null && typeof given === "object" && !Array.isArray(given);
    if (tool.outputSchema && given !== undefined && !isObject) throw new InvalidParams("Tool arguments must be an object.");
    const args = isObject ? (given as Record<string, unknown>) : {};
    const fail = (error: McpToolError) =>
      complete(
        { content: [textContent(error.message)], isError: true },
        error.code ? { [ERROR_META]: { code: error.code, message: error.message, ...(error.details ? { details: error.details } : {}) } } : {}
      );
    const assertPermission = () => {
      const { allowChanges, allowLiveControl } = options.permissions();
      if (tool.access === "write" && !allowChanges) {
        throw new McpToolError(
          "Not allowed: changes are turned off. The user can enable 'Allow changes' in Settings → MCP of PraiseProjector.",
          "PERMISSION_DENIED"
        );
      }
      if (tool.access === "control" && !allowLiveControl) {
        throw new McpToolError(
          "Not allowed: live control is turned off. The user can enable 'Allow live control' in Settings → MCP of PraiseProjector.",
          "PERMISSION_DENIED"
        );
      }
    };
    try {
      assertPermission();
      const change = tool.prepare
        ? tool.prepare(args, host)
        : {
            get confirmation() {
              return tool.confirmation?.(args, host);
            },
            commit: () => tool.run(args, host),
          };
      if (tool.access === "write" && options.permissions().confirmChanges) {
        const question = change.confirmation;
        if (question && !(await host.confirm("MCP", question))) {
          throw new McpToolError("The user declined this change in PraiseProjector. Stop this write.", "USER_DECLINED");
        }
      }
      const run = () => {
        assertPermission();
        return change.commit();
      };
      let value: unknown;
      const queue = tool.serialize?.(args);
      if (queue) {
        await commitQueues[queue].enqueue(async () => {
          value = await run();
        });
      } else {
        value = await run();
      }
      return complete({
        content: [textContent(value ?? "OK")],
        isError: false,
        ...(tool.outputSchema && supportsStructuredContent ? { structuredContent: value } : {}),
      });
    } catch (error) {
      if (error instanceof McpToolError) return fail(error);
      console.error("MCP", `Tool ${tool.name} failed`, error);
      return fail(new McpToolError(`The tool failed: ${error instanceof Error ? error.message : String(error)}`));
    }
  }

  async function dispatch(message: JsonRpcRequest, protocolVersion?: string): Promise<unknown> {
    const params = message.params ?? {};
    const metaVersion = (params._meta as Record<string, unknown> | undefined)?.[MCP_META_PROTOCOL_VERSION];
    const version = protocolVersion ?? (metaVersion === MCP_STATELESS_PROTOCOL_VERSION ? metaVersion : DEFAULT_PROTOCOL_VERSION);
    const supportsStructuredContent = version === MCP_STATELESS_PROTOCOL_VERSION || version === "2025-11-25" || version === "2025-06-18";
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
        return version === MCP_STATELESS_PROTOCOL_VERSION ? complete({}) : {};
      case "tools/list":
        return cached({
          tools: tools.map((tool) => ({
            name: tool.name,
            title: tool.title,
            description: tool.description,
            inputSchema: tool.inputSchema,
            ...(tool.outputSchema && supportsStructuredContent ? { outputSchema: tool.outputSchema } : {}),
            annotations: {
              title: tool.title,
              readOnlyHint: tool.readOnlyHint ?? tool.access === "read",
              destructiveHint: tool.destructiveHint ?? false,
              openWorldHint: false,
            },
          })),
        });
      case "tools/call":
        return callTool(params, supportsStructuredContent);
      case "resources/list":
        return cached({
          resources: resources.map(({ uri, name, title, description, mimeType }) => ({ uri, name, title, description, mimeType })),
        });
      case "prompts/list": {
        const language = host.language();
        return complete({
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
  return async function handle(message: JsonRpcRequest, protocolVersion?: string): Promise<JsonRpcResponse | null> {
    if (isJsonRpcNotification(message)) return null;
    const id = message.id ?? null;
    try {
      return { jsonrpc: "2.0", id, result: await dispatch(message, protocolVersion) };
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
