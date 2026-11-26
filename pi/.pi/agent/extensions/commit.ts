import { type Message, uuidv7 } from "@earendil-works/pi-ai";
import { convertToLlm, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Box, Text } from "@earendil-works/pi-tui";
import { copyFile, mkdtemp, rm, unlink, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { resolveSmallModel } from "./shared/model-slots.js";
import { createCommandWorking } from "./shared/command-working.js";
import { WRITING_STYLE_PROMPT } from "./shared/writing-style.js";

const MAX_DIFF_CHARS = 180_000;
const MAX_SESSION_CONTEXT_CHARS = 8_000;
const MAX_COMMIT_STYLE_CHARS = 12_000;
const MAX_COMMIT_STYLE_EXAMPLES = 20;
const MAX_SUBJECT_LENGTH = 120;

// Planning and staging must use the same patch format, regardless of user diff settings.
const DIFF_ARGS = [
  "-c", "core.quotePath=false", "diff", "--no-ext-diff", "--no-color", "--no-textconv",
  "--src-prefix=a/", "--dst-prefix=b/", "--no-relative", "--unified=3", "--inter-hunk-context=0",
];

// Start each exclusion with a wildcard: git add reports explicitly named
// ignored files (or directory prefixes) as errors even in negative pathspecs.
const SENSITIVE_EXCLUDE_PATHS = [
  ":(exclude,glob)**/.env",
  ":(exclude,glob)**/.env/**",
  ":(exclude,glob)**/.env.*",
  ":(exclude,glob)**/.env.*/**",
  ":(exclude,glob)[a]gent/auth.json",
  ":(exclude,glob)[a]gent/auth.json/**",
];

const PLAN_SYSTEM_PROMPT = `You create a safe git commit plan for an existing working tree.

Return ONLY valid JSON, no markdown fences:
{
  "commits": [
    {
      "subject": "type: short imperative summary",
      "description": "optional why/context, or empty string",
      "files": {
        "path/file.ts": "all",
        "path/other.ts": [0, 2]
      }
    }
  ]
}

${WRITING_STYLE_PROMPT}

Rules:
- Group changes by PURPOSE and dependency, not by file extension.
- Use unscoped Conventional Commits: feat, fix, refactor, chore, docs, style, test, perf, ci, build.
- Never add a scope: use "feat: summary", not "feat(some-feature): summary".
- Use "Author commit style examples" for language according to the output-language priority above, and match their description usage. Ignore scopes and wording that conflicts with the clarity principles.
- "Explicit user commit intent" can override the inferred language. Without an explicit language request or usable style history, write the subject and description in Korean.
- Still keep the subject in unscoped Conventional Commit form; do not copy merge, PR, issue-number suffixes, or co-author trailers from examples.
- Leave description empty for simple commits; when used, explain why/context/details without repeating the subject.
- Do not include issue tracker tags.
- Every commit must be independently buildable/runnable.
- Never split tightly coupled changes, shared interfaces, imports/usages, or renames across separate commits.
- Prefer fewer safe commits over many brittle commits.
- Use "all" for whole-file changes.
- Use hunk index arrays only when one file contains clearly independent changes.
- If a commit uses "all" for a file, no other commit may list that file. When splitting by hunk instead, assign each hunk to exactly one commit.
- New, deleted, renamed, binary, and mode-changed files must use "all" in exactly one commit.
- Include all listed non-sensitive changed files exactly where they belong.
- The git diff/status is the source of truth; session context is only a hint.
- Do not invent files or changes not present in the input.`;

type FileSpec = "all" | number[];

interface Hunk {
  index: number;
  body: string;
  fingerprint: string;
}

interface DiffFile {
  path: string;
  oldPath: string;
  header: string;
  hunks: Hunk[];
  binary: boolean;
  wholeFileOnly: boolean;
}

interface PlanCommit {
  subject: string;
  description: string;
  files: Record<string, FileSpec>;
}

interface HeadState {
  commit?: string;
  ref?: string;
}

interface CommitSandbox {
  directory: string;
  indexFile: string;
  stateIndexFile: string;
  snapshotIndexFile: string;
  realIndexFile: string;
}

interface CommitSnapshot {
  head: HeadState;
  baseTree: string;
  targetTree: string;
  indexTree: string;
}

interface PreparedCommit {
  commit: PlanCommit;
  tree: string;
}

interface CommitRun {
  sandbox: CommitSandbox;
  snapshot: CommitSnapshot;
  head: HeadState;
  indexTree: string;
}

interface StageSource {
  indexFile?: string;
  base?: string;
  target?: string;
}

interface PushSummary {
  text: string;
  failed: boolean;
}

interface CommitMessageDetails {
  status?: "success" | "failed";
}

function trimTrailingSlash(value: string): string {
  return value.replace(/\/+$/, "");
}

function normalizeGitPath(value: string): string | undefined {
  const path = value.trim().replace(/^\.\//, "").replace(/\\/g, "/");
  if (!path || path.startsWith("/") || path === "." || path === ".." || path.startsWith("../") || path.includes("/../")) {
    return undefined;
  }
  return trimTrailingSlash(path);
}

function isSensitivePath(value: string): boolean {
  const path = normalizeGitPath(value);
  if (!path) return true;
  if (path === "agent/auth.json") return true;
  return path.split("/").some((part) => part === ".env" || part.startsWith(".env."));
}

function truncateText(value: string, maxChars: number, note = "[truncated]"): string {
  if (value.length <= maxChars) return value;
  const head = Math.floor(maxChars * 0.65);
  const tail = Math.max(0, maxChars - head - note.length - 4);
  return `${value.slice(0, head)}\n${note}\n${value.slice(value.length - tail)}`;
}

function textFromContent(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((part: any) => {
      if (part?.type === "text" && typeof part.text === "string") return part.text;
      if (part?.type === "toolCall") return `[tool call: ${part.name ?? "unknown"}]`;
      return "";
    })
    .filter(Boolean)
    .join("\n");
}

function buildSessionContext(ctx: ExtensionContext): string {
  const entries = convertToLlm(ctx.sessionManager.buildSessionProjection().messages)
    .filter((message) => message.role !== "system")
    .slice(-10)
    .map((message) => {
      const role = message.role;
      const text = truncateText(textFromContent(message.content).trim(), 900);
      return text ? `### ${role}\n${text}` : "";
    })
    .filter(Boolean);

  return truncateText(entries.join("\n\n"), MAX_SESSION_CONTEXT_CHARS);
}

function extractAssistantText(response: any): string {
  return (response.content ?? [])
    .filter((part: any) => part?.type === "text" && typeof part.text === "string")
    .map((part: any) => part.text)
    .join("\n")
    .trim();
}

function stripOptionalJsonFence(text: string): string {
  return text.replace(/^```(?:json)?\s*\n?/gm, "").replace(/^```\s*$/gm, "").trim();
}

function extractJsonObject(text: string): unknown {
  const stripped = stripOptionalJsonFence(text);
  const start = stripped.indexOf("{");
  if (start === -1) throw new Error("no JSON object found");

  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < stripped.length; i++) {
    const char = stripped[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === '"') inString = false;
      continue;
    }

    if (char === '"') inString = true;
    else if (char === "{") depth++;
    else if (char === "}") {
      depth--;
      if (depth === 0) return JSON.parse(stripped.slice(start, i + 1));
    }
  }

  throw new Error("unterminated JSON object");
}

function unquoteDiffPath(value: string): string {
  const trimmed = value.trim();
  if (!trimmed.startsWith('"')) return trimmed;
  try {
    return JSON.parse(trimmed);
  } catch {
    return trimmed.replace(/^"|"$/g, "");
  }
}

function parseDiffHeaderPath(line: string): { oldPath: string; newPath: string } | undefined {
  const match = line.match(/^diff --git ("(?:\\.|[^"])*"|.+?) ("(?:\\.|[^"])*"|b\/.+)$/);
  if (!match) return undefined;

  const oldRaw = unquoteDiffPath(match[1]).replace(/^a\//, "");
  const newRaw = unquoteDiffPath(match[2]).replace(/^b\//, "");
  const oldPath = normalizeGitPath(oldRaw);
  const newPath = normalizeGitPath(newRaw);
  if (!oldPath || !newPath) return undefined;
  return { oldPath, newPath };
}

function parseDiff(raw: string): DiffFile[] {
  const files: DiffFile[] = [];
  for (const chunk of raw.split(/(?=^diff --git )/m)) {
    if (!chunk.startsWith("diff --git ")) continue;

    const firstLine = chunk.split("\n", 1)[0];
    const paths = parseDiffHeaderPath(firstLine);
    if (!paths) continue;

    // ---/+++ are unambiguous even when a path itself contains " b/".
    for (const [prefix, key] of [["---", "oldPath"], ["+++", "newPath"]] as const) {
      const marker = chunk.split("\n").find((line) => line.startsWith(`${prefix} `));
      if (!marker) continue;
      const rawPath = unquoteDiffPath(marker.slice(4).split("\t", 1)[0]);
      if (rawPath === "/dev/null") continue;
      const path = normalizeGitPath(rawPath.replace(/^[ab]\//, ""));
      if (path) paths[key] = path;
    }

    const deleted = /^deleted file mode /m.test(chunk);
    const path = deleted ? paths.oldPath : paths.newPath;
    const parts = chunk.split(/(?=^@@ )/m);
    const hunks: Hunk[] = [];

    for (let index = 1; index < parts.length; index++) {
      const body = parts[index];
      // Ignore line offsets, but keep context and EOF markers to identify the location.
      const fingerprint = body.slice(body.indexOf("\n") + 1);
      hunks.push({ index: index - 1, body, fingerprint });
    }

    files.push({
      path,
      oldPath: paths.oldPath,
      header: parts[0],
      hunks,
      binary: /Binary files .* differ|GIT binary patch/m.test(chunk),
      wholeFileOnly: paths.oldPath !== paths.newPath
        || /^(?:new file mode |deleted file mode |old mode |new mode |Binary files |GIT binary patch)/m.test(chunk),
    });
  }
  return files.filter((file) => !isSensitivePath(file.path) && !isSensitivePath(file.oldPath));
}

function formatDiffForModel(files: DiffFile[]): string {
  const sections: string[] = [];
  for (const file of files) {
    let text = file.header;
    if (file.wholeFileOnly) text += "[structural or binary change: stage only as whole file]\n";
    for (const hunk of file.hunks) text += `[hunk ${hunk.index}]\n${hunk.body}`;
    sections.push(text.trimEnd());
  }

  return truncateText(sections.join("\n\n"), MAX_DIFF_CHARS, "[diff truncated; rely on status for full file list]");
}

function parseStatusPaths(stdout: string): string[] {
  return stdout
    .split("\n")
    .map((line) => line.slice(3).trim())
    .map((item) => item.includes(" -> ") ? item.split(" -> ").at(-1)! : item)
    .map((item) => normalizeGitPath(item))
    .filter((item): item is string => !!item && !isSensitivePath(item));
}

function parseSensitiveStatusPaths(stdout: string): string[] {
  return stdout
    .split("\n")
    .map((line) => line.slice(3).trim())
    .map((item) => item.includes(" -> ") ? item.split(" -> ").at(-1)! : item)
    .map((item) => normalizeGitPath(item))
    .filter((item): item is string => !!item && isSensitivePath(item));
}

function normalizeSubject(subject: unknown): string {
  const raw = String(subject ?? "").replace(/\s+/g, " ").trim();
  const oneLine = raw || "chore: update changes";
  const withoutScope = oneLine.replace(
    /^(feat|fix|refactor|chore|docs|style|test|perf|ci|build)\([^)]+\):\s*/i,
    "$1: ",
  );
  const conventional = /^(feat|fix|refactor|chore|docs|style|test|perf|ci|build):\s+.+/i.test(withoutScope)
    ? withoutScope
    : `chore: ${withoutScope.replace(/^(chore:\s*)?/i, "")}`;
  return conventional.length <= MAX_SUBJECT_LENGTH ? conventional : conventional.slice(0, MAX_SUBJECT_LENGTH - 1).trimEnd() + "…";
}

function normalizeDescription(value: unknown): string {
  return String(value ?? "").trim().slice(0, 2000);
}

function appendIndentedLines(lines: string[], text: string, indent: string): void {
  for (const line of text.split("\n")) lines.push(line ? `${indent}${line}` : "");
}

function appendCommitMessageDetails(lines: string[], commit: PlanCommit, index: number): void {
  lines.push(`${index}. ${commit.subject}`);
  if (!commit.description) return;

  lines.push("");
  lines.push("   Description");
  appendIndentedLines(lines, commit.description, "   ");
}

function formatCompletedCommits(commits: PlanCommit[]): string {
  const lines: string[] = [];
  for (const [index, commit] of commits.entries()) {
    appendCommitMessageDetails(lines, commit, index + 1);
    if (index < commits.length - 1) lines.push("");
  }
  return lines.join("\n");
}

function normalizeFileSpec(value: unknown, file: DiffFile | undefined): FileSpec | undefined {
  if (value === "all") return "all";
  if (!Array.isArray(value)) return undefined;
  if (!file || file.wholeFileOnly || file.hunks.length === 0) return "all";

  const valid = [...new Set(value)]
    .filter((item): item is number => Number.isInteger(item) && item >= 0 && item < file.hunks.length)
    .sort((a, b) => a - b);
  return valid.length > 0 ? valid : undefined;
}

function normalizePlan(raw: unknown, changedFiles: Set<string>, diffByPath: Map<string, DiffFile>): { commits: PlanCommit[]; warnings: string[] } {
  const warnings: string[] = [];
  const input = raw as any;
  if (!input || !Array.isArray(input.commits)) throw new Error("JSON must contain commits[]");

  const commits: PlanCommit[] = [];
  for (const item of input.commits) {
    if (!item || typeof item !== "object") continue;
    const files = item.files && typeof item.files === "object" && !Array.isArray(item.files) ? item.files : undefined;
    if (!files) continue;

    const normalizedFiles: Record<string, FileSpec> = {};
    for (const [rawPath, rawSpec] of Object.entries(files)) {
      const path = normalizeGitPath(rawPath);
      if (!path) {
        warnings.push(`Ignored invalid path: ${rawPath}`);
        continue;
      }
      if (isSensitivePath(path)) {
        warnings.push(`Skipped sensitive path: ${path}`);
        continue;
      }
      if (!changedFiles.has(path)) {
        warnings.push(`Ignored unchanged/unknown path: ${path}`);
        continue;
      }

      const spec = normalizeFileSpec(rawSpec, diffByPath.get(path));
      if (!spec) {
        warnings.push(`Ignored invalid hunk selection for ${path}`);
        continue;
      }
      normalizedFiles[path] = spec;
    }

    if (Object.keys(normalizedFiles).length === 0) continue;
    commits.push({
      subject: normalizeSubject(item.subject),
      description: normalizeDescription(item.description),
      files: normalizedFiles,
    });
  }

  if (commits.length === 0) throw new Error("commit plan contained no usable commits");

  const fallbackFiles: Record<string, FileSpec> = {};
  for (const file of changedFiles) {
    const owners = commits.filter((commit) => Object.hasOwn(commit.files, file));

    if (owners.length === 0) {
      fallbackFiles[file] = "all";
      continue;
    }

    const wholeFileOwner = owners.find((commit) => commit.files[file] === "all");
    if (wholeFileOwner) {
      if (owners.length > 1) {
        for (const commit of owners) {
          if (commit !== wholeFileOwner) delete commit.files[file];
        }
        warnings.push(`Removed overlapping selections for ${file}; the whole file belongs to "${wholeFileOwner.subject}".`);
      }
      continue;
    }

    const diffFile = diffByPath.get(file);
    if (!diffFile || diffFile.hunks.length === 0) continue;

    const allSelections = owners.flatMap(({ files }) => Array.isArray(files[file]) ? files[file] : []);
    const selected = new Set(allSelections);
    if (selected.size !== allSelections.length) {
      throw new Error(`Overlapping commit plan for ${file}: a hunk belongs to multiple commits. Run /commit again.`);
    }
    const missingHunks = diffFile.hunks.map((hunk) => hunk.index).filter((index) => !selected.has(index));
    if (missingHunks.length > 0) fallbackFiles[file] = missingHunks;
  }

  const fallbackCount = Object.keys(fallbackFiles).length;
  if (fallbackCount > 0) {
    warnings.push(`Added fallback commit for ${fallbackCount} file(s)/hunk group(s) omitted by analysis.`);
    commits.push({
      subject: "chore: commit remaining changes",
      description: "Files or hunks omitted by the generated commit plan.",
      files: fallbackFiles,
    });
  }

  return { commits: commits.filter((commit) => Object.keys(commit.files).length > 0), warnings };
}

function formatPlan(commits: PlanCommit[], warnings: string[], sensitiveSkipped: string[]): string {
  const lines: string[] = [];

  if (warnings.length > 0) {
    lines.push("Warnings:");
    for (const warning of warnings.slice(0, 8)) lines.push(`- ${warning}`);
    if (warnings.length > 8) lines.push(`- ...and ${warnings.length - 8} more`);
    lines.push("");
  }

  if (sensitiveSkipped.length > 0) {
    lines.push("Sensitive files will NOT be staged:");
    for (const file of sensitiveSkipped.slice(0, 8)) lines.push(`- ${file}`);
    if (sensitiveSkipped.length > 8) lines.push(`- ...and ${sensitiveSkipped.length - 8} more`);
    lines.push("");
  }

  for (const [index, commit] of commits.entries()) {
    appendCommitMessageDetails(lines, commit, index + 1);
    lines.push("");
    lines.push("   Files");
    const entries = Object.entries(commit.files).map(([file, spec]) => spec === "all" ? file : `${file} (hunks ${spec.join(", ")})`);
    for (const entry of entries.slice(0, 12)) lines.push(`   - ${entry}`);
    if (entries.length > 12) lines.push(`   - ...and ${entries.length - 12} more file(s)`);
    lines.push("");
  }

  lines.push("All groups are preflighted in a temporary index. This will replace staging with the approved trees; working tree contents are not discarded. If the repository or a hook changes the plan, execution stops without undoing created commits.");
  return lines.join("\n");
}

async function selectCommitAction(
  ctx: ExtensionContext,
  title: string,
  details: string,
  options: string[],
): Promise<string | undefined> {
  const prompt = `${title}\n\n${details}`;
  if (ctx.mode !== "tui") return ctx.ui.select(prompt, options);

  // Keep long details in the transcript, not in the fixed-height input area.
  ctx.ui.notify(ctx.ui.theme.fg("text", prompt), "info");
  return ctx.ui.select(`${title}\nReview the details above before continuing.`, options);
}

async function git(pi: ExtensionAPI, root: string, args: string[], timeout = 60_000, indexFile?: string) {
  // pi.exec has no per-call env option. Never mutate process.env: other extensions
  // and concurrent commands must continue to use their own index.
  return indexFile
    ? pi.exec("env", [`GIT_INDEX_FILE=${indexFile}`, "git", ...args], { cwd: root, timeout })
    : pi.exec("git", args, { cwd: root, timeout });
}

async function checkedGit(pi: ExtensionAPI, root: string, args: string[], timeout = 60_000, indexFile?: string) {
  const result = await git(pi, root, args, timeout, indexFile);
  if (result.code !== 0 || result.killed || result.truncated) {
    throw new Error(`git ${args.join(" ")} failed:\n${truncateText(resultText(result) || "No Git error output", 5_000)}`);
  }
  return result;
}

async function readHeadState(pi: ExtensionAPI, root: string): Promise<HeadState> {
  const commit = await git(pi, root, ["rev-parse", "--verify", "--quiet", "HEAD"], 10_000);
  const ref = await git(pi, root, ["symbolic-ref", "--quiet", "HEAD"], 10_000);
  for (const result of [commit, ref]) {
    if ((result.code !== 0 && result.code !== 1) || result.killed || result.truncated) {
      throw new Error(`Could not resolve HEAD:\n${resultText(result)}`);
    }
  }
  return {
    commit: commit.code === 0 ? commit.stdout.trim() : undefined,
    ref: ref.code === 0 ? ref.stdout.trim() : undefined,
  };
}

function sameHead(a: HeadState, b: HeadState): boolean {
  return a.commit === b.commit && a.ref === b.ref;
}

async function readIndexTree(pi: ExtensionAPI, root: string, sandbox: CommitSandbox): Promise<string> {
  // write-tree may refresh index extensions. Run it on a copy so even cancelled
  // planning leaves the real index (including intent-to-add entries) untouched.
  try {
    await copyFile(sandbox.realIndexFile, sandbox.stateIndexFile);
  } catch (error) {
    if ((error as { code?: string }).code !== "ENOENT") throw error;
    await checkedGit(pi, root, ["read-tree", "--empty"], 60_000, sandbox.stateIndexFile);
  }
  return (await checkedGit(pi, root, ["write-tree"], 60_000, sandbox.stateIndexFile)).stdout.trim();
}

async function readWorktreeTree(pi: ExtensionAPI, root: string, sandbox: CommitSandbox, baseTree: string): Promise<string> {
  // Start with the original tracking state so force-added ignored files, sparse
  // checkout flags, and intent-to-add entries survive every snapshot comparison.
  await copyFile(sandbox.snapshotIndexFile, sandbox.stateIndexFile);
  const addArgs = ["-c", "core.fsmonitor=false", "-c", "core.untrackedCache=false", "add"];
  await checkedGit(pi, root, [...addArgs, "-A", "--", ".", ...SENSITIVE_EXCLUDE_PATHS], 60_000, sandbox.stateIndexFile);
  // Copying an index changes its mtime and can hide racy, same-size edits. Force
  // tracked blobs through Git's clean filters instead of trusting cached stat data.
  await checkedGit(pi, root, [...addArgs, "--renormalize", "--", ".", ...SENSITIVE_EXCLUDE_PATHS], 60_000, sandbox.stateIndexFile);
  // Exclusions alone do not remove secrets that were already staged by the user.
  const changed = await checkedGit(pi, root, ["diff", "--cached", "--no-ext-diff", "--name-only", "--no-renames", "-z", baseTree, "--"], 60_000, sandbox.stateIndexFile);
  const sensitive = changed.stdout.split("\0").filter((path) => path && isSensitivePath(path));
  if (sensitive.length > 0) {
    await checkedGit(pi, root, ["restore", "--staged", `--source=${baseTree}`, "--", ...sensitive.map((path) => `:(literal)${path}`)], 60_000, sandbox.stateIndexFile);
  }
  return (await checkedGit(pi, root, ["write-tree"], 60_000, sandbox.stateIndexFile)).stdout.trim();
}

async function captureSnapshot(pi: ExtensionAPI, root: string, sandbox: CommitSandbox): Promise<CommitSnapshot> {
  const head = await readHeadState(pi, root);
  const baseTree = (await checkedGit(pi, root, head.commit
    ? ["rev-parse", `${head.commit}^{tree}`]
    : ["hash-object", "-w", "-t", "tree", "--stdin"])).stdout.trim();
  const indexTree = await readIndexTree(pi, root, sandbox);
  await copyFile(sandbox.stateIndexFile, sandbox.snapshotIndexFile);
  const targetTree = await readWorktreeTree(pi, root, sandbox, baseTree);
  if (!sameHead(head, await readHeadState(pi, root))) throw new Error("HEAD or branch changed while gathering changes. Run /commit again.");
  return { head, baseTree, targetTree, indexTree };
}

async function assertSnapshot(pi: ExtensionAPI, root: string, run: CommitRun, expectedIndex?: string): Promise<void> {
  if (!sameHead(run.head, await readHeadState(pi, root))) {
    throw new Error("HEAD or branch changed since planning. Existing commits were not reset; review the repository and run /commit again.");
  }
  if (expectedIndex !== undefined && await readIndexTree(pi, root, run.sandbox) !== expectedIndex) {
    throw new Error("The Git index changed outside the approved plan. Staged contents were left untouched; review them and run /commit again.");
  }
  if (await readWorktreeTree(pi, root, run.sandbox, run.snapshot.baseTree) !== run.snapshot.targetTree) {
    throw new Error("The working tree changed since the planning snapshot (including file contents, modes, or paths). No new changes will be included; review them and run /commit again.");
  }
  if (!sameHead(run.head, await readHeadState(pi, root))) throw new Error("HEAD or branch changed during validation. Run /commit again.");
}

function cleanCommitStyleExample(record: string): string {
  const lines = record
    .split("\n")
    .filter((line) => !/^Co-authored-by:/i.test(line.trim()));
  if (lines[0]) lines[0] = lines[0].replace(/\s+\(#\d+\)\s*$/, "");
  return lines.join("\n").trim();
}

function formatCommitStyleExamples(raw: string): string {
  const examples = raw
    .split("\x1e")
    .map(cleanCommitStyleExample)
    .filter(Boolean)
    .slice(0, MAX_COMMIT_STYLE_EXAMPLES)
    .map((record) => truncateText(record, 1_200, "[commit example truncated]"));

  return truncateText(examples.join("\n\n---\n\n"), MAX_COMMIT_STYLE_CHARS, "[commit style examples truncated]");
}

async function readAuthorCommitStyleExamples(pi: ExtensionAPI, root: string): Promise<string> {
  const [emailResult, nameResult] = await Promise.all([
    git(pi, root, ["config", "user.email"], 10_000),
    git(pi, root, ["config", "user.name"], 10_000),
  ]);
  const authorCandidates = [
    emailResult.code === 0 ? emailResult.stdout.trim() : "",
    nameResult.code === 0 ? nameResult.stdout.trim() : "",
  ];
  const authors = authorCandidates.filter((value, index, values) => Boolean(value) && values.indexOf(value) === index);
  const baseArgs = ["log", "--no-merges", `-${MAX_COMMIT_STYLE_EXAMPLES}`, "--format=%s%n%b%x1e"];

  for (const author of authors) {
    const result = await git(
      pi,
      root,
      ["log", "--no-merges", `--author=${author}`, `-${MAX_COMMIT_STYLE_EXAMPLES}`, "--format=%s%n%b%x1e"],
      20_000,
    );
    if (result.code !== 0) continue;
    const examples = formatCommitStyleExamples(result.stdout);
    if (examples) return examples;
  }

  const result = await git(pi, root, baseArgs, 20_000);
  if (result.code !== 0) return "";
  return formatCommitStyleExamples(result.stdout);
}

async function gitRoot(pi: ExtensionAPI, cwd: string): Promise<string | undefined> {
  const result = await pi.exec("git", ["rev-parse", "--show-toplevel"], { cwd, timeout: 10_000 });
  if (result.code !== 0) return undefined;
  return result.stdout.trim();
}

async function currentBranchName(pi: ExtensionAPI, root: string): Promise<string | undefined> {
  const result = await git(pi, root, ["branch", "--show-current"], 10_000);
  if (result.code !== 0) return undefined;
  return result.stdout.trim() || undefined;
}

async function upstreamBranchName(pi: ExtensionAPI, root: string): Promise<string | undefined> {
  const result = await git(pi, root, ["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}"], 10_000);
  if (result.code !== 0) return undefined;
  return result.stdout.trim() || undefined;
}

async function promptPushAfterCommits(
  pi: ExtensionAPI,
  root: string,
  ctx: any,
  setStatus: (text: string | undefined) => void,
  verify: () => Promise<void>,
): Promise<PushSummary> {
  const branch = await currentBranchName(pi, root);
  if (!branch) {
    ctx.ui.notify("Commits created; push skipped because HEAD is detached", "info");
    return { text: "✓ Push skipped (detached HEAD)", failed: false };
  }

  const upstream = await upstreamBranchName(pi, root);
  const target = upstream ?? `origin/${branch}`;
  const pushChoice = `Push to ${target}`;
  const choice = await ctx.ui.select(`Created commits on ${branch}. Push now?`, [pushChoice, "Skip push"]);
  if (choice !== pushChoice) return { text: "✓ Push skipped", failed: false };
  await verify();

  setStatus(`Pushing to ${target}…`);
  const result = await git(pi, root, upstream ? ["push"] : ["push", "-u", "origin", "HEAD"], 300_000);
  setStatus(undefined);

  if (result.code !== 0) {
    const output = resultText(result) || "git push failed";
    ctx.ui.notify(`Push failed:\n${truncateText(output, 5_000, "[push output truncated]")}`, "error");
    return { text: `✗ Push failed to ${target}`, failed: true };
  }

  ctx.ui.notify(`Pushed to ${target}`, "info");
  return { text: `✓ Pushed to ${target}`, failed: false };
}

async function stageWholeFile(pi: ExtensionAPI, root: string, file: string, diffByPath: Map<string, DiffFile>, source: StageSource = {}): Promise<void> {
  const diffFile = diffByPath.get(file);
  const paths = diffFile && diffFile.oldPath !== diffFile.path ? [diffFile.oldPath, diffFile.path] : [file];
  const args = source.target ? ["restore", "--staged", `--source=${source.target}`] : ["add", "-A"];
  await checkedGit(pi, root, [...args, "--", ...paths.map((path) => `:(literal)${path}`)], 60_000, source.indexFile);
}

function selectCurrentHunks(file: string, indices: number[], original: DiffFile, current: DiffFile): Hunk[] {
  const unchanged = original.header === current.header
    && original.hunks.length === current.hunks.length
    && original.hunks.every((hunk, index) => hunk.body === current.hunks[index].body);
  const selected: Hunk[] = [];
  const used = new Set<number>();

  for (const index of indices) {
    const originalHunk = original.hunks[index];
    if (!originalHunk) throw new Error(`Invalid hunk ${index} for ${file}.`);

    let match = unchanged ? current.hunks[index] : undefined;
    if (!match) {
      // Matching only +/- lines can silently select the same edit at another
      // location. Require unchanged context and uniqueness in both diffs.
      const sameHunk = (hunk: Hunk) => hunk.fingerprint === originalHunk.fingerprint;
      const candidates = current.hunks.filter(sameHunk);
      if (original.hunks.filter(sameHunk).length === 1 && candidates.length === 1) match = candidates[0];
    }
    if (!match || used.has(match.index)) {
      throw new Error(`Cannot safely match hunk ${index} for ${file}: the diff changed, the hunk was already committed, or the match is ambiguous.`);
    }
    used.add(match.index);
    selected.push(match);
  }
  if (selected.length === 0) throw new Error(`No hunks selected for ${file}.`);
  return selected.sort((a, b) => a.index - b.index);
}

async function stagePartialFile(pi: ExtensionAPI, root: string, file: string, hunks: number[], originalDiff: DiffFile, source: StageSource = {}): Promise<void> {
  const revisions = [source.base ?? "HEAD", ...(source.target ? [source.target] : [])];
  const result = await checkedGit(pi, root, [...DIFF_ARGS, ...revisions, "--", `:(literal)${file}`], 60_000, source.indexFile);
  const currentFile = parseDiff(result.stdout).find((item) => item.path === file || item.oldPath === file);
  if (!currentFile) throw new Error(`Cannot stage hunks for ${file}: no remaining diff (already committed or changed).`);
  if (originalDiff.wholeFileOnly || currentFile.wholeFileOnly) {
    throw new Error(`Cannot split hunks for ${file}: structural or binary changes require a new whole-file plan.`);
  }

  const selected = selectCurrentHunks(file, hunks, originalDiff, currentFile);
  const patch = `${currentFile.header}${selected.map((hunk) => hunk.body).join("")}`;
  const patchPath = join(tmpdir(), `pi-commit-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}.patch`);
  await writeFile(patchPath, patch, "utf8");
  try {
    await checkedGit(pi, root, ["apply", "--cached", "--whitespace=nowarn", patchPath], 60_000, source.indexFile);
  } finally {
    await unlink(patchPath).catch(() => {});
  }
}

async function stageCommitFiles(pi: ExtensionAPI, root: string, commit: PlanCommit, diffByPath: Map<string, DiffFile>, source: StageSource = {}): Promise<void> {
  // Preserve staged contents if any file in this group fails. Never change worktree contents.
  const previousTree = (await checkedGit(pi, root, ["write-tree"], 60_000, source.indexFile)).stdout.trim();
  // Preflight advances trees without creating commits or moving HEAD.
  await checkedGit(pi, root, source.base ? ["read-tree", source.base] : ["reset", "--quiet"], 60_000, source.indexFile);

  try {
    for (const [file, spec] of Object.entries(commit.files)) {
      if (isSensitivePath(file)) continue;
      if (spec === "all") {
        await stageWholeFile(pi, root, file, diffByPath, source);
        continue;
      }

      const diffFile = diffByPath.get(file);
      if (!diffFile) throw new Error(`Missing planned diff for ${file}.`);
      await stagePartialFile(pi, root, file, spec, diffFile, source);
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    try {
      await checkedGit(pi, root, ["read-tree", previousTree], 60_000, source.indexFile);
    } catch (restoreError) {
      throw new Error(`${message}\nCould not restore the previous index: ${restoreError instanceof Error ? restoreError.message : String(restoreError)}\nStop and inspect git status before continuing.`);
    }
    throw new Error(`${message}\nStaging stopped and the previous staged contents were restored; no whole-file fallback was used. Review the remaining changes and run /commit again.`);
  }
}

async function preflightPlan(pi: ExtensionAPI, root: string, commits: PlanCommit[], diffByPath: Map<string, DiffFile>, run: CommitRun): Promise<PreparedCommit[]> {
  const { sandbox, snapshot } = run;
  await checkedGit(pi, root, ["read-tree", snapshot.baseTree], 60_000, sandbox.indexFile);
  const prepared: PreparedCommit[] = [];
  let base = snapshot.baseTree;
  for (const [index, commit] of commits.entries()) {
    try {
      await stageCommitFiles(pi, root, commit, diffByPath, { indexFile: sandbox.indexFile, base, target: snapshot.targetTree });
      const tree = (await checkedGit(pi, root, ["write-tree"], 60_000, sandbox.indexFile)).stdout.trim();
      if (tree === base) throw new Error("This group produces an empty commit.");
      prepared.push({ commit, tree });
      base = tree;
    } catch (error) {
      throw new Error(`Preflight failed for commit ${index + 1}/${commits.length} (${commit.subject}). No commits were created and the real index was not changed.\n${error instanceof Error ? error.message : String(error)}`);
    }
  }
  if (base !== snapshot.targetTree) throw new Error("Preflight did not reproduce the complete planning snapshot. No commits were created; run /commit again.");
  return prepared;
}

async function commitStaged(pi: ExtensionAPI, root: string, commit: PlanCommit, options?: { noVerify?: boolean; expected?: { head: HeadState; tree: string } }) {
  const before = await readHeadState(pi, root);
  const expectedTree = (await checkedGit(pi, root, ["write-tree"])).stdout.trim();
  if (options?.expected && (!sameHead(before, options.expected.head) || expectedTree !== options.expected.tree)) {
    throw new Error("HEAD or the staged tree changed before commit. Nothing will be committed; review the repository and run /commit again.");
  }
  const args = ["commit", "-m", commit.subject];
  if (commit.description) args.push("-m", commit.description);
  if (options?.noVerify) args.push("--no-verify");
  const result = await git(pi, root, args, 120_000);
  const after = await readHeadState(pi, root);
  const failed = result.code !== 0 || result.killed || result.truncated;
  if (failed && sameHead(before, after)) return { ...result, code: result.code || 1, committedHead: undefined };
  if (failed) {
    throw new Error(`Git reported failure but HEAD or branch changed (now ${after.commit ?? "unborn"}). A commit may have been created; it was not reset and will not be retried automatically. Review git log and git status.\n${resultText(result)}`);
  }
  if (!after.commit || before.commit === after.commit || before.ref !== after.ref) {
    throw new Error("Git reported success but HEAD or branch does not match the expected commit transition. Stop and inspect git log; history was not reset.");
  }
  const details = await checkedGit(pi, root, ["log", "-1", "--no-show-signature", "--format=%T%n%P", after.commit]);
  const [tree, parents = ""] = details.stdout.trim().split("\n");
  if (tree !== expectedTree || parents !== (before.commit ?? "")) {
    throw new Error(`Commit ${after.commit} was created but its tree or parent does not match the approved plan (a hook or another Git process may have changed it). Remaining commits and push were stopped. The created commit was NOT reset; review git show ${after.commit} before continuing.`);
  }
  return { ...result, committedHead: after };
}

async function executePreparedCommit(pi: ExtensionAPI, root: string, prepared: PreparedCommit, run: CommitRun, retry = false, noVerify = false) {
  // An explicit retry may replace a failed hook's staging, but never its worktree
  // edits. Every attempt uses the frozen tree, not another git add of live files.
  await assertSnapshot(pi, root, run, retry ? undefined : run.indexTree);
  const previousTree = await readIndexTree(pi, root, run.sandbox);
  await checkedGit(pi, root, ["read-tree", prepared.tree]);
  try {
    await assertSnapshot(pi, root, run, prepared.tree);
  } catch (error) {
    // Undo only our own staging, never an external writer's index or moved HEAD.
    if (sameHead(run.head, await readHeadState(pi, root)) && await readIndexTree(pi, root, run.sandbox) === prepared.tree) {
      await checkedGit(pi, root, ["read-tree", previousTree]);
    }
    throw error;
  }
  const result = await commitStaged(pi, root, prepared.commit, { noVerify, expected: { head: run.head, tree: prepared.tree } });
  if (result.committedHead) {
    run.head = result.committedHead;
    run.indexTree = prepared.tree;
    try {
      await assertSnapshot(pi, root, run, run.indexTree);
    } catch (error) {
      throw new Error(`Commit ${run.head.commit} was created. Validation after commit failed; remaining commits and push were stopped, and no commits were undone.\n${error instanceof Error ? error.message : String(error)}`);
    }
  }
  return result;
}

function resultText(result: { stdout: string; stderr: string }): string {
  return [result.stdout, result.stderr].filter(Boolean).join("\n").trim();
}

type CommitFailureResolution = "committed" | "abort" | "fix";

function formatCommitFailureDetails(commit: PlanCommit, errorOutput: string): string {
  return [
    commit.subject,
    "",
    "Error output:",
    "```",
    truncateText(errorOutput || "git commit failed", 5_000, "[error truncated]"),
    "```",
    "",
    "Choose how to continue.",
  ].join("\n");
}

async function resolveCommitFailure(
  pi: ExtensionAPI,
  root: string,
  prepared: PreparedCommit,
  index: number,
  total: number,
  initialErrorOutput: string,
  run: CommitRun,
  ctx: any,
): Promise<CommitFailureResolution> {
  const { commit } = prepared;
  let errorOutput = initialErrorOutput || "git commit failed";

  while (true) {
    const choice = await selectCommitAction(ctx, `Commit ${index + 1}/${total} failed`, formatCommitFailureDetails(commit, errorOutput), [
      "Fix with agent",
      "Retry",
      "Retry --no-verify",
      "Abort remaining commits",
    ]);

    if (choice === "Retry" || choice === "Retry --no-verify") {
      const retry = await executePreparedCommit(pi, root, prepared, run, true, choice === "Retry --no-verify");
      if (retry.code === 0) return "committed";
      errorOutput = resultText(retry) || "git commit failed";
      continue;
    }

    if (choice === "Fix with agent") {
      pi.sendUserMessage(`The /commit command failed while creating commit \"${commit.subject}\". Please fix the issue, then run /commit again.\n\n\`\`\`\n${errorOutput}\n\`\`\``);
      return "fix";
    }

    // Later frozen trees include this group's changes, so skipping a group would
    // silently reintroduce it. Stop and replan instead, preserving the current index.
    ctx.ui.notify("Aborted remaining commits; existing commits and staged contents were preserved. Run /commit again to replan.", "info");
    return "abort";
  }
}

function commitMessageText(content: string | Array<{ type?: string; text?: string }>): string {
  if (typeof content === "string") return content;
  return content
    .filter((part): part is { type: string; text: string } => part?.type === "text" && typeof part.text === "string")
    .map((part) => part.text)
    .join("\n");
}

function registerCommitMessageRenderer(pi: ExtensionAPI): void {
  pi.registerMessageRenderer<CommitMessageDetails>("commit", (message, _options, theme) => {
    const text = commitMessageText(message.content);
    const failed = message.details?.status === "failed" || /(^|\n)(?:✗|Push: failed|Push failed)/.test(text);
    const header = theme.fg("text", theme.bold("[commit]"));
    const body = theme.fg("text", text);
    const box = new Box(1, 1, (value) => theme.bg(failed ? "toolErrorBg" : "toolSuccessBg", value));
    box.addChild(new Text(`${header}\n${body}`, 0, 0));
    return box;
  });
}

async function createPlan(ctx: any, input: string): Promise<{ text: string; modelReference: string }> {
  const resolved = await resolveSmallModel(ctx);
  const messages: Message[] = [{
    role: "user",
    content: [{ type: "text", text: input }],
    timestamp: Date.now(),
  } as Message];

  const response = await ctx.modelRegistry.complete(
    resolved.model,
    { systemPrompt: PLAN_SYSTEM_PROMPT, messages },
    { cacheRetention: "none", sessionId: uuidv7() },
  );

  if (response.stopReason === "error") throw new Error(response.errorMessage ?? "model error");
  if (response.stopReason === "aborted") throw new Error("analysis aborted");
  return { text: extractAssistantText(response), modelReference: resolved.reference };
}

export default function commitExtension(pi: ExtensionAPI) {
  registerCommitMessageRenderer(pi);

  pi.registerCommand("commit", {
    description: "Analyze all git changes, split by purpose, create commits after confirmation, and optionally push.",
    handler: async (args, ctx) => {
      if (!ctx.hasUI) {
        ctx.ui.notify("/commit requires interactive or RPC UI confirmation", "error");
        return;
      }

      const root = await gitRoot(pi, ctx.cwd);
      if (!root) {
        ctx.ui.notify("Not inside a git repository", "error");
        return;
      }

      let sandbox: CommitSandbox | undefined;
      const completed: PlanCommit[] = [];
      const working = createCommandWorking(ctx, "commit", "Commit");
      const setStatus = (text: string | undefined, details: string[] = []) => {
        working.set(text, details);
      };

      try {
        setStatus("Gathering changes…");
        const directory = await mkdtemp(join(tmpdir(), "pi-commit-plan-"));
        sandbox = {
          directory,
          indexFile: join(directory, "plan.index"),
          stateIndexFile: join(directory, "state.index"),
          snapshotIndexFile: join(directory, "snapshot.index"),
          realIndexFile: "",
        };
        sandbox.realIndexFile = resolve(root, (await checkedGit(pi, root, ["rev-parse", "--git-path", "index"])).stdout.trim());
        const snapshot = await captureSnapshot(pi, root, sandbox);
        const run: CommitRun = { sandbox, snapshot, head: snapshot.head, indexTree: snapshot.indexTree };
        const pathspec = ["--", ".", ...SENSITIVE_EXCLUDE_PATHS];
        const [log, status, statusAll, diff, authorStyleExamples] = await Promise.all([
          git(pi, root, ["log", "-6", "--format=%s%n%b---"], 10_000),
          checkedGit(pi, root, ["--no-optional-locks", "status", "--short", ...pathspec], 20_000),
          checkedGit(pi, root, ["--no-optional-locks", "status", "--short"], 20_000),
          checkedGit(pi, root, [...DIFF_ARGS, snapshot.baseTree, snapshot.targetTree, ...pathspec]),
          readAuthorCommitStyleExamples(pi, root),
        ]);

        const diffFiles = parseDiff(diff.stdout);
        const changedFiles = new Set(diffFiles.map((file) => file.path));
        const sensitiveSkipped = [...new Set(parseSensitiveStatusPaths(statusAll.stdout))];

        if (changedFiles.size === 0) {
          setStatus(undefined);
          ctx.ui.notify(sensitiveSkipped.length > 0 ? "Only sensitive files changed; nothing safe to commit" : "No changes to commit", "info");
          return;
        }

        const diffByPath = new Map(diffFiles.map((file) => [file.path, file]));
        const sessionContext = buildSessionContext(ctx);
        const explicitIntent = (args ?? "").trim();
        const modelInput = [
          explicitIntent ? `## Explicit user commit intent\n${explicitIntent}` : "",
          sessionContext ? `## Recent session context\n${sessionContext}` : "",
          authorStyleExamples ? `## Author commit style examples\n${authorStyleExamples}` : "",
          `## Recent git log\n${log.stdout.trim() || "(no recent commits)"}`,
          `## Git status (safe paths only)\n${status.stdout.trim()}`,
          `## Changed files that must be placed\n${[...changedFiles].sort().join("\n")}`,
          sensitiveSkipped.length ? `## Sensitive files excluded from commit\n${sensitiveSkipped.join("\n")}` : "",
          `## Frozen diff (including new files)\n${formatDiffForModel(diffFiles)}`,
        ].filter(Boolean).join("\n\n");

        setStatus("Planning commits with medium model…");
        const { text: planText } = await createPlan(ctx, modelInput);
        const rawPlan = extractJsonObject(planText);
        const { commits, warnings } = normalizePlan(rawPlan, changedFiles, diffByPath);

        setStatus("Validating all commit groups in a temporary index…");
        await assertSnapshot(pi, root, run, run.indexTree);
        const prepared = await preflightPlan(pi, root, commits, diffByPath, run);
        await assertSnapshot(pi, root, run, run.indexTree);
        setStatus(undefined);
        const plan = formatPlan(commits, warnings, sensitiveSkipped);
        const confirmed = ctx.mode === "tui"
          ? await selectCommitAction(ctx, "Commit plan", plan, ["Yes", "No"]) === "Yes"
          : await ctx.ui.confirm("Commit plan", plan);
        if (!confirmed) {
          ctx.ui.notify("Cancelled", "info");
          return;
        }

        for (const [index, item] of prepared.entries()) {
          setStatus(`Committing ${index + 1}/${prepared.length}…`, [item.commit.subject]);
          const result = await executePreparedCommit(pi, root, item, run);
          if (result.code !== 0) {
            const errorOutput = resultText(result) || "git commit failed";
            setStatus(undefined);
            const resolution = await resolveCommitFailure(pi, root, item, index, prepared.length, errorOutput, run, ctx);
            if (resolution !== "committed") return;
          }
          completed.push(item.commit);
        }

        setStatus(undefined);

        if (completed.length === 0) {
          ctx.ui.notify("No commits were made", "info");
          return;
        }

        const pushSummary = await promptPushAfterCommits(pi, root, ctx, setStatus, () => assertSnapshot(pi, root, run, run.indexTree));
        const summary = formatCompletedCommits(completed);
        pi.sendMessage(
          {
            customType: "commit",
            content: `✓ Created ${completed.length} commit${completed.length === 1 ? "" : "s"}:\n\n${summary}\n\n${pushSummary.text}`,
            display: true,
            details: { status: pushSummary.failed ? "failed" : "success" },
          },
          { triggerTurn: false },
        );
        ctx.ui.notify(`Created ${completed.length} commit${completed.length === 1 ? "" : "s"}`, "info");
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        const retained = completed.length > 0 ? `\n${completed.length} earlier verified commit(s) were retained.` : "";
        ctx.ui.notify(`/commit failed: ${message}${retained}`, "error");
      } finally {
        if (sandbox) await rm(sandbox.directory, { recursive: true, force: true }).catch(() => {
          ctx.ui.notify(`Could not remove temporary commit index directory: ${sandbox.directory}`, "warning");
        });
        working.clear();
      }
    },
  });
}
