import { DynamicBorder, type ExtensionAPI } from "@mariozechner/pi-coding-agent";
import {
  Input,
  Key,
  SelectList,
  matchesKey,
  truncateToWidth,
  visibleWidth,
  type Component,
  type Focusable,
  type SelectItem,
} from "@mariozechner/pi-tui";
import { readFile } from "node:fs/promises";
import { basename, extname, relative } from "node:path";
import type { Diagnostic, LspLocation, WorkspaceSymbol } from "./client.js";
import { LspManager, type ManagedLspServer, type ReadyLspServer } from "./manager.js";
import { formatCommand, formatRoot } from "./servers.js";

const manager = new LspManager();
const MAX_DIAGNOSTICS_PER_FILE = 20;
const SYMBOL_PICKER_LIMIT = 50;

const searchSymbolsParameters = {
  type: "object",
  properties: {
    query: {
      type: "string",
      description: "Python symbol name to search with ty LSP. Partial matches work best.",
    },
    kind: {
      type: "string",
      description: "Optional symbol kind filter, e.g. Class, Function, Method, Variable.",
    },
    limit: {
      type: "number",
      description: "Maximum number of results to return (default 20, max 100).",
    },
  },
  required: ["query"],
  additionalProperties: false,
} as const;

const navigationPositionParameters = {
  type: "object",
  properties: {
    path: {
      type: "string",
      description: "Python file path. Relative paths are resolved against the current workspace.",
    },
    line: {
      type: "number",
      description: "1-based line number.",
    },
    character: {
      type: "number",
      description: "0-based character/column number.",
    },
  },
  required: ["path", "line", "character"],
  additionalProperties: false,
} as const;

const findReferencesParameters = {
  type: "object",
  properties: {
    ...navigationPositionParameters.properties,
    includeDeclaration: {
      type: "boolean",
      description: "Include the symbol declaration in results (default true).",
    },
    limit: {
      type: "number",
      description: "Maximum number of references to return (default 50, max 200).",
    },
  },
  required: ["path", "line", "character"],
  additionalProperties: false,
} as const;

function shortenHome(filePath: string): string {
  const home = process.env.HOME || process.env.USERPROFILE;
  return home && filePath.startsWith(home) ? `~${filePath.slice(home.length)}` : filePath;
}

function stateIcon(server: ManagedLspServer): string {
  if (server.state === "ready") return "✅";
  if (server.state === "starting") return "⏳";
  if (server.state === "failed") return "❌";
  if (server.state === "dead") return "☠";
  return "—";
}

function stateText(server: ManagedLspServer): string {
  if (server.state === "skipped") return `skipped: ${server.spec.skipReason ?? "not applicable"}`;
  if (server.state === "failed") return `failed: ${server.client?.getError() ?? "unknown error"}`;
  return server.state;
}

function commandText(server: ManagedLspServer): string {
  const command = server.client?.getCommand() ?? server.spec.command;
  if (!command) return "";
  return `${command.source}: ${formatCommand(command)}`;
}

function renderServerLine(server: ManagedLspServer, projectRoot: string): string {
  const roles = server.spec.roles.join(", ");
  const root = formatRoot(projectRoot, server.spec.workspaceRoot);
  const details = [stateText(server), roles, root !== "." ? `root ${root}` : "", commandText(server)]
    .filter(Boolean)
    .join(" • ");

  return `  ${stateIcon(server)} ${server.spec.displayName.padEnd(14)} ${details}`;
}

function renderStatusLines(width: number, theme: any): string[] {
  const snapshot = manager.snapshot();
  const lines: string[] = [];

  lines.push(theme.fg("accent", theme.bold("LSP status")));
  lines.push(theme.fg("dim", shortenHome(snapshot.projectRoot || process.cwd())));
  lines.push("");

  for (const server of snapshot.servers) {
    const line = renderServerLine(server, snapshot.projectRoot);
    const color = server.state === "failed" ? "error" : server.state === "ready" ? "success" : "dim";
    lines.push(theme.fg(color, truncateToWidth(line, width - 2, "...")));
  }

  lines.push("");
  lines.push(theme.fg("dim", "q/esc/enter close"));
  return lines.map((line) => truncateToWidth(line, width, "..."));
}

async function showStatusModal(ctx: any): Promise<void> {
  if (!ctx.hasUI) return;

  let requestRender = () => {};
  const unsubscribe = manager.onChange(() => requestRender());

  await ctx.ui.custom<void>((tui: any, theme: any, _keybindings: any, done: (value: void) => void) => {
    requestRender = () => tui.requestRender();

    const component: Component = {
      render(width: number): string[] {
        const innerWidth = Math.max(20, width - 4);
        const body = renderStatusLines(innerWidth, theme);
        const border = theme.fg("dim", "─".repeat(Math.max(1, innerWidth)));
        return [border, ...body.map((line) => `  ${line}`), border];
      },
      invalidate() {},
      handleInput(data: string) {
        if (data === "q" || matchesKey(data, Key.escape) || matchesKey(data, Key.enter) || matchesKey(data, Key.ctrl("c"))) {
          done(undefined);
        }
      },
    };

    return component;
  }, { overlay: true });

  unsubscribe();
}

function dedupeDiagnostics(items: Diagnostic[]): Diagnostic[] {
  const seen = new Set<string>();
  return items.filter((item) => {
    const key = JSON.stringify({
      file: item.file,
      line: item.line,
      character: item.character,
      endLine: item.endLine,
      endCharacter: item.endCharacter,
      severity: item.severity,
      source: item.source,
      message: item.message,
    });
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function formatDiagnostic(diagnostic: Diagnostic): string {
  const label = diagnostic.severity.toUpperCase();
  const column = diagnostic.character + 1;
  const source = diagnostic.source ? ` (${diagnostic.source})` : "";
  return `${label} [${diagnostic.line}:${column}] ${diagnostic.message}${source}`;
}

function renderDiagnosticsBlock(filePath: string, diagnostics: Diagnostic[]): string {
  const errors = dedupeDiagnostics(diagnostics).filter((diagnostic) => diagnostic.severity === "error");
  if (errors.length === 0) return "";

  const shown = errors.slice(0, MAX_DIAGNOSTICS_PER_FILE);
  const more = errors.length - shown.length;
  const suffix = more > 0 ? `\n... and ${more} more` : "";
  return `<diagnostics file="${filePath}">\n${shown.map(formatDiagnostic).join("\n")}${suffix}\n</diagnostics>`;
}

function projectRelative(filePath: string): string {
  const root = manager.snapshot().projectRoot;
  if (!root) return filePath;
  const rel = relative(root, filePath);
  return rel && !rel.startsWith("..") ? rel.replace(/\\/g, "/") : filePath;
}

function takeEndToWidth(text: string, maxWidth: number): string {
  let result = "";
  for (const char of Array.from(text).reverse()) {
    if (visibleWidth(char + result) > maxWidth) break;
    result = char + result;
  }
  return result;
}

function truncateStartToWidth(text: string, maxWidth: number): string {
  if (maxWidth <= 0) return "";
  if (visibleWidth(text) <= maxWidth) return text;
  if (maxWidth === 1) return "…";
  return `…${takeEndToWidth(text, maxWidth - 1)}`;
}

function truncateSymbolRow(text: string, maxWidth: number): string {
  if (visibleWidth(text) <= maxWidth) return text;

  const separator = "  ";
  const pathStart = text.lastIndexOf(separator);
  if (pathStart === -1 || maxWidth < 24) return truncateStartToWidth(text, maxWidth);

  const prefix = text.slice(0, pathStart + separator.length);
  const pathPart = text.slice(pathStart + separator.length);
  const prefixWidth = visibleWidth(prefix);

  if (prefixWidth + 16 <= maxWidth) {
    return `${prefix}${truncateStartToWidth(pathPart, maxWidth - prefixWidth)}`;
  }

  const pathWidth = Math.max(16, Math.min(48, Math.floor(maxWidth * 0.5)));
  const prefixWidthLimit = Math.max(1, maxWidth - pathWidth);
  return `${truncateToWidth(prefix, prefixWidthLimit, "")}${truncateStartToWidth(pathPart, pathWidth)}`;
}

function rankSymbols(symbols: WorkspaceSymbol[], query: string): WorkspaceSymbol[] {
  const q = query.trim().toLowerCase();
  const seen = new Set<string>();

  function score(symbol: WorkspaceSymbol): number {
    const name = symbol.name.toLowerCase();
    if (name === q) return 0;
    if (name.startsWith(q)) return 1;
    if (name.includes(q)) return 2;
    return 3;
  }

  return symbols
    .filter((symbol) => {
      const key = `${symbol.name}:${symbol.file}:${symbol.line}:${symbol.character}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .sort((a, b) => score(a) - score(b) || a.name.length - b.name.length || a.name.localeCompare(b.name));
}

async function searchTySymbols(query: string, options: { kind?: string; limit?: number } = {}): Promise<WorkspaceSymbol[]> {
  const ty = manager.getReadyServer("ty");
  if (!ty) throw new Error("ty LSP is not ready");

  const rawSymbols = await ty.client.workspaceSymbol(query);
  const kind = options.kind?.trim().toLowerCase();
  const filtered = kind
    ? rawSymbols.filter((symbol) => symbol.kind.toLowerCase() === kind)
    : rawSymbols;
  const limit = Math.max(1, Math.min(100, Math.floor(options.limit ?? 20)));
  return rankSymbols(filtered, query).slice(0, limit);
}

function formatSymbol(symbol: WorkspaceSymbol): string {
  const container = symbol.containerName ? ` [${symbol.containerName}]` : "";
  return `${symbol.name}  ${symbol.kind}  ${projectRelative(symbol.file)}:${symbol.line}:${symbol.character}${container}`;
}

function formatLocation(location: LspLocation): string {
  return `${projectRelative(location.file)}:${location.line}:${location.character}`;
}

async function formatLocationWithPreview(location: LspLocation, cache: Map<string, Promise<string[]>>): Promise<string> {
  const base = formatLocation(location);
  if (isSensitivePath(location.file)) return base;

  try {
    let linesPromise = cache.get(location.file);
    if (!linesPromise) {
      linesPromise = readFile(location.file, "utf8").then((text) => text.split(/\r\n|\r|\n/));
      cache.set(location.file, linesPromise);
    }

    const lines = await linesPromise;
    const preview = lines[location.line - 1]?.trimEnd();
    if (!preview) return base;
    return `${base}  ${truncateToWidth(preview.trimStart(), 160, "...")}`;
  } catch {
    return base;
  }
}

async function formatLocationsWithPreview(locations: LspLocation[]): Promise<string[]> {
  const cache = new Map<string, Promise<string[]>>();
  return Promise.all(locations.map((location) => formatLocationWithPreview(location, cache)));
}

function isSensitivePath(filePath: string): boolean {
  const name = basename(filePath);
  return name === ".env" || name.startsWith(".env.") || filePath.replace(/\\/g, "/").endsWith("agent/auth.json");
}

function getReadyTyNavigationServer(filePath: string): ReadyLspServer {
  const stripped = filePath.replace(/^@/, "");
  const ext = extname(stripped).toLowerCase();
  if (ext !== ".py" && ext !== ".pyi") throw new Error("ty navigation only supports Python files (.py, .pyi)");
  if (isSensitivePath(stripped)) throw new Error("refusing to inspect a sensitive path");

  const server = manager.getReadyServersForFile(stripped)
    .find((server) => server.spec.id === "ty" && server.spec.roles.includes("navigation"));
  if (!server) throw new Error("ty LSP navigation is not ready for this file");
  return server;
}

function parsePositiveInteger(value: number, name: string): number {
  if (!Number.isFinite(value)) throw new Error(`${name} must be a number`);
  const parsed = Math.floor(value);
  if (parsed < 1) throw new Error(`${name} must be >= 1`);
  return parsed;
}

function parseNonNegativeInteger(value: number, name: string): number {
  if (!Number.isFinite(value)) throw new Error(`${name} must be a number`);
  const parsed = Math.floor(value);
  if (parsed < 0) throw new Error(`${name} must be >= 0`);
  return parsed;
}

function clampReferencesLimit(limit: number | undefined): number {
  if (!Number.isFinite(limit)) return 50;
  return Math.max(1, Math.min(200, Math.floor(limit!)));
}

async function runFormatters(servers: ReadyLspServer[]): Promise<string[]> {
  const applied: string[] = [];

  for (const server of servers) {
    try {
      if (await server.client.formatDocument(server.absolutePath)) {
        applied.push(server.spec.displayName);
      }
    } catch {
      // Formatting is best-effort. Diagnostics still run below.
    }
  }

  return applied;
}

async function collectDiagnostics(servers: ReadyLspServer[]): Promise<Diagnostic[]> {
  const results = await Promise.all(
    servers.map(async (server) => {
      try {
        return await server.client.collectDiagnostics(server.absolutePath, "document");
      } catch {
        return [];
      }
    }),
  );

  return dedupeDiagnostics(results.flat());
}

async function postWriteLspMessage(filePath: string): Promise<string> {
  const formatters = manager.getReadyFormattersForFile(filePath);
  const diagnosticsServers = manager.getReadyDiagnosticsServersForFile(filePath);

  if (formatters.length === 0 && diagnosticsServers.length === 0) return "";

  const formattedBy = await runFormatters(formatters);
  const diagnostics = await collectDiagnostics(diagnosticsServers);
  const diagnosticsBlock = renderDiagnosticsBlock(filePath, diagnostics);
  const parts: string[] = [];

  if (formattedBy.length > 0) {
    parts.push(`LSP formatted this file with ${formattedBy.join(", ")}.`);
    parts.push("The file changed after the tool call. Read it before relying on exact text matches.");
  }

  if (diagnosticsBlock) {
    parts.push(`LSP errors detected in this file. Fix them before finishing:\n${diagnosticsBlock}`);
  }

  return parts.length > 0 ? parts.join("\n") : "";
}

async function showPythonSymbolPicker(ctx: any): Promise<void> {
  if (!ctx.hasUI) return;

  if (!manager.getReadyServer("ty")) {
    ctx.ui.notify("ty LSP is not ready", "warning");
    return;
  }

  await ctx.ui.custom<string | null>((tui: any, theme: any, _keybindings: any, done: (value: string | null) => void) => {
    const rows = tui.terminal?.rows || 24;
    const overlayRows = Math.max(10, Math.floor(rows * 0.8));
    const maxVisible = Math.min(30, Math.max(5, overlayRows - 8));
    const borderTop = new DynamicBorder((text: string) => theme.fg("accent", text));
    const borderBottom = new DynamicBorder((text: string) => theme.fg("accent", text));
    const input = new Input();
    const listTheme = {
      selectedPrefix: (text: string) => theme.fg("accent", text),
      selectedText: (text: string) => theme.fg("accent", text),
      description: (text: string) => theme.fg("dim", text),
      scrollInfo: (text: string) => theme.fg("dim", text),
      noMatch: () => theme.fg("warning", "  No symbols"),
    };
    const listLayout = {
      minPrimaryColumnWidth: 40,
      maxPrimaryColumnWidth: 200,
      truncatePrimary: ({ text, maxWidth }: { text: string; maxWidth: number }) => truncateSymbolRow(text, maxWidth),
    };

    let focused = false;
    let lastQuery = "";
    let searching = false;
    let items: SelectItem[] = [];
    let selectList = new SelectList(items, maxVisible, listTheme, listLayout);
    let debounceTimer: ReturnType<typeof setTimeout> | undefined;

    function rebuildList() {
      selectList = new SelectList(items, maxVisible, listTheme, listLayout);
    }

    function queueSearch() {
      if (debounceTimer) clearTimeout(debounceTimer);
      debounceTimer = setTimeout(async () => {
        const query = input.getValue().trim();
        if (query.length < 2) {
          items = [];
          searching = false;
          rebuildList();
          tui.requestRender();
          return;
        }

        searching = true;
        tui.requestRender();
        try {
          const symbols = await searchTySymbols(query, { limit: SYMBOL_PICKER_LIMIT });
          if (input.getValue().trim() !== query) return;
          items = symbols.map((symbol) => ({
            value: `${projectRelative(symbol.file)}:${symbol.line}:${symbol.character}`,
            label: `${symbol.name}${symbol.containerName ? ` (${symbol.containerName})` : ""}  ${symbol.kind}  ${projectRelative(symbol.file)}:${symbol.line}:${symbol.character}`,
          }));
        } catch {
          items = [];
        } finally {
          searching = false;
          rebuildList();
          tui.requestRender();
        }
      }, 200);
      debounceTimer.unref?.();
    }

    const component: Component & Focusable = {
      get focused() { return focused; },
      set focused(value: boolean) { focused = value; input.focused = value; },

      render(width: number): string[] {
        const query = input.getValue();
        const status = searching
          ? theme.fg("dim", " searching")
          : query.length < 2
            ? theme.fg("dim", " type 2+ chars")
            : theme.fg("dim", ` ${items.length} results`);
        const divider = theme.fg("dim", " " + "─".repeat(Math.max(1, width - 2)));
        const lines = [
          ...borderTop.render(width),
          ` ${theme.fg("accent", theme.bold("Python symbols"))}${status} ${theme.fg("dim", "ty")}`,
          "",
          ...input.render(width - 2).map((line: string) => ` ${line}`),
          divider,
        ];

        if (items.length > 0) lines.push(...selectList.render(width));
        else if (searching) lines.push(theme.fg("muted", "  Searching…"));
        else if (query.length >= 2) lines.push(theme.fg("warning", "  No symbols"));

        lines.push("");
        lines.push(theme.fg("dim", " ↑↓ navigate  enter select  esc cancel"));
        lines.push(...borderBottom.render(width));
        return lines;
      },

      invalidate() {
        borderTop.invalidate();
        borderBottom.invalidate();
        input.invalidate();
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
        if (matchesKey(data, Key.up) || matchesKey(data, Key.down) || matchesKey(data, Key.pageUp) || matchesKey(data, Key.pageDown)) {
          selectList.handleInput(data);
          tui.requestRender();
          return;
        }

        input.handleInput(data);
        const query = input.getValue();
        if (query !== lastQuery) {
          lastQuery = query;
          queueSearch();
        }
        tui.requestRender();
      },
    };

    return component;
  }, {
    overlay: true,
    overlayOptions: {
      anchor: "center",
      width: "80%",
      minWidth: 40,
      maxHeight: "80%",
      margin: 2,
    },
  }).then((result: string | null | undefined) => {
    if (result) ctx.ui.pasteToEditor(result);
  });
}

export default function (pi: ExtensionAPI) {
  pi.registerTool({
    name: "search_symbols",
    label: "Search Symbols",
    description: "Search Python workspace symbols using ty LSP. Returns compact symbol name, kind, and file:line locations.",
    promptSnippet: "Search Python symbols with ty LSP before reading files when you need functions, classes, methods, or variables by name.",
    promptGuidelines: [
      "Use search_symbols for Python symbol names before reading files when the exact file is unknown.",
      "Use grep instead of search_symbols when searching arbitrary file contents.",
    ],
    parameters: searchSymbolsParameters,
    async execute(_toolCallId, params: { query: string; kind?: string; limit?: number }) {
      const query = params.query.trim();
      if (!query) {
        return { content: [{ type: "text", text: "query must not be empty" }], details: {} };
      }

      try {
        const symbols = await searchTySymbols(query, { kind: params.kind, limit: params.limit });
        if (symbols.length === 0) {
          const kindText = params.kind ? ` of kind ${params.kind}` : "";
          return { content: [{ type: "text", text: `No Python symbols${kindText} matching "${query}".` }], details: { total: 0 } };
        }

        const lines = symbols.map(formatSymbol);
        return {
          content: [{ type: "text", text: `${symbols.length} Python symbol(s) matching "${query}":\n${lines.join("\n")}` }],
          details: { total: symbols.length },
        };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return { content: [{ type: "text", text: `search_symbols failed: ${message}` }], details: {}, isError: true };
      }
    },
  });

  pi.registerTool({
    name: "goto_definition",
    label: "Goto Definition",
    description: "Find Python definitions for a symbol at a file position using ty LSP.",
    promptSnippet: "Use goto_definition for Python code when you have a file position and need the defining location.",
    promptGuidelines: [
      "Use search_symbols first when you only know a symbol name.",
      "Use goto_definition when you already have a Python file:line:character location.",
    ],
    parameters: navigationPositionParameters,
    async execute(_toolCallId, params: { path: string; line: number; character: number }) {
      try {
        const server = getReadyTyNavigationServer(params.path);
        const line = parsePositiveInteger(params.line, "line");
        const character = parseNonNegativeInteger(params.character, "character");
        const locations = await server.client.gotoDefinition(server.absolutePath, line, character);

        if (locations.length === 0) {
          return { content: [{ type: "text", text: "No definition found." }], details: { total: 0 } };
        }

        const lines = await formatLocationsWithPreview(locations);
        return {
          content: [{ type: "text", text: `${locations.length} definition location(s):\n${lines.join("\n")}` }],
          details: { total: locations.length },
        };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return { content: [{ type: "text", text: `goto_definition failed: ${message}` }], details: {}, isError: true };
      }
    },
  });

  pi.registerTool({
    name: "find_references",
    label: "Find References",
    description: "Find Python references for a symbol at a file position using ty LSP.",
    promptSnippet: "Use find_references for Python code when you need usages of a symbol from a file position.",
    promptGuidelines: [
      "Use search_symbols first when you only know a symbol name.",
      "Use find_references when you already have a Python file:line:character location.",
    ],
    parameters: findReferencesParameters,
    async execute(_toolCallId, params: { path: string; line: number; character: number; includeDeclaration?: boolean; limit?: number }) {
      try {
        const server = getReadyTyNavigationServer(params.path);
        const line = parsePositiveInteger(params.line, "line");
        const character = parseNonNegativeInteger(params.character, "character");
        const limit = clampReferencesLimit(params.limit);
        const locations = await server.client.findReferences(server.absolutePath, line, character, params.includeDeclaration !== false);
        const shown = locations.slice(0, limit);
        const more = locations.length - shown.length;
        const suffix = more > 0 ? `\n... and ${more} more` : "";

        if (locations.length === 0) {
          return { content: [{ type: "text", text: "No references found." }], details: { total: 0 } };
        }

        const lines = await formatLocationsWithPreview(shown);
        return {
          content: [{ type: "text", text: `${locations.length} reference location(s):\n${lines.join("\n")}${suffix}` }],
          details: { total: locations.length, shown: shown.length },
        };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return { content: [{ type: "text", text: `find_references failed: ${message}` }], details: {}, isError: true };
      }
    },
  });

  pi.registerShortcut("#", {
    description: "Search Python symbols with ty",
    handler: async (ctx) => {
      await showPythonSymbolPicker(ctx);
    },
  });

  pi.on("session_start", (_event, ctx) => {
    manager.start(ctx.cwd);
  });

  pi.on("session_shutdown", () => {
    manager.shutdownNow();
  });

  pi.on("tool_result", async (event) => {
    if (event.toolName !== "edit" && event.toolName !== "write") return;
    if (event.isError) return;

    const filePath = (event.input as { path?: unknown })?.path;
    if (typeof filePath !== "string" || !filePath.trim()) return;

    const message = await postWriteLspMessage(filePath.replace(/^@/, ""));
    if (!message) return;

    return {
      content: [
        ...event.content,
        { type: "text" as const, text: `\n\n${message}` },
      ],
    };
  });

  pi.registerCommand("lsp", {
    description: "Manage LSP servers. Usage: /lsp status",
    handler: async (args, ctx) => {
      const subcommand = (args ?? "").trim() || "status";

      if (subcommand === "status") {
        await showStatusModal(ctx);
        return;
      }

      ctx.ui.notify(`Unknown /lsp command: ${subcommand}\nUsage: /lsp status`, "warning");
    },
  });
}
