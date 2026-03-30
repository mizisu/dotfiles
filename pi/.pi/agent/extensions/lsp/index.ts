import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import {
  DynamicBorder,
  truncateHead,
  DEFAULT_MAX_BYTES,
  DEFAULT_MAX_LINES,
} from "@mariozechner/pi-coding-agent";
import { Container, SelectList, Text, type SelectItem } from "@mariozechner/pi-tui";
import { Type } from "@sinclair/typebox";
import { spawnSync } from "node:child_process";
import { resolve, extname, relative, dirname, join } from "node:path";
import { readFileSync, existsSync, statSync, watch, type FSWatcher } from "node:fs";
import { execFileSync } from "node:child_process";
import {
  LSPClient,
  type Diagnostic,
  type Location,
  type WorkspaceSymbol,
  type WatchedFileChange,
} from "./client.js";
import { detectServers } from "./servers.js";

const TS_EXTS = new Set([".ts", ".tsx", ".js", ".jsx"]);
const PY_EXTS = new Set([".py"]);
const FULL_REINDEX_THRESHOLD = 400;
const GIT_HEAD_POLL_MS = 10000;

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

function getLanguage(filePath: string): "typescript" | "python" | null {
  const ext = extname(filePath);
  if (TS_EXTS.has(ext)) return "typescript";
  if (PY_EXTS.has(ext)) return "python";
  return null;
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

  async function getClient(filePath: string, forDiagnostics = false): Promise<LSPClient | null> {
    const lang = getLanguage(filePath);
    if (!lang) return null;
    if (initPromise) await initPromise;
    if (forDiagnostics) {
      return clients.find((c) => c.language === lang && c.isAlive() && diagnosticsOnlyClients.has(c))
        ?? clients.find((c) => c.language === lang && c.isAlive()) ?? null;
    }
    return clients.find((c) => c.language === lang && c.isAlive() && !diagnosticsOnlyClients.has(c))
      ?? clients.find((c) => c.language === lang && c.isAlive()) ?? null;
  }

  function startServers(cwd: string) {
    projectRoot = cwd;
    jsFormatters = null;
    const configs = detectServers(projectRoot);
    if (configs.length === 0) {
      clients = [];
      initPromise = Promise.resolve();
      if (currentCtx) updateStatus(currentCtx);
      return;
    }

    diagnosticsOnlyClients.clear();
    clients = configs.map((config) => {
      const wsRoot = config.workspaceSubdir ? resolve(projectRoot, config.workspaceSubdir) : projectRoot;
      const client = new LSPClient(config.name, config.command, config.args, wsRoot, config.language, config.env, config.settings);
      if (config.diagnosticsOnly) diagnosticsOnlyClients.add(client);
      return client;
    });

    initPromise = (async () => {
      await Promise.allSettled(clients.map(async (c) => {
        try { await c.waitReady(); }
        catch (e) { console.error(`[lsp] ${c.name} failed: ${e}`); }
      }));
      if (currentCtx) updateStatus(currentCtx);
    })();
  }

  function forceShutdownServers() {
    for (const client of clients) client.terminate();
    clients = [];
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
      const lang = getLanguage(change.path);
      if (!lang) continue;

      const absPath = resolve(projectRoot, change.path);
      for (const client of clients) {
        if (!client.isAlive() || client.language !== lang) continue;
        byClient.get(client)?.push({ path: absPath, type: change.type });
      }
    }

    await Promise.allSettled(
      [...byClient.entries()]
        .filter(([, entries]) => entries.length > 0)
        .map(([client, entries]) => client.notifyWatchedFilesChanged(entries)),
    );

    // Warm one file per language to trigger lazy index refresh in some servers.
    const warmupByLang = new Map<string, string>();
    for (const change of changes) {
      if (change.type === "deleted") continue;
      const lang = getLanguage(change.path);
      if (!lang || warmupByLang.has(lang)) continue;
      warmupByLang.set(lang, resolve(projectRoot, change.path));
    }

    await Promise.allSettled(
      [...warmupByLang.entries()].map(async ([lang, absPath]) => {
        const client = clients.find((c) => c.language === lang && c.isAlive());
        if (!client) return;
        await client.notifyChanged(absPath);
      }),
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

  pi.on("session_start", async (_event, ctx) => {
    currentCtx = ctx;
    symbolGeneration = 0;
    reindexing = false;
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

  pi.on("session_switch", async (_event, ctx) => {
    currentCtx = ctx;
    if (ctx.cwd === projectRoot) {
      updateStatus(ctx);
      return;
    }

    stopGitHeadTracking();
    await shutdownServers();
    startServers(ctx.cwd);

    if (clients.length > 0) {
      if (ctx.hasUI) {
        ctx.ui.setStatus("lsp", ctx.ui.theme.fg("dim", `LSP: starting ${clients.map((c) => c.name).join(", ")}…`));
      }
      startGitHeadTracking();
    } else {
      updateStatus(ctx);
    }
  });

  pi.on("session_shutdown", () => {
    stopGitHeadTracking();
    projectRoot = "";
    forceShutdownServers();
    currentCtx = null;
    lastGitHead = null;
    reindexing = false;
  });

  // ── Format-on-write ────────────────────────────────────────

  type Formatter = { command: string; args: (file: string) => string[] };

  const PY_FORMATTERS: Record<string, Formatter[]> = {
    ".py": [
      { command: "uvx", args: (f) => ["ruff", "check", "--fix", f] },
      { command: "uvx", args: (f) => ["ruff", "format", f] },
    ],
    ".pyi": [
      { command: "uvx", args: (f) => ["ruff", "check", "--fix", f] },
      { command: "uvx", args: (f) => ["ruff", "format", f] },
    ],
  };

  function detectJsFormatter(): Record<string, Formatter[]> {
    if (!projectRoot) return {};
    const biomeNames = ["biome.json", "biome.jsonc"];
    const prettierNames = [".prettierrc", ".prettierrc.json", ".prettierrc.js", ".prettierrc.cjs", ".prettierrc.mjs", ".prettierrc.yml", ".prettierrc.yaml", ".prettierrc.toml", "prettier.config.js", "prettier.config.cjs", "prettier.config.mjs"];
    const hasBiome = biomeNames.some((n) => existsSync(resolve(projectRoot, n)));
    const hasPrettier = prettierNames.some((n) => existsSync(resolve(projectRoot, n)));

    let fmt: Formatter | null = null;
    if (hasBiome) fmt = { command: "npx", args: (f) => ["@biomejs/biome", "format", "--write", f] };
    else if (hasPrettier) fmt = { command: "npx", args: (f) => ["prettier", "--write", f] };

    if (!fmt) return {};
    const result: Record<string, Formatter[]> = {};
    for (const ext of [".ts", ".tsx", ".js", ".jsx"]) result[ext] = [fmt];
    return result;
  }

  let jsFormatters: Record<string, Formatter[]> | null = null;

  function getFormatters(): Record<string, Formatter[]> {
    if (!jsFormatters) jsFormatters = detectJsFormatter();
    return { ...PY_FORMATTERS, ...jsFormatters };
  }

  function formatFile(absPath: string): boolean {
    const ext = extname(absPath).toLowerCase();
    const formatters = getFormatters()[ext];
    if (!formatters || formatters.length === 0) return false;
    let ok = true;
    for (const formatter of formatters) {
      try {
        execFileSync(formatter.command, formatter.args(absPath), {
          timeout: 10000,
          stdio: "pipe",
        });
      } catch {
        ok = false;
      }
    }
    return ok;
  }

  // ── Auto-diagnostics after edit/write ─────────────────────

  pi.on("tool_result", async (event) => {
    if (event.toolName !== "edit" && event.toolName !== "write") return;
    if (event.isError) return;
    const filePath = (event.input as any)?.path;
    if (!filePath) return;

    const absPath = resolve(projectRoot, filePath);

    // Format-on-write
    const formatted = formatFile(absPath);

    const client = await getClient(filePath, true);
    if (!client) return;

    await client.notifyChanged(absPath);
    await new Promise((r) => setTimeout(r, 2000));

    const errors = client.getErrorDiagnostics(absPath);
    const original = event.content
      .filter((c): c is { type: "text"; text: string } => c.type === "text")
      .map((c) => c.text).join("");

    if (errors.length === 0) {
      return {
        content: [{
          type: "text" as const,
          text: `${original}\n\n✅ No LSP errors from ${client.name}.`,
        }],
      };
    }

    const errorText = errors.map((e) => `  Line ${e.line}: ${e.message}`).join("\n");
    return {
      content: [{
        type: "text" as const,
        text: `${original}\n\n⚠️ LSP Diagnostics (${errors.length} error${errors.length > 1 ? "s" : ""}) from ${client.name}:\n${errorText}\n\nPlease fix these errors.`,
      }],
    };
  });

  // ── Tools ─────────────────────────────────────────────────

  pi.registerTool({
    name: "goto_definition",
    label: "Go to Definition",
    description: "Find the definition of a symbol at a given file position. Returns file path and line number where the symbol is defined. Line is 1-based, character is 0-based.",
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
    description: "Get type errors, warnings, and diagnostics for a file from the LSP server (pyright for Python, tsserver for TypeScript). Note: edit/write tools already report errors automatically — use this only to check files you haven't just modified.",
    parameters: Type.Object({
      path: Type.String({ description: "File path (relative to project root)" }),
    }),
    async execute(_id, params) {
      const filePath = params.path.replace(/^@/, "");
      const client = await getClient(filePath, true);
      if (!client) return { content: [{ type: "text", text: `No LSP server for ${filePath}.` }], isError: true };
      try {
        const absPath = resolve(projectRoot, filePath);
        await client.notifyChanged(absPath);
        await new Promise((r) => setTimeout(r, 2000));
        const diags = client.getDiagnostics(absPath);
        const errors = diags.filter((d) => d.severity === "error").length;
        const warnings = diags.filter((d) => d.severity === "warning").length;
        return { content: [{ type: "text", text: `Diagnostics for ${filePath}: ${errors} error(s), ${warnings} warning(s)\n\n${fmtDiags(diags)}` }], details: { errors, warnings } };
      } catch (e: any) {
        return { content: [{ type: "text", text: `LSP error: ${e.message}` }], isError: true };
      }
    },
  });

  pi.registerTool({
    name: "hover_info",
    label: "Hover Info",
    description: "Get type information and documentation for a symbol at a given position. Useful for checking function signatures and types.",
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
        let root = new Container();
        let items: SelectItem[] = [];
        let selectList: SelectList | null = null;
        let query = "";
        let searching = false;
        let debounceTimer: ReturnType<typeof setTimeout> | null = null;
        let activeQuery = "";

        function rebuild() {
          const c = new Container();
          c.addChild(new DynamicBorder((s: string) => theme.fg("accent", s)));
          c.addChild(new Text(
            theme.fg("accent", theme.bold("# Symbol Search")) + theme.fg("muted", `  ${query || "…"}`),
            1, 0,
          ));

          if (items.length > 0) {
            selectList = new SelectList(items, Math.min(items.length, 15), {
              selectedPrefix: (t) => theme.fg("accent", t),
              selectedText: (t) => theme.fg("accent", t),
              description: (t) => theme.fg("dim", t),
              scrollInfo: (t) => theme.fg("dim", t),
              noMatch: (t) => theme.fg("warning", t),
            });
            selectList.onSelect = (item) => done(item.value);
            selectList.onCancel = () => done(null);
            c.addChild(selectList);
          } else if (searching || reindexing) {
            const msg = reindexing ? "  Indexing after branch change…" : "  Searching…";
            c.addChild(new Text(theme.fg("muted", msg), 0, 0));
          } else if (query.length >= 2) {
            c.addChild(new Text(theme.fg("muted", "  No results"), 0, 0));
          }

          c.addChild(new Text(theme.fg("dim", "type to search • ↑↓ navigate • enter select • esc cancel"), 1, 0));
          c.addChild(new DynamicBorder((s: string) => theme.fg("accent", s)));
          root = c;
        }

        function doSearch() {
          if (query.length < 2) { items = []; searching = false; rebuild(); tui.requestRender(); return; }

          const q = query;
          const searchGeneration = symbolGeneration;
          activeQuery = q;
          searching = true;
          rebuild();
          tui.requestRender();

          const pyClients = getPyClients();
          if (pyClients.length === 0) {
            searching = false;
            items = [];
            rebuild();
            tui.requestRender();
            return;
          }

          Promise.all(pyClients.map((c) => c.workspaceSymbol(q)))
            .then((results) => {
              if (activeQuery !== q) return;
              if (searchGeneration !== symbolGeneration) {
                searching = false;
                items = [];
                rebuild();
                tui.requestRender();
                return;
              }

              const symbols = rankSymbols(results.flat(), q);
              items = symbols.map((s) => {
                const rel = s.file.startsWith(projectRoot) ? relative(projectRoot, s.file) : s.file;
                const suffix = s.containerName ? ` (${s.containerName})` : "";
                return {
                  value: `${rel}:${s.line}:${s.character}`,
                  // Keep results on a single label line.
                  // This avoids SelectList's label+description width bug with wide chars (e.g. Korean).
                  label: `${s.name}${suffix}  ${s.kind}  ${rel}:${s.line}`,
                };
              });
              searching = false;
              rebuild();
              tui.requestRender();
            })
            .catch(() => {
              if (activeQuery !== q) return;
              searching = false;
              items = [];
              rebuild();
              tui.requestRender();
            });
        }

        rebuild();

        return {
          render: (w) => root.render(w),
          invalidate: () => root.invalidate(),
          handleInput: (data) => {
            if (data === "\x1b") { done(null); return; }
            if (selectList && items.length > 0 && (data === "\r" || data === "\x1b[A" || data === "\x1b[B")) {
              selectList.handleInput(data);
              tui.requestRender();
              return;
            }
            if (data === "\x7f") {
              query = query.slice(0, -1);
            } else if (data.length === 1 && data >= " ") {
              query += data;
            } else if (selectList) {
              selectList.handleInput(data);
              tui.requestRender();
              return;
            }
            if (debounceTimer) clearTimeout(debounceTimer);
            debounceTimer = setTimeout(doSearch, 200);
            items = [];
            selectList = null;
            rebuild();
            tui.requestRender();
          },
        };
      }, { overlay: true });

      if (result) {
        const [file, line] = result.split(":");
        const text = `${file}:${line}`;
        ctx.ui.pasteToEditor(text);
      }
    },
  });
}
