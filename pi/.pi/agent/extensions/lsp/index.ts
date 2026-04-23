import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import {
  DynamicBorder,
  truncateHead,
  DEFAULT_MAX_BYTES,
  DEFAULT_MAX_LINES,
} from "@mariozechner/pi-coding-agent";
import {
  Container,
  Input,
  Key,
  SelectList,
  Text,
  matchesKey,
  type Component,
  type Focusable,
  type SelectItem,
} from "@mariozechner/pi-tui";
import { Type } from "typebox";
import { spawnSync } from "node:child_process";
import { resolve, extname, relative, dirname, join } from "node:path";
import { readFileSync, existsSync, statSync, watch, type FSWatcher } from "node:fs";
import {
  LSPClient,
  type Diagnostic,
  type Location,
  type WorkspaceSymbol,
  type WatchedFileChange,
} from "./client.js";
import { detectServers, type ServerConfig } from "./servers.js";

const FULL_REINDEX_THRESHOLD = 400;
const GIT_HEAD_POLL_MS = 10000;
const LSP_SETTLE_MS = 400;

type RepoChangeType = "created" | "changed" | "deleted";

interface RepoFileChange {
  path: string;
  type: RepoChangeType;
}

function findGitHeadPath(startDir: string): string | null {
  let dir = resolve(startDir);
  while (true) {
    const gitPath = join(dir, ".git");
    if (existsSync(gitPath)) {
      try {
        const stat = statSync(gitPath);
        if (stat.isFile()) {
          const content = readFileSync(gitPath, "utf8").trim();
          if (content.startsWith("gitdir: ")) {
            const gitDir = content.slice(8).trim();
            const headPath = resolve(dir, gitDir, "HEAD");
            if (existsSync(headPath)) return headPath;
          }
        } else if (stat.isDirectory()) {
          const headPath = join(gitPath, "HEAD");
          if (existsSync(headPath)) return headPath;
        }
      } catch {
        return null;
      }
    }

    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

function runGit(cwd: string, args: string[]): string | null {
  const result = spawnSync("git", args, {
    cwd,
    encoding: "utf-8",
    timeout: 5000,
  });
  if (result.status !== 0) return null;
  return (result.stdout ?? "").trim();
}

function getGitHead(cwd: string): string | null {
  return runGit(cwd, ["rev-parse", "--verify", "HEAD"]);
}

function parseGitNameStatus(output: string): RepoFileChange[] {
  const byPath = new Map<string, RepoChangeType>();
  const priority: Record<RepoChangeType, number> = {
    created: 1,
    changed: 2,
    deleted: 3,
  };

  function upsert(filePath: string, type: RepoChangeType) {
    const prev = byPath.get(filePath);
    if (!prev || priority[type] > priority[prev]) byPath.set(filePath, type);
  }

  for (const raw of output.split("\n")) {
    if (!raw.trim()) continue;

    const cols = raw.split("\t");
    if (cols.length < 2) continue;

    const status = cols[0] ?? "";
    const kind = status[0] ?? "M";

    if (kind === "R") {
      const from = cols[1];
      const to = cols[2];
      if (from) upsert(from, "deleted");
      if (to) upsert(to, "created");
      continue;
    }

    if (kind === "C") {
      const to = cols[2] ?? cols[1];
      if (to) upsert(to, "created");
      continue;
    }

    const filePath = cols[1];
    if (!filePath) continue;

    if (kind === "A") upsert(filePath, "created");
    else if (kind === "D") upsert(filePath, "deleted");
    else upsert(filePath, "changed");
  }

  return [...byPath.entries()].map(([path, type]) => ({ path, type }));
}

function getGitDiffChanges(cwd: string, oldHead: string, newHead: string): RepoFileChange[] | null {
  const output = runGit(cwd, ["diff", "--name-status", "--find-renames", oldHead, newHead]);
  if (output === null) return null;
  return parseGitNameStatus(output);
}

function isConfigAffectingFile(filePath: string): boolean {
  const normalized = filePath.replace(/\\/g, "/");
  const base = normalized.split("/").pop() ?? normalized;

  return (
    /^tsconfig(\..+)?\.json$/i.test(base) ||
    /^jsconfig(\..+)?\.json$/i.test(base) ||
    /^requirements(\..+)?\.txt$/i.test(base) ||
    base === "package.json" ||
    base === "pnpm-workspace.yaml" ||
    base === "yarn.lock" ||
    base === "pyproject.toml" ||
    base === "poetry.lock" ||
    base === "Pipfile" ||
    base === "Pipfile.lock" ||
    base === "go.mod" ||
    base === "go.sum"
  );
}

function shouldFullReindex(changes: RepoFileChange[]): boolean {
  return changes.length >= FULL_REINDEX_THRESHOLD || changes.some((c) => isConfigAffectingFile(c.path));
}

function getFileExtension(filePath: string): string {
  return extname(filePath).toLowerCase();
}

function fmtDiags(diags: Diagnostic[]): string {
  if (diags.length === 0) return "No diagnostics.";
  return diags
    .map((d) => `${d.file}:${d.line}:${d.character} [${d.severity}] ${d.message}${d.source ? ` (${d.source})` : ""}`)
    .join("\n");
}

function fmtLocs(locs: Location[], label: string): string {
  if (locs.length === 0) return `No ${label} found.`;
  return locs.map((l) => `${l.file}:${l.line}:${l.character}`).join("\n");
}

/**
 * Rank symbols by relevance to the query.
 *  1. Exact match (case-insensitive)
 *  2. Starts with query
 *  3. Contains query as a word boundary (e.g. "Cycle" matches "ReviewCycle")
 *  4. Contains query anywhere
 * Within each tier, shorter names come first (more specific).
 * Deduplicates by name+file+line.
 */
function rankSymbols(symbols: WorkspaceSymbol[], query: string): WorkspaceSymbol[] {
  const q = query.toLowerCase();

  function score(s: WorkspaceSymbol): number {
    const name = s.name.toLowerCase();
    if (name === q) return 0;                    // exact
    if (name.startsWith(q)) return 1;            // prefix
    // word-boundary: query appears after an uppercase transition (camelCase)
    const idx = name.indexOf(q);
    if (idx > 0) {
      const ch = s.name[idx];
      if (ch === ch.toUpperCase()) return 2;     // camelCase boundary
    }
    return 3;                                    // substring
  }

  const seen = new Set<string>();
  return symbols
    .filter((s) => {
      const key = `${s.name}:${s.file}:${s.line}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .sort((a, b) => {
      const sa = score(a), sb = score(b);
      if (sa !== sb) return sa - sb;
      return a.name.length - b.name.length;
    });
}

function symbolAt(root: string, filePath: string, line: number, character: number): string | null {
  try {
    const src = readFileSync(resolve(root, filePath), "utf-8").split("\n")[line - 1];
    if (!src) return null;
    const re = /[\w$]/;
    let s = character, e = character;
    while (s > 0 && re.test(src[s - 1])) s--;
    while (e < src.length && re.test(src[e])) e++;
    return src.slice(s, e) || null;
  } catch { return null; }
}

interface ClientEntry {
  client: LSPClient;
  config: ServerConfig;
}

interface ClientDiagnostics {
  name: string;
  diagnostics: Diagnostic[];
}

function summarizeClientDiagnostics(groups: ClientDiagnostics[]): string[] {
  return groups.map(({ name, diagnostics }) => {
    const errors = diagnostics.filter((diagnostic) => diagnostic.severity === "error").length;
    const warnings = diagnostics.filter((diagnostic) => diagnostic.severity === "warning").length;
    const infos = diagnostics.filter((diagnostic) => diagnostic.severity === "info").length;
    const hints = diagnostics.filter((diagnostic) => diagnostic.severity === "hint").length;

    const parts = [`${errors} error${errors === 1 ? "" : "s"}`];
    if (warnings > 0) parts.push(`${warnings} warning${warnings === 1 ? "" : "s"}`);
    if (infos > 0) parts.push(`${infos} info`);
    if (hints > 0) parts.push(`${hints} hint${hints === 1 ? "" : "s"}`);
    return `- ${name}: ${parts.join(", ")}`;
  });
}

function formatTopDiagnostics(groups: ClientDiagnostics[], maxItems = 6): string {
  const ranked = groups.flatMap(({ name, diagnostics }) => diagnostics.map((diagnostic) => ({
    name,
    diagnostic,
    weight: diagnostic.severity === "error"
      ? 0
      : diagnostic.severity === "warning"
        ? 1
        : diagnostic.severity === "info"
          ? 2
          : 3,
  })));

  ranked.sort((a, b) => {
    if (a.weight !== b.weight) return a.weight - b.weight;
    if (a.diagnostic.line !== b.diagnostic.line) return a.diagnostic.line - b.diagnostic.line;
    return a.diagnostic.character - b.diagnostic.character;
  });

  return ranked.slice(0, maxItems)
    .map(({ name, diagnostic }) => `  ${name} ${relative(process.cwd(), diagnostic.file) || diagnostic.file}:${diagnostic.line}:${diagnostic.character} [${diagnostic.severity}] ${diagnostic.message}`)
    .join("\n");
}

export default function (pi: ExtensionAPI) {
  let clients: LSPClient[] = [];
  const diagnosticsOnlyClients = new Set<LSPClient>();
  let projectRoot = "";
  let initPromise: Promise<void> | null = null;
  let currentCtx: ExtensionContext | null = null;

  let gitHeadWatcher: FSWatcher | null = null;
  let gitHeadPollTimer: ReturnType<typeof setInterval> | null = null;
  let lastGitHead: string | null = null;
  let branchSyncInFlight = false;
  let branchSyncQueued = false;

  let symbolGeneration = 0;
  let reindexing = false;

  function updateStatus(ctx: ExtensionContext) {
    if (!ctx.hasUI) return;
    const alive = clients.filter((c) => c.isAlive());
    if (alive.length === 0) {
      ctx.ui.setStatus("lsp", undefined);
      return;
    }

    const suffix = reindexing ? ` • reindexing g${symbolGeneration}` : "";
    ctx.ui.setStatus("lsp", ctx.ui.theme.fg("dim", `LSP: ${alive.map((c) => c.name).join(", ")}${suffix}`));
  }

  const clientConfigs = new Map<LSPClient, ServerConfig>();

  async function getClientEntries(filePath: string): Promise<ClientEntry[]> {
    if (initPromise) await initPromise;
    const ext = getFileExtension(filePath);
    return clients.flatMap((client) => {
      const config = clientConfigs.get(client);
      if (!config || !config.extensions.includes(ext)) return [];
      return [{ client, config }];
    });
  }

  async function getAliveClientEntries(filePath: string): Promise<ClientEntry[]> {
    return (await getClientEntries(filePath)).filter(({ client }) => client.isAlive());
  }

  async function getClient(filePath: string, forDiagnostics = false): Promise<LSPClient | null> {
    const aliveEntries = await getAliveClientEntries(filePath);
    if (aliveEntries.length === 0) return null;
    if (forDiagnostics) {
      return aliveEntries.find(({ config }) => config.diagnostics !== false && config.diagnosticsOnly)?.client
        ?? aliveEntries.find(({ config }) => config.diagnostics !== false)?.client
        ?? null;
    }
    return aliveEntries.find(({ config }) => !config.diagnosticsOnly)?.client
      ?? aliveEntries[0]?.client
      ?? null;
  }

  async function notifyEntriesChanged(entries: ClientEntry[], filePath: string) {
    const absPath = resolve(projectRoot, filePath);
    await Promise.allSettled(
      entries
        .filter(({ client }) => client.isAlive())
        .map(({ client }) => client.notifyChanged(absPath)),
    );
  }

  async function collectDiagnostics(filePath: string): Promise<ClientDiagnostics[]> {
    const entries = (await getClientEntries(filePath)).filter(({ config }) => config.diagnostics !== false);
    if (entries.length === 0) return [];

    const missing = [...new Set(entries.filter(({ client }) => !client.isAlive()).map(({ config }) => config.name))];
    if (missing.length > 0) {
      throw new Error(`Missing LSP server(s) for ${filePath}: ${missing.join(", ")}.`);
    }

    const absPath = resolve(projectRoot, filePath);
    await notifyEntriesChanged(entries, filePath);
    return Promise.all(entries.map(async ({ client, config }) => ({
      name: config.name,
      diagnostics: await client.refreshDiagnostics(absPath, LSP_SETTLE_MS),
    })));
  }

  async function runAutoFix(filePath: string): Promise<string[]> {
    const entries = await getClientEntries(filePath);
    if (entries.length === 0) return [];

    const fixEntries = entries.filter(({ config }) => (config.fixOnSaveKinds?.length ?? 0) > 0);
    const formatEntries = entries.filter(({ config }) => !!config.formatOnSave);
    const requiredEntries = [...fixEntries, ...formatEntries];
    const missing = [...new Set(requiredEntries.filter(({ client }) => !client.isAlive()).map(({ config }) => config.name))];
    if (missing.length > 0) {
      throw new Error(`Missing LSP auto-fix server(s) for ${filePath}: ${missing.join(", ")}.`);
    }

    const applied = new Set<string>();
    const absPath = resolve(projectRoot, filePath);

    await notifyEntriesChanged(entries, filePath);
    await new Promise((resolve) => setTimeout(resolve, LSP_SETTLE_MS));

    for (const { client, config } of fixEntries) {
      const changed = await client.applyCodeActionKinds(absPath, config.fixOnSaveKinds ?? []);
      if (!changed) continue;
      applied.add(config.name);
      await notifyEntriesChanged(entries, filePath);
      await new Promise((resolve) => setTimeout(resolve, LSP_SETTLE_MS));
    }

    for (const { client, config } of formatEntries) {
      const changed = await client.formatDocument(absPath);
      if (!changed) continue;
      applied.add(config.name);
      await notifyEntriesChanged(entries, filePath);
      await new Promise((resolve) => setTimeout(resolve, LSP_SETTLE_MS));
    }

    return [...applied];
  }

  function startServers(cwd: string) {
    projectRoot = cwd;
    const configs = detectServers(projectRoot);
    if (configs.length === 0) {
      clients = [];
      clientConfigs.clear();
      initPromise = Promise.resolve();
      if (currentCtx) updateStatus(currentCtx);
      return;
    }

    diagnosticsOnlyClients.clear();
    clientConfigs.clear();
    clients = configs.map((config) => {
      const wsRoot = config.workspaceSubdir ? resolve(projectRoot, config.workspaceSubdir) : projectRoot;
      const client = new LSPClient(config.name, config.command, config.args, wsRoot, config.language, config.env, config.settings, config.sendDidSave ?? true);
      clientConfigs.set(client, config);
      if (config.diagnosticsOnly) diagnosticsOnlyClients.add(client);
      return client;
    });

    initPromise = (async () => {
      await Promise.allSettled(clients.map(async (client) => {
        try { await client.waitReady(); }
        catch (e) { console.error(`[lsp] ${client.name} failed: ${e}`); }
      }));
      if (currentCtx) updateStatus(currentCtx);
    })();
  }

  function forceShutdownServers() {
    for (const client of clients) client.terminate();
    clients = [];
    clientConfigs.clear();
    diagnosticsOnlyClients.clear();
    initPromise = null;
    if (currentCtx) updateStatus(currentCtx);
  }

  async function shutdownServers() {
    await Promise.allSettled(clients.map((c) => c.shutdown()));
    forceShutdownServers();
  }

  async function restartServers(reason: string) {
    if (!projectRoot) return;
    await shutdownServers();
    if (!projectRoot) return;
    startServers(projectRoot);
    if (initPromise) await initPromise;
    if (currentCtx?.hasUI) currentCtx.ui.notify(`LSP restarted (${reason})`, "info");
  }

  async function applyIncrementalBranchChanges(changes: RepoFileChange[]) {
    if (changes.length === 0) return;
    if (initPromise) await initPromise;

    const byClient = new Map<LSPClient, WatchedFileChange[]>();
    for (const client of clients) {
      if (!client.isAlive()) continue;
      byClient.set(client, []);
    }

    for (const change of changes) {
      const ext = getFileExtension(change.path);
      if (!ext) continue;

      const absPath = resolve(projectRoot, change.path);
      for (const client of clients) {
        const config = clientConfigs.get(client);
        if (!client.isAlive() || !config || !config.extensions.includes(ext)) continue;
        byClient.get(client)?.push({ path: absPath, type: change.type });
      }
    }

    await Promise.allSettled(
      [...byClient.entries()]
        .filter(([, entries]) => entries.length > 0)
        .map(([client, entries]) => client.notifyWatchedFilesChanged(entries)),
    );

    const warmupByClient = new Map<LSPClient, string>();
    for (const change of changes) {
      if (change.type === "deleted") continue;
      const ext = getFileExtension(change.path);
      if (!ext) continue;
      const absPath = resolve(projectRoot, change.path);
      for (const client of clients) {
        const config = clientConfigs.get(client);
        if (!client.isAlive() || !config || !config.extensions.includes(ext) || warmupByClient.has(client)) continue;
        warmupByClient.set(client, absPath);
      }
    }

    await Promise.allSettled(
      [...warmupByClient.entries()].map(([client, absPath]) => client.notifyChanged(absPath)),
    );
  }

  async function syncGitHead(source: string) {
    if (!projectRoot) return;

    const nextHead = getGitHead(projectRoot);
    if (!nextHead) return;

    if (!lastGitHead) {
      lastGitHead = nextHead;
      return;
    }

    if (nextHead === lastGitHead) return;

    const prevHead = lastGitHead;
    lastGitHead = nextHead;

    symbolGeneration += 1;
    reindexing = true;
    if (currentCtx) updateStatus(currentCtx);

    try {
      const changes = getGitDiffChanges(projectRoot, prevHead, nextHead);
      if (!changes) {
        await restartServers(`branch switch via ${source}: diff unavailable`);
        return;
      }

      if (shouldFullReindex(changes)) {
        const reason = changes.length >= FULL_REINDEX_THRESHOLD
          ? `branch switch via ${source}: ${changes.length} changed files`
          : `branch switch via ${source}: project config changed`;
        await restartServers(reason);
        return;
      }

      await applyIncrementalBranchChanges(changes);
    } finally {
      reindexing = false;
      if (currentCtx) updateStatus(currentCtx);
    }
  }

  function scheduleGitHeadSync(source: string) {
    if (branchSyncInFlight) {
      branchSyncQueued = true;
      return;
    }

    branchSyncInFlight = true;
    void syncGitHead(source)
      .catch((e) => {
        console.error(`[lsp] git sync failed: ${e}`);
      })
      .finally(() => {
        branchSyncInFlight = false;
        if (branchSyncQueued) {
          branchSyncQueued = false;
          scheduleGitHeadSync("queued");
        }
      });
  }

  function stopGitHeadTracking() {
    if (gitHeadWatcher) {
      gitHeadWatcher.close();
      gitHeadWatcher = null;
    }
    if (gitHeadPollTimer) {
      clearInterval(gitHeadPollTimer);
      gitHeadPollTimer = null;
    }
    branchSyncInFlight = false;
    branchSyncQueued = false;
  }

  function startGitHeadTracking() {
    stopGitHeadTracking();
    if (!projectRoot) return;

    lastGitHead = getGitHead(projectRoot);

    const headPath = findGitHeadPath(projectRoot);
    if (headPath) {
      const gitDir = dirname(headPath);
      try {
        gitHeadWatcher = watch(gitDir, (_eventType, filename) => {
          if (!filename || filename.toString() === "HEAD") {
            scheduleGitHeadSync("fs-watch");
          }
        });
        gitHeadWatcher.unref?.();
      } catch {
        gitHeadWatcher = null;
      }
    }

    gitHeadPollTimer = setInterval(() => {
      scheduleGitHeadSync("poll");
    }, GIT_HEAD_POLL_MS);
    gitHeadPollTimer.unref?.();
  }

  // ── Lifecycle ──────────────────────────────────────────────

  pi.on("session_start", async (event, ctx) => {
    currentCtx = ctx;

    if (event.reason !== "startup" && ctx.cwd === projectRoot) {
      updateStatus(ctx);
      return;
    }

    symbolGeneration = 0;
    reindexing = false;
    stopGitHeadTracking();
    await shutdownServers();
    startServers(ctx.cwd);

    if (clients.length > 0) {
      if (ctx.hasUI) {
        ctx.ui.setStatus("lsp", ctx.ui.theme.fg("dim", `LSP: starting ${clients.map((c) => c.name).join(", ")}…`));
      }
      startGitHeadTracking();
    } else {
      stopGitHeadTracking();
      updateStatus(ctx);
    }
  });

  pi.on("session_shutdown", async () => {
    stopGitHeadTracking();
    projectRoot = "";
    await shutdownServers();
    currentCtx = null;
    lastGitHead = null;
    reindexing = false;
  });

  // ── LSP auto-fix + diagnostics after edit/write ──────────

  pi.on("tool_result", async (event) => {
    if (event.toolName !== "edit" && event.toolName !== "write") return;
    if (event.isError) return;

    const filePath = (event.input as any)?.path;
    if (!filePath) return;

    const entries = await getClientEntries(filePath);
    if (entries.length === 0) return;

    const original = event.content
      .filter((content): content is { type: "text"; text: string } => content.type === "text")
      .map((content) => content.text)
      .join("");

    try {
      const autoFixers = await runAutoFix(filePath);
      const diagnostics = await collectDiagnostics(filePath);
      const summaryLines = summarizeClientDiagnostics(diagnostics);
      const topDiagnostics = formatTopDiagnostics(diagnostics);
      const errorCount = diagnostics.reduce((sum, { diagnostics }) => sum + diagnostics.filter((diagnostic) => diagnostic.severity === "error").length, 0);
      const warningCount = diagnostics.reduce((sum, { diagnostics }) => sum + diagnostics.filter((diagnostic) => diagnostic.severity === "warning").length, 0);

      let text = original;
      if (autoFixers.length > 0) {
        text += `\n\nApplied LSP auto-fixes: ${autoFixers.join(", ")}.`;
        text += "\nThe file changed again after the tool call. Read it before relying on exact text matches.";
      }

      if (diagnostics.length === 0) {
        text += "\n\nNo LSP diagnostics were configured for this file.";
        return { content: [{ type: "text" as const, text }] };
      }

      if (errorCount === 0 && warningCount === 0) {
        text += `\n\nNo LSP errors from ${diagnostics.map(({ name }) => name).join(", ")}.`;
        return { content: [{ type: "text" as const, text }] };
      }

      text += `\n\nLSP diagnostics for ${filePath}:\n${summaryLines.join("\n")}`;
      if (topDiagnostics) {
        text += `\n\nTop issues:\n${topDiagnostics}`;
      }
      text += "\n\nUse these diagnostics instead of running biome/eslint/pyright/ruff directly.";

      return { content: [{ type: "text" as const, text }] };
    } catch (e: any) {
      return {
        content: [{
          type: "text" as const,
          text: `${original}\n\nLSP auto-fix/diagnostics failed for ${filePath}: ${e.message}`,
        }],
        isError: true,
      };
    }
  });

  // ── Tools ─────────────────────────────────────────────────

  pi.registerTool({
    name: "goto_definition",
    label: "Go to Definition",
    description: "Find the definition of a symbol at a given file position. Returns file path and line number where the symbol is defined. Line is 1-based, character is 0-based.",
    promptSnippet: "Find the definition of a symbol at a given file position. Returns file path and line number where the symbol is defined. Line is 1-based, character is 0-based.",
    parameters: Type.Object({
      path: Type.String({ description: "File path (relative to project root)" }),
      line: Type.Number({ description: "Line number (1-based)" }),
      character: Type.Number({ description: "Column/character offset (0-based)" }),
    }),
    renderCall(args, theme) {
      const sym = symbolAt(projectRoot, args.path, args.line, args.character);
      return new Text(
        theme.fg("toolTitle", theme.bold("goto_definition ")) +
        (sym ? theme.fg("accent", sym) + " " : "") +
        theme.fg("dim", `${args.path}:${args.line}:${args.character}`),
        0, 0,
      );
    },
    async execute(_id, params) {
      const filePath = params.path.replace(/^@/, "");
      const client = await getClient(filePath);
      if (!client) return { content: [{ type: "text", text: `No LSP server for ${filePath}.` }], isError: true };
      try {
        const locs = await client.definition(resolve(projectRoot, filePath), params.line, params.character);
        return { content: [{ type: "text", text: fmtLocs(locs, "definitions") }], details: { locations: locs } };
      } catch (e: any) {
        return { content: [{ type: "text", text: `LSP error: ${e.message}` }], isError: true };
      }
    },
  });

  pi.registerTool({
    name: "find_references",
    label: "Find References",
    description: "Find all references to a symbol at a given file position. Use before renaming or refactoring. Line is 1-based, character is 0-based.",
    promptSnippet: "Find all references to a symbol at a given file position. Use before renaming or refactoring. Line is 1-based, character is 0-based.",
    parameters: Type.Object({
      path: Type.String({ description: "File path (relative to project root)" }),
      line: Type.Number({ description: "Line number (1-based)" }),
      character: Type.Number({ description: "Column/character offset (0-based)" }),
      include_declaration: Type.Optional(Type.Boolean({ description: "Include the declaration itself (default: true)" })),
    }),
    async execute(_id, params) {
      const filePath = params.path.replace(/^@/, "");
      const client = await getClient(filePath);
      if (!client) return { content: [{ type: "text", text: `No LSP server for ${filePath}.` }], isError: true };
      try {
        const locs = await client.references(resolve(projectRoot, filePath), params.line, params.character, params.include_declaration ?? true);
        let text = fmtLocs(locs, "references");
        if (locs.length > 0) text = `Found ${locs.length} reference${locs.length > 1 ? "s" : ""}:\n${text}`;
        return { content: [{ type: "text", text: truncateHead(text, { maxLines: DEFAULT_MAX_LINES, maxBytes: DEFAULT_MAX_BYTES }).content }], details: { count: locs.length } };
      } catch (e: any) {
        return { content: [{ type: "text", text: `LSP error: ${e.message}` }], isError: true };
      }
    },
  });

  pi.registerTool({
    name: "get_diagnostics",
    label: "Get Diagnostics",
    description: "Get type errors, warnings, and diagnostics for a file from the configured LSP servers (for example pyright, ruff, typescript, biome, eslint). Note: edit/write tools already report diagnostics automatically — use this only to check files you haven't just modified.",
    promptSnippet: "Get type errors, warnings, and diagnostics for a file from the configured LSP servers (for example pyright, ruff, typescript, biome, eslint). Note: edit/write tools already report diagnostics automatically — use this only to check files you haven't just modified.",
    parameters: Type.Object({
      path: Type.String({ description: "File path (relative to project root)" }),
    }),
    async execute(_id, params) {
      const filePath = params.path.replace(/^@/, "");
      try {
        const diagnostics = await collectDiagnostics(filePath);
        if (diagnostics.length === 0) {
          return { content: [{ type: "text", text: `No LSP diagnostics configured for ${filePath}.` }] };
        }

        const allDiagnostics = diagnostics.flatMap(({ diagnostics }) => diagnostics);
        const errors = allDiagnostics.filter((diagnostic) => diagnostic.severity === "error").length;
        const warnings = allDiagnostics.filter((diagnostic) => diagnostic.severity === "warning").length;
        const summary = summarizeClientDiagnostics(diagnostics).join("\n");
        const detailText = diagnostics
          .filter(({ diagnostics }) => diagnostics.length > 0)
          .map(({ name, diagnostics }) => `${name}:\n${fmtDiags(diagnostics)}`)
          .join("\n\n");

        return {
          content: [{
            type: "text",
            text: `Diagnostics for ${filePath}: ${errors} error(s), ${warnings} warning(s)\n\n${summary}${detailText ? `\n\n${detailText}` : ""}`,
          }],
          details: { errors, warnings },
        };
      } catch (e: any) {
        return { content: [{ type: "text", text: `LSP error: ${e.message}` }], isError: true };
      }
    },
  });

  pi.registerTool({
    name: "hover_info",
    label: "Hover Info",
    description: "Get type information and documentation for a symbol at a given position. Useful for checking function signatures and types.",
    promptSnippet: "Get type information and documentation for a symbol at a given position. Useful for checking function signatures and types.",
    parameters: Type.Object({
      path: Type.String({ description: "File path (relative to project root)" }),
      line: Type.Number({ description: "Line number (1-based)" }),
      character: Type.Number({ description: "Column/character offset (0-based)" }),
    }),
    async execute(_id, params) {
      const filePath = params.path.replace(/^@/, "");
      const client = await getClient(filePath);
      if (!client) return { content: [{ type: "text", text: `No LSP server for ${filePath}.` }], isError: true };
      try {
        const info = await client.hover(resolve(projectRoot, filePath), params.line, params.character);
        return { content: [{ type: "text", text: info ?? "No hover information available at this position." }] };
      } catch (e: any) {
        return { content: [{ type: "text", text: `LSP error: ${e.message}` }], isError: true };
      }
    },
  });

  // ── Command: /lsp-status ──────────────────────────────────

  pi.registerCommand("lsp-status", {
    description: "Show LSP server status",
    handler: async (_args, ctx) => {
      if (clients.length === 0) { ctx.ui.notify("No LSP servers configured", "info"); return; }
      const head = lastGitHead ? lastGitHead.slice(0, 8) : "none";
      const summary = `generation=${symbolGeneration} • ${reindexing ? "reindexing" : "idle"} • HEAD=${head}`;
      const servers = clients.map((c) => `${c.name}: ${c.isAlive() ? "✅ running" : "❌ dead"}`);
      ctx.ui.notify([summary, ...servers].join("\n"), "info");
    },
  });

  // ── # Workspace Symbol Search ─────────────────────────────
  //
  // pyrefly indexes lazily: opening a file triggers background indexing
  // of the entire project-includes (~10s). The search UI polls every 2s
  // until results arrive, so the user just sees "Indexing…" and then results.

  pi.registerShortcut("#", {
    description: "Search workspace symbols",
    handler: async (ctx) => {
      if (!ctx.hasUI) return;

      if (initPromise) await initPromise;

      const getPyClients = () => clients.filter((c) => c.language === "python" && c.isAlive() && !diagnosticsOnlyClients.has(c));
      if (getPyClients().length === 0) { ctx.ui.notify("No Python LSP running", "warning"); return; }

      const result = await ctx.ui.custom<string | null>((tui, theme, _kb, done) => {
        const termRows = tui.terminal.rows || 24;
        const maxVisible = Math.min(20, Math.max(5, termRows - 8));

        const borderTop = new DynamicBorder((s: string) => theme.fg("accent", s));
        const borderBottom = new DynamicBorder((s: string) => theme.fg("accent", s));
        const searchInput = new Input();
        const listTheme = {
          selectedPrefix: (text: string) => theme.fg("accent", text),
          selectedText: (text: string) => theme.fg("accent", text),
          description: (text: string) => theme.fg("dim", text),
          scrollInfo: (text: string) => theme.fg("dim", text),
          noMatch: () => theme.fg("warning", "  No results"),
        };

        let items: SelectItem[] = [];
        let selectList = new SelectList(items, maxVisible, listTheme);
        let searching = false;
        let debounceTimer: ReturnType<typeof setTimeout> | null = null;
        let activeQuery = "";
        let focused = false;
        let lastQuery = "";

        function rebuildSelectList() {
          selectList = new SelectList(items, maxVisible, listTheme);
        }

        function queueSearch() {
          if (debounceTimer) clearTimeout(debounceTimer);
          items = [];
          rebuildSelectList();
          debounceTimer = setTimeout(doSearch, 200);
          tui.requestRender();
        }

        function doSearch() {
          const query = searchInput.getValue();
          if (query.length < 2) {
            searching = false;
            items = [];
            rebuildSelectList();
            tui.requestRender();
            return;
          }

          const q = query;
          const searchGeneration = symbolGeneration;
          activeQuery = q;
          searching = true;
          tui.requestRender();

          const pyClients = getPyClients();
          if (pyClients.length === 0) {
            searching = false;
            items = [];
            rebuildSelectList();
            tui.requestRender();
            return;
          }

          Promise.all(pyClients.map((c) => c.workspaceSymbol(q)))
            .then((results) => {
              if (activeQuery !== q) return;
              if (searchGeneration !== symbolGeneration) {
                searching = false;
                items = [];
                rebuildSelectList();
                tui.requestRender();
                return;
              }

              const symbols = rankSymbols(results.flat(), q);
              items = symbols.map((s) => {
                const rel = s.file.startsWith(projectRoot) ? relative(projectRoot, s.file) : s.file;
                const suffix = s.containerName ? ` (${s.containerName})` : "";
                return {
                  value: `${rel}:${s.line}:${s.character}`,
                  label: `${s.name}${suffix}  ${s.kind}  ${rel}:${s.line}`,
                };
              });
              searching = false;
              rebuildSelectList();
              tui.requestRender();
            })
            .catch(() => {
              if (activeQuery !== q) return;
              searching = false;
              items = [];
              rebuildSelectList();
              tui.requestRender();
            });
        }

        const comp: Component & Focusable = {
          get focused() { return focused; },
          set focused(value: boolean) { focused = value; searchInput.focused = value; },

          render(width: number): string[] {
            const lines: string[] = [];
            const query = searchInput.getValue();
            const status = reindexing
              ? theme.fg("dim", " indexing")
              : searching
                ? theme.fg("dim", " searching")
                : query.length >= 2
                  ? theme.fg("dim", ` ${items.length} results`)
                  : theme.fg("dim", " type 2+ chars");

            lines.push(...borderTop.render(width));
            lines.push(" " + theme.fg("accent", theme.bold("🔎 Symbols")) + status);
            lines.push("");
            for (const line of searchInput.render(width - 2)) lines.push(" " + line);
            lines.push(theme.fg("dim", " " + "─".repeat(Math.max(1, width - 2))));

            if (items.length > 0) {
              lines.push(...selectList.render(width));
            } else if (searching || reindexing) {
              const msg = reindexing ? "  Indexing after branch change…" : "  Searching…";
              lines.push(theme.fg("muted", msg));
            } else if (query.length >= 2) {
              lines.push(theme.fg("warning", "  No results"));
            } else if (query.length > 0) {
              lines.push(theme.fg("muted", "  Type at least 2 characters"));
            }

            lines.push("");
            lines.push(
              " " +
                theme.fg("dim", "↑↓") + theme.fg("muted", " navigate  ") +
                theme.fg("dim", "enter") + theme.fg("muted", " select  ") +
                theme.fg("dim", "esc") + theme.fg("muted", " cancel"),
            );
            lines.push(...borderBottom.render(width));
            return lines;
          },

          invalidate() {
            borderTop.invalidate();
            borderBottom.invalidate();
            searchInput.invalidate();
            selectList.invalidate();
          },

          handleInput(data: string) {
            if (matchesKey(data, Key.escape) || matchesKey(data, Key.ctrl("c"))) {
              done(null);
              return;
            }

            if (matchesKey(data, Key.enter)) {
              done(selectList.getSelectedItem()?.value ?? null);
              return;
            }

            if (
              matchesKey(data, Key.up) ||
              matchesKey(data, Key.down) ||
              matchesKey(data, Key.pageUp) ||
              matchesKey(data, Key.pageDown)
            ) {
              selectList.handleInput(data);
              tui.requestRender();
              return;
            }

            searchInput.handleInput(data);
            const query = searchInput.getValue();
            if (query !== lastQuery) {
              queueSearch();
              lastQuery = query;
            }
            tui.requestRender();
          },
        };

        return comp;
      }, { overlay: true });

      if (result) {
        const [file, line] = result.split(":");
        const text = `${file}:${line}`;
        ctx.ui.pasteToEditor(text);
      }
    },
  });
}
