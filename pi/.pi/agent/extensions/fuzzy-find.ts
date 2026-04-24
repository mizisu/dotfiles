import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { readdir } from "node:fs/promises";
import path from "node:path";

interface FuzzyFindInput {
  query: string;
  path?: string;
  limit?: number;
}

const DEFAULT_LIMIT = 30;
const MAX_LIMIT = 200;
const WALK_IGNORED_DIR_NAMES = new Set([
  ".git",
  ".next",
  ".ruff_cache",
  ".venv",
  "build",
  "dist",
  "node_modules",
  "sessions",
  "venv",
  "__pycache__",
]);

const WALK_IGNORED_PATHS = new Set([".pi/index", "agent-backups", "agent/sessions"]);

const fuzzyFindParameters = {
  type: "object",
  properties: {
    query: {
      type: "string",
      description: "Approximate file/path query, e.g. 'auth settings' or 'user model'.",
    },
    path: {
      type: "string",
      description: "Optional directory or file scope, e.g. 'src/' or 'agent/extensions'.",
    },
    limit: {
      type: "number",
      description: `Maximum number of results to return (default ${DEFAULT_LIMIT}, max ${MAX_LIMIT}).`,
    },
  },
  required: ["query"],
  additionalProperties: false,
} as const;

function toPosixPath(value: string): string {
  return value.replace(/\\/g, "/");
}

function normalizeToolPath(cwd: string, value: string | undefined): string | undefined {
  const stripped = value?.trim().replace(/^@/, "");
  if (!stripped || stripped === ".") return undefined;

  const absolutePath = path.isAbsolute(stripped) ? stripped : path.resolve(cwd, stripped);
  const relativePath = path.relative(cwd, absolutePath);

  if (relativePath && !relativePath.startsWith("..") && !path.isAbsolute(relativePath)) {
    return toPosixPath(relativePath).replace(/\/$/, "");
  }

  return toPosixPath(stripped).replace(/^\.\//, "").replace(/\/$/, "");
}

function isIgnoredWalkDir(relativePath: string): boolean {
  const normalizedPath = toPosixPath(relativePath);
  if ([...WALK_IGNORED_PATHS].some((ignored) => normalizedPath === ignored || normalizedPath.startsWith(`${ignored}/`))) {
    return true;
  }

  return normalizedPath.split("/").some((part) => WALK_IGNORED_DIR_NAMES.has(part));
}

async function walkFiles(cwd: string, relativeDir = ""): Promise<string[]> {
  const absoluteDir = relativeDir ? path.join(cwd, relativeDir) : cwd;
  const entries = await readdir(absoluteDir, { withFileTypes: true });
  const files: string[] = [];

  for (const entry of entries) {
    const relativePath = relativeDir ? path.posix.join(relativeDir, entry.name) : entry.name;

    if (entry.isDirectory()) {
      if (!isIgnoredWalkDir(relativePath)) {
        files.push(...(await walkFiles(cwd, relativePath)));
      }
      continue;
    }

    if (entry.isFile()) files.push(relativePath);
  }

  return files;
}

async function gitFiles(pi: ExtensionAPI, cwd: string, signal: AbortSignal | undefined): Promise<string[] | undefined> {
  const result = await pi.exec("git", ["ls-files", "--cached", "--others", "--exclude-standard", "-z"], {
    cwd,
    signal,
    timeout: 10_000,
  });

  if (result.code !== 0) return undefined;

  return result.stdout
    .split("\0")
    .filter(Boolean)
    .map(toPosixPath)
    .filter((file) => existsSync(path.join(cwd, file)));
}

async function listFiles(pi: ExtensionAPI, cwd: string, signal: AbortSignal | undefined): Promise<string[]> {
  return (await gitFiles(pi, cwd, signal)) ?? (await walkFiles(cwd));
}

function scopedFiles(files: string[], scope: string | undefined): string[] {
  if (!scope) return files;

  const prefix = scope.endsWith("/") ? scope : `${scope}/`;
  return files.filter((file) => file === scope || file.startsWith(prefix));
}

function clampLimit(limit: number | undefined): number {
  if (!Number.isFinite(limit)) return DEFAULT_LIMIT;
  return Math.max(1, Math.min(MAX_LIMIT, Math.floor(limit!)));
}

async function runFzf(files: string[], query: string, limit: number, signal: AbortSignal | undefined): Promise<string[]> {
  return new Promise((resolve, reject) => {
    const child = spawn("fzf", ["--filter", query, "--scheme=path", "--read0", "--print0"], {
      stdio: ["pipe", "pipe", "pipe"],
    });

    let settled = false;
    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];

    const finish = (fn: () => void) => {
      if (settled) return;
      settled = true;
      signal?.removeEventListener("abort", onAbort);
      fn();
    };

    const onAbort = () => {
      child.kill("SIGTERM");
      finish(() => reject(new Error("fuzzy_find cancelled")));
    };

    signal?.addEventListener("abort", onAbort, { once: true });

    child.on("error", (error) => {
      finish(() => reject(error));
    });

    child.stdout.on("data", (chunk: Buffer) => stdoutChunks.push(chunk));
    child.stderr.on("data", (chunk: Buffer) => stderrChunks.push(chunk));

    child.on("close", (code) => {
      finish(() => {
        const stdout = Buffer.concat(stdoutChunks).toString("utf8");
        const stderr = Buffer.concat(stderrChunks).toString("utf8").trim();

        if (code === 0 || code === 1) {
          resolve(stdout.split("\0").filter(Boolean).slice(0, limit));
          return;
        }

        reject(new Error(stderr || `fzf exited with code ${code}`));
      });
    });

    child.stdin.end(files.join("\0"));
  });
}

export default function (pi: ExtensionAPI) {
  pi.registerTool({
    name: "fuzzy_find",
    label: "Fuzzy Find",
    description: "Find files by fuzzy path matching using fzf. Use when you know part of a file name or path.",
    promptSnippet: "Find files by fuzzy path matching using fzf before reading when the exact path is unknown.",
    promptGuidelines: [
      "Use fuzzy_find when you know part of a file name or path but not the exact location.",
      "Use grep or search_symbols instead of fuzzy_find when searching file contents or symbols.",
    ],
    parameters: fuzzyFindParameters,
    async execute(_toolCallId, params: FuzzyFindInput, signal, _onUpdate, ctx) {
      const query = params.query.trim();
      if (!query) {
        return {
          content: [{ type: "text", text: "query must not be empty" }],
          details: {},
        };
      }

      const limit = clampLimit(params.limit);
      const scope = normalizeToolPath(ctx.cwd, params.path);
      const allFiles = await listFiles(pi, ctx.cwd, signal);
      const files = scopedFiles(allFiles, scope);

      if (files.length === 0) {
        return {
          content: [{ type: "text", text: `No files found${scope ? ` under ${scope}` : ""}.` }],
          details: { query, scope, totalFiles: allFiles.length, searchedFiles: 0, shown: 0 },
        };
      }

      try {
        const matches = await runFzf(files, query, limit, signal);

        if (matches.length === 0) {
          return {
            content: [{ type: "text", text: `No files fuzzy-matching "${query}"${scope ? ` under ${scope}` : ""}.` }],
            details: { query, scope, totalFiles: allFiles.length, searchedFiles: files.length, shown: 0 },
          };
        }

        const header = `${matches.length}/${files.length} file(s) fuzzy-matching "${query}"${scope ? ` under ${scope}` : ""}:`;
        return {
          content: [{ type: "text", text: `${header}\n${matches.join("\n")}` }],
          details: { query, scope, totalFiles: allFiles.length, searchedFiles: files.length, shown: matches.length },
        };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return {
          content: [{ type: "text", text: `fuzzy_find failed: ${message}` }],
          details: { query, scope, totalFiles: allFiles.length, searchedFiles: files.length, shown: 0 },
        };
      }
    },
  });
}
