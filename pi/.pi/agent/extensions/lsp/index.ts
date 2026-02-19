import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import {
  DynamicBorder,
  truncateHead,
  DEFAULT_MAX_BYTES,
  DEFAULT_MAX_LINES,
} from "@mariozechner/pi-coding-agent";
import { Container, SelectList, Text, type SelectItem } from "@mariozechner/pi-tui";
import { Type } from "@sinclair/typebox";
import { resolve, extname, relative } from "node:path";
import { LSPClient, type Diagnostic, type Location, type WorkspaceSymbol } from "./client.js";
import { detectServers } from "./servers.js";

const TS_EXTS = new Set([".ts", ".tsx", ".js", ".jsx"]);
const PY_EXTS = new Set([".py"]);

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

export default function (pi: ExtensionAPI) {
  let clients: LSPClient[] = [];
  let projectRoot = "";
  let initPromise: Promise<void> | null = null;

  async function getClient(filePath: string): Promise<LSPClient | null> {
    const lang = getLanguage(filePath);
    if (!lang) return null;
    if (initPromise) await initPromise;
    return clients.find((c) => c.language === lang && c.isAlive()) ?? null;
  }

  function startServers(cwd: string) {
    projectRoot = cwd;
    const configs = detectServers(projectRoot);
    if (configs.length === 0) { initPromise = Promise.resolve(); return; }

    clients = configs.map((config) => {
      const wsRoot = config.workspaceSubdir ? resolve(projectRoot, config.workspaceSubdir) : projectRoot;
      return new LSPClient(config.name, config.command, config.args, wsRoot, config.language, config.env);
    });
    initPromise = (async () => {
      await Promise.allSettled(clients.map(async (c) => {
        try { await c.waitReady(); }
        catch (e) { console.error(`[lsp] ${c.name} failed: ${e}`); }
      }));
    })();
  }

  // ── Lifecycle ──────────────────────────────────────────────

  pi.on("session_start", async (_event, ctx) => {
    startServers(ctx.cwd);
    initPromise?.then(() => {
      const alive = clients.filter((c) => c.isAlive());
      if (alive.length > 0) {
        ctx.ui.setStatus("lsp", ctx.ui.theme.fg("dim", `LSP: ${alive.map((c) => c.name).join(", ")}`));
      }
    });
  });

  pi.on("session_shutdown", async () => {
    await Promise.allSettled(clients.map((c) => c.shutdown()));
    clients = [];
    initPromise = null;
  });

  // ── Auto-diagnostics after edit/write ─────────────────────

  pi.on("tool_result", async (event) => {
    if (event.toolName !== "edit" && event.toolName !== "write") return;
    const filePath = (event.input as any)?.path;
    if (!filePath) return;
    const client = await getClient(filePath);
    if (!client) return;

    const absPath = resolve(projectRoot, filePath);
    await client.notifyChanged(absPath);
    await new Promise((r) => setTimeout(r, 2000));

    const errors = client.getErrorDiagnostics(absPath);
    if (errors.length === 0) return;

    const errorText = errors.map((e) => `  Line ${e.line}: ${e.message}`).join("\n");
    const original = event.content
      .filter((c): c is { type: "text"; text: string } => c.type === "text")
      .map((c) => c.text).join("");

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
    description: "Get type errors, warnings, and diagnostics for a file from the LSP server (pyrefly for Python, tsserver for TypeScript).",
    parameters: Type.Object({
      path: Type.String({ description: "File path (relative to project root)" }),
    }),
    async execute(_id, params) {
      const filePath = params.path.replace(/^@/, "");
      const client = await getClient(filePath);
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
      ctx.ui.notify(clients.map((c) => `${c.name}: ${c.isAlive() ? "✅ running" : "❌ dead"}`).join("\n"), "info");
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

      // Custom shortcuts are handled before normal text input.
      // If '#' is typed in the middle of a token, insert it as plain text.
      const existingText = ctx.ui.getEditorText();
      const prevChar = existingText.slice(-1);
      if (existingText.length > 0 && !/\s/.test(prevChar)) {
        ctx.ui.setEditorText(existingText + "#");
        return;
      }

      if (initPromise) await initPromise;

      const pyClients = clients.filter((c) => c.language === "python" && c.isAlive());
      if (pyClients.length === 0) { ctx.ui.notify("No Python LSP running", "warning"); return; }

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
          } else if (searching) {
            c.addChild(new Text(theme.fg("muted", "  Searching…"), 0, 0));
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
          activeQuery = q;
          searching = true;
          rebuild();
          tui.requestRender();

          Promise.all(pyClients.map((c) => c.workspaceSymbol(q)))
            .then((results) => {
              if (activeQuery !== q) return;
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
      });

      if (result) {
        const [file, line] = result.split(":");
        const text = `${file}:${line}`;
        await new Promise((r) => setTimeout(r, 50));
        // setEditorText replaces all content — append to existing text instead
        const existing = ctx.ui.getEditorText();
        ctx.ui.setEditorText(existing + text);
      }
    },
  });
}
