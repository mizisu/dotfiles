import { DynamicBorder, type ExtensionAPI } from "@mariozechner/pi-coding-agent";
import {
  Input,
  Key,
  SelectList,
  fuzzyFilter,
  matchesKey,
  wrapTextWithAnsi,
  type Component,
  type Focusable,
  type SelectItem,
} from "@mariozechner/pi-tui";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createCommandWorking } from "./shared/command-working.js";

const REVIEW_TIMEOUT = 900_000;
const MAX_ERROR_CHARS = 4_000;
const PREVIEW_SCROLL_STEP = 8;
const CODEX_REVIEW_GUARDRAILS = `Review behavior constraints:
- Do not run manual lint/format/typecheck commands unless explicitly requested, LSP reports errors, or non-LSP tests/validation are required.
- Treat successful edit/write results without LSP errors as LSP-clean.
- Never run repo-wide checks (e.g. pyright ., eslint ., ruff ., full-project formatters) unless explicitly asked; if validation is needed, use the smallest targeted command.`;

type ReviewSource = "coderabbit" | "codex";
type ReviewScope = "base" | "uncommitted" | "commit";

interface ParsedArgs {
  base?: string;
  scope?: ReviewScope;
  commit?: string;
  instructions?: string;
  codexEffort: "high" | "xhigh";
}

interface ReviewConfig {
  root: string;
  scope: ReviewScope;
  base?: string;
  baseRef?: string;
  commit?: string;
  instructions?: string;
  codexEffort: "high" | "xhigh";
}

interface ReviewFinding {
  id: string;
  source: ReviewSource;
  severity?: string;
  title: string;
  file?: string;
  content: string;
}

interface ReviewRunResult {
  source: ReviewSource;
  findings: ReviewFinding[];
  raw: string;
  error?: string;
  skipped?: string;
}

interface PickerResult {
  findings: ReviewFinding[];
  comment?: string;
}

function truncate(value: string, maxChars = MAX_ERROR_CHARS): string {
  const trimmed = value.trim();
  if (trimmed.length <= maxChars) return trimmed;
  return `${trimmed.slice(0, maxChars - 20).trimEnd()}\n… truncated …`;
}

function sourceLabel(source: ReviewSource): string {
  return source === "coderabbit" ? "CR" : "Codex";
}

function sourceName(source: ReviewSource): string {
  return source === "coderabbit" ? "CodeRabbit" : "Codex";
}

function normalizeBranch(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  if (!trimmed) return undefined;
  return trimmed.replace(/^origin\//, "");
}

function parseArgs(args: string | undefined): ParsedArgs {
  const tokens = (args ?? "").trim().split(/\s+/).filter(Boolean);
  const instructions: string[] = [];
  const parsed: ParsedArgs = { codexEffort: "high" };
  let baseConsumed = false;

  for (let index = 0; index < tokens.length; index++) {
    const token = tokens[index];
    if (token === "--xhigh") {
      parsed.codexEffort = "xhigh";
      continue;
    }
    if (token === "--uncommitted") {
      parsed.scope = "uncommitted";
      continue;
    }
    if (token === "--commit") {
      parsed.scope = "commit";
      parsed.commit = tokens[++index];
      continue;
    }
    if (token === "--base") {
      parsed.base = normalizeBranch(tokens[++index]);
      baseConsumed = true;
      continue;
    }
    if (token === "--") {
      instructions.push(...tokens.slice(index + 1));
      break;
    }

    if (!baseConsumed && !parsed.scope && !parsed.base && !token.startsWith("-")) {
      parsed.base = normalizeBranch(token);
      baseConsumed = true;
      continue;
    }

    instructions.push(token);
  }

  parsed.instructions = instructions.join(" ").trim() || undefined;
  return parsed;
}

async function git(pi: ExtensionAPI, root: string, args: string[], timeout = 60_000) {
  return pi.exec("git", args, { cwd: root, timeout });
}

async function gitRoot(pi: ExtensionAPI, cwd: string): Promise<string | undefined> {
  const result = await pi.exec("git", ["rev-parse", "--show-toplevel"], { cwd, timeout: 10_000 });
  if (result.code !== 0) return undefined;
  return result.stdout.trim() || undefined;
}

async function currentBranch(pi: ExtensionAPI, root: string): Promise<string | undefined> {
  const result = await git(pi, root, ["branch", "--show-current"], 10_000);
  return result.code === 0 ? result.stdout.trim() || undefined : undefined;
}

async function remoteBranches(pi: ExtensionAPI, root: string): Promise<string[]> {
  const result = await git(pi, root, ["branch", "-r", "--sort=-committerdate", "--format=%(refname:short)"], 10_000);
  if (result.code !== 0) return [];
  return [...new Set(result.stdout
    .split("\n")
    .map((branch) => normalizeBranch(branch))
    .filter((branch): branch is string => !!branch && branch !== "HEAD" && !branch.includes("/HEAD")))];
}

async function suggestedBaseBranch(pi: ExtensionAPI, root: string, branches: string[]): Promise<string | undefined> {
  const [current, remoteTips, history] = await Promise.all([
    currentBranch(pi, root),
    git(pi, root, ["for-each-ref", "--format=%(refname:short) %(objectname)", "refs/remotes/origin"], 10_000),
    git(pi, root, ["rev-list", "--first-parent", "HEAD"], 10_000),
  ]);

  if (!current || remoteTips.code !== 0 || history.code !== 0) return branches.includes("main") ? "main" : branches[0];

  const historyIndex = new Map<string, number>();
  for (const [index, sha] of history.stdout.split("\n").filter(Boolean).entries()) historyIndex.set(sha, index);
  const branchOrder = new Map(branches.map((branch, index) => [branch, index]));
  let best: { branch: string; distance: number; order: number } | undefined;

  for (const line of remoteTips.stdout.split("\n").filter(Boolean)) {
    const [ref, sha] = line.trim().split(/\s+/, 2);
    const branch = normalizeBranch(ref);
    if (!branch || branch === current || !sha || !branchOrder.has(branch)) continue;
    const distance = historyIndex.get(sha);
    if (distance === undefined) continue;
    const order = branchOrder.get(branch)!;
    if (!best || distance < best.distance || (distance === best.distance && order < best.order)) {
      best = { branch, distance, order };
    }
  }

  return best?.branch ?? (branches.includes("main") ? "main" : branches[0]);
}

function branchPriority(branch: string, query: string): number {
  const value = branch.toLowerCase();
  const q = query.toLowerCase();
  const leaf = value.split("/").at(-1) ?? value;
  if (value === q) return 0;
  if (leaf === q) return 1;
  if (value.endsWith(`/${q}`)) return 2;
  if (value.startsWith(`${q}/`)) return 3;
  if (leaf.startsWith(q)) return 4;
  if (value.includes(q)) return 5;
  return 6;
}

function filterBranchItems(items: SelectItem[], query: string): SelectItem[] {
  const matches = fuzzyFilter(items, query, (item) => item.value);
  const originalOrder = new Map(matches.map((item, index) => [item.value, index]));
  return [...matches].sort((a, b) => {
    const priority = branchPriority(a.value, query) - branchPriority(b.value, query);
    return priority || ((originalOrder.get(a.value) ?? 0) - (originalOrder.get(b.value) ?? 0));
  });
}

async function openBaseBranchPicker(
  pi: ExtensionAPI,
  root: string,
  ctx: any,
  preferred?: { branch: string; description: string },
): Promise<string | undefined> {
  const remote = await remoteBranches(pi, root);
  const branches = preferred?.branch && !remote.includes(preferred.branch)
    ? [preferred.branch, ...remote]
    : remote;
  if (branches.length === 0) {
    ctx.ui.notify("No origin remote branches found", "warning");
    return undefined;
  }

  const suggested = preferred?.branch ?? await suggestedBaseBranch(pi, root, branches);
  const suggestedNote = preferred?.branch
    ? `${preferred.description}: ${preferred.branch}`
    : suggested
      ? `suggested base: ${suggested}`
      : undefined;
  const allItems = branches.map((branch) => ({
    value: branch,
    label: branch,
  }));

  return ctx.ui.custom<string | undefined>((tui: any, theme: any, _kb: any, done: (value: string | undefined) => void) => {
    const maxVisible = Math.min(20, Math.max(6, (tui.terminal.rows || 24) - 8));
    const borderTop = new DynamicBorder((text: string) => theme.fg("accent", text));
    const borderBottom = new DynamicBorder((text: string) => theme.fg("accent", text));
    const input = new Input();
    input.focused = true;

    const listTheme = {
      selectedPrefix: (text: string) => theme.fg("accent", text),
      selectedText: (text: string) => theme.fg("accent", text),
      description: (text: string) => theme.fg("muted", text),
      scrollInfo: (text: string) => theme.fg("dim", text),
      noMatch: () => theme.fg("warning", "  No matching branches"),
    };

    let items = allItems;
    let list = new SelectList(items, maxVisible, listTheme);
    const selectDefault = () => {
      const value = input.getValue().trim() ? items[0]?.value : suggested;
      const index = value ? items.findIndex((item) => item.value === value) : -1;
      if (index >= 0) list.setSelectedIndex(index);
    };
    selectDefault();

    let focused = true;
    const component: Component & Focusable = {
      get focused() { return focused; },
      set focused(value: boolean) { focused = value; input.focused = value; },
      render(width: number): string[] {
        const lines = [
          ...borderTop.render(width),
          ` ${theme.fg("accent", theme.bold("Review base branch"))}${theme.fg("dim", ` ${items.length}/${branches.length}`)}`,
          ...(suggestedNote ? [` ${theme.fg("dim", suggestedNote)}`] : []),
          "",
          ...input.render(width - 2).map((line) => ` ${line}`),
          theme.fg("dim", ` ${"─".repeat(Math.max(1, width - 2))}`),
          ...list.render(width),
          "",
          ` ${theme.fg("dim", "↑↓")} navigate  ${theme.fg("dim", "enter")} select  ${theme.fg("dim", "esc")} cancel`,
          ...borderBottom.render(width),
        ];
        return lines;
      },
      invalidate() {
        borderTop.invalidate();
        borderBottom.invalidate();
        input.invalidate();
        list.invalidate();
      },
      handleInput(data: string) {
        if (matchesKey(data, Key.escape) || matchesKey(data, Key.ctrl("c"))) return done(undefined);
        if (matchesKey(data, Key.enter)) return done(list.getSelectedItem()?.value);
        if (matchesKey(data, Key.up) || matchesKey(data, Key.down) || matchesKey(data, Key.pageUp) || matchesKey(data, Key.pageDown)) {
          list.handleInput(data);
          tui.requestRender();
          return;
        }
        input.handleInput(data);
        const query = input.getValue().trim();
        items = query ? filterBranchItems(allItems, query) : allItems;
        list = new SelectList(items, maxVisible, listTheme);
        selectDefault();
        tui.requestRender();
      },
    };

    return component;
  }, { overlay: true });
}

async function detectPrBase(pi: ExtensionAPI, root: string): Promise<string | undefined> {
  const result = await pi.exec("gh", ["pr", "view", "--json", "baseRefName", "--jq", ".baseRefName"], { cwd: root, timeout: 15_000 });
  if (result.code !== 0) return undefined;
  return normalizeBranch(result.stdout);
}

async function chooseScope(ctx: any, parsed: ParsedArgs, dirtySummary: string): Promise<ReviewScope | undefined> {
  if (parsed.scope) return parsed.scope;
  const options = [
    "Branch commits vs base (Recommended)",
    dirtySummary ? `Uncommitted changes (${dirtySummary})` : "Uncommitted changes",
    "Single commit",
  ];
  const choice = await ctx.ui.select("What should /review inspect?", options);
  if (!choice) return undefined;
  if (choice.startsWith("Uncommitted")) return "uncommitted";
  if (choice.startsWith("Single")) return "commit";
  return "base";
}

async function chooseBase(pi: ExtensionAPI, root: string, ctx: any, parsed: ParsedArgs): Promise<string | undefined> {
  const explicit = normalizeBranch(parsed.base);
  if (explicit) return explicit;

  const prBase = await detectPrBase(pi, root);
  return openBaseBranchPicker(
    pi,
    root,
    ctx,
    prBase ? { branch: prBase, description: "detected PR base" } : undefined,
  );
}

async function chooseCommit(pi: ExtensionAPI, root: string, ctx: any, parsed: ParsedArgs): Promise<string | undefined> {
  if (parsed.commit?.trim()) return parsed.commit.trim();
  const latest = await git(pi, root, ["log", "--oneline", "-n", "10"], 10_000);
  const prompt = latest.code === 0 && latest.stdout.trim()
    ? `Commit SHA to review\n\nRecent commits:\n${latest.stdout.trim()}`
    : "Commit SHA to review";
  const value = await ctx.ui.input(prompt, "HEAD");
  return value?.trim() || undefined;
}

async function resolveBaseRef(pi: ExtensionAPI, root: string, base: string): Promise<string | undefined> {
  await git(pi, root, ["fetch", "--quiet", "origin", base], 60_000).catch(() => undefined);
  const remote = `origin/${base}`;
  const remoteCheck = await git(pi, root, ["rev-parse", "--verify", remote], 10_000);
  if (remoteCheck.code === 0) return remote;
  const localCheck = await git(pi, root, ["rev-parse", "--verify", base], 10_000);
  if (localCheck.code === 0) return base;
  return undefined;
}

function parseStatusPaths(stdout: string): string[] {
  const entries = stdout.split("\0").filter(Boolean);
  const paths: string[] = [];
  for (let index = 0; index < entries.length; index++) {
    const entry = entries[index];
    const status = entry.slice(0, 2);
    const path = entry.slice(3).trim();
    if (path) paths.push(path);
    if ((status.includes("R") || status.includes("C")) && entries[index + 1]) {
      paths.push(entries[++index].trim());
    }
  }
  return paths;
}

function isSensitivePath(filePath: string): boolean {
  const normalized = filePath.replace(/\\/g, "/").replace(/^\.\//, "");
  return normalized === ".env"
    || normalized.startsWith(".env.")
    || normalized.includes("/.env")
    || normalized === "agent/auth.json";
}

async function changedPaths(pi: ExtensionAPI, config: ReviewConfig): Promise<string[]> {
  if (config.scope === "uncommitted") {
    const result = await git(pi, config.root, ["status", "--porcelain=v1", "-z"], 20_000);
    return result.code === 0 ? parseStatusPaths(result.stdout) : [];
  }

  if (config.scope === "commit") {
    const result = await git(pi, config.root, ["diff-tree", "--no-commit-id", "--name-only", "-r", "-z", config.commit!], 20_000);
    return result.code === 0 ? result.stdout.split("\0").filter(Boolean) : [];
  }

  const result = await git(pi, config.root, ["diff", "--name-only", "-z", `${config.baseRef}...HEAD`, "--"], 20_000);
  return result.code === 0 ? result.stdout.split("\0").filter(Boolean) : [];
}

async function validateReviewScope(pi: ExtensionAPI, config: ReviewConfig): Promise<string | undefined> {
  if (config.scope === "base" && !config.baseRef) return "Base branch is not resolved.";
  if (config.scope === "commit") {
    const commitCheck = await git(pi, config.root, ["rev-parse", "--verify", `${config.commit}^{commit}`], 10_000);
    if (commitCheck.code !== 0) return `Commit not found: ${config.commit}`;
  }

  const paths = await changedPaths(pi, config);
  if (paths.length === 0) return "No changes found for the selected review scope.";

  const sensitive = paths.filter(isSensitivePath);
  if (sensitive.length > 0) {
    return `Review blocked because sensitive files are included in this scope:\n${sensitive.join("\n")}`;
  }

  return undefined;
}

function detectSeverity(content: string): string | undefined {
  const priority = content.match(/\[(P[0-4])\]/i)?.[1];
  if (priority) return priority.toUpperCase();
  const label = content.match(/\b(CRITICAL|HIGH|MEDIUM|LOW)\b/i)?.[1];
  return label?.toUpperCase();
}

function detectFile(content: string): string | undefined {
  const fileHeader = content.match(/^File:\s*(.+)$/m)?.[1]?.trim();
  if (fileHeader) return fileHeader;
  const codePath = content.match(/`([^`\n]+\.[\w.-]+(?::\d+)?)`/)?.[1]?.trim();
  if (codePath) return codePath;
  const loosePath = content.match(/(^|\s)((?:[\w@.-]+\/)+[\w@.-]+\.[\w.-]+(?::\d+)?)/)?.[2]?.trim();
  return loosePath;
}

function firstUsefulLine(content: string): string {
  for (const line of content.split("\n")) {
    const trimmed = line.trim().replace(/^[-*]\s+/, "");
    if (!trimmed) continue;
    if (/^File:\s*/i.test(trimmed)) continue;
    if (/^[-=]{3,}$/.test(trimmed)) continue;
    if (/^#{1,6}\s*$/.test(trimmed)) continue;
    return trimmed.replace(/^#{1,6}\s+/, "");
  }
  return "Review finding";
}

function cleanTitle(content: string, fallback: string): string {
  const line = firstUsefulLine(content) || fallback;
  return line
    .replace(/^\[(P[0-4])\]\s*/i, "")
    .replace(/^\*\*(.*?)\*\*:?\s*/, "$1 ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 120) || fallback;
}

function looksLikeCleanReview(output: string): boolean {
  const text = output.toLowerCase();
  return /no (meaningful |actionable |discrete |correctness |critical )*(issues|findings|problems)/.test(text)
    || /did not find (any )?(meaningful |actionable |discrete |correctness |critical )*(issues|findings|problems)/.test(text)
    || /didn't find (any )?(meaningful |actionable |discrete |correctness |critical )*(issues|findings|problems)/.test(text)
    || /no changes to review/.test(text)
    || /nothing to review/.test(text)
    || /looks good/.test(text);
}

function makeFinding(source: ReviewSource, index: number, content: string, fallbackTitle: string): ReviewFinding {
  const trimmed = content.trim();
  return {
    id: `${source}-${index}`,
    source,
    severity: detectSeverity(trimmed),
    title: cleanTitle(trimmed, fallbackTitle),
    file: detectFile(trimmed),
    content: trimmed,
  };
}

function splitByLineStarts(output: string, pattern: RegExp): string[] {
  const matches = [...output.matchAll(pattern)];
  if (matches.length === 0) return [];
  return matches.map((match, index) => {
    const start = match.index ?? 0;
    const end = index + 1 < matches.length ? matches[index + 1].index! : output.length;
    return output.slice(start, end).trim();
  }).filter(Boolean);
}

function parseReviewFindings(source: ReviewSource, output: string): ReviewFinding[] {
  const trimmed = output.trim();
  if (!trimmed || looksLikeCleanReview(trimmed)) return [];

  const priorityBlocks = splitByLineStarts(trimmed, /^(?:[-*]\s*)?\[(P[0-4])\]\s+.+$/gim);
  const blocks = priorityBlocks.length > 0
    ? priorityBlocks
    : splitByLineStarts(trimmed, /^File:\s*.+$/gm);

  const sections = blocks.length > 0
    ? blocks
    : splitByLineStarts(trimmed, /^#{2,4}\s+.+$/gm);

  const finalSections = sections.length > 0
    ? sections
    : trimmed.split(/\n={3,}\n|\n-{3,}\n/).map((section) => section.trim()).filter(Boolean);

  const usable = finalSections.length > 1 ? finalSections : [trimmed];
  return usable.map((section, index) => makeFinding(source, index, section, `${sourceName(source)} review`));
}

function formatDuration(ms: number): string {
  const minutes = Math.round(ms / 60_000);
  return minutes > 0 ? `${minutes}m` : `${Math.round(ms / 1000)}s`;
}

function runErrorText(result: Awaited<ReturnType<ExtensionAPI["exec"]>>): string {
  return truncate([result.stdout, result.stderr].filter(Boolean).join("\n"));
}

function executionFailureText(label: string, result: Awaited<ReturnType<ExtensionAPI["exec"]>>, timeoutMs: number): string {
  const killed = Boolean((result as any).killed);
  const code = typeof result.code === "number" ? String(result.code) : "unknown";
  const stdout = result.stdout.trim();
  const stderr = result.stderr.trim();
  const header = killed
    ? `${label} timed out after ${formatDuration(timeoutMs)}.`
    : `${label} exited with code ${code}.`;

  const parts = [header];
  if (stderr) parts.push(`stderr:\n${truncate(stderr)}`);
  if (stdout) parts.push(`${stderr ? "stdout" : "output"}:\n${truncate(stdout)}`);
  return parts.join("\n\n");
}

async function runCodeRabbitReview(pi: ExtensionAPI, config: ReviewConfig): Promise<ReviewRunResult> {
  let cwd = config.root;
  let cleanup: (() => Promise<void>) | undefined;

  try {
    const args = ["review", "--plain", "--no-color"];

    if (config.scope === "base") {
      args.push("--type", "committed", "--base", config.base!);
    } else if (config.scope === "uncommitted") {
      args.push("--type", "uncommitted");
    } else {
      const parent = await git(pi, config.root, ["rev-parse", "--verify", `${config.commit}^`], 10_000);
      if (parent.code !== 0) {
        return { source: "coderabbit", findings: [], raw: "", skipped: "CodeRabbit commit review requires a non-root commit with a parent." };
      }

      const worktree = await mkdtemp(join(tmpdir(), "pi-review-cr-"));
      cleanup = async () => {
        await git(pi, config.root, ["worktree", "remove", "--force", worktree], 60_000).catch(() => undefined);
        await rm(worktree, { recursive: true, force: true }).catch(() => undefined);
      };
      const add = await git(pi, config.root, ["worktree", "add", "--detach", worktree, config.commit!], 120_000);
      if (add.code !== 0) return { source: "coderabbit", findings: [], raw: "", error: `CodeRabbit worktree setup failed:\n${runErrorText(add)}` };
      cwd = worktree;
      args.push("--type", "committed", "--base-commit", parent.stdout.trim());
    }

    const result = await pi.exec("cr", args, { cwd, timeout: REVIEW_TIMEOUT });
    const raw = result.stdout.trim();
    if (result.code !== 0) {
      return { source: "coderabbit", findings: [], raw, error: executionFailureText("CodeRabbit review", result, REVIEW_TIMEOUT) };
    }
    return { source: "coderabbit", findings: parseReviewFindings("coderabbit", raw), raw };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { source: "coderabbit", findings: [], raw: "", error: `CodeRabbit review failed: ${message}` };
  } finally {
    await cleanup?.();
  }
}

function buildCodexPrompt(instructions?: string): string {
  return instructions
    ? `${CODEX_REVIEW_GUARDRAILS}\n\nAdditional review focus:\n${instructions}`
    : CODEX_REVIEW_GUARDRAILS;
}

async function runCodexReview(pi: ExtensionAPI, config: ReviewConfig): Promise<ReviewRunResult> {
  try {
    const args = [
      "review",
      "-c",
      `model_reasoning_effort=\"${config.codexEffort}\"`,
      "--enable",
      "web_search_cached",
    ];

    if (config.scope === "base") args.push("--base", config.base!);
    else if (config.scope === "uncommitted") args.push("--uncommitted");
    else args.push("--commit", config.commit!);

    args.push("--", buildCodexPrompt(config.instructions));

    const result = await pi.exec("codex", args, { cwd: config.root, timeout: REVIEW_TIMEOUT });
    const raw = result.stdout.trim();
    if (result.code !== 0) {
      return { source: "codex", findings: [], raw, error: executionFailureText("Codex review", result, REVIEW_TIMEOUT) };
    }
    return { source: "codex", findings: parseReviewFindings("codex", raw), raw };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { source: "codex", findings: [], raw: "", error: `Codex review failed: ${message}` };
  }
}

function findingDescription(finding: ReviewFinding): string {
  return [finding.severity, finding.file].filter(Boolean).join(" • ");
}

function resultSummary(results: ReviewRunResult[]): string {
  return results.map((result) => {
    if (result.error) return `${sourceLabel(result.source)} failed`;
    if (result.skipped) return `${sourceLabel(result.source)} skipped`;
    return `${sourceLabel(result.source)} ${result.findings.length}`;
  }).join("  ");
}

function selectedSorted(selected: Set<string>, findings: ReviewFinding[]): ReviewFinding[] {
  const indexById = new Map(findings.map((finding, index) => [finding.id, index]));
  return [...selected]
    .sort((a, b) => (indexById.get(a) ?? 0) - (indexById.get(b) ?? 0))
    .map((id) => findings.find((finding) => finding.id === id))
    .filter((finding): finding is ReviewFinding => !!finding);
}

async function showReviewPicker(ctx: any, findings: ReviewFinding[], results: ReviewRunResult[]): Promise<PickerResult | undefined> {
  return ctx.ui.custom<PickerResult | undefined>((tui: any, theme: any, _kb: any, done: (value: PickerResult | undefined) => void) => {
    const terminalRows = tui.terminal.rows || 24;
    const maxVisible = Math.min(Math.max(3, findings.length), Math.max(3, Math.min(6, Math.floor((terminalRows - 10) * 0.25))));
    const borderTop = new DynamicBorder((text: string) => theme.fg("accent", text));
    const borderBottom = new DynamicBorder((text: string) => theme.fg("accent", text));
    const selected = new Set<string>();
    const commentInput = new Input();
    let mode: "select" | "comment" = "select";
    let focused = true;
    let previewScroll = 0;

    const items: SelectItem[] = findings.map((finding) => ({
      value: finding.id,
      label: `[${sourceLabel(finding.source)}] ${finding.title}`,
      description: findingDescription(finding),
    }));

    const listTheme = {
      selectedPrefix: (text: string) => theme.fg("accent", text),
      selectedText: (text: string) => theme.fg("accent", text),
      description: (text: string) => theme.fg("muted", text),
      scrollInfo: (text: string) => theme.fg("dim", text),
      noMatch: () => theme.fg("warning", "  No findings"),
    };

    const list = new SelectList(items, maxVisible, listTheme, {
      truncatePrimary: ({ text, maxWidth, item }: any) => {
        const icon = selected.has(item.value) ? theme.fg("success", "◉ ") : theme.fg("dim", "○ ");
        const available = Math.max(1, maxWidth - 2);
        return icon + (text.length <= available ? text : `${text.slice(0, available - 1)}…`);
      },
    });

    const finish = () => {
      const chosen = selectedSorted(selected, findings);
      done(chosen.length > 0 ? { findings: chosen, comment: commentInput.getValue().trim() || undefined } : undefined);
    };

    const component: Component & Focusable = {
      get focused() { return focused; },
      set focused(value: boolean) { focused = value; commentInput.focused = value && mode === "comment"; },
      render(width: number): string[] {
        const lines: string[] = [];
        lines.push(...borderTop.render(width));
        lines.push(` ${theme.fg("accent", theme.bold("Review findings"))}${theme.fg("dim", ` ${selected.size}/${findings.length} selected  ${resultSummary(results)}`)}`);

        const problemLines = results
          .filter((result) => result.error || result.skipped)
          .map((result) => ` ${sourceLabel(result.source)}: ${truncate(result.error ?? result.skipped ?? "", 180).replace(/\n/g, " ")}`);
        for (const line of problemLines.slice(0, 2)) lines.push(theme.fg("warning", line));
        lines.push("");
        lines.push(...list.render(width));

        const item = list.getSelectedItem();
        const finding = item ? findings.find((candidate) => candidate.id === item.value) : undefined;
        if (finding) {
          lines.push(theme.fg("dim", ` ${"─".repeat(Math.max(1, width - 2))}`));
          lines.push(` ${theme.fg("accent", `[${sourceName(finding.source)}]`)} ${theme.fg("muted", [finding.severity, finding.file].filter(Boolean).join(" • "))}`);
          const wrapped = wrapTextWithAnsi(finding.content, Math.max(10, width - 4));
          const footerRows = mode === "comment" ? 5 : 3;
          const reservedRows = 1 + 1 + problemLines.slice(0, 2).length + 1 + maxVisible + 1 + 1 + footerRows + 1;
          const previewLineCount = Math.max(8, (tui.terminal.rows || 24) - reservedRows);
          previewScroll = Math.max(0, Math.min(previewScroll, Math.max(0, wrapped.length - previewLineCount)));
          const shown = wrapped.slice(previewScroll, previewScroll + previewLineCount);
          for (const line of shown) lines.push(`  ${theme.fg("text", line)}`);
          if (wrapped.length > previewLineCount) {
            const end = Math.min(wrapped.length, previewScroll + previewLineCount);
            lines.push(`  ${theme.fg("dim", `Preview ${previewScroll + 1}-${end}/${wrapped.length}  [ / ] scroll`)}`);
          }
        }

        if (mode === "comment") {
          lines.push(theme.fg("dim", ` ${"─".repeat(Math.max(1, width - 2))}`));
          lines.push(` ${theme.fg("accent", "Comment / focus note")}`);
          for (const line of commentInput.render(width - 4)) lines.push(`  ${line}`);
          lines.push(` ${theme.fg("dim", "enter")} apply  ${theme.fg("dim", "esc")} back`);
        } else {
          lines.push("");
          lines.push(` ${theme.fg("dim", "space")} toggle  ${theme.fg("dim", "a")} all  ${theme.fg("dim", "[ ]")} preview  ${theme.fg("dim", "c")} comment  ${theme.fg("dim", "enter")} apply  ${theme.fg("dim", "esc")} cancel`);
        }

        lines.push(...borderBottom.render(width));
        return lines;
      },
      invalidate() {
        borderTop.invalidate();
        borderBottom.invalidate();
        list.invalidate();
        commentInput.invalidate();
      },
      handleInput(data: string) {
        if (matchesKey(data, Key.ctrl("c"))) return done(undefined);
        if (mode === "comment") {
          if (matchesKey(data, Key.escape)) {
            mode = "select";
            commentInput.focused = false;
            tui.requestRender();
            return;
          }
          if (matchesKey(data, Key.enter)) return finish();
          commentInput.handleInput(data);
          tui.requestRender();
          return;
        }

        if (matchesKey(data, Key.escape)) return done(undefined);
        if (matchesKey(data, Key.enter)) return finish();
        if (matchesKey(data, Key.up) || matchesKey(data, Key.down) || matchesKey(data, Key.pageUp) || matchesKey(data, Key.pageDown)) {
          const before = list.getSelectedItem()?.value;
          list.handleInput(data);
          if (list.getSelectedItem()?.value !== before) previewScroll = 0;
          tui.requestRender();
          return;
        }
        if (data === "[" || data === "{") {
          previewScroll = Math.max(0, previewScroll - PREVIEW_SCROLL_STEP);
          tui.requestRender();
          return;
        }
        if (data === "]" || data === "}") {
          previewScroll += PREVIEW_SCROLL_STEP;
          tui.requestRender();
          return;
        }
        if (data === " ") {
          const current = list.getSelectedItem();
          if (current) {
            if (selected.has(current.value)) selected.delete(current.value);
            else selected.add(current.value);
            list.invalidate();
          }
          tui.requestRender();
          return;
        }
        if (data === "a") {
          if (selected.size === findings.length) selected.clear();
          else for (const finding of findings) selected.add(finding.id);
          list.invalidate();
          tui.requestRender();
          return;
        }
        if (data === "c" && selected.size > 0) {
          mode = "comment";
          commentInput.focused = true;
          tui.requestRender();
        }
      },
    };

    return component;
  }, { overlay: true, overlayOptions: { width: "96%", maxHeight: "96%", margin: 1 } });
}

function scopeText(config: ReviewConfig): string {
  if (config.scope === "uncommitted") return "uncommitted changes";
  if (config.scope === "commit") return `commit ${config.commit}`;
  return `branch commits vs ${config.base}`;
}

function buildApplyMessage(config: ReviewConfig, result: PickerResult): string {
  const comment = result.comment ? `\n\nUser focus note:\n${result.comment}` : "";
  const body = result.findings.map((finding, index) => {
    const attrs = [
      `source="${sourceName(finding.source)}"`,
      finding.severity ? `severity="${finding.severity}"` : "",
      finding.file ? `file="${finding.file}"` : "",
    ].filter(Boolean).join(" ");
    return `<finding ${attrs}>\n${finding.content}\n</finding>`;
  }).join("\n\n");

  return `Selected ${result.findings.length} review finding(s) from CodeRabbit/Codex.\nScope: ${scopeText(config)}.${comment}\n\nPlease validate each finding and fix only the valid ones. If a finding is a false positive, mention that briefly instead of changing code.\n\n${body}`;
}

async function dirtySummary(pi: ExtensionAPI, root: string): Promise<string> {
  const result = await git(pi, root, ["status", "--short"], 10_000);
  if (result.code !== 0 || !result.stdout.trim()) return "";
  const count = result.stdout.trim().split("\n").length;
  return `${count} file${count === 1 ? "" : "s"}`;
}

export default function reviewExtension(pi: ExtensionAPI) {
  pi.registerCommand("review", {
    description: "Run CodeRabbit and Codex reviews in parallel, then select findings to apply. Pass Codex prompt after --.",
    handler: async (args, ctx) => {
      if (!ctx.hasUI) {
        ctx.ui.notify("/review requires interactive or RPC UI", "error");
        return;
      }

      const root = await gitRoot(pi, ctx.cwd);
      if (!root) {
        ctx.ui.notify("Not inside a git repository", "error");
        return;
      }

      const parsed = parseArgs(args);
      const working = createCommandWorking(ctx, "review", "Review");
      const setProgress = (text: string | undefined, details: string[] = []) => {
        working.set(text, details);
      };

      try {
        const scope = await chooseScope(ctx, parsed, await dirtySummary(pi, root));
        if (!scope) return;

        const config: ReviewConfig = {
          root,
          scope,
          instructions: parsed.instructions,
          codexEffort: parsed.codexEffort,
        };

        if (scope === "base") {
          const base = await chooseBase(pi, root, ctx, parsed);
          if (!base) return;
          const baseRef = await resolveBaseRef(pi, root, base);
          if (!baseRef) {
            ctx.ui.notify(`Base branch not found: ${base}`, "error");
            return;
          }
          config.base = base;
          config.baseRef = baseRef;
        } else if (scope === "commit") {
          const commit = await chooseCommit(pi, root, ctx, parsed);
          if (!commit) return;
          config.commit = commit;
        }

        setProgress("Checking review scope…", [`Scope: ${scopeText(config)}`]);
        const validationError = await validateReviewScope(pi, config);
        if (validationError) {
          setProgress(undefined);
          ctx.ui.notify(validationError, validationError.startsWith("No changes") ? "info" : "error");
          return;
        }

        setProgress("Running CodeRabbit + Codex reviews…", [
          `Scope: ${scopeText(config)}`,
          "Codex guardrail: no manual lint/format/typecheck unless required",
          ...(config.instructions ? [`Codex focus: ${truncate(config.instructions, 180)}`] : []),
          "CodeRabbit: cr review (up to 15m)",
          `Codex: codex review (${config.codexEffort} reasoning, up to 15m)`,
          "You can keep reading; results will open when both finish or fail.",
        ]);
        const [coderabbit, codex] = await Promise.all([
          runCodeRabbitReview(pi, config),
          runCodexReview(pi, config),
        ]);
        setProgress(undefined);

        const results = [coderabbit, codex];
        const findings = results.flatMap((result) => result.findings);
        const errors = results.filter((result) => result.error || result.skipped);

        for (const result of errors) {
          ctx.ui.notify(`${sourceName(result.source)} ${result.error ? "failed" : "skipped"}`, result.error ? "warning" : "info");
        }

        if (findings.length === 0) {
          const summary = errors.length > 0
            ? `No selectable findings. ${errors.map((result) => `${sourceName(result.source)}: ${truncate(result.error ?? result.skipped ?? "", 500)}`).join("\n")}`
            : "No review findings from CodeRabbit or Codex.";
          ctx.ui.notify(summary, errors.length > 0 ? "warning" : "info");
          return;
        }

        const picked = await showReviewPicker(ctx, findings, results);
        if (!picked || picked.findings.length === 0) {
          ctx.ui.notify("No review findings selected", "info");
          return;
        }

        pi.sendUserMessage(buildApplyMessage(config, picked));
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        ctx.ui.notify(`/review failed: ${message}`, "error");
      } finally {
        working.clear();
      }
    },
  });
}
