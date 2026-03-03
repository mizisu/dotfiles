import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import { Text } from "@mariozechner/pi-tui";
import { spawn, ChildProcess } from "node:child_process";
import { createInterface, Interface } from "node:readline";
import * as path from "node:path";
import * as fs from "node:fs";

export default function (pi: ExtensionAPI) {
  const engineDir = path.join(__dirname, "engine");
  const venvDir = path.join(engineDir, ".venv");
  const pythonPath = path.join(venvDir, "bin", "python");
  const requirementsPath = path.join(engineDir, "requirements.txt");
  const indexerScript = path.join(engineDir, "indexer.py");
  const serverScript = path.join(engineDir, "server.py");

  function dbPath(cwd: string): string {
    return path.join(cwd, ".pi", "index", "code_search.db");
  }

  function isIndexBuilt(cwd: string): boolean {
    return fs.existsSync(dbPath(cwd));
  }

  // ── Venv setup ──

  async function ensureVenv(ctx: any): Promise<boolean> {
    if (fs.existsSync(pythonPath)) return true;

    ctx.ui.notify("🔧 Setting up code search (first time, may take a few minutes)...", "info");

    let res = await pi.exec("uv", ["venv", venvDir, "--python", "3.14"], { timeout: 60_000 });
    if (res.code !== 0) {
      res = await pi.exec("python3", ["-m", "venv", venvDir], { timeout: 60_000 });
    }
    if (res.code !== 0) {
      ctx.ui.notify(`Failed to create venv: ${res.stderr}`, "error");
      return false;
    }

    ctx.ui.notify("📦 Installing dependencies (torch + sentence-transformers)...", "info");
    res = await pi.exec("uv", ["pip", "install", "-r", requirementsPath, "--python", pythonPath], { timeout: 600_000 });
    if (res.code !== 0) {
      ctx.ui.notify(`Failed to install deps: ${res.stderr}`, "error");
      return false;
    }

    ctx.ui.notify("✅ Code search engine ready!", "success");
    return true;
  }

  // ── Persistent search server ──

  let _server: {
    proc: ChildProcess;
    rl: Interface;
    queue: Array<{ resolve: (v: any) => void; reject: (e: Error) => void }>;
  } | null = null;
  let _starting: Promise<void> | null = null;

  function startServer(): Promise<void> {
    // Already running
    if (_server && !_server.proc.killed) return Promise.resolve();
    // Already starting
    if (_starting) return _starting;

    _starting = new Promise<void>((resolve, reject) => {
      const proc = spawn(pythonPath, [serverScript], {
        stdio: ["pipe", "pipe", "pipe"],
        cwd: engineDir,
      });

      const queue: typeof _server extends null ? never : NonNullable<typeof _server>["queue"] = [];
      const rl = createInterface({ input: proc.stdout! });
      _server = { proc, rl, queue };

      rl.on("line", (line) => {
        let data: any;
        try {
          data = JSON.parse(line);
        } catch {
          return; // skip non-JSON (model loading logs etc.)
        }
        if (data.status === "loading") return;
        if (data.status === "ready") {
          resolve();
          return;
        }
        const pending = queue.shift();
        if (pending) pending.resolve(data);
      });

      proc.on("exit", () => {
        while (queue.length) {
          queue.shift()!.reject(new Error("Search server exited"));
        }
        _server = null;
        _starting = null;
      });

      proc.on("error", (err) => {
        _server = null;
        _starting = null;
        reject(err);
      });

      // 60s timeout for model loading
      setTimeout(() => {
        if (_starting === null) return; // already resolved
        reject(new Error("Server startup timeout (60s)"));
      }, 60_000);
    });

    return _starting;
  }

  async function serverQuery(req: any, timeoutMs = 30_000): Promise<any> {
    await startServer();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new Error("Search request timeout"));
      }, timeoutMs);
      _server!.queue.push({
        resolve: (data) => { clearTimeout(timer); resolve(data); },
        reject: (err) => { clearTimeout(timer); reject(err); },
      });
      _server!.proc.stdin!.write(JSON.stringify(req) + "\n");
    });
  }

  function stopServer() {
    if (_server && !_server.proc.killed) {
      try {
        _server.proc.stdin!.write('{"action":"quit"}\n');
      } catch { /* ignore */ }
      const proc = _server.proc;
      setTimeout(() => { try { proc.kill(); } catch { /* ignore */ } }, 3000);
    }
    _server = null;
    _starting = null;
  }

  // Cleanup on process exit
  process.on("exit", stopServer);

  // ── Session lifecycle ──

  pi.on("session_start", async (_event, ctx) => {
  });

  // ── code_search tool ──

  pi.registerTool({
    name: "code_search",
    label: "Code Search",
    description: [
      "Semantic code search across the codebase using vector embeddings (CodeRankEmbed).",
      "Returns the most relevant code chunks matching a natural language query.",
      "Use this FIRST to locate relevant code before reading full files.",
      "Results include file paths and line numbers — pass them to the read tool.",
    ].join("\n"),
    parameters: Type.Object({
      query: Type.String({ description: "Natural language description of the code to find" }),
      top_k: Type.Optional(Type.Number({ description: "Number of results (default 10, max 30)" })),
      path_filter: Type.Optional(Type.String({ description: "Path prefix filter, e.g. 'lemonbase/review/'" })),
      language: Type.Optional(Type.String({ description: 'Filter: python | typescript | tsx' })),
    }),

    async execute(toolCallId, params, signal, onUpdate, ctx) {
      if (!fs.existsSync(pythonPath)) {
        if (!(await ensureVenv(ctx))) {
          return { content: [{ type: "text", text: "Code search not set up. Run /reindex" }], isError: true, details: {} };
        }
      }
      if (!isIndexBuilt(ctx.cwd)) {
        return { content: [{ type: "text", text: "Index not built. Run /reindex first." }], isError: true, details: {} };
      }

      try {
        const result = await serverQuery({
          action: "search",
          db_path: dbPath(ctx.cwd),
          query: params.query,
          top_k: Math.min(params.top_k ?? 10, 30),
          path_filter: params.path_filter,
          language: params.language,
        });

        if (result.error) {
          return { content: [{ type: "text", text: result.error }], isError: true, details: {} };
        }

        // Detect no-results and provide actionable hints
        const text: string = result.text;
        const wordCount = params.query.split(/\s+/).length;

        if (text.startsWith("No results found")) {
          const hints: string[] = [];
          if (params.language) {
            hints.push(`Try removing the language filter (currently "${params.language}") — the symbol may exist in another language.`);
          }
          if (wordCount > 4) {
            hints.push("Try a shorter query (2-4 keywords). Use actual code identifiers, not descriptions.");
          }
          hints.push("Consider using search_symbols or rg instead.");
          const hintText = "\nHints:\n- " + hints.join("\n- ");
          return { content: [{ type: "text", text: text + hintText }], details: {} };
        }

        // Warn about long queries even when results are found (scores likely suffer)
        const longQueryHint = wordCount > 5
          ? `\n(Note: query has ${wordCount} words. Shorter queries (2-4 words) produce better relevance scores.)`
          : "";

        return { content: [{ type: "text", text: text + longQueryHint }], details: {} };
      } catch (e: any) {
        return { content: [{ type: "text", text: `Search error: ${e.message}` }], isError: true, details: {} };
      }
    },

    renderCall(args: any, theme: any) {
      let t = theme.fg("toolTitle", theme.bold("code_search "));
      t += theme.fg("muted", `"${args.query}"`);
      if (args.path_filter) t += theme.fg("dim", ` in ${args.path_filter}`);
      if (args.language) t += theme.fg("dim", ` [${args.language}]`);
      return new Text(t, 0, 0);
    },
  });

  // ── /reindex command (ctags + vector) ──

  const CTAGS_BIN = "/opt/homebrew/bin/ctags";

  async function buildCtags(cwd: string): Promise<{ ok: boolean; count: number }> {
    const isGit = fs.existsSync(path.join(cwd, ".git"));
    const cmd = isGit
      ? `git ls-files --cached --others --exclude-standard | "${CTAGS_BIN}" --output-format=json --fields=+nKS -L - -f -`
      : `"${CTAGS_BIN}" -R --output-format=json --fields=+nKS --exclude=node_modules --exclude=.git --exclude=dist --exclude=build --exclude=__pycache__ --exclude=vendor --exclude=.next --exclude='*.min.*' -f - .`;

    const result = await pi.exec("bash", ["-c", cmd], { cwd, timeout: 30_000 });
    if (result.code !== 0 && !result.stdout) return { ok: false, count: 0 };

    const tags: string[] = [];
    for (const line of result.stdout.split("\n")) {
      if (!line.trim()) continue;
      try {
        const e = JSON.parse(line);
        if (e._type !== "tag") continue;
        const relPath = path.isAbsolute(e.path) ? path.relative(cwd, e.path) : e.path;
        tags.push(JSON.stringify({
          name: e.name, path: relPath, line: e.line, kind: e.kind,
          ...(e.scope && { scope: e.scope }),
          ...(e.scopeKind && { scopeKind: e.scopeKind }),
          ...(e.signature && { signature: e.signature }),
        }));
      } catch { /* skip */ }
    }

    const dir = path.join(cwd, ".pi", "index");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "tags.jsonl"), tags.join("\n"));
    return { ok: true, count: tags.length };
  }

  pi.registerCommand("reindex", {
    description: "Rebuild code index: ctags (symbols) + vector search. Add --full for complete vector rebuild.",
    handler: async (args, ctx) => {
      const fullRebuild = args?.includes("--full");

      // ── Step 1: ctags ──
      ctx.ui.setStatus("code-search", "🔍 ctags...");
      const ctags = await buildCtags(ctx.cwd);
      if (ctags.ok) {
        ctx.ui.notify(`📋 ctags: ${ctags.count} symbols indexed`, "success");
      } else {
        ctx.ui.notify("⚠️ ctags failed (is universal-ctags installed?)", "error");
      }

      // ── Step 2: vector index ──
      if (!(await ensureVenv(ctx))) return;

      ctx.ui.notify(`${fullRebuild ? "🔄 Full rebuild" : "📝 Incremental update"} of vector index...`, "info");
      ctx.ui.setStatus("code-search", "🔍 embedding...");

      const result = await pi.exec(
        pythonPath,
        [indexerScript, ctx.cwd, ...(fullRebuild ? ["--full"] : [])],
        { timeout: 1200_000 },
      );

      if (result.code !== 0) {
        ctx.ui.notify(`Vector indexing failed: ${result.stderr.slice(-500)}`, "error");
        ctx.ui.setStatus("code-search", "🔍 index error");
        return;
      }

      // Parse last status line
      const lines = result.stdout.trim().split("\n");
      for (let i = lines.length - 1; i >= 0; i--) {
        try {
          const s = JSON.parse(lines[i]);
          if (s.status === "complete") {
            ctx.ui.notify(
              `🔍 vector: ${s.total_chunks} chunks from ${s.total_files} files` +
              (s.files_processed > 0 ? ` (${s.files_processed} updated, ${s.elapsed_sec}s)` : " (up to date)"),
              "success",
            );
            ctx.ui.setStatus("code-search", "");
            return;
          }
        } catch { continue; }
      }
      ctx.ui.notify("✅ Indexing complete", "success");
      ctx.ui.setStatus("code-search", "");
    },
  });
}
