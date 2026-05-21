import { complete, type Message } from "@mariozechner/pi-ai";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Box, Text } from "@mariozechner/pi-tui";
import { open, stat, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { resolveMediumModel } from "./shared/model-slots.js";
import { createCommandWorking } from "./shared/command-working.js";

const MAX_DIFF_CHARS = 180_000;
const MAX_SESSION_CONTEXT_CHARS = 8_000;
const MAX_COMMIT_STYLE_CHARS = 12_000;
const MAX_COMMIT_STYLE_EXAMPLES = 20;
const MAX_UNTRACKED_FILE_BYTES = 24_000;
const MAX_UNTRACKED_TOTAL_BYTES = 90_000;
const MAX_SUBJECT_LENGTH = 120;

const SENSITIVE_EXCLUDE_PATHS = [
  ":(exclude).env",
  ":(exclude).env.*",
  ":(exclude)**/.env",
  ":(exclude)**/.env.*",
  ":(exclude)agent/auth.json",
];

const PLAN_SYSTEM_PROMPT = `You create a safe git commit plan for an existing working tree.

Return ONLY valid JSON, no markdown fences:
{
  "commits": [
    {
      "subject": "type(scope): short imperative summary",
      "description": "optional why/context, or empty string",
      "files": {
        "path/file.ts": "all",
        "path/other.ts": [0, 2]
      }
    }
  ]
}

Rules:
- Group changes by PURPOSE and dependency, not by file extension.
- Use Conventional Commits: feat, fix, refactor, chore, docs, style, test, perf, ci, build.
- Match "Author commit style examples" when provided: language, scope granularity, and description usage.
- Still keep the subject in Conventional Commit form; do not copy merge, PR, issue-number suffixes, or co-author trailers from examples.
- Leave description empty for simple commits; when used, explain why/context/details without repeating the subject.
- Do not include issue tracker tags.
- Every commit must be independently buildable/runnable.
- Never split tightly coupled changes, shared interfaces, imports/usages, or renames across separate commits.
- Prefer fewer safe commits over many brittle commits.
- Use "all" for whole-file changes.
- Use hunk index arrays only when one file contains clearly independent changes.
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
}

interface PlanCommit {
  subject: string;
  description: string;
  files: Record<string, FileSpec>;
}

interface UntrackedPreview {
  path: string;
  preview: string;
  note?: string;
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

function isProbablyText(buffer: Buffer): boolean {
  if (buffer.length === 0) return true;
  if (buffer.includes(0)) return false;
  const sample = buffer.subarray(0, Math.min(buffer.length, 4000));
  let control = 0;
  for (const byte of sample) {
    if (byte < 32 && byte !== 9 && byte !== 10 && byte !== 13) control++;
  }
  return control / sample.length < 0.02;
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

function buildSessionContext(ctx: any): string {
  const branch = ctx.sessionManager?.getBranch?.();
  if (!Array.isArray(branch)) return "";

  const entries = branch
    .filter((entry: any) => entry?.type === "message" && entry.message)
    .slice(-10)
    .map((entry: any) => {
      const message = entry.message;
      const role = typeof message.role === "string" ? message.role : "message";
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
  const match = line.match(/^diff --git (.+) (.+)$/);
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

    const deleted = /^deleted file mode /m.test(chunk);
    const path = deleted ? paths.oldPath : paths.newPath;
    const parts = chunk.split(/(?=^@@ )/m);
    const hunks: Hunk[] = [];

    for (let index = 1; index < parts.length; index++) {
      const body = parts[index];
      const fingerprint = body
        .split("\n")
        .filter((line) => (line.startsWith("+") || line.startsWith("-")) && !line.startsWith("+++") && !line.startsWith("---"))
        .join("\n");
      hunks.push({ index: index - 1, body, fingerprint });
    }

    files.push({
      path,
      oldPath: paths.oldPath,
      header: parts[0],
      hunks,
      binary: /Binary files .* differ|GIT binary patch/m.test(chunk),
    });
  }
  return files.filter((file) => !isSensitivePath(file.path) && !isSensitivePath(file.oldPath));
}

function formatDiffForModel(files: DiffFile[], untracked: UntrackedPreview[]): string {
  const sections: string[] = [];
  for (const file of files) {
    let text = file.header;
    if (file.binary) text += "[binary file: stage only as whole file]\n";
    for (const hunk of file.hunks) text += `[hunk ${hunk.index}]\n${hunk.body}`;
    sections.push(text.trimEnd());
  }

  for (const item of untracked) {
    sections.push(`--- untracked file: ${item.path}${item.note ? ` (${item.note})` : ""} ---\n${item.preview}`.trimEnd());
  }

  return truncateText(sections.join("\n\n"), MAX_DIFF_CHARS, "[diff truncated; rely on status for full file list]");
}

function parseNulList(stdout: string): string[] {
  return stdout
    .split("\0")
    .map((item) => normalizeGitPath(item))
    .filter((item): item is string => !!item && !isSensitivePath(item));
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

async function readUntrackedPreviews(root: string, files: string[]): Promise<UntrackedPreview[]> {
  const previews: UntrackedPreview[] = [];
  let totalBytes = 0;

  for (const file of files) {
    if (isSensitivePath(file)) continue;
    const fullPath = join(root, file);
    try {
      const info = await stat(fullPath);
      if (!info.isFile()) continue;
      if (totalBytes >= MAX_UNTRACKED_TOTAL_BYTES) {
        previews.push({ path: file, preview: "", note: "preview omitted; total untracked preview budget reached" });
        continue;
      }

      const maxBytes = Math.min(MAX_UNTRACKED_FILE_BYTES, MAX_UNTRACKED_TOTAL_BYTES - totalBytes, info.size);
      const handle = await open(fullPath, "r");
      try {
        const buffer = Buffer.alloc(maxBytes);
        const { bytesRead } = await handle.read(buffer, 0, maxBytes, 0);
        const slice = buffer.subarray(0, bytesRead);
        if (!isProbablyText(slice)) {
          previews.push({ path: file, preview: "", note: `binary or non-text file, ${info.size} bytes` });
          continue;
        }

        totalBytes += slice.byteLength;
        previews.push({
          path: file,
          preview: new TextDecoder().decode(slice),
          note: info.size > slice.byteLength ? `preview truncated at ${slice.byteLength}/${info.size} bytes` : undefined,
        });
      } finally {
        await handle.close();
      }
    } catch (error) {
      previews.push({ path: file, preview: "", note: `could not read preview: ${error instanceof Error ? error.message : String(error)}` });
    }
  }

  return previews;
}

function normalizeSubject(subject: unknown): string {
  const raw = String(subject ?? "").replace(/\s+/g, " ").trim();
  const oneLine = raw || "chore: update changes";
  const conventional = /^(feat|fix|refactor|chore|docs|style|test|perf|ci|build)(\([^)]+\))?:\s+.+/i.test(oneLine)
    ? oneLine
    : `chore: ${oneLine.replace(/^(chore:\s*)?/i, "")}`;
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
  if (!file || file.binary || file.hunks.length === 0) return "all";

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
    const specs = commits
      .map((commit) => commit.files[file])
      .filter((spec): spec is FileSpec => spec !== undefined);

    if (specs.length === 0) {
      fallbackFiles[file] = "all";
      continue;
    }

    if (specs.includes("all")) continue;

    const diffFile = diffByPath.get(file);
    if (!diffFile || diffFile.hunks.length === 0) continue;

    const selected = new Set(specs.flatMap((spec) => Array.isArray(spec) ? spec : []));
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

  return { commits, warnings };
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

  lines.push("This will reset the git index and stage each commit group automatically. Working tree contents are not discarded.");
  return lines.join("\n");
}

async function git(pi: ExtensionAPI, root: string, args: string[], timeout = 60_000) {
  return pi.exec("git", args, { cwd: root, timeout });
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
): Promise<PushSummary> {
  const branch = await currentBranchName(pi, root);
  if (!branch) {
    ctx.ui.notify("Commits created; push skipped because HEAD is detached", "info");
    return { text: "✓ Push skipped (detached HEAD)", failed: false };
  }

  const upstream = await upstreamBranchName(pi, root);
  const target = upstream ?? `origin/${branch}`;
  const pushChoice = `Push to ${target} (Recommended)`;
  const choice = await ctx.ui.select(`Created commits on ${branch}. Push now?`, [pushChoice, "Skip push"]);
  if (choice !== pushChoice) return { text: "✓ Push skipped", failed: false };

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

async function hasStagedChanges(pi: ExtensionAPI, root: string): Promise<boolean> {
  const result = await git(pi, root, ["diff", "--cached", "--quiet", "--exit-code"], 10_000);
  return result.code === 1;
}

async function stageWholeFile(pi: ExtensionAPI, root: string, file: string, diffByPath: Map<string, DiffFile>): Promise<void> {
  const diffFile = diffByPath.get(file);
  const paths = diffFile && diffFile.oldPath !== diffFile.path ? [diffFile.oldPath, diffFile.path] : [file];
  await git(pi, root, ["add", "-A", "--", ...paths]);
}

async function stagePartialFile(pi: ExtensionAPI, root: string, file: string, hunks: number[], originalDiff: DiffFile): Promise<boolean> {
  const current = parseDiff((await git(pi, root, ["diff", "--no-ext-diff", "--no-color", "HEAD", "--", file])).stdout);
  const currentFile = current.find((item) => item.path === file || item.oldPath === file);
  if (!currentFile) return false;

  const selected: string[] = [];
  for (const index of hunks) {
    const originalHunk = originalDiff.hunks[index];
    if (!originalHunk) continue;
    const match = currentFile.hunks.find((hunk) => hunk.fingerprint === originalHunk.fingerprint);
    if (match) selected.push(match.body);
  }
  if (selected.length === 0) return false;

  const patch = `${currentFile.header}${selected.join("")}`;
  const patchPath = join(tmpdir(), `pi-commit-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}.patch`);
  await writeFile(patchPath, patch, "utf8");
  try {
    const result = await git(pi, root, ["apply", "--cached", patchPath]);
    return result.code === 0;
  } finally {
    await unlink(patchPath).catch(() => {});
  }
}

async function stageCommitFiles(pi: ExtensionAPI, root: string, commit: PlanCommit, diffByPath: Map<string, DiffFile>, ctx: any): Promise<void> {
  await git(pi, root, ["reset", "--quiet", "HEAD"]);

  for (const [file, spec] of Object.entries(commit.files)) {
    if (isSensitivePath(file)) continue;
    if (spec === "all") {
      await stageWholeFile(pi, root, file, diffByPath);
      continue;
    }

    const diffFile = diffByPath.get(file);
    const staged = diffFile ? await stagePartialFile(pi, root, file, spec, diffFile) : false;
    if (!staged) {
      ctx.ui.notify(`Could not stage selected hunks for ${file}; staging whole file`, "warning");
      await stageWholeFile(pi, root, file, diffByPath);
    }
  }
}

async function commitStaged(pi: ExtensionAPI, root: string, commit: PlanCommit, options?: { noVerify?: boolean }) {
  const args = ["commit", "-m", commit.subject];
  if (commit.description) args.push("-m", commit.description);
  if (options?.noVerify) args.push("--no-verify");
  return git(pi, root, args, 120_000);
}

function resultText(result: { stdout: string; stderr: string }): string {
  return [result.stdout, result.stderr].filter(Boolean).join("\n").trim();
}

type CommitFailureResolution = "committed" | "skip" | "abort" | "fix";

function formatCommitFailurePrompt(index: number, total: number, commit: PlanCommit, errorOutput: string): string {
  return [
    `Commit ${index + 1}/${total} failed`,
    "",
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
  commit: PlanCommit,
  index: number,
  total: number,
  initialErrorOutput: string,
  diffByPath: Map<string, DiffFile>,
  ctx: any,
): Promise<CommitFailureResolution> {
  let errorOutput = initialErrorOutput || "git commit failed";

  while (true) {
    await git(pi, root, ["reset", "--quiet", "HEAD"]);
    const choice = await ctx.ui.select(formatCommitFailurePrompt(index, total, commit, errorOutput), [
      "Fix with agent (Recommended)",
      "Retry",
      "Retry --no-verify",
      "Skip this commit",
      "Abort remaining commits",
    ]);

    if (choice === "Retry" || choice === "Retry --no-verify") {
      await stageCommitFiles(pi, root, commit, diffByPath, ctx);
      if (!(await hasStagedChanges(pi, root))) {
        errorOutput = "Retry produced no staged changes for this commit.";
        continue;
      }

      const retry = await commitStaged(pi, root, commit, { noVerify: choice === "Retry --no-verify" });
      if (retry.code === 0) return "committed";
      errorOutput = resultText(retry) || "git commit failed";
      continue;
    }

    if (choice === "Skip this commit") {
      await git(pi, root, ["reset", "--quiet", "HEAD"]);
      ctx.ui.notify(`Skipped commit: ${commit.subject}`, "warning");
      return "skip";
    }

    if (choice === "Fix with agent (Recommended)") {
      await git(pi, root, ["reset", "--quiet", "HEAD"]);
      pi.sendUserMessage(`The /commit command failed while creating commit \"${commit.subject}\". Please fix the issue, then run /commit again.\n\n\`\`\`\n${errorOutput}\n\`\`\``);
      return "fix";
    }

    await git(pi, root, ["reset", "--quiet", "HEAD"]);
    ctx.ui.notify("Aborted remaining commits", "info");
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
  const resolved = await resolveMediumModel(ctx);
  const messages: Message[] = [{
    role: "user",
    content: [{ type: "text", text: input }],
    timestamp: Date.now(),
  } as Message];

  const response = await complete(
    resolved.model,
    { systemPrompt: PLAN_SYSTEM_PROMPT, messages },
    { apiKey: resolved.auth.apiKey, headers: resolved.auth.headers },
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

      const working = createCommandWorking(ctx, "commit", "Commit");
      const setStatus = (text: string | undefined, details: string[] = []) => {
        working.set(text, details);
      };

      try {
        setStatus("Gathering changes…");
        const pathspec = ["--", ".", ...SENSITIVE_EXCLUDE_PATHS];
        const [log, status, statusAll, diff, untrackedRaw, authorStyleExamples] = await Promise.all([
          git(pi, root, ["log", "-6", "--format=%s%n%b---"], 10_000),
          git(pi, root, ["status", "--short", ...pathspec], 20_000),
          git(pi, root, ["status", "--short"], 20_000),
          git(pi, root, ["diff", "--no-ext-diff", "--no-color", "HEAD", ...pathspec], 60_000),
          git(pi, root, ["ls-files", "--others", "--exclude-standard", "-z", ...pathspec], 20_000),
          readAuthorCommitStyleExamples(pi, root),
        ]);

        const diffFiles = parseDiff(diff.stdout);
        const untrackedFiles = parseNulList(untrackedRaw.stdout);
        const changedFiles = new Set<string>([...diffFiles.map((file) => file.path), ...untrackedFiles]);
        const sensitiveSkipped = [...new Set(parseSensitiveStatusPaths(statusAll.stdout))];

        if (changedFiles.size === 0) {
          setStatus(undefined);
          ctx.ui.notify(sensitiveSkipped.length > 0 ? "Only sensitive files changed; nothing safe to commit" : "No changes to commit", "info");
          return;
        }

        const stagedAlready = await hasStagedChanges(pi, root);
        if (stagedAlready) {
          const ok = await ctx.ui.confirm(
            "Reset staged changes?",
            "/commit creates its own staging groups from the full working tree. Existing staged changes will be unstaged first; file contents are not discarded.",
          );
          if (!ok) {
            setStatus(undefined);
            ctx.ui.notify("Cancelled", "info");
            return;
          }
        }

        const untrackedPreviews = await readUntrackedPreviews(root, untrackedFiles);
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
          `## Diff and untracked previews\n${formatDiffForModel(diffFiles, untrackedPreviews)}`,
        ].filter(Boolean).join("\n\n");

        setStatus("Planning commits with medium model…");
        const { text: planText } = await createPlan(ctx, modelInput);
        const rawPlan = extractJsonObject(planText);
        const { commits, warnings } = normalizePlan(rawPlan, changedFiles, diffByPath);

        setStatus(undefined);
        const confirmed = await ctx.ui.confirm("Commit plan", formatPlan(commits, warnings, sensitiveSkipped));
        if (!confirmed) {
          ctx.ui.notify("Cancelled", "info");
          return;
        }

        const completed: PlanCommit[] = [];
        for (const [index, commit] of commits.entries()) {
          setStatus(`Committing ${index + 1}/${commits.length}…`, [commit.subject]);
          await stageCommitFiles(pi, root, commit, diffByPath, ctx);

          if (!(await hasStagedChanges(pi, root))) {
            ctx.ui.notify(`Skipping empty commit: ${commit.subject}`, "warning");
            continue;
          }

          let result = await commitStaged(pi, root, commit);
          if (result.code !== 0) {
            const dirtyNames = parseNulList((await git(pi, root, ["diff", "--name-only", "-z"])).stdout);
            const commitFiles = new Set(Object.keys(commit.files));
            const touchedCommitFiles = dirtyNames.filter((file) => commitFiles.has(file));
            if (touchedCommitFiles.length > 0) {
              for (const file of touchedCommitFiles) await stageWholeFile(pi, root, file, diffByPath);
              result = await commitStaged(pi, root, commit);
            }
          }

          if (result.code !== 0) {
            const errorOutput = resultText(result) || "git commit failed";
            setStatus(undefined);
            const resolution = await resolveCommitFailure(pi, root, commit, index, commits.length, errorOutput, diffByPath, ctx);
            if (resolution === "committed") {
              completed.push(commit);
              continue;
            }
            if (resolution === "skip") continue;
            return;
          }

          completed.push(commit);
        }

        await git(pi, root, ["reset", "--quiet", "HEAD"]);
        setStatus(undefined);

        if (completed.length === 0) {
          ctx.ui.notify("No commits were made", "info");
          return;
        }

        const pushSummary = await promptPushAfterCommits(pi, root, ctx, setStatus);
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
        ctx.ui.notify(`/commit failed: ${message}`, "error");
      } finally {
        working.clear();
      }
    },
  });
}
