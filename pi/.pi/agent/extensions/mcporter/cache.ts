import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { ServerToolInfo } from "mcporter";

export interface CachedToolInfo {
  name: string;
  description?: string;
  inputSchema?: unknown;
  outputSchema?: unknown;
}

export interface CachedServerInfo {
  tools: CachedToolInfo[];
  updatedAt: string;
  lastError?: string;
}

export interface ToolCacheFile {
  version: 1;
  servers: Record<string, CachedServerInfo>;
}

export interface CacheStats {
  serverCount: number;
  toolCount: number;
  lastUpdatedAt?: string;
}

export function emptyCache(): ToolCacheFile {
  return { version: 1, servers: {} };
}

export async function loadCache(cachePath: string): Promise<ToolCacheFile> {
  try {
    const parsed = JSON.parse(await readFile(cachePath, "utf8")) as Partial<ToolCacheFile>;
    if (parsed.version !== 1 || !parsed.servers || typeof parsed.servers !== "object") return emptyCache();
    return { version: 1, servers: parsed.servers };
  } catch {
    return emptyCache();
  }
}

export async function saveCache(cachePath: string, cache: ToolCacheFile): Promise<void> {
  await mkdir(dirname(cachePath), { recursive: true });
  await writeFile(cachePath, `${JSON.stringify(cache, null, 2)}\n`, "utf8");
}

export function getCachedTools(cache: ToolCacheFile, serverName: string): CachedToolInfo[] | undefined {
  return cache.servers[serverName]?.tools;
}

export async function updateCachedTools(
  cachePath: string,
  cache: ToolCacheFile,
  serverName: string,
  tools: ServerToolInfo[],
): Promise<CachedToolInfo[]> {
  const cachedTools = tools.map((tool) => ({
    name: tool.name,
    description: tool.description,
    inputSchema: tool.inputSchema,
    outputSchema: tool.outputSchema,
  }));

  cache.servers[serverName] = {
    tools: cachedTools,
    updatedAt: new Date().toISOString(),
  };
  await saveCache(cachePath, cache);
  return cachedTools;
}

export async function updateServerError(
  cachePath: string,
  cache: ToolCacheFile,
  serverName: string,
  message: string,
): Promise<void> {
  const previous = cache.servers[serverName];
  cache.servers[serverName] = {
    tools: previous?.tools ?? [],
    updatedAt: previous?.updatedAt ?? new Date().toISOString(),
    lastError: message,
  };
  await saveCache(cachePath, cache);
}

export function cacheStats(cache: ToolCacheFile): CacheStats {
  const servers = Object.values(cache.servers);
  const updatedAt = servers
    .map((server) => server.updatedAt)
    .filter(Boolean)
    .sort()
    .at(-1);

  return {
    serverCount: servers.length,
    toolCount: servers.reduce((total, server) => total + server.tools.length, 0),
    lastUpdatedAt: updatedAt,
  };
}
