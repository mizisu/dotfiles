import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import {
	DEFAULT_MAX_BYTES,
	DEFAULT_MAX_LINES,
	formatSize,
	truncateHead,
} from "@mariozechner/pi-coding-agent";
import { Type } from "typebox";
import {
	createCallResult,
	createRuntime,
	describeConnectionIssue,
	type Runtime,
	type ServerToolInfo,
} from "mcporter";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";

const TOOL_NAME = "mcp";
const EXTENSION_DIR = dirname(fileURLToPath(import.meta.url));
const EXTENSION_ENV_PATH = join(EXTENSION_DIR, ".env");
const CACHE_PATH = join(homedir(), ".pi", "agent", "mcporter-cache.json");
const HOME_CONFIG_PATH = join(homedir(), ".mcporter", "mcporter.json");
const PROJECT_CONFIG_PATH = "config/mcporter.json";

interface CachedToolInfo {
	name: string;
	description?: string;
	inputSchema?: unknown;
	outputSchema?: unknown;
}

interface CachedServerInfo {
	tools: CachedToolInfo[];
	updatedAt: string;
}

interface ToolCacheFile {
	version: 1;
	servers: Record<string, CachedServerInfo>;
}

interface ResolvedToolSelector {
	serverName: string;
	toolName: string;
}

function loadCache(): ToolCacheFile {
	if (!existsSync(CACHE_PATH)) {
		return { version: 1, servers: {} };
	}

	try {
		const parsed = JSON.parse(readFileSync(CACHE_PATH, "utf8")) as Partial<ToolCacheFile>;
		if (parsed.version !== 1 || !parsed.servers || typeof parsed.servers !== "object") {
			return { version: 1, servers: {} };
		}
		return {
			version: 1,
			servers: parsed.servers,
		};
	} catch {
		return { version: 1, servers: {} };
	}
}

function saveCache(cache: ToolCacheFile): void {
	mkdirSync(dirname(CACHE_PATH), { recursive: true });
	writeFileSync(CACHE_PATH, JSON.stringify(cache, null, 2) + "\n", "utf8");
}

function configHint(): string {
	return `Configure mcporter in ${HOME_CONFIG_PATH} or ${PROJECT_CONFIG_PATH}. Extension-local secrets can live in ${EXTENSION_ENV_PATH}.`;
}

function stripWrappingQuotes(value: string): string {
	if (
		(value.startsWith('"') && value.endsWith('"'))
		|| (value.startsWith("'") && value.endsWith("'"))
	) {
		return value.slice(1, -1);
	}
	return value;
}

function parseEnvFile(content: string): Record<string, string> {
	const env: Record<string, string> = {};
	for (const [index, rawLine] of content.split(/\r?\n/).entries()) {
		const line = rawLine.trim();
		if (!line || line.startsWith("#")) continue;

		const normalized = line.startsWith("export ") ? line.slice(7).trim() : line;
		const separatorIndex = normalized.indexOf("=");
		if (separatorIndex <= 0) {
			throw new Error(`Invalid env line ${index + 1} in ${EXTENSION_ENV_PATH}`);
		}

		const key = normalized.slice(0, separatorIndex).trim();
		if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) {
			throw new Error(`Invalid env key on line ${index + 1} in ${EXTENSION_ENV_PATH}`);
		}

		const value = stripWrappingQuotes(normalized.slice(separatorIndex + 1).trim());
		env[key] = value;
	}
	return env;
}

function canonicalize(text: string): string {
	return text.toLowerCase().replace(/[^a-z0-9]/g, "");
}

function normalizeArgs(args?: string): Record<string, unknown> {
	if (!args || args.trim() === "") {
		return {};
	}

	let parsed: unknown;
	try {
		parsed = JSON.parse(args);
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		throw new Error(`Invalid JSON in args: ${message}`);
	}

	if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
		throw new Error("args must decode to a JSON object.");
	}

	return parsed as Record<string, unknown>;
}

function truncateForModel(text: string): string {
	const truncation = truncateHead(text, {
		maxLines: DEFAULT_MAX_LINES,
		maxBytes: DEFAULT_MAX_BYTES,
	});

	if (!truncation.truncated) {
		return truncation.content;
	}

	return `${truncation.content}\n\n[Output truncated: ${truncation.outputLines} of ${truncation.totalLines} lines (${formatSize(truncation.outputBytes)} of ${formatSize(truncation.totalBytes)})]`;
}

function formatJson(value: unknown): string {
	return JSON.stringify(value, null, 2);
}

function renderCallResult(raw: unknown): string {
	const result = createCallResult(raw);
	const markdown = result.markdown();
	if (markdown) return truncateForModel(markdown);
	const text = result.text();
	if (text) return truncateForModel(text);
	const json = result.json();
	if (json !== null) return truncateForModel(formatJson(json));
	return truncateForModel(formatJson(raw));
}

function schemaTypeLabel(schema: unknown): string {
	if (!schema || typeof schema !== "object") return "unknown";
	const typeValue = (schema as { type?: unknown }).type;
	if (typeof typeValue === "string") return typeValue;
	if (Array.isArray(typeValue)) {
		return typeValue.filter((item): item is string => typeof item === "string").join(" | ") || "unknown";
	}
	if (Array.isArray((schema as { anyOf?: unknown[] }).anyOf)) return "anyOf";
	if (Array.isArray((schema as { oneOf?: unknown[] }).oneOf)) return "oneOf";
	return "unknown";
}

function describeParameters(schema: unknown): Array<{ name: string; required: boolean; type: string; description?: string; defaultValue?: unknown }> {
	if (!schema || typeof schema !== "object") return [];
	const objectSchema = schema as {
		properties?: Record<string, { type?: unknown; description?: unknown; default?: unknown }>;
		required?: unknown;
	};
	const required = Array.isArray(objectSchema.required)
		? new Set(objectSchema.required.filter((item): item is string => typeof item === "string"))
		: new Set<string>();
	const properties = objectSchema.properties ?? {};
	const orderedKeys = [
		...required,
		...Object.keys(properties).filter((key) => !required.has(key)),
	];

	return orderedKeys.map((name) => {
		const property = properties[name] ?? {};
		return {
			name,
			required: required.has(name),
			type: schemaTypeLabel(property),
			description: typeof property.description === "string" ? property.description : undefined,
			defaultValue: property.default,
		};
	});
}

function renderSignature(selector: ResolvedToolSelector, tool: CachedToolInfo): string {
	const params = describeParameters(tool.inputSchema)
		.map((param) => `${param.name}${param.required ? "" : "?"}: ${param.type}`)
		.join(", ");
	return `${selector.serverName}.${selector.toolName}(${params})`;
}

function cacheTools(cache: ToolCacheFile, serverName: string, tools: ServerToolInfo[]): void {
	cache.servers[serverName] = {
		tools: tools.map((tool) => ({
			name: tool.name,
			description: tool.description,
			inputSchema: tool.inputSchema,
			outputSchema: tool.outputSchema,
		})),
		updatedAt: new Date().toISOString(),
	};
	saveCache(cache);
}

export default function mcporterExtension(pi: ExtensionAPI) {
	let runtime: Runtime | null = null;
	let runtimePromise: Promise<Runtime> | null = null;
	let sessionCwd = process.cwd();
	let injectedEnv = new Map<string, string>();
	const cache = loadCache();

	function loadExtensionEnv(): void {
		if (!existsSync(EXTENSION_ENV_PATH)) {
			return;
		}

		const parsed = parseEnvFile(readFileSync(EXTENSION_ENV_PATH, "utf8"));
		const nextInjected = new Map<string, string>();

		for (const [key, previousValue] of injectedEnv) {
			if (!(key in parsed) && process.env[key] === previousValue) {
				delete process.env[key];
			}
		}

		for (const [key, value] of Object.entries(parsed)) {
			const currentValue = process.env[key];
			const previousValue = injectedEnv.get(key);
			const shouldInject = currentValue === undefined || currentValue === previousValue;
			if (!shouldInject) {
				continue;
			}
			process.env[key] = value;
			nextInjected.set(key, value);
		}

		injectedEnv = nextInjected;
	}

	function unloadExtensionEnv(): void {
		for (const [key, value] of injectedEnv) {
			if (process.env[key] === value) {
				delete process.env[key];
			}
		}
		injectedEnv = new Map();
	}

	function isToolEnabled(): boolean {
		return pi.getActiveTools().includes(TOOL_NAME);
	}

	function setToolEnabled(enabled: boolean): void {
		const activeTools = new Set(pi.getActiveTools());
		if (enabled) {
			activeTools.add(TOOL_NAME);
		} else {
			activeTools.delete(TOOL_NAME);
		}
		pi.setActiveTools(Array.from(activeTools));
	}

	async function closeRuntime(): Promise<void> {
		try {
			if (runtime) {
				await runtime.close();
			}
			if (runtimePromise) {
				const pending = await runtimePromise;
				await pending.close();
			}
		} catch {
			// Best-effort cleanup only.
		} finally {
			runtime = null;
			runtimePromise = null;
			unloadExtensionEnv();
		}
	}

	async function ensureRuntime(ctx?: ExtensionContext): Promise<Runtime> {
		if (runtime) return runtime;
		if (runtimePromise) return runtimePromise;

		loadExtensionEnv();
		const rootDir = ctx?.cwd ?? sessionCwd;
		runtimePromise = createRuntime({
			rootDir,
			clientInfo: {
				name: "pi-mcporter",
				version: "0.1.0",
			},
		}).then((createdRuntime) => {
			runtime = createdRuntime;
			runtimePromise = null;
			return createdRuntime;
		}).catch((error) => {
			runtimePromise = null;
			throw error;
		});

		return runtimePromise;
	}

	async function listServers(ctx: ExtensionContext): Promise<string[]> {
		const currentRuntime = await ensureRuntime(ctx);
		return currentRuntime.listServers();
	}

	async function getServerTools(serverName: string, ctx: ExtensionContext, refresh = false): Promise<CachedToolInfo[]> {
		if (!refresh) {
			const cached = cache.servers[serverName]?.tools;
			if (cached) return cached;
		}

		const currentRuntime = await ensureRuntime(ctx);
		const tools = await currentRuntime.listTools(serverName, {
			includeSchema: true,
			autoAuthorize: false,
			allowCachedAuth: true,
		});
		cacheTools(cache, serverName, tools);
		return cache.servers[serverName]?.tools ?? [];
	}

	async function getAllTools(ctx: ExtensionContext, refresh = false): Promise<Array<ResolvedToolSelector & CachedToolInfo>> {
		const servers = await listServers(ctx);
		const allTools: Array<ResolvedToolSelector & CachedToolInfo> = [];

		for (const serverName of servers) {
			try {
				const tools = await getServerTools(serverName, ctx, refresh);
				for (const tool of tools) {
					allTools.push({
						serverName,
						toolName: tool.name,
						...tool,
					});
				}
			} catch {
				// Skip unavailable servers during discovery/search.
			}
		}

		return allTools;
	}

	async function resolveToolSelector(selector: string, ctx: ExtensionContext, serverHint?: string): Promise<ResolvedToolSelector> {
		const trimmed = selector.trim();
		if (!trimmed) {
			throw new Error("Tool name is required.");
		}

		const dotIndex = trimmed.indexOf(".");
		if (dotIndex > 0) {
			return {
				serverName: trimmed.slice(0, dotIndex),
				toolName: trimmed.slice(dotIndex + 1),
			};
		}

		if (serverHint) {
			return { serverName: serverHint, toolName: trimmed };
		}

		const allTools = await getAllTools(ctx);
		const exactMatches = allTools.filter((tool) => tool.toolName === trimmed);
		if (exactMatches.length === 1) {
			return {
				serverName: exactMatches[0].serverName,
				toolName: exactMatches[0].toolName,
			};
		}
		if (exactMatches.length > 1) {
			throw new Error(`Tool "${trimmed}" exists on multiple servers. Use server.tool form.`);
		}

		const canonical = canonicalize(trimmed);
		const fuzzyMatches = allTools.filter((tool) => canonicalize(tool.toolName) === canonical);
		if (fuzzyMatches.length === 1) {
			return {
				serverName: fuzzyMatches[0].serverName,
				toolName: fuzzyMatches[0].toolName,
			};
		}
		if (fuzzyMatches.length > 1) {
			throw new Error(`Tool "${trimmed}" is ambiguous. Use server.tool form.`);
		}

		throw new Error(`Tool "${trimmed}" not found. Start with mcp({ search: "${trimmed}" }).`);
	}

	async function renderServers(ctx: ExtensionContext): Promise<string> {
		const currentRuntime = await ensureRuntime(ctx);
		const definitions = currentRuntime.getDefinitions();
		if (definitions.length === 0) {
			return `No MCP servers configured. ${configHint()}`;
		}

		const lines = ["Configured MCP servers:", ""];
		for (const definition of definitions.sort((a, b) => a.name.localeCompare(b.name))) {
			const cachedCount = cache.servers[definition.name]?.tools.length;
			const transport = definition.command.kind === "http" ? definition.command.url.toString() : definition.command.command;
			const details = cachedCount !== undefined ? ` · cached tools: ${cachedCount}` : "";
			lines.push(`- ${definition.name}${details}`);
			if (definition.description) lines.push(`  ${definition.description}`);
			lines.push(`  ${transport}`);
		}
		lines.push("", "Use mcp({ server: \"name\" }) to inspect a server.");
		return lines.join("\n");
	}

	async function renderServerTools(serverName: string, ctx: ExtensionContext, refresh = false): Promise<string> {
		const currentRuntime = await ensureRuntime(ctx);
		const servers = currentRuntime.listServers();
		if (!servers.includes(serverName)) {
			throw new Error(`Server "${serverName}" not found. ${configHint()}`);
		}

		const tools = await getServerTools(serverName, ctx, refresh);
		if (tools.length === 0) {
			return `${serverName}: no tools found.`;
		}

		const lines = [`${serverName} (${tools.length} tools):`, ""];
		for (const tool of tools.sort((a, b) => a.name.localeCompare(b.name))) {
			const summary = tool.description ? ` - ${tool.description}` : "";
			lines.push(`- ${tool.name}${summary}`);
		}
		lines.push("", `Use mcp({ describe: \"${serverName}.${tools[0].name}\" }) for parameters.`);
		return lines.join("\n");
	}

	function scoreMatch(tool: ResolvedToolSelector & CachedToolInfo, query: string): number {
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

	async function renderSearchResults(query: string, ctx: ExtensionContext): Promise<string> {
		const allTools = await getAllTools(ctx);
		if (allTools.length === 0) {
			return `No tool metadata available yet. ${configHint()}`;
		}

		const matches = allTools
			.map((tool) => ({ tool, score: scoreMatch(tool, query) }))
			.filter((entry) => entry.score > 0)
			.sort((a, b) => b.score - a.score || a.tool.serverName.localeCompare(b.tool.serverName) || a.tool.toolName.localeCompare(b.tool.toolName))
			.slice(0, 20);

		if (matches.length === 0) {
			return `No MCP tools matched "${query}".`;
		}

		const lines = [`Search results for "${query}":`, ""];
		for (const { tool } of matches) {
			const summary = tool.description ? ` - ${tool.description}` : "";
			lines.push(`- ${tool.serverName}.${tool.toolName}${summary}`);
		}
		return lines.join("\n");
	}

	async function renderToolDescription(selector: string, ctx: ExtensionContext, serverHint?: string): Promise<string> {
		const resolved = await resolveToolSelector(selector, ctx, serverHint);
		const tools = await getServerTools(resolved.serverName, ctx);
		const tool = tools.find((entry) => entry.name === resolved.toolName);
		if (!tool) {
			throw new Error(`Tool "${resolved.serverName}.${resolved.toolName}" not found.`);
		}

		const lines = [renderSignature(resolved, tool)];
		if (tool.description) {
			lines.push("", tool.description);
		}

		const params = describeParameters(tool.inputSchema);
		if (params.length > 0) {
			lines.push("", "Parameters:");
			for (const param of params) {
				let line = `- ${param.name}${param.required ? "" : "?"}: ${param.type}`;
				if (param.description) line += ` - ${param.description}`;
				if (param.defaultValue !== undefined) line += ` (default: ${JSON.stringify(param.defaultValue)})`;
				lines.push(line);
			}
		} else {
			lines.push("", "Parameters: none");
		}

		if (tool.inputSchema && params.length === 0) {
			lines.push("", "Input schema:", formatJson(tool.inputSchema));
		}

		return lines.join("\n");
	}

	async function refreshMetadata(target: string | undefined, ctx: ExtensionContext): Promise<string> {
		if (target) {
			const serverName = target.trim();
			await renderServerTools(serverName, ctx, true);
			return `Refreshed metadata for ${serverName}.`;
		}

		const servers = await listServers(ctx);
		for (const server of servers) {
			try {
				await getServerTools(server, ctx, true);
			} catch {
				// Refresh best-effort only.
			}
		}
		return `Refreshed metadata for ${servers.length} server(s).`;
	}

	async function callMcpTool(toolSelector: string, argsJson: string | undefined, ctx: ExtensionContext, serverHint?: string): Promise<string> {
		const resolved = await resolveToolSelector(toolSelector, ctx, serverHint);
		const args = normalizeArgs(argsJson);
		const currentRuntime = await ensureRuntime(ctx);

		try {
			const raw = await currentRuntime.callTool(resolved.serverName, resolved.toolName, { args });
			return renderCallResult(raw);
		} catch (error) {
			const issue = describeConnectionIssue(error);
			const message = error instanceof Error ? error.message : String(error);
			throw new Error(`[${issue.kind}] ${message}`);
		}
	}

	pi.on("session_start", async (_event, ctx) => {
		sessionCwd = ctx.cwd;
		await closeRuntime();
		setToolEnabled(false);
	});

	pi.on("session_shutdown", async () => {
		await closeRuntime();
	});

	pi.registerCommand("mcp", {
		description: "Enable or disable the mcporter-backed MCP tool",
		handler: async (args, ctx) => {
			const [subcommand, ...rest] = (args ?? "").trim().split(/\s+/).filter(Boolean);

			if (!subcommand || subcommand === "on") {
				setToolEnabled(true);
				ctx.ui.notify("Enabled mcp tool for this session. Use mcp({}) to inspect configured servers.", "info");
				return;
			}

			if (subcommand === "off") {
				setToolEnabled(false);
				await closeRuntime();
				ctx.ui.notify("Disabled mcp tool for this session.", "info");
				return;
			}

			if (subcommand === "status") {
				if (!isToolEnabled()) {
					ctx.ui.notify(`mcp tool is disabled. Run /mcp to enable it. ${configHint()}`, "info");
					return;
				}

				try {
					const servers = await listServers(ctx);
					ctx.ui.notify(`mcp tool is enabled. ${servers.length} configured server(s).`, "info");
				} catch (error) {
					const message = error instanceof Error ? error.message : String(error);
					ctx.ui.notify(`mcp tool is enabled, but runtime initialization failed: ${message}`, "warning");
				}
				return;
			}

			if (subcommand === "refresh") {
				try {
					const message = await refreshMetadata(rest[0], ctx);
					ctx.ui.notify(message, "info");
				} catch (error) {
					const message = error instanceof Error ? error.message : String(error);
					ctx.ui.notify(`Refresh failed: ${message}`, "error");
				}
				return;
			}

			ctx.ui.notify("Usage: /mcp [on|off|status|refresh <server>]", "warning");
		},
	});

	pi.registerTool({
		name: TOOL_NAME,
		label: "MCP",
		description: "Access MCP servers through mcporter with progressive discovery. Start with mcp({}) or mcp({ server: \"name\" }) before calling tools.",
		promptSnippet: "Access MCP servers through mcporter. Start with mcp({}) or mcp({ server: \"name\" }) before calling tools.",
		parameters: Type.Object({
			server: Type.Optional(Type.String({ description: "Server name. By itself, lists tools for that server." })),
			search: Type.Optional(Type.String({ description: "Search tool names and descriptions across configured MCP servers." })),
			describe: Type.Optional(Type.String({ description: "Describe one tool. Use server.tool or provide server separately." })),
			tool: Type.Optional(Type.String({ description: "Call a tool. Use server.tool or provide server separately." })),
			args: Type.Optional(Type.String({ description: "JSON string of tool arguments. Object input is also accepted." })),
			refresh: Type.Optional(Type.String({ description: "Refresh cached metadata for one server or use '*' for all servers." })),
		}),
		prepareArguments(raw) {
			if (!raw || typeof raw !== "object") return raw;
			const input = raw as Record<string, unknown>;
			if (input.args !== undefined && typeof input.args === "object" && input.args !== null) {
				return {
					...input,
					args: JSON.stringify(input.args),
				};
			}
			return raw;
		},
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			if (!isToolEnabled()) {
				throw new Error("mcp tool is disabled for this session. Run /mcp to enable it first.");
			}

			if (params.refresh) {
				const target = params.refresh === "*" ? undefined : params.refresh;
				const text = await refreshMetadata(target, ctx);
				return {
					content: [{ type: "text", text }],
					details: { mode: "refresh", target: target ?? "all" },
				};
			}

			let text: string;
			if (params.tool) {
				text = await callMcpTool(params.tool, params.args, ctx, params.server);
			} else if (params.describe) {
				text = await renderToolDescription(params.describe, ctx, params.server);
			} else if (params.search) {
				text = await renderSearchResults(params.search, ctx);
			} else if (params.server) {
				text = await renderServerTools(params.server, ctx);
			} else {
				text = await renderServers(ctx);
			}

			return {
				content: [{ type: "text", text }],
				details: {
					mode: params.tool
						? "call"
						: params.describe
							? "describe"
							: params.search
								? "search"
								: params.server
									? "server"
									: "status",
				},
			};
		},
	});
}
