import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { cacheStats, type CachedToolInfo } from "./cache.js";
import {
  renderCallResult,
  renderToolDescription,
  renderToolList,
  truncateForModel,
} from "./format.js";
import { McpRuntimeManager, configHint, type McpTool, type ResolvedToolSelector } from "./runtime.js";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const TOOL_NAME = "mcp";
const EXTENSION_DIR = dirname(fileURLToPath(import.meta.url));
const CACHE_PATH = join(EXTENSION_DIR, "mcporter-cache.json");
const runtime = new McpRuntimeManager(EXTENSION_DIR, CACHE_PATH);

const mcpParameters = {
  type: "object",
  properties: {
    server: {
      type: "string",
      description: "MCP server name. By itself, lists tools for that server.",
    },
    search: {
      type: "string",
      description: "Search tool names and descriptions across configured MCP servers.",
    },
    describe: {
      type: "string",
      description: "Describe one MCP tool. Use server.tool, or provide server separately.",
    },
    call: {
      type: "string",
      description: "Call one MCP tool. Use server.tool, or provide server separately.",
    },
    args: {
      type: "object",
      description: "Arguments object for call.",
      additionalProperties: true,
    },
    refresh: {
      type: "string",
      description: "Refresh cached metadata for one server, or '*' for all servers.",
    },
  },
  additionalProperties: false,
} as const;

type McpParams = {
  server?: string;
  search?: string;
  describe?: string;
  call?: string;
  args?: Record<string, unknown> | string;
  refresh?: string;
};

function shortenPath(filePath: string): string {
  const home = process.env.HOME || process.env.USERPROFILE;
  if (home && filePath.startsWith(home)) return `~${filePath.slice(home.length)}`;
  return filePath;
}

function relativeToCwd(filePath: string): string {
  const rel = relative(process.cwd(), filePath);
  return rel && !rel.startsWith("..") ? rel : shortenPath(filePath);
}

function setToolEnabled(pi: ExtensionAPI, enabled: boolean): void {
  const activeTools = new Set(pi.getActiveTools());
  if (enabled) activeTools.add(TOOL_NAME);
  else activeTools.delete(TOOL_NAME);
  pi.setActiveTools([...activeTools]);
}

function sanitizeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function normalizeArgs(args: unknown): Record<string, unknown> {
  if (args === undefined || args === null) return {};
  if (typeof args === "string") {
    const parsed = JSON.parse(args) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("args JSON must decode to an object.");
    return parsed as Record<string, unknown>;
  }
  if (typeof args !== "object" || Array.isArray(args)) throw new Error("args must be an object.");
  return args as Record<string, unknown>;
}

function scoreMatch(tool: McpTool, query: string): number {
  const lowered = query.toLowerCase();
  const terms = lowered.split(/\s+/).filter(Boolean);
  const fullName = `${tool.serverName}.${tool.toolName}`.toLowerCase();
  const description = (tool.description ?? "").toLowerCase();
  let score = 0;

  if (fullName === lowered) score += 120;
  if (tool.toolName.toLowerCase() === lowered) score += 100;
  if (fullName.startsWith(lowered)) score += 70;
  if (fullName.includes(lowered)) score += 50;
  if (description.includes(lowered)) score += 20;

  for (const term of terms) {
    if (fullName.includes(term)) score += 12;
    if (description.includes(term)) score += 5;
  }

  return score;
}

function commandKind(definition: unknown): string {
  const command = (definition as { command?: { kind?: unknown } })?.command;
  const kind = command?.kind;
  return typeof kind === "string" ? kind : "stdio";
}

async function renderStatus(enabled: boolean, ctx?: ExtensionContext): Promise<string> {
  const env = runtime.getEnvStatus();
  const cache = await runtime.getCache();
  const stats = cacheStats(cache);
  const lines = [`MCP: ${enabled ? "enabled" : "disabled"}`];

  lines.push(`Folder: ${relativeToCwd(EXTENSION_DIR)}`);

  if (env.loaded) {
    lines.push(`Env: loaded from .env (${env.variableCount} variable${env.variableCount === 1 ? "" : "s"})`);
  } else if (env.exists && env.error) {
    lines.push(`Env: .env failed to load (${env.error})`);
  } else if (env.exists) {
    lines.push("Env: .env exists, not loaded");
  } else {
    lines.push("Env: no .env loaded");
  }

  const refreshed = stats.lastUpdatedAt ? `, refreshed ${new Date(stats.lastUpdatedAt).toLocaleString()}` : "";
  lines.push(`Cache: ${relativeToCwd(runtime.getCachePath())}, ${stats.toolCount} cached tool(s) across ${stats.serverCount} server(s)${refreshed}`);

  if (enabled) {
    try {
      const servers = await runtime.listServers(ctx);
      lines.push(`Configured servers: ${servers.length}`);
    } catch (error) {
      lines.push(`Configured servers: unavailable (${sanitizeError(error)})`);
    }
  } else {
    lines.push("Configured servers: not checked while disabled");
  }

  lines.push(`Last error: ${runtime.getLastError() ?? "none"}`);
  lines.push("", "Use /mcp auth [server] to run OAuth, /mcp on to enable, /mcp off to disable, /mcp refresh [server] to refresh metadata.");
  return lines.join("\n");
}

async function renderServers(ctx: ExtensionContext): Promise<string> {
  const definitions = await runtime.getDefinitions(ctx);
  if (definitions.length === 0) return `No MCP servers configured. ${configHint(join(EXTENSION_DIR, ".env"))}`;

  const cache = await runtime.getCache();
  const lines = ["Configured MCP servers:", ""];
  for (const definition of [...definitions].sort((a, b) => a.name.localeCompare(b.name))) {
    const cachedCount = cache.servers[definition.name]?.tools.length;
    const details = [commandKind(definition), cachedCount !== undefined ? `${cachedCount} cached tools` : undefined]
      .filter(Boolean)
      .join(" · ");
    lines.push(`- ${definition.name}${details ? ` (${details})` : ""}`);
    if (definition.description) lines.push(`  ${definition.description}`);
  }

  lines.push("", "Use mcp({ server: \"name\" }) to inspect a server.");
  lines.push("Use mcp({ search: \"issue\" }) to search tools.");
  return truncateForModel(lines.join("\n"));
}

async function renderServerTools(serverName: string, ctx: ExtensionContext, refresh = false): Promise<string> {
  const servers = await runtime.listServers(ctx);
  if (!servers.includes(serverName)) throw new Error(`Server "${serverName}" not found. ${configHint(join(EXTENSION_DIR, ".env"))}`);
  return renderToolList(serverName, await runtime.listTools(serverName, ctx, refresh));
}

async function renderSearchResults(query: string, ctx: ExtensionContext): Promise<string> {
  const trimmed = query.trim();
  if (!trimmed) throw new Error("search query must not be empty.");

  const matches = (await runtime.allTools(ctx))
    .map((tool) => ({ tool, score: scoreMatch(tool, trimmed) }))
    .filter((entry) => entry.score > 0)
    .sort((a, b) => b.score - a.score || a.tool.serverName.localeCompare(b.tool.serverName) || a.tool.toolName.localeCompare(b.tool.toolName))
    .slice(0, 20);

  if (matches.length === 0) return `No MCP tools matched "${trimmed}".`;

  const lines = [`${matches.length} MCP tool(s) matching "${trimmed}":`, ""];
  for (const { tool } of matches) {
    const summary = tool.description ? ` - ${tool.description}` : "";
    lines.push(`- ${tool.serverName}.${tool.toolName}${summary}`);
  }
  return truncateForModel(lines.join("\n"));
}

async function describeTool(selectorText: string, ctx: ExtensionContext, serverHint?: string): Promise<string> {
  const selector = await runtime.resolveToolSelector(selectorText, ctx, serverHint);
  const tools = await runtime.listTools(selector.serverName, ctx);
  const tool = tools.find((entry: CachedToolInfo) => entry.name === selector.toolName);
  if (!tool) throw new Error(`Tool "${selector.serverName}.${selector.toolName}" not found.`);
  return renderToolDescription(selector, tool);
}

async function callTool(selectorText: string, args: unknown, ctx: ExtensionContext, serverHint?: string): Promise<string> {
  const selector: ResolvedToolSelector = await runtime.resolveToolSelector(selectorText, ctx, serverHint);
  const raw = await runtime.callTool(selector, normalizeArgs(args), ctx);
  return renderCallResult(raw);
}

async function refreshMetadata(target: string | undefined, ctx: ExtensionContext): Promise<string> {
  const normalized = target?.trim();
  const result = await runtime.refreshMetadata(!normalized || normalized === "*" ? undefined : normalized, ctx);
  const lines = [`Refreshed metadata for ${result.refreshed} server(s).`];
  if (result.failed.length > 0) {
    lines.push("", "Failures:");
    for (const failure of result.failed) lines.push(`- ${failure.server}: ${failure.error}`);
  }
  return lines.join("\n");
}

async function resolveAuthTarget(requestedTarget: string | undefined, ctx: ExtensionContext): Promise<string> {
  const definitions = await runtime.getDefinitions(ctx);
  const names = definitions.map((definition) => definition.name).sort((a, b) => a.localeCompare(b));
  if (names.length === 0) throw new Error(`No MCP servers configured. ${configHint(join(EXTENSION_DIR, ".env"))}`);

  const requested = requestedTarget?.trim();
  if (requested) {
    if (!names.includes(requested)) throw new Error(`Server "${requested}" not found. Configured servers: ${names.join(", ")}`);
    return requested;
  }

  const oauthNames = definitions
    .filter((definition) => definition.auth === "oauth")
    .map((definition) => definition.name)
    .sort((a, b) => a.localeCompare(b));

  if (oauthNames.includes("notion")) return "notion";
  if (oauthNames.length === 1) return oauthNames[0];
  if (names.length === 1) return names[0];

  throw new Error(`OAuth target is ambiguous. Usage: /mcp auth <server>. Configured servers: ${names.join(", ")}`);
}

async function authorizeServer(target: string, ctx: ExtensionContext): Promise<string> {
  const tools = await runtime.authorizeServer(target, ctx);
  return `OAuth complete for "${target}". Cached ${tools.length} tool${tools.length === 1 ? "" : "s"}.`;
}

export default function mcporterExtension(pi: ExtensionAPI) {
  let enabled = false;

  function syncActiveTool(nextEnabled: boolean): void {
    setToolEnabled(pi, nextEnabled);
  }

  pi.on("session_start", async (_event, ctx) => {
    runtime.setSessionCwd(ctx.cwd);
    await runtime.close(true);
    enabled = false;
    syncActiveTool(false);
  });

  pi.on("session_shutdown", async () => {
    await runtime.close(true);
  });

  pi.registerCommand("mcp", {
    description: "Manage the mcporter-backed MCP tool. Usage: /mcp [status|on|off|auth <server>|refresh <server>]",
    handler: async (args, ctx) => {
      const [subcommand = "status", ...rest] = (args ?? "").trim().split(/\s+/).filter(Boolean);

      if (subcommand === "status") {
        ctx.ui.notify(await renderStatus(enabled, ctx), "info");
        return;
      }

      if (subcommand === "on") {
        try {
          await runtime.close(true);
          await runtime.loadExtensionEnv();
          enabled = true;
          syncActiveTool(true);
          const env = runtime.getEnvStatus();
          const envText = env.loaded ? " Loaded extension .env." : " No extension .env found.";
          ctx.ui.notify(`Enabled mcp tool for this session.${envText} Use mcp({}) to inspect configured servers.`, "info");
        } catch (error) {
          enabled = false;
          syncActiveTool(false);
          ctx.ui.notify(`Failed to enable mcp: ${sanitizeError(error)}`, "error");
        }
        return;
      }

      if (subcommand === "off") {
        enabled = false;
        syncActiveTool(false);
        await runtime.close(true);
        ctx.ui.notify("Disabled mcp tool for this session.", "info");
        return;
      }

      if (subcommand === "auth") {
        const closeAfterAuth = !enabled;
        try {
          await runtime.loadExtensionEnv();
          const target = await resolveAuthTarget(rest[0], ctx);
          ctx.ui.setStatus("mcp-auth", `MCP OAuth: ${target}`);
          ctx.ui.notify(`Starting OAuth for "${target}". Complete the browser flow when it opens.`, "info");
          ctx.ui.notify(await authorizeServer(target, ctx), "info");
        } catch (error) {
          ctx.ui.notify(`OAuth failed: ${sanitizeError(error)}`, "error");
        } finally {
          ctx.ui.setStatus("mcp-auth", undefined);
          if (closeAfterAuth) await runtime.close(true);
        }
        return;
      }

      if (subcommand === "refresh") {
        if (!enabled) {
          ctx.ui.notify("mcp tool is disabled. Run /mcp on first.", "warning");
          return;
        }

        try {
          ctx.ui.notify(await refreshMetadata(rest[0], ctx), "info");
        } catch (error) {
          ctx.ui.notify(`Refresh failed: ${sanitizeError(error)}`, "error");
        }
        return;
      }

      ctx.ui.notify("Usage: /mcp [status|on|off|auth <server>|refresh <server>]", "warning");
    },
  });

  pi.registerTool({
    name: TOOL_NAME,
    label: "MCP",
    description: "Access configured MCP servers through mcporter. Start with mcp({}) or mcp({ server: \"name\" }) before calling tools.",
    promptSnippet: "Access MCP servers through mcporter. Run /mcp on first and /mcp auth <server> for OAuth servers. Start with mcp({}) or mcp({ server: \"name\" }) before calling tools.",
    promptGuidelines: [
      "Use mcp({}) to inspect configured MCP servers before using MCP tools.",
      "Use mcp({ server: \"name\" }) to list a server's tools.",
      "For OAuth-backed MCP servers, run /mcp auth <server> before calling protected tools.",
      "Use mcp({ describe: \"server.tool\" }) before mcp({ call: \"server.tool\", args: {...} }).",
    ],
    parameters: mcpParameters,
    async execute(_toolCallId, params: McpParams, _signal, _onUpdate, ctx) {
      if (!enabled) {
        return {
          content: [{ type: "text" as const, text: "mcp tool is disabled for this session. Run /mcp on to enable it." }],
          details: {},
          isError: true,
        };
      }

      try {
        let text: string;
        let mode = "servers";

        if (params.refresh !== undefined) {
          mode = "refresh";
          text = await refreshMetadata(params.refresh, ctx);
        } else if (params.call) {
          mode = "call";
          text = await callTool(params.call, params.args, ctx, params.server);
        } else if (params.describe) {
          mode = "describe";
          text = await describeTool(params.describe, ctx, params.server);
        } else if (params.search) {
          mode = "search";
          text = await renderSearchResults(params.search, ctx);
        } else if (params.server) {
          mode = "server";
          text = await renderServerTools(params.server, ctx);
        } else {
          text = await renderServers(ctx);
        }

        return { content: [{ type: "text" as const, text }], details: { mode } };
      } catch (error) {
        const message = sanitizeError(error);
        return {
          content: [{ type: "text" as const, text: `mcp failed: ${message}` }],
          details: {},
          isError: true,
        };
      }
    },
  });

}
