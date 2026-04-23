import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import {
  createFindTool,
  createGrepTool,
  DEFAULT_MAX_BYTES,
  DEFAULT_MAX_LINES,
  formatSize,
  truncateHead,
} from "@mariozechner/pi-coding-agent";
import { Text } from "@mariozechner/pi-tui";
import { Type } from "typebox";
import { FileFinder } from "@ff-labs/fff-node";
import type {
  GrepCursor,
  GrepMode,
  GrepResult,
  Location,
  SearchResult,
} from "@ff-labs/fff-node";
import { spawnSync } from "node:child_process";
import { readFile, readdir, stat } from "node:fs/promises";
import * as path from "node:path";

const DEFAULT_GREP_LIMIT = 100;
const DEFAULT_FIND_LIMIT = 200;
const DEFAULT_MULTI_GREP_LIMIT = 100;
const DEFAULT_FUZZY_SEARCH_LIMIT = 10;
const DEFAULT_MAX_MATCHES_PER_FILE = 50;
const GREP_MAX_LINE_LENGTH = 500;
const SUGGESTION_LIMIT = 5;
const VALID_FUZZY_SEARCH_TARGETS = new Set(["auto", "files", "content"]);
const FILE_CONTEXT_TOOLS = new Set([
  "read",
  "edit",
  "write",
  "get_diagnostics",
  "goto_definition",
  "find_references",
  "hover_info",
]);

interface FffFindInput {
  pattern: string;
  path?: string;
  constraints?: string;
  limit?: number;
}

interface FffGrepInput {
  pattern: string;
  path?: string;
  glob?: string;
  constraints?: string;
  ignoreCase?: boolean;
  literal?: boolean;
  mode?: GrepMode;
  context?: number;
  limit?: number;
  cursor?: string;
  maxFileSize?: number;
  timeBudgetMs?: number;
}

interface MultiGrepInput {
  patterns: string[];
  constraints?: string;
  context?: number;
  limit?: number;
  cursor?: string;
  ignoreCase?: boolean;
  maxFileSize?: number;
  timeBudgetMs?: number;
}

interface FuzzySearchInput {
  query: string;
  target?: string;
  limit?: number;
}

let finder: FileFinder | null = null;
let finderCwd: string | null = null;
let lastActiveFile: string | undefined;

const cursorCache = new Map<string, GrepCursor>();
const safeMultiGrepCursorCache = new Map<
  string,
  { signature: string; fileIndex: number; nextLine: number }
>();
let cursorCounter = 0;

function resolveToolPath(cwd: string, filePath: string): string {
  return path.isAbsolute(filePath) ? filePath : path.resolve(cwd, filePath);
}

function normalizeContextPath(cwd: string, targetPath: string): string | undefined {
  const resolved = resolveToolPath(cwd, targetPath);
  const relative = path.relative(cwd, resolved);
  if (!relative || relative.startsWith("..")) return undefined;
  return relative.split(path.sep).join("/");
}

function renderTruncatedText(output: string): {
  text: string;
  truncation?: ReturnType<typeof truncateHead>;
} {
  const truncation = truncateHead(output, {
    maxLines: DEFAULT_MAX_LINES,
    maxBytes: DEFAULT_MAX_BYTES,
  });

  if (!truncation.truncated) {
    return { text: truncation.content || "(no output)" };
  }

  return {
    text: `${truncation.content}\n\n[Output truncated: ${truncation.outputLines} of ${truncation.totalLines} lines (${formatSize(truncation.outputBytes)} of ${formatSize(truncation.totalBytes)})]`,
    truncation,
  };
}

function isGrepMode(value: unknown): value is GrepMode {
  return value === "plain" || value === "regex" || value === "fuzzy";
}

function storeCursor(cursor: GrepCursor): string {
  const id = `fff_c${++cursorCounter}`;
  cursorCache.set(id, cursor);
  if (cursorCache.size > 200) {
    const first = cursorCache.keys().next().value;
    if (first) cursorCache.delete(first);
  }
  return id;
}

function storeSafeMultiGrepCursor(signature: string, fileIndex: number, nextLine: number): string {
  const id = `safe_mg_c${++cursorCounter}`;
  safeMultiGrepCursorCache.set(id, { signature, fileIndex, nextLine });
  if (safeMultiGrepCursorCache.size > 200) {
    const first = safeMultiGrepCursorCache.keys().next().value;
    if (first) safeMultiGrepCursorCache.delete(first);
  }
  return id;
}

function getCursor(id: string | undefined): GrepCursor | undefined {
  if (!id) return undefined;
  return cursorCache.get(id);
}

function getSafeMultiGrepCursor(
  id: string | undefined,
  signature: string,
): { fileIndex: number; nextLine: number } | undefined {
  if (!id) return undefined;
  const value = safeMultiGrepCursorCache.get(id);
  if (!value || value.signature !== signature) return undefined;
  return { fileIndex: value.fileIndex, nextLine: value.nextLine };
}

function truncateLine(line: string, max = GREP_MAX_LINE_LENGTH): string {
  const trimmed = line.replace(/[\r\n]+$/, "");
  return trimmed.length <= max ? trimmed : `${trimmed.slice(0, max)}...`;
}

function usesShellSearch(command: string): boolean {
  return /(^|[^\w-])(rg|grep)(?=\s|$)/.test(command);
}

function formatLocation(location: Location | undefined): string {
  if (!location) return "";
  if (location.type === "line") return `:${location.line}`;
  if (location.type === "position") return `:${location.line}:${location.col}`;
  return `:${location.start.line}:${location.start.col}-${location.end.line}:${location.end.col}`;
}

function formatFindOutput(result: SearchResult, limit: number): string {
  const items = result.items.slice(0, limit);
  if (items.length === 0) return "No files found matching pattern";

  const location = formatLocation(result.location);
  return items.map((item) => `${item.relativePath}${location}`).join("\n");
}

function formatGrepOutput(result: GrepResult, limit: number): string {
  const items = result.items.slice(0, limit);
  if (items.length === 0) return "No matches found";

  const lines: string[] = [];
  let currentFile = "";

  for (const match of items) {
    if (match.relativePath !== currentFile) {
      currentFile = match.relativePath;
      if (lines.length > 0) lines.push("");
    }

    match.contextBefore?.forEach((line, index) => {
      lines.push(
        `${match.relativePath}-${match.lineNumber - match.contextBefore!.length + index}- ${truncateLine(line)}`,
      );
    });

    lines.push(
      `${match.relativePath}:${match.lineNumber}:${match.col + 1}: ${truncateLine(match.lineContent)}`,
    );

    match.contextAfter?.forEach((line, index) => {
      lines.push(`${match.relativePath}-${match.lineNumber + 1 + index}- ${truncateLine(line)}`);
    });
  }

  return lines.join("\n");
}

function hasWildcard(token: string): boolean {
  return /[*?[{]/.test(token);
}

function looksLikeFilenameConstraintToken(token: string): boolean {
  if (token.endsWith("/")) return false;
  if (hasWildcard(token)) return false;

  const filename = token.split("/").pop() ?? token;
  const dotIndex = filename.lastIndexOf(".");
  if (dotIndex <= 0) return false;

  const ext = filename.slice(dotIndex + 1);
  return /^[A-Za-z][A-Za-z0-9]{0,9}$/.test(ext);
}

function hasUnsafeFffQueryTokens(query: string): boolean {
  const tokens = query.trim().split(/\s+/).filter(Boolean);
  if (tokens.length === 0) return false;

  for (const rawToken of tokens) {
    const token = rawToken.startsWith("!") ? rawToken.slice(1) : rawToken;
    if (!token || (token.startsWith("\\") && token.length > 1)) continue;
    if (token.startsWith("/") || token.endsWith("/")) return true;
    if (looksLikeFilenameConstraintToken(token) && tokens.length > 1) return true;
    if (
      hasWildcard(token) &&
      (token.includes("/") || (token.includes("{") && token.includes("}") && token.includes(",")))
    ) {
      return true;
    }
  }

  return false;
}

function escapeUnsafeFffQuery(query: string): string {
  return query
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .map((rawToken) => {
      const token = rawToken.startsWith("!") ? rawToken.slice(1) : rawToken;
      if (!token || rawToken.startsWith("\\")) return rawToken;
      if (
        token.startsWith("/") ||
        token.endsWith("/") ||
        looksLikeFilenameConstraintToken(token) ||
        (
          hasWildcard(token) &&
          (token.includes("/") || (token.includes("{") && token.includes("}") && token.includes(",")))
        )
      ) {
        return `\\${rawToken}`;
      }
      return rawToken;
    })
    .join(" ");
}

function hasUnsafeFffFindScope(input: FffFindInput): boolean {
  return Boolean(input.path || input.constraints || hasUnsafeFffQueryTokens(input.pattern));
}

function hasUnsafeFffGrepScope(input: FffGrepInput): boolean {
  return Boolean(
    input.path ||
      input.glob ||
      input.constraints ||
      hasUnsafeFffQueryTokens(input.pattern),
  );
}

function hasUnsafeFffMultiGrepScope(input: MultiGrepInput): boolean {
  return Boolean(input.constraints);
}

function buildConstraintParts(input: {
  constraints?: string;
  path?: string;
  glob?: string;
}): string[] {
  if (input.constraints?.trim()) return [input.constraints.trim()];

  const parts: string[] = [];
  if (input.path && input.path !== ".") parts.push(input.path);
  if (input.glob) parts.push(input.glob);
  return parts;
}

function buildFindQuery(input: FffFindInput): string {
  return [...buildConstraintParts(input), input.pattern].filter(Boolean).join(" ").trim();
}

function resolveGrepMode(input: FffGrepInput): GrepMode {
  if (isGrepMode(input.mode)) return input.mode;
  return input.literal === false ? "regex" : "plain";
}

function preparePattern(pattern: string, mode: GrepMode, ignoreCase?: boolean): string {
  if (!ignoreCase) return pattern;
  if (mode === "regex") return pattern.startsWith("(?i)") ? pattern : `(?i)${pattern}`;
  return pattern.toLowerCase();
}

function buildGrepQuery(input: FffGrepInput, mode: GrepMode): string {
  const pattern = preparePattern(input.pattern, mode, input.ignoreCase);
  return [...buildConstraintParts(input), pattern].filter(Boolean).join(" ").trim();
}

async function ensureFinder(cwd: string): Promise<FileFinder> {
  if (finder && !finder.isDestroyed && finderCwd === cwd) return finder;

  if (finder && !finder.isDestroyed) {
    finder.destroy();
    finder = null;
    finderCwd = null;
  }

  const result = FileFinder.create({
    basePath: cwd,
    aiMode: true,
  });

  if (!result.ok) throw new Error(result.error);

  finder = result.value;
  finderCwd = cwd;
  await finder.waitForScan(15_000);
  return finder;
}

function destroyFinder() {
  if (finder && !finder.isDestroyed) finder.destroy();
  finder = null;
  finderCwd = null;
}

function getFileSuggestions(
  fileFinder: FileFinder,
  query: string,
  currentFile: string | undefined,
): string[] {
  if (query.trim().length === 0) return [];

  const result = fileFinder.fileSearch(query, {
    pageSize: SUGGESTION_LIMIT,
    currentFile,
  });

  if (!result.ok) return [];
  return result.value.items.slice(0, SUGGESTION_LIMIT).map((item) => item.relativePath);
}

function getContentSuggestions(fileFinder: FileFinder, query: string): string {
  if (query.trim().length < 2) return "";

  const result = fileFinder.grep(query, {
    mode: "plain",
    smartCase: true,
    maxMatchesPerFile: 3,
    timeBudgetMs: 150,
  });

  if (!result.ok || result.value.items.length === 0) return "";
  return formatGrepOutput(result.value, SUGGESTION_LIMIT);
}

function splitConstraintTokens(constraints: string | undefined): string[] {
  return constraints?.trim().split(/\s+/).filter(Boolean) ?? [];
}

function tryListGitFiles(cwd: string): string[] | undefined {
  const result = spawnSync("git", ["ls-files", "--cached", "--others", "--exclude-standard", "-z"], {
    cwd,
    encoding: "utf-8",
    maxBuffer: 10 * 1024 * 1024,
  });
  if (result.status !== 0) return undefined;
  return (result.stdout ?? "")
    .split("\0")
    .filter(Boolean)
    .map((item) => item.replace(/\\/g, "/"));
}

async function walkFiles(cwd: string, relativeDir = ""): Promise<string[]> {
  const directory = relativeDir ? path.join(cwd, relativeDir) : cwd;
  const entries = await readdir(directory, { withFileTypes: true });
  const files: string[] = [];

  for (const entry of entries) {
    if (entry.name === ".git") continue;
    const relativePath = relativeDir ? path.posix.join(relativeDir, entry.name) : entry.name;
    if (entry.isDirectory()) {
      files.push(...(await walkFiles(cwd, relativePath)));
      continue;
    }
    if (!entry.isFile()) continue;
    files.push(relativePath.replace(/\\/g, "/"));
  }

  return files;
}

function getGitStatusSets(cwd: string): {
  modified: Set<string>;
  staged: Set<string>;
  untracked: Set<string>;
} {
  const sets = {
    modified: new Set<string>(),
    staged: new Set<string>(),
    untracked: new Set<string>(),
  };

  const result = spawnSync(
    "git",
    ["status", "--porcelain=v1", "-z", "--untracked-files=all"],
    {
      cwd,
      encoding: "utf-8",
      maxBuffer: 10 * 1024 * 1024,
    },
  );

  if (result.status !== 0) return sets;

  const entries = (result.stdout ?? "").split("\0").filter(Boolean);
  for (let index = 0; index < entries.length; index++) {
    const entry = entries[index];
    const code = entry.slice(0, 2);
    const filePath = entry.slice(3).replace(/\\/g, "/");

    if (code === "??") {
      sets.untracked.add(filePath);
      continue;
    }

    if (code[0] === "R" || code[0] === "C") index += 1;
    if (code[0] !== " " && code[0] !== "?") sets.staged.add(filePath);
    if (code[1] !== " " && code[1] !== "?") sets.modified.add(filePath);
  }

  return sets;
}

function escapeRegex(text: string): string {
  return text.replace(/[|\\{}()[\]^$+?.]/g, "\\$&");
}

function globToRegExp(pattern: string): RegExp {
  let source = "";

  for (let index = 0; index < pattern.length; index++) {
    const char = pattern[index];

    if (char === "*" && pattern[index + 1] === "*" && pattern[index + 2] === "/") {
      source += "(?:.*\\/)?";
      index += 2;
      continue;
    }

    if (char === "*" && pattern[index + 1] === "*") {
      source += ".*";
      index += 1;
      continue;
    }

    if (char === "*") {
      source += "[^/]*";
      continue;
    }

    if (char === "?") {
      source += "[^/]";
      continue;
    }

    if (char === "{") {
      const close = pattern.indexOf("}", index + 1);
      if (close !== -1) {
        const parts = pattern
          .slice(index + 1, close)
          .split(",")
          .filter(Boolean)
          .map((part) => escapeRegex(part));
        if (parts.length > 0) {
          source += `(?:${parts.join("|")})`;
          index = close;
          continue;
        }
      }
    }

    if (char === "[") {
      const close = pattern.indexOf("]", index + 1);
      if (close !== -1) {
        source += pattern.slice(index, close + 1);
        index = close;
        continue;
      }
    }

    source += escapeRegex(char);
  }

  return new RegExp(`^${source}$`, "i");
}

function pathMatchesSegment(relativePath: string, segment: string): boolean {
  const normalizedPath = relativePath.toLowerCase();
  const normalizedSegment = segment.replace(/^\/+|\/+$/g, "").toLowerCase();
  if (!normalizedSegment) return true;
  return (
    normalizedPath.startsWith(`${normalizedSegment}/`) ||
    normalizedPath.includes(`/${normalizedSegment}/`)
  );
}

function pathMatchesFileSuffix(relativePath: string, suffix: string): boolean {
  const normalizedPath = relativePath.toLowerCase();
  const normalizedSuffix = suffix.toLowerCase();
  return normalizedPath === normalizedSuffix || normalizedPath.endsWith(`/${normalizedSuffix}`);
}

function isGitConstraintToken(token: string): boolean {
  return /^(?:git|status|st|g):/.test(token);
}

function matchesConstraintToken(
  relativePath: string,
  token: string,
  gitStatus: { modified: Set<string>; staged: Set<string>; untracked: Set<string> },
  globCache: Map<string, RegExp>,
): boolean {
  const negated = token.startsWith("!");
  const value = negated ? token.slice(1) : token;
  if (!value) return true;

  let matched = true;

  if (isGitConstraintToken(value)) {
    const [, filter = ""] = value.split(":", 2);
    if (filter === "modified") matched = gitStatus.modified.has(relativePath);
    else if (filter === "staged") matched = gitStatus.staged.has(relativePath);
    else if (filter === "untracked") matched = gitStatus.untracked.has(relativePath);
    else matched = true;
  } else if (value.startsWith("/") || value.endsWith("/")) {
    matched = pathMatchesSegment(relativePath, value);
  } else if (hasWildcard(value)) {
    let regex = globCache.get(value);
    if (!regex) {
      regex = globToRegExp(value);
      globCache.set(value, regex);
    }
    matched = regex.test(relativePath);
  } else if (looksLikeFilenameConstraintToken(value)) {
    matched = pathMatchesFileSuffix(relativePath, value);
  } else {
    matched = relativePath.toLowerCase().includes(value.toLowerCase());
  }

  return negated ? !matched : matched;
}

function getMatchRanges(line: string, patterns: string[], ignoreCase: boolean): [number, number][] {
  const haystack = ignoreCase ? line.toLowerCase() : line;
  const ranges: [number, number][] = [];

  for (const pattern of patterns) {
    const needle = ignoreCase ? pattern.toLowerCase() : pattern;
    const start = haystack.indexOf(needle);
    if (start === -1) continue;
    ranges.push([start, start + pattern.length]);
  }

  ranges.sort((a, b) => a[0] - b[0]);
  return ranges;
}

async function executeSafeMultiGrep(
  cwd: string,
  params: MultiGrepInput,
  patterns: string[],
): Promise<{
  result: GrepResult;
  safeCursor?: string;
}> {
  const signature = JSON.stringify({
    patterns,
    constraints: params.constraints ?? "",
    ignoreCase: !!params.ignoreCase,
    maxFileSize: params.maxFileSize ?? 0,
    context: params.context ?? 0,
  });
  const startCursor = getSafeMultiGrepCursor(params.cursor, signature) ?? {
    fileIndex: 0,
    nextLine: 0,
  };

  const allFiles = tryListGitFiles(cwd) ?? (await walkFiles(cwd));
  const gitStatus = getGitStatusSets(cwd);
  const constraintTokens = splitConstraintTokens(params.constraints);
  const globCache = new Map<string, RegExp>();
  const filteredFiles = constraintTokens.length === 0
    ? allFiles
    : allFiles.filter((relativePath) =>
        constraintTokens.every((token) => matchesConstraintToken(relativePath, token, gitStatus, globCache)),
      );

  const effectiveLimit = Math.max(1, params.limit ?? DEFAULT_MULTI_GREP_LIMIT);
  const perFileLimit = Math.min(effectiveLimit, DEFAULT_MAX_MATCHES_PER_FILE);
  const beforeContext = Math.max(0, params.context ?? 0);
  const afterContext = Math.max(0, params.context ?? 0);
  const timeBudgetMs = params.timeBudgetMs ?? 0;
  const deadline = timeBudgetMs > 0 ? Date.now() + timeBudgetMs : undefined;

  const items: GrepResult["items"] = [];
  let totalFilesSearched = 0;
  let nextCursor: { fileIndex: number; nextLine: number } | null = null;

  for (let fileIndex = startCursor.fileIndex; fileIndex < filteredFiles.length; fileIndex++) {
    const relativePath = filteredFiles[fileIndex];
    const absolutePath = path.join(cwd, relativePath);

    if (deadline && Date.now() >= deadline) {
      nextCursor = { fileIndex, nextLine: fileIndex === startCursor.fileIndex ? startCursor.nextLine : 0 };
      break;
    }

    let fileStat;
    try {
      fileStat = await stat(absolutePath);
    } catch {
      continue;
    }

    if (!fileStat.isFile()) continue;
    if (params.maxFileSize && fileStat.size > params.maxFileSize) continue;

    let buffer: Buffer;
    try {
      buffer = await readFile(absolutePath);
    } catch {
      continue;
    }

    totalFilesSearched += 1;
    if (buffer.subarray(0, 1024).includes(0)) continue;

    const content = buffer.toString("utf-8").replace(/\r\n/g, "\n").replace(/\r/g, "\n");
    const lines = content.split("\n");
    let byteOffset = 0;
    let fileMatches = 0;
    const startLine = fileIndex === startCursor.fileIndex ? startCursor.nextLine : 0;

    for (let lineIndex = 0; lineIndex < startLine; lineIndex++) {
      byteOffset += Buffer.byteLength(lines[lineIndex] ?? "", "utf8") + 1;
    }

    for (let lineIndex = startLine; lineIndex < lines.length; lineIndex++) {
      if (deadline && Date.now() >= deadline) {
        nextCursor = { fileIndex, nextLine: lineIndex };
        break;
      }

      const line = lines[lineIndex] ?? "";
      const matchRanges = getMatchRanges(line, patterns, !!params.ignoreCase);
      const lineBytes = Buffer.byteLength(line, "utf8") + 1;

      if (matchRanges.length > 0) {
        items.push({
          relativePath,
          fileName: path.basename(relativePath),
          gitStatus: gitStatus.untracked.has(relativePath)
            ? "untracked"
            : gitStatus.staged.has(relativePath)
              ? "staged"
              : gitStatus.modified.has(relativePath)
                ? "modified"
                : "clean",
          size: fileStat.size,
          modified: Math.floor(fileStat.mtimeMs / 1000),
          isBinary: false,
          totalFrecencyScore: 0,
          accessFrecencyScore: 0,
          modificationFrecencyScore: 0,
          lineNumber: lineIndex + 1,
          col: matchRanges[0][0],
          byteOffset,
          lineContent: line,
          matchRanges,
          contextBefore: lines.slice(Math.max(0, lineIndex - beforeContext), lineIndex),
          contextAfter: lines.slice(lineIndex + 1, lineIndex + 1 + afterContext),
        });
        fileMatches += 1;

        if (items.length >= effectiveLimit) {
          nextCursor = { fileIndex, nextLine: lineIndex + 1 };
          byteOffset += lineBytes;
          break;
        }
        if (fileMatches >= perFileLimit) {
          byteOffset += lineBytes;
          break;
        }
      }

      byteOffset += lineBytes;
    }

    if (nextCursor) break;
  }

  const safeCursor = nextCursor
    ? storeSafeMultiGrepCursor(signature, nextCursor.fileIndex, nextCursor.nextLine)
    : undefined;

  return {
    result: {
      items,
      totalMatched: items.length,
      totalFilesSearched,
      totalFiles: allFiles.length,
      filteredFileCount: filteredFiles.length,
      nextCursor: null,
    },
    safeCursor,
  };
}

function renderSection(title: string, body: string): string {
  return `${title}:\n${body}`;
}

function renderTextResult(
  result: { content?: { type: string; text?: string }[] },
  options: { expanded?: boolean },
  theme: any,
  context: any,
  maxLines = 15,
) {
  const text = (context.lastComponent as Text | undefined) ?? new Text("", 0, 0);
  const output = result.content?.find((item) => item.type === "text")?.text?.trim() ?? "";
  if (!output) {
    text.setText(theme.fg("muted", "No output"));
    return text;
  }

  const lines = output.split("\n");
  const displayLines = lines.slice(0, options.expanded ? lines.length : maxLines);
  let content = `\n${displayLines.map((line) => theme.fg("toolOutput", line)).join("\n")}`;
  if (lines.length > displayLines.length) {
    content += theme.fg("muted", `\n... (${lines.length - displayLines.length} more lines)`);
  }
  text.setText(content);
  return text;
}

export default function (pi: ExtensionAPI) {
  const cwd = process.cwd();
  const grepTool = createGrepTool(cwd);
  const findTool = createFindTool(cwd);

  const grepSchema = Type.Object({
    pattern: Type.String({ description: "Search pattern (plain text, regex, or fuzzy query)" }),
    path: Type.Optional(
      Type.String({
        description: "Directory or file constraint, e.g. 'src/' or 'package.json'",
      }),
    ),
    glob: Type.Optional(
      Type.String({ description: "Glob constraint, e.g. '*.ts' or '**/*.spec.ts'" }),
    ),
    constraints: Type.Optional(
      Type.String({
        description: "FFF constraints, e.g. 'src/**/*.ts !**/*.test.ts git:modified'",
      }),
    ),
    ignoreCase: Type.Optional(Type.Boolean({ description: "Force case-insensitive matching" })),
    literal: Type.Optional(
      Type.Boolean({ description: "Treat pattern as literal string instead of regex" }),
    ),
    mode: Type.Optional(Type.String({ description: "Search mode: plain | regex | fuzzy" })),
    context: Type.Optional(
      Type.Number({ description: "Number of lines to show before and after each match" }),
    ),
    limit: Type.Optional(
      Type.Number({ description: `Maximum number of matches to return (default: ${DEFAULT_GREP_LIMIT})` }),
    ),
    cursor: Type.Optional(
      Type.String({ description: "Cursor from previous grep result for pagination" }),
    ),
    maxFileSize: Type.Optional(
      Type.Number({ description: "Skip files larger than this many bytes" }),
    ),
    timeBudgetMs: Type.Optional(
      Type.Number({ description: "Stop after this many milliseconds and return partial results" }),
    ),
  });

  const findSchema = Type.Object({
    pattern: Type.String({
      description: "Fuzzy file query. Supports path prefixes and file:line[:col] locations.",
    }),
    path: Type.Optional(Type.String({ description: "Directory constraint, e.g. 'src/'" })),
    constraints: Type.Optional(
      Type.String({ description: "FFF constraints, e.g. 'src/** !**/*.test.ts'" }),
    ),
    limit: Type.Optional(
      Type.Number({ description: `Maximum number of results (default: ${DEFAULT_FIND_LIMIT})` }),
    ),
  });

  const multiGrepSchema = Type.Object({
    patterns: Type.Array(Type.String(), {
      description: "Patterns to search for with OR logic. Use naming variants together.",
    }),
    constraints: Type.Optional(
      Type.String({ description: "FFF constraints, e.g. '*.{ts,tsx} !**/*.test.ts'" }),
    ),
    context: Type.Optional(
      Type.Number({ description: "Number of lines to show before and after each match" }),
    ),
    limit: Type.Optional(
      Type.Number({ description: `Maximum number of matches to return (default: ${DEFAULT_MULTI_GREP_LIMIT})` }),
    ),
    cursor: Type.Optional(
      Type.String({ description: "Cursor from previous multi_grep result for pagination" }),
    ),
    ignoreCase: Type.Optional(Type.Boolean({ description: "Force case-insensitive matching" })),
    maxFileSize: Type.Optional(
      Type.Number({ description: "Skip files larger than this many bytes" }),
    ),
    timeBudgetMs: Type.Optional(
      Type.Number({ description: "Stop after this many milliseconds and return partial results" }),
    ),
  });

  const fuzzySearchSchema = Type.Object({
    query: Type.String({ description: "Short fuzzy query for files, paths, or content" }),
    target: Type.Optional(
      Type.String({ description: "Search target: auto | files | content" }),
    ),
    limit: Type.Optional(
      Type.Number({ description: `Maximum number of fuzzy results to return (default: ${DEFAULT_FUZZY_SEARCH_LIMIT})` }),
    ),
  });

  pi.on("session_start", async (_event, ctx) => {
    try {
      await ensureFinder(ctx.cwd);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      ctx.ui.notify(`FFF search unavailable: ${message}`, "warning");
    }
  });

  pi.on("session_shutdown", async () => {
    destroyFinder();
    lastActiveFile = undefined;
  });

  pi.on("tool_call", (event, ctx) => {
    if (event.toolName === "bash") {
      const command = (event.input as { command?: unknown }).command;
      if (typeof command === "string" && usesShellSearch(command)) {
        return {
          block: true,
          reason: "Use built-in find, grep, rg, or multi_grep instead of shell rg/grep.",
        };
      }
      return;
    }

    if (!FILE_CONTEXT_TOOLS.has(event.toolName)) return;
    const targetPath = (event.input as { path?: unknown }).path;
    if (typeof targetPath !== "string") return;
    lastActiveFile = normalizeContextPath(ctx.cwd, targetPath);
  });

  const grepPromptGuidelines = [
    "Use grep for one identifier or string.",
    "Use mode='plain' by default, 'regex' only when needed, and 'fuzzy' for typo-tolerant search.",
    "Use constraints for file scoping instead of shell rg flags.",
    "If you need OR logic across naming variants, use multi_grep instead of repeated grep calls.",
  ];

  async function executeFffGrep(
    toolCallId: string,
    params: FffGrepInput,
    signal: AbortSignal,
    onUpdate: ((update: unknown) => void) | undefined,
    ctx: { cwd: string },
  ) {
    if (hasUnsafeFffGrepScope(params)) {
      return grepTool.execute(toolCallId, params, signal, onUpdate);
    }

    try {
      const fileFinder = await ensureFinder(ctx.cwd);
      const effectiveLimit = Math.max(1, params.limit ?? DEFAULT_GREP_LIMIT);
      const mode = resolveGrepMode(params);
      const query = buildGrepQuery(params, mode);

      const grepResult = fileFinder.grep(query, {
        mode,
        smartCase: mode === "regex" ? !params.ignoreCase : true,
        maxMatchesPerFile: Math.min(effectiveLimit, DEFAULT_MAX_MATCHES_PER_FILE),
        cursor: getCursor(params.cursor) ?? null,
        beforeContext: params.context ?? 0,
        afterContext: params.context ?? 0,
        maxFileSize: params.maxFileSize ?? 0,
        timeBudgetMs: params.timeBudgetMs ?? 0,
      });

      if (!grepResult.ok) throw new Error(grepResult.error);

      const result = grepResult.value;
      let output = formatGrepOutput(result, effectiveLimit);

      if (result.items.length === 0) {
        const suggestions = getFileSuggestions(fileFinder, params.pattern, lastActiveFile);
        if (suggestions.length > 0) {
          output += `\n\nSuggested files:\n${suggestions.join("\n")}`;
        }
      }

      const rendered = renderTruncatedText(output);
      output = rendered.text;

      const notices: string[] = [];
      if (result.regexFallbackError) {
        notices.push(`Regex failed: ${result.regexFallbackError}. Used literal fallback.`);
      }
      if (result.nextCursor) {
        notices.push(`More results available. Use cursor=\"${storeCursor(result.nextCursor)}\" to continue`);
      }
      if (result.totalFilesSearched < result.filteredFileCount) {
        notices.push(`Searched ${result.totalFilesSearched} of ${result.filteredFileCount} eligible files`);
      }
      if (notices.length > 0) output += `\n\n[${notices.join(". ")}]`;

      return {
        content: [{ type: "text", text: output }],
        details: {
          truncation: rendered.truncation,
          totalMatched: result.totalMatched,
          totalFiles: result.totalFiles,
          totalFilesSearched: result.totalFilesSearched,
          filteredFileCount: result.filteredFileCount,
        },
      };
    } catch {
      return grepTool.execute(toolCallId, params, signal, onUpdate);
    }
  }

  function renderAliasGrepCall(name: string, args: FffGrepInput, theme: any, context: any) {
    const text = (context.lastComponent as Text | undefined) ?? new Text("", 0, 0);
    const pattern = args?.pattern ?? "";
    const searchPath = args?.path ?? args?.constraints ?? ".";
    let content =
      theme.fg("toolTitle", theme.bold(name)) +
      " " +
      theme.fg("accent", `/${pattern}/`) +
      theme.fg("toolOutput", ` in ${searchPath}`);
    if (args?.limit !== undefined) content += theme.fg("toolOutput", ` limit ${args.limit}`);
    if (args?.cursor) content += theme.fg("muted", " (page)");
    text.setText(content);
    return text;
  }

  function renderFffGrepResult(result: any, options: any, theme: any, context: any) {
    return renderTextResult(result, options, theme, context, 15);
  }

  pi.registerTool({
    ...grepTool,
    description:
      "Search file contents using FFF. Fast indexed search with plain, regex, and fuzzy modes. Prefer this over shell rg.",
    promptSnippet:
      "Search file contents with FFF first. Prefer plain search, use multi_grep for naming variants, and use code_search only after lexical search is insufficient.",
    promptGuidelines: grepPromptGuidelines,
    parameters: grepSchema,
    async execute(toolCallId, params: FffGrepInput, signal, onUpdate, ctx) {
      return executeFffGrep(toolCallId, params, signal, onUpdate, ctx);
    },
    renderResult: renderFffGrepResult,
  });

  pi.registerTool({
    ...grepTool,
    name: "rg",
    label: "rg",
    description:
      "FFF-backed alias for ripgrep-style content search. Uses the same parameters as grep, but runs on FFF instead of shell rg.",
    promptSnippet:
      "Ripgrep-style alias backed by FFF grep. Use this when you want rg naming without shell rg.",
    promptGuidelines: grepPromptGuidelines,
    parameters: grepSchema,
    async execute(toolCallId, params: FffGrepInput, signal, onUpdate, ctx) {
      return executeFffGrep(toolCallId, params, signal, onUpdate, ctx);
    },
    renderCall(args, theme, context) {
      return renderAliasGrepCall("rg", args as FffGrepInput, theme, context);
    },
    renderResult: renderFffGrepResult,
  });

  pi.registerTool({
    ...findTool,
    description:
      "Find files using FFF fuzzy search. Fast indexed file lookup with path-aware matching and lexical fallback from grep when needed.",
    promptSnippet:
      "Find files with FFF first. Use short fuzzy queries and prefer this over shell rg when you are looking for files, not file contents.",
    promptGuidelines: [
      "Use short file/path queries.",
      "Use path prefixes like 'src/' or a constraints string to narrow scope.",
      "If you are looking for contents, use grep or multi_grep instead.",
    ],
    parameters: findSchema,
    async execute(toolCallId, params: FffFindInput, signal, onUpdate, ctx) {
      if (hasUnsafeFffFindScope(params)) {
        return findTool.execute(toolCallId, params, signal, onUpdate);
      }

      try {
        const fileFinder = await ensureFinder(ctx.cwd);
        const effectiveLimit = Math.max(1, params.limit ?? DEFAULT_FIND_LIMIT);
        const query = buildFindQuery(params);

        const searchResult = fileFinder.fileSearch(query, {
          pageSize: effectiveLimit,
          currentFile: lastActiveFile,
        });

        if (!searchResult.ok) throw new Error(searchResult.error);

        const result = searchResult.value;
        let output = formatFindOutput(result, effectiveLimit);

        if (result.items.length === 0) {
          const suggestions = getContentSuggestions(fileFinder, params.pattern);
          if (suggestions) {
            output += `\n\nSuggested content matches:\n${suggestions}`;
          }
        }

        const rendered = renderTruncatedText(output);
        output = rendered.text;

        const notices: string[] = [];
        if (result.totalMatched > result.items.length) {
          notices.push(`${result.totalMatched} total matches across ${result.totalFiles} indexed files`);
        }
        if (notices.length > 0) output += `\n\n[${notices.join(". ")}]`;

        return {
          content: [{ type: "text", text: output }],
          details: {
            truncation: rendered.truncation,
            totalMatched: result.totalMatched,
            totalFiles: result.totalFiles,
            location: result.location,
          },
        };
      } catch {
        return findTool.execute(toolCallId, params, signal, onUpdate);
      }
    },
    renderResult(result, options, theme, context) {
      return renderTextResult(result, options, theme, context, 20);
    },
  });

  pi.registerTool({
    name: "fuzzy_search",
    label: "fuzzy_search",
    description:
      "Combined fuzzy file and content search using FFF. Use this when the query may have typos or you are unsure whether the match is in a file path or file content.",
    promptSnippet:
      "Combined fuzzy file and content search using FFF. Use this when you want typo-tolerant search across both file paths and content.",
    promptGuidelines: [
      "Use short typo-tolerant queries.",
      "Use target='auto' when you are unsure whether the match is in a file path or file content.",
      "Use target='files' for fuzzy file/path lookup and target='content' for fuzzy line matches.",
      "Prefer exact find or grep when you already know the identifier or file name.",
    ],
    parameters: fuzzySearchSchema,
    async execute(_toolCallId, params: FuzzySearchInput, _signal, _onUpdate, ctx) {
      const query = params.query.trim();
      if (!query) {
        return {
          content: [{ type: "text", text: "query must not be empty" }],
          isError: true,
          details: {},
        };
      }

      const target = params.target ?? "auto";
      if (!VALID_FUZZY_SEARCH_TARGETS.has(target)) {
        return {
          content: [{ type: "text", text: "target must be one of: auto, files, content" }],
          isError: true,
          details: {},
        };
      }

      try {
        const fileFinder = await ensureFinder(ctx.cwd);
        const effectiveLimit = Math.max(1, params.limit ?? DEFAULT_FUZZY_SEARCH_LIMIT);
        const safeQuery = escapeUnsafeFffQuery(query);

        const fileResult = target === "content"
          ? undefined
          : fileFinder.fileSearch(safeQuery, {
              pageSize: effectiveLimit,
              currentFile: lastActiveFile,
            });
        const contentResult = target === "files"
          ? undefined
          : fileFinder.grep(safeQuery, {
              mode: "fuzzy",
              smartCase: true,
              maxMatchesPerFile: Math.min(effectiveLimit, DEFAULT_MAX_MATCHES_PER_FILE),
              timeBudgetMs: 150,
            });

        if (fileResult && !fileResult.ok) throw new Error(fileResult.error);
        if (contentResult && !contentResult.ok) throw new Error(contentResult.error);

        const fileMatches = fileResult?.value.items.length ?? 0;
        const contentMatches = contentResult?.value.items.length ?? 0;
        if (fileMatches === 0 && contentMatches === 0) {
          return {
            content: [{ type: "text", text: "No fuzzy matches found" }],
            details: { target },
          };
        }

        const showFiles = fileMatches > 0;
        const showContent = contentMatches > 0;
        const fileLimit = showFiles && showContent ? Math.max(1, Math.ceil(effectiveLimit / 2)) : effectiveLimit;
        const contentLimit = showFiles && showContent ? Math.max(1, Math.floor(effectiveLimit / 2)) : effectiveLimit;
        const sections: string[] = [];

        if (showFiles && fileResult) {
          const body = formatFindOutput(fileResult.value, fileLimit);
          sections.push(target === "auto" ? renderSection("Files", body) : body);
        }

        if (showContent && contentResult) {
          const body = formatGrepOutput(contentResult.value, contentLimit);
          sections.push(target === "auto" ? renderSection("Content matches", body) : body);
        }

        let output = sections.join("\n\n");
        const rendered = renderTruncatedText(output);
        output = rendered.text;

        const notices: string[] = [];
        if (safeQuery !== query) {
          notices.push("Escaped constraint-like tokens for safe fuzzy search");
        }
        if (fileResult && fileResult.value.totalMatched > fileLimit) {
          notices.push("More file matches available. Use target=\"files\" and a higher limit for more");
        }
        if (contentResult && contentResult.value.nextCursor) {
          notices.push("More content matches available. Use target=\"content\" and a higher limit for more");
        }
        if (notices.length > 0) output += `\n\n[${notices.join(". ")}]`;

        return {
          content: [{ type: "text", text: output }],
          details: {
            truncation: rendered.truncation,
            target,
            fileMatches: fileResult?.value.totalMatched ?? 0,
            contentMatches: contentResult?.value.totalMatched ?? 0,
          },
        };
      } catch (error) {
        return {
          content: [
            {
              type: "text",
              text: `fuzzy_search failed: ${error instanceof Error ? error.message : String(error)}`,
            },
          ],
          isError: true,
          details: {},
        };
      }
    },
    renderCall(args: FuzzySearchInput, theme: any, context: any) {
      const text = (context.lastComponent as Text | undefined) ?? new Text("", 0, 0);
      const target = args?.target ?? "auto";
      let content =
        theme.fg("toolTitle", theme.bold("fuzzy_search")) +
        " " +
        theme.fg("accent", `\"${args?.query ?? ""}\"`) +
        theme.fg("toolOutput", ` [${target}]`);
      if (args?.limit !== undefined) content += theme.fg("toolOutput", ` limit ${args.limit}`);
      text.setText(content);
      return text;
    },
    renderResult(result, options, theme, context) {
      return renderTextResult(result, options, theme, context, 18);
    },
  });

  pi.registerTool({
    name: "multi_grep",
    label: "multi_grep",
    description:
      "Search file contents for any of multiple literal patterns using FFF. Prefer this over repeated grep calls when you need OR logic across naming variants.",
    promptSnippet:
      "Search multiple identifiers at once with OR logic. Use this for snake_case, PascalCase, and camelCase variants of the same concept.",
    promptGuidelines: [
      "Use multi_grep for OR logic across related identifiers.",
      "Keep patterns literal. Do not escape regex characters.",
      "Use constraints to narrow the file set.",
    ],
    parameters: multiGrepSchema,
    async execute(_toolCallId, params: MultiGrepInput, _signal, _onUpdate, ctx) {
      const patterns = params.patterns.map((pattern) => pattern.trim()).filter(Boolean);
      if (patterns.length === 0) {
        return {
          content: [{ type: "text", text: "patterns array must have at least 1 element" }],
          isError: true,
          details: {},
        };
      }

      try {
        const fileFinder = await ensureFinder(ctx.cwd);
        const effectiveLimit = Math.max(1, params.limit ?? DEFAULT_MULTI_GREP_LIMIT);
        const searchPatterns = params.ignoreCase
          ? patterns.map((pattern) => pattern.toLowerCase())
          : patterns;

        const fallbackResult = hasUnsafeFffMultiGrepScope(params)
          ? await executeSafeMultiGrep(ctx.cwd, params, searchPatterns)
          : undefined;

        const grepResult = fallbackResult
          ? undefined
          : fileFinder.multiGrep({
              patterns: searchPatterns,
              constraints: params.constraints,
              smartCase: true,
              maxMatchesPerFile: Math.min(effectiveLimit, DEFAULT_MAX_MATCHES_PER_FILE),
              cursor: getCursor(params.cursor) ?? null,
              beforeContext: params.context ?? 0,
              afterContext: params.context ?? 0,
              maxFileSize: params.maxFileSize ?? 0,
              timeBudgetMs: params.timeBudgetMs ?? 0,
            });

        if (grepResult && !grepResult.ok) throw new Error(grepResult.error);

        const result = fallbackResult ? fallbackResult.result : grepResult!.value;
        let output = formatGrepOutput(result, effectiveLimit);
        if (result.items.length === 0) {
          const suggestions = getFileSuggestions(fileFinder, patterns[0], lastActiveFile);
          if (suggestions.length > 0) {
            output += `\n\nSuggested files:\n${suggestions.join("\n")}`;
          }
        }

        const rendered = renderTruncatedText(output);
        output = rendered.text;

        const notices: string[] = [];
        const cursorId = fallbackResult?.safeCursor
          ?? (result.nextCursor ? storeCursor(result.nextCursor) : undefined);
        if (cursorId) {
          notices.push(`More results available. Use cursor=\"${cursorId}\" to continue`);
        }
        if (result.totalFilesSearched < result.filteredFileCount) {
          notices.push(`Searched ${result.totalFilesSearched} of ${result.filteredFileCount} eligible files`);
        }
        if (notices.length > 0) output += `\n\n[${notices.join(". ")}]`;

        return {
          content: [{ type: "text", text: output }],
          details: {
            truncation: rendered.truncation,
            totalMatched: result.totalMatched,
            totalFiles: result.totalFiles,
            totalFilesSearched: result.totalFilesSearched,
            filteredFileCount: result.filteredFileCount,
            patterns,
          },
        };
      } catch (error) {
        return {
          content: [
            {
              type: "text",
              text: `multi_grep failed: ${error instanceof Error ? error.message : String(error)}`,
            },
          ],
          isError: true,
          details: {},
        };
      }
    },
    renderCall(args: MultiGrepInput, theme: any) {
      let content = theme.fg("toolTitle", theme.bold("multi_grep"));
      content += " ";
      content += theme.fg(
        "accent",
        (args.patterns ?? []).map((pattern) => `\"${pattern}\"`).join(", "),
      );
      if (args.constraints) content += theme.fg("toolOutput", ` (${args.constraints})`);
      return new Text(content, 0, 0);
    },
    renderResult(result, options, theme, context) {
      return renderTextResult(result, options, theme, context, 15);
    },
  });
}
