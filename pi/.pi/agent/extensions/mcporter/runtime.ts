import { access, readFile } from "node:fs/promises";
import { constants } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  createRuntime,
  describeConnectionIssue,
  type Runtime,
  type ServerDefinition,
} from "mcporter";
import {
  emptyCache,
  getCachedTools,
  loadCache,
  updateCachedTools,
  updateServerError,
  type CachedToolInfo,
  type ToolCacheFile,
} from "./cache.js";

export interface ContextLike {
  cwd: string;
}

export interface EnvStatus {
  path: string;
  checkedAt?: string;
  loadedAt?: string;
  exists: boolean;
  loaded: boolean;
  variableCount: number;
  error?: string;
}

export interface ResolvedToolSelector {
  serverName: string;
  toolName: string;
}

export interface McpTool extends ResolvedToolSelector, CachedToolInfo {}

export interface RefreshResult {
  refreshed: number;
  failed: Array<{ server: string; error: string }>;
}

const HOME_CONFIG_PATH = join(homedir(), ".mcporter", "mcporter.json");
const PROJECT_CONFIG_PATH = "config/mcporter.json";

function sanitizeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function stripWrappingQuotes(value: string): string {
  if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
    return value.slice(1, -1);
  }
  return value;
}

function parseEnvFile(content: string, envPath: string): Record<string, string> {
  const env: Record<string, string> = {};

  for (const [index, rawLine] of content.split(/\r?\n/).entries()) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;

    const normalized = line.startsWith("export ") ? line.slice(7).trim() : line;
    const separatorIndex = normalized.indexOf("=");
    if (separatorIndex <= 0) throw new Error(`Invalid env assignment on line ${index + 1} in ${envPath}`);

    const key = normalized.slice(0, separatorIndex).trim();
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) throw new Error(`Invalid env key on line ${index + 1} in ${envPath}`);

    env[key] = stripWrappingQuotes(normalized.slice(separatorIndex + 1).trim());
  }

  return env;
}

function canonicalize(text: string): string {
  return text.toLowerCase().replace(/[^a-z0-9]/g, "");
}

export function configHint(envPath: string): string {
  return `Configure mcporter in ${HOME_CONFIG_PATH} or ${PROJECT_CONFIG_PATH}. Extension-local secrets can live in ${envPath}.`;
}

export class McpRuntimeManager {
  private runtime: Runtime | undefined;
  private runtimePromise: Promise<Runtime> | undefined;
  private cache: ToolCacheFile = emptyCache();
  private cacheLoaded = false;
  private sessionCwd = process.cwd();
  private originalEnv = new Map<string, string | undefined>();
  private injectedKeys = new Set<string>();
  private envStatus: EnvStatus;
  private lastError: string | undefined;

  constructor(
    private readonly extensionDir: string,
    private readonly cachePath: string,
  ) {
    this.envStatus = {
      path: join(extensionDir, ".env"),
      exists: false,
      loaded: false,
      variableCount: 0,
    };
  }

  setSessionCwd(cwd: string): void {
    this.sessionCwd = cwd;
  }

  getCachePath(): string {
    return this.cachePath;
  }

  getEnvStatus(): EnvStatus {
    return { ...this.envStatus };
  }

  getLastError(): string | undefined {
    return this.lastError;
  }

  async getCache(): Promise<ToolCacheFile> {
    if (!this.cacheLoaded) {
      this.cache = await loadCache(this.cachePath);
      this.cacheLoaded = true;
    }
    return this.cache;
  }

  async loadExtensionEnv(): Promise<EnvStatus> {
    await this.unloadExtensionEnv();

    const checkedAt = new Date().toISOString();
    try {
      await access(this.envStatus.path, constants.R_OK);
    } catch {
      this.envStatus = {
        path: this.envStatus.path,
        checkedAt,
        exists: false,
        loaded: false,
        variableCount: 0,
      };
      return this.getEnvStatus();
    }

    try {
      const parsed = parseEnvFile(await readFile(this.envStatus.path, "utf8"), this.envStatus.path);
      for (const [key, value] of Object.entries(parsed)) {
        if (!this.originalEnv.has(key)) this.originalEnv.set(key, process.env[key]);
        process.env[key] = value;
        this.injectedKeys.add(key);
      }

      this.envStatus = {
        path: this.envStatus.path,
        checkedAt,
        loadedAt: checkedAt,
        exists: true,
        loaded: true,
        variableCount: Object.keys(parsed).length,
      };
      this.lastError = undefined;
      return this.getEnvStatus();
    } catch (error) {
      const message = sanitizeError(error);
      this.envStatus = {
        path: this.envStatus.path,
        checkedAt,
        exists: true,
        loaded: false,
        variableCount: 0,
        error: message,
      };
      this.lastError = message;
      throw error;
    }
  }

  async unloadExtensionEnv(): Promise<void> {
    for (const key of this.injectedKeys) {
      const previous = this.originalEnv.get(key);
      if (previous === undefined) delete process.env[key];
      else process.env[key] = previous;
    }

    this.injectedKeys.clear();
    this.originalEnv.clear();
    this.envStatus = {
      path: this.envStatus.path,
      checkedAt: this.envStatus.checkedAt,
      exists: this.envStatus.exists,
      loaded: false,
      variableCount: 0,
    };
  }

  async close(unloadEnv = true): Promise<void> {
    const runtime = this.runtime;
    const pending = this.runtimePromise;
    this.runtime = undefined;
    this.runtimePromise = undefined;

    try {
      if (runtime) await runtime.close();
      if (pending) await (await pending).close();
    } catch {
      // Best-effort cleanup only.
    } finally {
      if (unloadEnv) await this.unloadExtensionEnv();
    }
  }

  async ensureRuntime(ctx?: ContextLike): Promise<Runtime> {
    if (this.runtime) return this.runtime;
    if (this.runtimePromise) return this.runtimePromise;

    if (!this.envStatus.loaded && !this.envStatus.checkedAt) {
      await this.loadExtensionEnv();
    }

    const rootDir = ctx?.cwd ?? this.sessionCwd;
    this.runtimePromise = createRuntime({
      rootDir,
      clientInfo: {
        name: "pi-mcporter",
        version: "0.1.0",
      },
    }).then((runtime) => {
      this.runtime = runtime;
      this.runtimePromise = undefined;
      this.lastError = undefined;
      return runtime;
    }).catch((error) => {
      const message = sanitizeError(error);
      this.runtimePromise = undefined;
      this.lastError = message;
      throw error;
    });

    return this.runtimePromise;
  }

  async listServers(ctx?: ContextLike): Promise<string[]> {
    const runtime = await this.ensureRuntime(ctx);
    return runtime.listServers();
  }

  async getDefinitions(ctx?: ContextLike): Promise<ServerDefinition[]> {
    const runtime = await this.ensureRuntime(ctx);
    return runtime.getDefinitions();
  }

  async listTools(serverName: string, ctx?: ContextLike, refresh = false): Promise<CachedToolInfo[]> {
    const cache = await this.getCache();
    if (!refresh) {
      const cached = getCachedTools(cache, serverName);
      if (cached) return cached;
    }

    try {
      const runtime = await this.ensureRuntime(ctx);
      const tools = await runtime.listTools(serverName, {
        includeSchema: true,
        autoAuthorize: false,
        allowCachedAuth: true,
      });
      return updateCachedTools(this.cachePath, cache, serverName, tools);
    } catch (error) {
      const message = sanitizeError(error);
      this.lastError = message;
      await updateServerError(this.cachePath, cache, serverName, message).catch(() => {});
      throw error;
    }
  }

  async allTools(ctx?: ContextLike, refresh = false): Promise<McpTool[]> {
    const servers = await this.listServers(ctx);
    const all: McpTool[] = [];

    for (const serverName of servers) {
      try {
        const tools = await this.listTools(serverName, ctx, refresh);
        for (const tool of tools) all.push({ serverName, toolName: tool.name, ...tool });
      } catch {
        // Discovery/search should remain useful when one server is unavailable.
      }
    }

    return all;
  }

  async refreshMetadata(target: string | undefined, ctx?: ContextLike): Promise<RefreshResult> {
    const failed: RefreshResult["failed"] = [];
    let refreshed = 0;

    if (target) {
      await this.listTools(target, ctx, true);
      return { refreshed: 1, failed };
    }

    const servers = await this.listServers(ctx);
    for (const server of servers) {
      try {
        await this.listTools(server, ctx, true);
        refreshed += 1;
      } catch (error) {
        failed.push({ server, error: sanitizeError(error) });
      }
    }

    return { refreshed, failed };
  }

  async resolveToolSelector(selector: string, ctx?: ContextLike, serverHint?: string): Promise<ResolvedToolSelector> {
    const trimmed = selector.trim();
    if (!trimmed) throw new Error("Tool name is required.");

    const dotIndex = trimmed.indexOf(".");
    if (dotIndex > 0) {
      return { serverName: trimmed.slice(0, dotIndex), toolName: trimmed.slice(dotIndex + 1) };
    }

    if (serverHint) return { serverName: serverHint, toolName: trimmed };

    const allTools = await this.allTools(ctx);
    const exactMatches = allTools.filter((tool) => tool.toolName === trimmed);
    if (exactMatches.length === 1) return { serverName: exactMatches[0].serverName, toolName: exactMatches[0].toolName };
    if (exactMatches.length > 1) throw new Error(`Tool "${trimmed}" exists on multiple servers. Use server.tool form.`);

    const canonical = canonicalize(trimmed);
    const fuzzyMatches = allTools.filter((tool) => canonicalize(tool.toolName) === canonical);
    if (fuzzyMatches.length === 1) return { serverName: fuzzyMatches[0].serverName, toolName: fuzzyMatches[0].toolName };
    if (fuzzyMatches.length > 1) throw new Error(`Tool "${trimmed}" is ambiguous. Use server.tool form.`);

    throw new Error(`Tool "${trimmed}" not found. Start with mcp({ search: "${trimmed}" }).`);
  }

  async callTool(selector: ResolvedToolSelector, args: Record<string, unknown>, ctx?: ContextLike): Promise<unknown> {
    try {
      const runtime = await this.ensureRuntime(ctx);
      return await runtime.callTool(selector.serverName, selector.toolName, { args });
    } catch (error) {
      const issue = describeConnectionIssue(error);
      const message = sanitizeError(error);
      this.lastError = message;
      throw new Error(`[${issue.kind}] ${message}`);
    }
  }
}
