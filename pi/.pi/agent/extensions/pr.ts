import { complete, type Message } from "@mariozechner/pi-ai";
import { DynamicBorder, type ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { CURSOR_MARKER, Input, Key, SelectList, fuzzyFilter, matchesKey, truncateToWidth, visibleWidth, type Component, type Focusable, type SelectItem } from "@mariozechner/pi-tui";
import { mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { registerSuccessMessageRenderer } from "./shared/success-message-renderer.js";
import { resolveMediumModel } from "./shared/model-slots.js";
import { createCommandWorking } from "./shared/command-working.js";

const DEFAULT_BRANCH_FALLBACK = "master";
const MAX_DIFF_CHARS = 100_000;
const MAX_TEMPLATE_CHARS = 30_000;
const MAX_TITLE_CHARS = 72;
const MAX_CORE_DIFF_FILES = 10;
const MAX_UNTRACKED_FILE_CHARS = 24_000;
const MAX_UNTRACKED_TOTAL_CHARS = 70_000;

const SENSITIVE_EXCLUDE_PATHS = [
  ":(exclude).env",
  ":(exclude).env.*",
  ":(exclude)**/.env",
  ":(exclude)**/.env.*",
  ":(exclude)agent/auth.json",
];

const DEFAULT_PR_TEMPLATE = `### 배경 (Why)
<!-- 왜 이 변경이 필요한지 적어주세요. Jira, Slack, Figma, Notion 등 관련 링크가 있다면 포함해주세요. -->

### 변경 내용 (What)
<!-- 주요 변경 사항을 bullet으로 요약해주세요. -->

### 리뷰 포인트
<!-- 리뷰어가 집중해서 봐야 할 부분이 있다면 적어주세요. 없으면 삭제해도 됩니다. -->

### 스크린샷/영상
<!-- UI 변경이 있다면 첨부해주세요. 해당 없으면 삭제해도 됩니다. -->

### 참고 사항
<!-- 배포 순서, 마이그레이션, 서드파티 패키지 변경 등 리뷰어나 배포자가 알아야 할 사항이 있다면 적어주세요. 해당 없으면 삭제해도 됩니다. -->`;

const PR_SYSTEM_PROMPT = `You generate a GitHub pull request title suggestion and body for reviewers.

Return ONLY valid JSON, no markdown fences:
{
  "title": "Suggested PR title",
  "body": "Markdown PR body"
}

Default style:
- 간결한 한국어.
- Write for a teammate who has not followed the implementation background, unless the directives say this is a stacked/existing PR.
- Prefer reviewer context over code archaeology: explain why this PR exists and what behavior changes, not every file/function.

Grounding rules:
- Use ONLY the provided git data, PR template, branch/base metadata, and explicit generation directives.
- Do not use conversation, session context, assumptions, or unstated intent.
- Do not invent tests, screenshots, rollout risks, migrations, or links that are not present in the provided data.
- If the draft source is "working-tree-only", make the body primarily about uncommitted working tree changes. Mention committed branch context only as short secondary context if it helps.
- If a broad-base warning is provided, make the broader scope explicit; the chosen base includes parent-branch changes already contained in the recommended stacked base.

Title rules:
- The title is only a suggestion; the user may confirm or override it.
- Title: concise, specific, <= 72 characters including issue key. Do not end with a period.
- If an issue key prefix is provided, start the title with that exact prefix.
- Product-facing changes: express user/product behavior, not implementation means. Avoid titles like "flag 추가", "hook 추가", "middleware 수정" when the visible behavior can be named.
- Technical-only changes: technical terms are allowed.
- Do not use Conventional Commit prefixes unless the changes are clearly tooling/chore-only.

Body/template rules:
- Preserve the provided PR template's heading order, checklists, HTML comments, and placeholders unless a section is explicitly optional and irrelevant.
- Follow each template section's HTML comment guide; the template is the source of truth for section intent.
- 배경/Why: explain only what need/problem would remain without this PR. Do not describe implementation details, options, or policy mechanics here.
- 변경 내용/What/Summary: summarize changed behavior/capability. Use 1-5 concise bullets when the template allows bullets.
- Do not list code changes that are obvious from diff, such as raw file/function/class lists. Use file names only when they clarify purpose/location of a new artifact.
- For new files, describe purpose and location. For modified files, describe the changed behavior only.
- Optional sections whose comment says "삭제해도 됩니다", "if applicable", or similar should be removed when there is no grounded content. Do not leave empty optional sections.
- If a section is retained, keep its HTML comment unless it would make the final body confusing.
- For product-facing changes, body wording should also prefer product/user behavior over implementation details.
- For stacked/existing PRs, concise technical context is acceptable when it helps review.
- Do not reference tools, reviewers, or the assistant.
- Do not include Mermaid diagrams.`;

type ChangeSource = "committed" | "working-tree";
type BaseSelectionReason = "existing-pr" | "argument" | "stacked-prompt" | "default" | "picker";
type PublishAction = "create-draft" | "create-ready" | "update" | "dry-run";

interface GeneratedPr {
  title: string;
  body: string;
}

interface ParsedArgs {
  base?: string;
  title?: string;
  noOpen: boolean;
}

interface ExistingPr {
  number: number;
  title: string;
  base: string;
  url: string;
  isDraft?: boolean;
}

interface BaseChoice {
  base: string;
  reason: BaseSelectionReason;
  recommendedBase?: string;
  overrideWarning?: string;
}

interface ResolvedBaseChoice extends BaseChoice {
  baseRef: string;
}

interface ChangedFile {
  path: string;
  status: string;
}

interface ChangeContext {
  source: ChangeSource;
  log: string;
  diffStat: string;
  shortStat: string;
  nameStatus: string;
  detailDiff: string;
  untrackedPreview?: string;
  secondaryContext?: string;
  commitCount: number;
  changedFiles: number;
  insertions?: number;
  deletions?: number;
  fileNames: string[];
}

interface FinalPrDecision {
  content: GeneratedPr;
  action: PublishAction;
}

function truncateText(value: string, maxChars: number, note = "[truncated]"): string {
  if (value.length <= maxChars) return value;
  const head = Math.floor(maxChars * 0.65);
  const tail = Math.max(0, maxChars - head - note.length - 4);
  return `${value.slice(0, head)}\n${note}\n${value.slice(value.length - tail)}`;
}

function extractAssistantText(response: any): string {
  return (response.content ?? [])
    .filter((part: any) => part?.type === "text" && typeof part.text === "string")
    .map((part: any) => part.text)
    .join("\n")
    .trim();
}

function stripJsonFence(text: string): string {
  return text.replace(/^```(?:json)?\s*\n?/gm, "").replace(/^```\s*$/gm, "").trim();
}

function extractJsonObject(text: string): unknown {
  const stripped = stripJsonFence(text);
  const start = stripped.indexOf("{");
  if (start === -1) throw new Error("no JSON object found");

  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let index = start; index < stripped.length; index++) {
    const char = stripped[index];
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
      if (depth === 0) return JSON.parse(stripped.slice(start, index + 1));
    }
  }

  throw new Error("unterminated JSON object");
}

function normalizePrTitle(value: string): string {
  const title = value.replace(/\s+/g, " ").trim();
  return title.length <= MAX_TITLE_CHARS ? title : `${title.slice(0, MAX_TITLE_CHARS - 1).trimEnd()}…`;
}

function normalizePrDraft(raw: unknown): GeneratedPr {
  const parsed = raw as any;
  const title = normalizePrTitle(String(parsed?.title ?? ""));
  const body = String(parsed?.body ?? "").trim();
  if (!title) throw new Error("missing title");
  if (!body) throw new Error("missing body");
  return { title, body };
}

function shellWords(input: string): string[] {
  const words: string[] = [];
  const pattern = /"((?:\\.|[^"\\])*)"|'((?:\\.|[^'\\])*)'|(\S+)/g;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(input)) !== null) {
    const value = match[1] ?? match[2] ?? match[3] ?? "";
    words.push(value.replace(/\\(["'\\ ])/g, "$1"));
  }
  return words;
}

function normalizeBranch(value: string | undefined): string | undefined {
  const branch = value?.trim().replace(/^origin\//, "");
  return branch || undefined;
}

function parsePrArgs(args: string | undefined): ParsedArgs {
  const tokens = shellWords(args ?? "");
  const parsed: ParsedArgs = { noOpen: false };
  let baseConsumed = false;

  for (let index = 0; index < tokens.length; index++) {
    const token = tokens[index];
    if (token === "--no-open") {
      parsed.noOpen = true;
      continue;
    }
    if (token === "--base") {
      parsed.base = normalizeBranch(tokens[++index]);
      baseConsumed = true;
      continue;
    }
    if (token.startsWith("--base=")) {
      parsed.base = normalizeBranch(token.slice("--base=".length));
      baseConsumed = true;
      continue;
    }
    if (token === "--title") {
      parsed.title = tokens.slice(index + 1).join(" ").trim() || undefined;
      break;
    }
    if (token.startsWith("--title=")) {
      parsed.title = token.slice("--title=".length).trim() || undefined;
      continue;
    }
    if (!token.startsWith("-") && !baseConsumed && !parsed.base) {
      parsed.base = normalizeBranch(token);
      baseConsumed = true;
    }
  }

  return parsed;
}

function branchPriority(branch: string, query: string): number {
  const value = branch.toLowerCase();
  const normalizedQuery = query.toLowerCase();
  const parts = value.split("/");
  const leaf = parts.at(-1) ?? value;

  if (value === normalizedQuery) return 0;
  if (leaf === normalizedQuery) return 1;
  if (value.endsWith(`/${normalizedQuery}`)) return 2;
  if (value.startsWith(`${normalizedQuery}/`)) return 3;
  if (leaf.startsWith(normalizedQuery)) return 4;
  if (parts.some((part) => part.startsWith(normalizedQuery))) return 5;
  if (value.includes(normalizedQuery)) return 6;
  return 7;
}

function filterBranchItems(items: SelectItem[], query: string): SelectItem[] {
  const matches = fuzzyFilter(items, query, (item) => item.value);
  const originalOrder = new Map(matches.map((item, index) => [item.value, index]));
  return [...matches].sort((a, b) => {
    const priority = branchPriority(a.value, query) - branchPriority(b.value, query);
    return priority || ((originalOrder.get(a.value) ?? 0) - (originalOrder.get(b.value) ?? 0));
  });
}

async function git(pi: ExtensionAPI, root: string, args: string[], timeout = 60_000) {
  return pi.exec("git", args, { cwd: root, timeout });
}

async function gitRoot(pi: ExtensionAPI, cwd: string): Promise<string | undefined> {
  const result = await pi.exec("git", ["rev-parse", "--show-toplevel"], { cwd, timeout: 10_000 });
  if (result.code !== 0) return undefined;
  return result.stdout.trim();
}

async function hasOriginRemote(pi: ExtensionAPI, root: string): Promise<boolean> {
  const result = await git(pi, root, ["remote", "get-url", "origin"], 10_000);
  return result.code === 0 && !!result.stdout.trim();
}

async function remoteBranches(pi: ExtensionAPI, root: string): Promise<string[]> {
  const result = await git(pi, root, ["branch", "-r", "--sort=-committerdate", "--format=%(refname:short)"], 10_000);
  if (result.code !== 0) return [];
  return [...new Set(result.stdout
    .split("\n")
    .map((branch) => normalizeBranch(branch))
    .filter((branch): branch is string => !!branch && branch !== "HEAD" && !branch.includes("/HEAD")))];
}

async function currentBranch(pi: ExtensionAPI, root: string): Promise<string | undefined> {
  const result = await git(pi, root, ["branch", "--show-current"], 10_000);
  const branch = result.stdout.trim();
  return result.code === 0 && branch ? branch : undefined;
}

async function defaultBranch(pi: ExtensionAPI, root: string): Promise<string> {
  const result = await git(pi, root, ["symbolic-ref", "--quiet", "--short", "refs/remotes/origin/HEAD"], 10_000);
  const branch = normalizeBranch(result.stdout.trim());
  return result.code === 0 && branch ? branch : DEFAULT_BRANCH_FALLBACK;
}

async function verifyRef(pi: ExtensionAPI, root: string, ref: string): Promise<boolean> {
  const result = await git(pi, root, ["rev-parse", "--verify", `${ref}^{commit}`], 10_000);
  return result.code === 0;
}

async function resolveBaseRef(pi: ExtensionAPI, root: string, base: string): Promise<string | undefined> {
  await git(pi, root, ["fetch", "origin", `refs/heads/${base}:refs/remotes/origin/${base}`, "--quiet"], 60_000).catch(() => undefined);
  const remoteRef = `origin/${base}`;
  if (await verifyRef(pi, root, remoteRef)) return remoteRef;
  if (await verifyRef(pi, root, base)) return base;
  return undefined;
}

async function detectStackedBaseCandidates(pi: ExtensionAPI, root: string, current: string, fallbackDefaultBranch: string): Promise<string[]> {
  await git(pi, root, ["fetch", "origin", `refs/heads/${fallbackDefaultBranch}:refs/remotes/origin/${fallbackDefaultBranch}`, "--quiet"], 60_000).catch(() => undefined);
  const defaultRef = await verifyRef(pi, root, `origin/${fallbackDefaultBranch}`) ? `origin/${fallbackDefaultBranch}` : fallbackDefaultBranch;
  if (!(await verifyRef(pi, root, defaultRef))) return [];

  const merged = await git(pi, root, ["branch", "--merged", current, "--format=%(refname:short)"], 20_000);
  if (merged.code !== 0) return [];

  const candidates: Array<{ branch: string; distance: number }> = [];
  for (const branch of merged.stdout.split("\n").map((line) => line.trim()).filter(Boolean)) {
    if (branch === current || branch === fallbackDefaultBranch || branch === `origin/${fallbackDefaultBranch}`) continue;
    const ahead = await git(pi, root, ["rev-list", "--count", `${defaultRef}..${branch}`], 10_000);
    const aheadCount = Number.parseInt(ahead.stdout.trim(), 10);
    if (ahead.code !== 0 || !Number.isFinite(aheadCount) || aheadCount <= 0) continue;

    const distance = await git(pi, root, ["rev-list", "--count", `${branch}..${current}`], 10_000);
    const distanceCount = Number.parseInt(distance.stdout.trim(), 10);
    candidates.push({ branch, distance: Number.isFinite(distanceCount) ? distanceCount : 999_999 });
  }

  return candidates
    .sort((a, b) => a.distance - b.distance || a.branch.localeCompare(b.branch))
    .map((candidate) => candidate.branch)
    .slice(0, 5);
}

async function suggestedBaseBranch(pi: ExtensionAPI, root: string, branches: string[], preferred?: string): Promise<string | undefined> {
  if (preferred && branches.includes(preferred)) return preferred;
  const [current, remoteTips, history] = await Promise.all([
    currentBranch(pi, root),
    git(pi, root, ["for-each-ref", "--format=%(refname:short) %(objectname)", "refs/remotes/origin"], 10_000),
    git(pi, root, ["rev-list", "--first-parent", "HEAD"], 10_000),
  ]);
  if (!current || remoteTips.code !== 0 || history.code !== 0) return branches.includes(DEFAULT_BRANCH_FALLBACK) ? DEFAULT_BRANCH_FALLBACK : branches[0];

  const historyIndex = new Map<string, number>();
  for (const [index, sha] of history.stdout.split("\n").filter(Boolean).entries()) historyIndex.set(sha, index);
  const branchOrder = new Map(branches.map((branch, index) => [branch, index]));
  let best: { branch: string; distance: number; order: number } | undefined;

  for (const line of remoteTips.stdout.split("\n").filter(Boolean)) {
    const [ref, sha] = line.trim().split(/\s+/, 2);
    const branch = normalizeBranch(ref);
    if (!branch || branch === "HEAD" || branch === current || !sha || !branchOrder.has(branch)) continue;
    const distance = historyIndex.get(sha);
    if (distance === undefined) continue;
    const order = branchOrder.get(branch)!;
    if (!best || distance < best.distance || (distance === best.distance && order < best.order)) {
      best = { branch, distance, order };
    }
  }

  return best?.branch ?? (branches.includes(DEFAULT_BRANCH_FALLBACK) ? DEFAULT_BRANCH_FALLBACK : branches[0]);
}

async function openBaseBranchPicker(pi: ExtensionAPI, root: string, ctx: any, preferred?: string): Promise<string | undefined> {
  const branches = await remoteBranches(pi, root);
  if (branches.length === 0) {
    ctx.ui.notify("No origin remote branches found", "warning");
    return undefined;
  }

  const suggested = await suggestedBaseBranch(pi, root, branches, preferred);
  const suggestedNote = suggested ? `suggested base: ${suggested}` : undefined;
  const allItems: SelectItem[] = branches.map((branch) => ({
    value: branch,
    label: branch,
  }));

  return ctx.ui.custom<string | undefined>((tui: any, theme: any, _kb: any, done: (value: string | undefined) => void) => {
    const rows = tui.terminal.rows || 24;
    const maxVisible = Math.min(20, Math.max(6, rows - 8));
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
    let query = "";
    let list = new SelectList(items, maxVisible, listTheme);
    const selectSuggested = () => {
      const selected = query ? items[0]?.value : suggested;
      const index = selected ? items.findIndex((item) => item.value === selected) : -1;
      if (index >= 0) list.setSelectedIndex(index);
    };
    selectSuggested();

    const applyFilter = () => {
      query = input.getValue().trim();
      items = query ? filterBranchItems(allItems, query) : allItems;
      list = new SelectList(items, maxVisible, listTheme);
      selectSuggested();
    };

    let focused = true;
    const component: Component & Focusable = {
      get focused() { return focused; },
      set focused(value: boolean) { focused = value; input.focused = value; },
      render(width: number): string[] {
        const lines: string[] = [];
        lines.push(...borderTop.render(width));
        lines.push(` ${theme.fg("accent", theme.bold("Base branch"))}${theme.fg("dim", ` ${items.length}/${branches.length}`)}`);
        if (suggestedNote) lines.push(` ${theme.fg("dim", suggestedNote)}`);
        lines.push("");
        for (const line of input.render(width - 2)) lines.push(` ${line}`);
        lines.push(theme.fg("dim", ` ${"─".repeat(Math.max(1, width - 2))}`));
        lines.push(...list.render(width));
        lines.push("");
        lines.push(` ${theme.fg("dim", "↑↓")} navigate  ${theme.fg("dim", "enter")} select  ${theme.fg("dim", "esc")} cancel`);
        lines.push(...borderBottom.render(width));
        return lines;
      },
      invalidate() {
        borderTop.invalidate();
        borderBottom.invalidate();
        input.invalidate();
        list.invalidate();
      },
      handleInput(data: string) {
        if (matchesKey(data, Key.escape) || matchesKey(data, Key.ctrl("c"))) {
          done(undefined);
          return;
        }
        if (matchesKey(data, Key.enter)) {
          done(list.getSelectedItem()?.value);
          return;
        }
        if (matchesKey(data, Key.up) || matchesKey(data, Key.down) || matchesKey(data, Key.pageUp) || matchesKey(data, Key.pageDown)) {
          list.handleInput(data);
          tui.requestRender();
          return;
        }
        input.handleInput(data);
        applyFilter();
        tui.requestRender();
      },
    };

    return component;
  }, { overlay: true });
}

async function existingPrForBranch(pi: ExtensionAPI, root: string, branch: string): Promise<ExistingPr | undefined> {
  const result = await pi.exec("gh", [
    "pr",
    "list",
    "--head",
    branch,
    "--json",
    "number,title,baseRefName,url,isDraft",
    "--limit",
    "3",
  ], { cwd: root, timeout: 20_000 });
  if (result.code !== 0) return undefined;

  try {
    const items = JSON.parse(result.stdout) as any[];
    const first = items[0];
    if (!first?.number || !first?.url || !first?.baseRefName) return undefined;
    return {
      number: Number(first.number),
      title: String(first.title ?? ""),
      base: String(first.baseRefName),
      url: String(first.url),
      isDraft: Boolean(first.isDraft),
    };
  } catch {
    return undefined;
  }
}

async function chooseBaseBranch(
  pi: ExtensionAPI,
  root: string,
  ctx: any,
  parsed: ParsedArgs,
  current: string,
  fallbackDefaultBranch: string,
  existing?: ExistingPr,
): Promise<BaseChoice | undefined> {
  const stackedCandidates = await detectStackedBaseCandidates(pi, root, current, fallbackDefaultBranch);
  const recommendedBase = stackedCandidates[0];

  if (existing) {
    if (parsed.base && parsed.base !== existing.base) {
      ctx.ui.notify(`Existing PR base(${existing.base})를 사용합니다. 입력한 base(${parsed.base})는 무시됩니다.`, "warning");
    }
    return { base: existing.base, reason: "existing-pr", recommendedBase };
  }

  if (parsed.base) return { base: parsed.base, reason: "argument", recommendedBase };

  const labels = recommendedBase
    ? [
        ...stackedCandidates.map((branch, index) => index === 0 ? `${branch} (Recommended stacked base)` : `${branch} (stacked base)`),
        `${fallbackDefaultBranch} (default branch)`,
        "Choose another branch…",
        "Cancel",
      ]
    : [
        `${fallbackDefaultBranch} (Recommended default branch)`,
        "Choose another branch…",
        "Cancel",
      ];
  const title = recommendedBase
    ? "Recommended base branch detected. Choose the PR base branch."
    : "Choose the PR base branch.";
  const choice = await ctx.ui.select(title, labels);
  if (!choice || choice === "Cancel") return undefined;
  if (choice === "Choose another branch…") {
    const picked = await openBaseBranchPicker(pi, root, ctx, recommendedBase ?? fallbackDefaultBranch);
    return picked ? { base: picked, reason: "picker", recommendedBase } : undefined;
  }

  const branch = choice.replace(/ \(.+\)$/, "");
  const reason: BaseSelectionReason = branch === fallbackDefaultBranch
    ? "default"
    : stackedCandidates.includes(branch)
      ? "stacked-prompt"
      : "picker";
  return { base: branch, reason, recommendedBase };
}

async function confirmBaseOverride(ctx: any, choice: BaseChoice): Promise<BaseChoice | undefined> {
  const recommended = choice.recommendedBase;
  if (!recommended || choice.base === recommended || choice.reason === "existing-pr") return choice;

  const warning = `\`${choice.base}\` 기준 PR에는 \`${recommended}\`에 이미 포함된 상위 변경까지 함께 들어갑니다.`;
  if (choice.reason === "argument") return { ...choice, overrideWarning: warning };

  const action = await ctx.ui.select(`${warning}\n\n추천 base와 다른 base를 선택했습니다.`, [
    `Use ${recommended} instead (Recommended)`,
    `Continue with ${choice.base}`,
    "Cancel",
  ]);

  if (action === `Use ${recommended} instead (Recommended)`) {
    return { ...choice, base: recommended, reason: "stacked-prompt", overrideWarning: undefined };
  }
  if (action === `Continue with ${choice.base}`) {
    return { ...choice, overrideWarning: warning };
  }
  return undefined;
}

async function findPrTemplate(root: string): Promise<string | undefined> {
  const candidates = [
    ".github/pull_request_template.md",
    ".github/PULL_REQUEST_TEMPLATE.md",
    "docs/pull_request_template.md",
  ];

  for (const candidate of candidates) {
    try {
      const fullPath = join(root, candidate);
      const info = await stat(fullPath);
      if (info.isFile()) return truncateText(await readFile(fullPath, "utf8"), MAX_TEMPLATE_CHARS);
    } catch {
      // Try next candidate.
    }
  }

  try {
    const dir = join(root, ".github/PULL_REQUEST_TEMPLATE");
    const files = (await readdir(dir)).filter((file) => file.toLowerCase().endsWith(".md")).sort();
    for (const file of files) {
      const fullPath = join(dir, file);
      const info = await stat(fullPath);
      if (info.isFile()) return truncateText(await readFile(fullPath, "utf8"), MAX_TEMPLATE_CHARS);
    }
  } catch {
    // No template directory.
  }

  return undefined;
}

function normalizeGitPath(value: string | undefined): string | undefined {
  const path = value?.trim().replace(/^\.\//, "").replace(/\\/g, "/");
  if (!path || path.startsWith("/") || path === "." || path === ".." || path.startsWith("../") || path.includes("/../")) return undefined;
  return path.replace(/\/+$/, "");
}

function isSensitivePath(value: string): boolean {
  const path = normalizeGitPath(value);
  if (!path) return true;
  if (path === "agent/auth.json") return true;
  return path.split("/").some((part) => part === ".env" || part.startsWith(".env."));
}

function sanitizeStatusShort(output: string): string {
  return output
    .split("\n")
    .filter((line) => {
      const pathPart = line.slice(3).replace(/^"|"$/g, "");
      const finalPath = pathPart.includes(" -> ") ? pathPart.split(" -> ").at(-1) : pathPart;
      return !!finalPath && !isSensitivePath(finalPath);
    })
    .join("\n");
}

function parseNameStatus(output: string): ChangedFile[] {
  const files: ChangedFile[] = [];
  for (const line of output.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const parts = trimmed.split("\t");
    const status = parts[0] ?? "";
    const path = normalizeGitPath(status.startsWith("R") || status.startsWith("C") ? parts[2] : parts[1]);
    if (!path || isSensitivePath(path)) continue;
    files.push({ path, status });
  }
  return files;
}

function parseShortStat(shortStat: string): { files?: number; insertions?: number; deletions?: number } {
  const files = shortStat.match(/(\d+) files? changed/);
  const insertions = shortStat.match(/(\d+) insertions?\(\+\)/);
  const deletions = shortStat.match(/(\d+) deletions?\(-\)/);
  return {
    files: files ? Number.parseInt(files[1], 10) : undefined,
    insertions: insertions ? Number.parseInt(insertions[1], 10) : undefined,
    deletions: deletions ? Number.parseInt(deletions[1], 10) : undefined,
  };
}

function changedFilePriority(file: ChangedFile): number {
  const path = file.path.toLowerCase();
  let priority = 50;
  if (file.status.startsWith("A")) priority -= 8;
  if (/migration|schema|permission|auth|policy|security|api|route|controller|service/.test(path)) priority -= 10;
  if (/component|page|screen|view|hook|store|domain|model/.test(path)) priority -= 7;
  if (/package\.json|pnpm-lock|yarn\.lock|package-lock|config|\.ya?ml$|\.toml$/.test(path)) priority -= 4;
  if (/test|spec|__tests__/.test(path)) priority += 6;
  if (/\.md$|docs?\//.test(path)) priority += 8;
  return priority;
}

function pickCoreFiles(files: ChangedFile[], limit = MAX_CORE_DIFF_FILES): ChangedFile[] {
  return [...files]
    .sort((a, b) => changedFilePriority(a) - changedFilePriority(b))
    .slice(0, limit);
}

async function detailedDiffForFiles(pi: ExtensionAPI, root: string, range: string | undefined, files: ChangedFile[]): Promise<string> {
  const blocks: string[] = [];
  let total = 0;

  for (const file of pickCoreFiles(files)) {
    const args = range
      ? ["diff", "--no-ext-diff", "--no-color", range, "--", file.path]
      : ["diff", "--no-ext-diff", "--no-color", "--", file.path];
    const result = await git(pi, root, args, 30_000);
    const diff = result.stdout.trim();
    if (result.code !== 0 || !diff) continue;

    const block = `## ${file.status} ${file.path}\n${diff}`;
    if (total + block.length > MAX_DIFF_CHARS) {
      blocks.push(`[detail diff truncated before ${file.path}]`);
      break;
    }
    blocks.push(block);
    total += block.length;
  }

  return blocks.join("\n\n");
}

function countLogCommits(log: string): number {
  return log.split("\n").map((line) => line.trim()).filter(Boolean).length;
}

async function collectCommittedContext(pi: ExtensionAPI, root: string, baseRef: string): Promise<ChangeContext> {
  const pathspec = ["--", ".", ...SENSITIVE_EXCLUDE_PATHS];
  const [log, diffStat, shortStat, nameStatus] = await Promise.all([
    git(pi, root, ["log", "--oneline", `${baseRef}..HEAD`], 20_000),
    git(pi, root, ["diff", "--stat", `${baseRef}...HEAD`, ...pathspec], 30_000),
    git(pi, root, ["diff", "--shortstat", `${baseRef}...HEAD`, ...pathspec], 30_000),
    git(pi, root, ["diff", "--name-status", `${baseRef}...HEAD`, ...pathspec], 30_000),
  ]);

  const files = parseNameStatus(nameStatus.stdout);
  const detailDiff = await detailedDiffForFiles(pi, root, `${baseRef}...HEAD`, files);
  const parsedStat = parseShortStat(shortStat.stdout);
  return {
    source: "committed",
    log: log.stdout.trim(),
    diffStat: diffStat.stdout.trim(),
    shortStat: shortStat.stdout.trim(),
    nameStatus: nameStatus.stdout.trim(),
    detailDiff,
    commitCount: countLogCommits(log.stdout),
    changedFiles: parsedStat.files ?? files.length,
    insertions: parsedStat.insertions,
    deletions: parsedStat.deletions,
    fileNames: files.map((file) => file.path),
  };
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

async function untrackedFiles(pi: ExtensionAPI, root: string): Promise<string[]> {
  const result = await git(pi, root, ["ls-files", "--others", "--exclude-standard", "-z"], 20_000);
  if (result.code !== 0) return [];
  return result.stdout
    .split("\0")
    .map((path) => normalizeGitPath(path))
    .filter((path): path is string => !!path && !isSensitivePath(path));
}

async function previewUntrackedFiles(root: string, files: string[]): Promise<string> {
  const blocks: string[] = [];
  let total = 0;

  for (const path of files.slice(0, MAX_CORE_DIFF_FILES)) {
    try {
      const fullPath = join(root, path);
      const info = await stat(fullPath);
      if (!info.isFile()) continue;
      const buffer = await readFile(fullPath);
      if (!isProbablyText(buffer)) {
        blocks.push(`## ?? ${path}\n[binary or non-text file omitted]`);
        continue;
      }

      const text = buffer.toString("utf8");
      const truncated = truncateText(text, MAX_UNTRACKED_FILE_CHARS, "[file truncated]");
      const block = `## ?? ${path}\n\`\`\`\n${truncated}\n\`\`\``;
      if (total + block.length > MAX_UNTRACKED_TOTAL_CHARS) {
        blocks.push(`[untracked preview truncated before ${path}]`);
        break;
      }
      blocks.push(block);
      total += block.length;
    } catch {
      // File may have disappeared; ignore.
    }
  }

  return blocks.join("\n\n");
}

async function collectWorkingTreeContext(pi: ExtensionAPI, root: string, baseRef: string): Promise<ChangeContext> {
  const pathspec = ["--", ".", ...SENSITIVE_EXCLUDE_PATHS];
  const [status, diffStat, shortStat, nameStatus, branchLog, branchDiffStat] = await Promise.all([
    git(pi, root, ["status", "--short"], 20_000),
    git(pi, root, ["diff", "--stat", ...pathspec], 30_000),
    git(pi, root, ["diff", "--shortstat", ...pathspec], 30_000),
    git(pi, root, ["diff", "--name-status", ...pathspec], 30_000),
    git(pi, root, ["log", "--oneline", `${baseRef}..HEAD`], 20_000),
    git(pi, root, ["diff", "--stat", `${baseRef}...HEAD`, ...pathspec], 30_000),
  ]);

  const trackedFiles = parseNameStatus(nameStatus.stdout);
  const untracked = await untrackedFiles(pi, root);
  const untrackedChangedFiles: ChangedFile[] = untracked.map((path) => ({ path, status: "??" }));
  const detailDiff = await detailedDiffForFiles(pi, root, undefined, trackedFiles);
  const untrackedPreview = await previewUntrackedFiles(root, untracked);
  const parsedStat = parseShortStat(shortStat.stdout);
  const sanitizedStatus = sanitizeStatusShort(status.stdout);
  const fileNames = [...trackedFiles, ...untrackedChangedFiles].map((file) => file.path);
  const secondaryContext = [
    branchLog.stdout.trim() ? `## Committed branch commits (secondary context only)\n${branchLog.stdout.trim()}` : "",
    branchDiffStat.stdout.trim() ? `## Committed branch diff stat (secondary context only)\n${branchDiffStat.stdout.trim()}` : "",
  ].filter(Boolean).join("\n\n");

  return {
    source: "working-tree",
    log: sanitizedStatus.trim(),
    diffStat: diffStat.stdout.trim(),
    shortStat: shortStat.stdout.trim(),
    nameStatus: [nameStatus.stdout.trim(), ...untrackedChangedFiles.map((file) => `??\t${file.path}`)].filter(Boolean).join("\n"),
    detailDiff,
    untrackedPreview,
    secondaryContext,
    commitCount: countLogCommits(branchLog.stdout),
    changedFiles: (parsedStat.files ?? trackedFiles.length) + untrackedChangedFiles.length,
    insertions: parsedStat.insertions,
    deletions: parsedStat.deletions,
    fileNames,
  };
}

async function chooseChangeSource(ctx: any, dirtyStatus: string): Promise<ChangeSource | undefined> {
  if (!dirtyStatus.trim()) return "committed";

  const preview = [
    "Uncommitted changes detected. What should the PR draft use?",
    "",
    truncateText(dirtyStatus.trim(), 2_000, "[status truncated]"),
  ].join("\n");
  const choice = await ctx.ui.select(preview, [
    "Use committed changes only (Recommended)",
    "Use working tree changes only (dry-run)",
    "Cancel and run /commit first",
  ]);

  if (choice === "Use committed changes only (Recommended)") return "committed";
  if (choice === "Use working tree changes only (dry-run)") return "working-tree";
  return undefined;
}

function issueKeyFromBranch(branch: string): string | undefined {
  const matches = branch.match(/[A-Z]+-\d+/g);
  return matches?.at(-1);
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function withIssueKeyPrefix(title: string, branch: string): string {
  const issueKey = issueKeyFromBranch(branch);
  if (!issueKey) return normalizePrTitle(title);
  const pattern = new RegExp(`^\\[?${escapeRegex(issueKey)}\\]?(?:\\s|:|-)`, "i");
  if (pattern.test(title)) return normalizePrTitle(title);
  return normalizePrTitle(`[${issueKey}] ${title}`);
}

function inferChangeNature(files: string[]): string {
  if (files.length === 0) return "판단 어려움";
  const technicalOnly = files.every((file) => /(^|\/)(test|tests|__tests__|docs?|scripts?|\.github)\/|\.md$|package\.json$|lock$|config|\.ya?ml$|\.toml$/.test(file.toLowerCase()));
  if (technicalOnly) return "순수 기술 중심";
  const productLike = files.some((file) => /component|page|screen|view|route|api|domain|service|controller|policy|auth|permission|feature|app\//.test(file.toLowerCase()));
  return productLike ? "제품 기능 중심" : "판단 어려움";
}

function buildModelInput(params: {
  template: string;
  current: string;
  base: string;
  baseRef: string;
  baseChoice: BaseChoice;
  existing?: ExistingPr;
  context: ChangeContext;
}): string {
  const issueKey = issueKeyFromBranch(params.current);
  const reviewerContext = params.baseChoice.reason === "existing-pr" || params.baseChoice.reason.startsWith("stacked")
    ? "Reviewer likely has stacked/existing PR context; concise technical context is acceptable."
    : "Assume the reviewer has no prior implementation background.";
  const changeNature = inferChangeNature(params.context.fileNames);
  const sourceLabel = params.context.source === "working-tree" ? "working-tree-only" : "committed changes";

  return [
    `## Generation directives\n- Draft source: ${sourceLabel}\n- Change nature hint: ${changeNature}\n- Reviewer context: ${reviewerContext}\n- Final base: ${params.base}\n- Base ref used for git data: ${params.baseRef}\n- Base selection reason: ${params.baseChoice.reason}\n${params.baseChoice.recommendedBase ? `- Recommended stacked base: ${params.baseChoice.recommendedBase}` : ""}\n${params.baseChoice.overrideWarning ? `- Broad-base warning: ${params.baseChoice.overrideWarning}` : ""}\n${issueKey ? `- Issue key prefix: [${issueKey}]` : ""}\n${params.existing ? `- Existing PR: #${params.existing.number} ${params.existing.url}` : ""}`,
    `## PR Template\n${params.template}`,
    `## Branch\n${params.current} → ${params.base}`,
    params.context.source === "working-tree"
      ? `## Working tree status (primary source)\n${params.context.log || "(none)"}`
      : `## Commits (source of truth)\n${params.context.log || "(none)"}`,
    `## Diff stat\n${params.context.diffStat || "(none)"}`,
    `## Changed files\n${params.context.nameStatus || "(none)"}`,
    params.context.detailDiff ? `## Detailed diffs for core files\n${truncateText(params.context.detailDiff, MAX_DIFF_CHARS, "[detail diff truncated]")}` : "",
    params.context.untrackedPreview ? `## Untracked file previews (primary source)\n${params.context.untrackedPreview}` : "",
    params.context.secondaryContext ? `## Secondary committed branch context\n${params.context.secondaryContext}` : "",
  ].filter(Boolean).join("\n\n");
}

async function generatePrDraft(ctx: any, input: string): Promise<GeneratedPr> {
  const resolved = await resolveMediumModel(ctx);
  const messages: Message[] = [{
    role: "user",
    content: [{ type: "text", text: input }],
    timestamp: Date.now(),
  } as Message];

  const response = await complete(
    resolved.model,
    { systemPrompt: PR_SYSTEM_PROMPT, messages },
    { apiKey: resolved.auth.apiKey, headers: resolved.auth.headers },
  );

  if (response.stopReason === "error") throw new Error(response.errorMessage ?? "model error");
  if (response.stopReason === "aborted") throw new Error("generation aborted");
  return normalizePrDraft(extractJsonObject(extractAssistantText(response)));
}

async function ensureGhReady(pi: ExtensionAPI, root: string): Promise<string | undefined> {
  const version = await pi.exec("gh", ["--version"], { cwd: root, timeout: 10_000 });
  if (version.code !== 0) return "GitHub CLI `gh` is not installed or not on PATH.";

  const auth = await pi.exec("gh", ["auth", "status"], { cwd: root, timeout: 15_000 });
  if (auth.code !== 0) return `GitHub CLI is not authenticated:\n${[auth.stdout, auth.stderr].filter(Boolean).join("\n").trim()}`;
  return undefined;
}

function previewText(title: string, body: string, base: string, current: string, options: { source: ChangeSource; existing?: ExistingPr; warning?: string; dryRun: boolean }): string {
  const action = options.dryRun
    ? "Dry-run only: no push/create/update will be performed."
    : options.existing
      ? `This will push the current branch and update PR #${options.existing.number}.`
      : "This will push the current branch and create a PR.";
  return [
    `${current} → ${base}`,
    `Source: ${options.source === "working-tree" ? "uncommitted working tree only" : "committed changes"}`,
    options.existing ? `Existing PR: ${options.existing.url}` : "",
    options.warning ? `⚠ ${options.warning}` : "",
    "",
    title,
    "─".repeat(40),
    body,
    "",
    action,
  ].filter((line) => line !== "").join("\n");
}

function renderInputWithPlaceholder(input: Input, placeholder: string, theme: any, width: number): string[] {
  if (input.getValue()) return input.render(width);

  const prompt = "> ";
  const availableWidth = width - visibleWidth(prompt);
  if (availableWidth <= 0) return [prompt];

  const cursor = `${input.focused ? CURSOR_MARKER : ""}\x1b[7m \x1b[27m`;
  const placeholderWidth = Math.max(0, availableWidth - 1);
  const placeholderText = placeholderWidth > 0
    ? theme.fg("dim", truncateToWidth(placeholder, placeholderWidth, "…"))
    : "";
  const line = `${prompt}${cursor}${placeholderText}`;
  return [`${line}${" ".repeat(Math.max(0, width - visibleWidth(line)))}`];
}

type TitlePromptResult = { cancelled: true } | { value: string };

async function promptTitleWithPlaceholder(
  ctx: any,
  heading: string,
  placeholder: string,
  fallback: string,
  emptyAction: string,
): Promise<string | undefined> {
  const result = await ctx.ui.custom<TitlePromptResult | undefined>((tui: any, theme: any, _kb: any, done: (value: TitlePromptResult | undefined) => void) => {
    const borderTop = new DynamicBorder((text: string) => theme.fg("accent", text));
    const borderBottom = new DynamicBorder((text: string) => theme.fg("accent", text));
    const input = new Input();
    input.focused = true;

    const submit = () => done({ value: normalizePrTitle(input.getValue()) || fallback });

    let focused = true;
    const component: Component & Focusable = {
      get focused() { return focused; },
      set focused(value: boolean) { focused = value; input.focused = value; },
      render(width: number): string[] {
        const lines: string[] = [];
        lines.push(...borderTop.render(width));
        lines.push(` ${theme.fg("accent", theme.bold(heading))}`);
        lines.push(` ${theme.fg("dim", `Leave empty to ${emptyAction}.`)}`);
        lines.push("");
        for (const line of renderInputWithPlaceholder(input, placeholder, theme, width - 2)) lines.push(` ${line}`);
        lines.push("");
        lines.push(` ${theme.fg("dim", "enter")} submit  ${theme.fg("dim", "esc")} cancel`);
        lines.push(...borderBottom.render(width));
        return lines;
      },
      invalidate() {
        borderTop.invalidate();
        borderBottom.invalidate();
        input.invalidate();
      },
      handleInput(data: string) {
        if (matchesKey(data, Key.escape) || matchesKey(data, Key.ctrl("c"))) {
          done({ cancelled: true });
          return;
        }
        if (matchesKey(data, Key.enter)) {
          submit();
          return;
        }
        input.handleInput(data);
        tui.requestRender();
      },
    };

    return component;
  }, { overlay: true });

  if (result === undefined) {
    const input = await ctx.ui.input(`${heading} (leave empty to ${emptyAction})`, placeholder);
    if (input === undefined) return undefined;
    return normalizePrTitle(input) || fallback;
  }
  if ("cancelled" in result) return undefined;
  return result.value;
}

async function promptPrTitle(ctx: any, suggestedTitle: string): Promise<string | undefined> {
  return promptTitleWithPlaceholder(ctx, "PR title", suggestedTitle, suggestedTitle, "use suggestion");
}

function publishActionLabel(action: PublishAction): string {
  if (action === "create-draft") return "Create draft PR";
  if (action === "create-ready") return "Create ready PR";
  if (action === "update") return "Update existing PR";
  return "Dry-run only";
}

function actionFromLabel(label: string, existing?: ExistingPr): PublishAction | undefined {
  if (label.startsWith("Create draft PR")) return "create-draft";
  if (label.startsWith("Create ready PR")) return "create-ready";
  if (label.startsWith("Update existing PR")) return "update";
  if (label.startsWith("Dry-run only")) return "dry-run";
  if (existing && label.startsWith("Update")) return "update";
  return undefined;
}

async function editPrContent(
  ctx: any,
  generated: GeneratedPr,
  params: { base: string; current: string; existing?: ExistingPr; source: ChangeSource; warning?: string },
): Promise<FinalPrDecision | undefined> {
  const recommendedAction: PublishAction = params.source === "working-tree"
    ? "dry-run"
    : params.existing
      ? "update"
      : "create-draft";
  const preview = previewText(generated.title, generated.body, params.base, params.current, {
    source: params.source,
    existing: params.existing,
    warning: params.warning,
    dryRun: recommendedAction === "dry-run",
  });

  const actionLabels: string[] = [`${publishActionLabel(recommendedAction)} (Recommended)`];
  if (params.source !== "working-tree" && !params.existing) {
    const alternative = recommendedAction === "create-draft" ? "create-ready" : "create-draft";
    actionLabels.push(publishActionLabel(alternative));
  }
  if (recommendedAction !== "dry-run") actionLabels.push("Dry-run only");
  actionLabels.push("Edit title", "Edit body", "Cancel");

  const action = await ctx.ui.select(preview, actionLabels);
  const publishAction = action ? actionFromLabel(action, params.existing) : undefined;
  if (publishAction) return { content: generated, action: publishAction };
  if (action === "Edit title") {
    const title = await promptTitleWithPlaceholder(ctx, "PR title", generated.title, generated.title, "keep current");
    if (title === undefined) return undefined;
    return editPrContent(ctx, { ...generated, title }, params);
  }
  if (action === "Edit body") {
    const body = await ctx.ui.editor("PR body", generated.body);
    if (body === undefined) return undefined;
    return editPrContent(ctx, { ...generated, body: body.trim() || generated.body }, params);
  }

  return undefined;
}

function formatPushFailure(stdout: string, stderr: string): string {
  const message = [stdout, stderr].filter(Boolean).join("\n").trim();
  if (/non-fast-forward|fetch first|rejected/i.test(message)) {
    return `${message}\n\nRemote branch is ahead. Review the remote changes, then push manually with --force-with-lease only if it is safe. Automatic force push is disabled.`;
  }
  return message;
}

async function writeTempBody<T>(body: string, fn: (bodyFile: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), "pi-pr-"));
  const bodyFile = join(dir, "body.md");
  await writeFile(bodyFile, body, "utf8");
  try {
    return await fn(bodyFile);
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => undefined);
  }
}

async function createPr(pi: ExtensionAPI, root: string, current: string, base: string, content: GeneratedPr, draft: boolean): Promise<{ url: string; updatedExisting: boolean }> {
  return writeTempBody(content.body, async (bodyFile) => {
    const args = [
      "pr",
      "create",
      "--title",
      content.title,
      "--body-file",
      bodyFile,
      "--base",
      base,
      "--assignee",
      "@me",
    ];
    if (draft) args.splice(2, 0, "--draft");

    const result = await pi.exec("gh", args, { cwd: root, timeout: 120_000 });
    if (result.code === 0) {
      const createdUrl = result.stdout.trim() || (await existingPrForBranch(pi, root, current))?.url || "";
      return { url: createdUrl, updatedExisting: false };
    }

    const existing = await existingPrForBranch(pi, root, current);
    if (existing) return { url: await updatePr(pi, root, existing, content), updatedExisting: true };
    throw new Error(`gh pr create failed:\n${[result.stdout, result.stderr].filter(Boolean).join("\n").trim()}`);
  });
}

async function updatePr(pi: ExtensionAPI, root: string, pr: ExistingPr, content: GeneratedPr): Promise<string> {
  const result = await pi.exec("gh", [
    "api",
    `repos/{owner}/{repo}/pulls/${pr.number}`,
    "-X",
    "PATCH",
    "-f",
    `body=${content.body}`,
    "-f",
    `title=${content.title}`,
    "--jq",
    ".html_url",
  ], { cwd: root, timeout: 120_000 });
  if (result.code !== 0) {
    throw new Error(`gh pr update failed:\n${[result.stdout, result.stderr].filter(Boolean).join("\n").trim()}`);
  }
  return result.stdout.trim() || pr.url;
}

function tableEscape(value: string): string {
  return value.replace(/\|/g, "\\|").replace(/\n/g, "<br>");
}

function fileSummary(context: ChangeContext): string {
  const shortStat = context.shortStat.trim();
  if (shortStat) {
    const parsed = parseShortStat(shortStat);
    if (context.source === "working-tree" && parsed.files !== undefined && context.changedFiles > parsed.files) {
      return `${shortStat}, ${context.changedFiles - parsed.files} untracked`;
    }
    return shortStat;
  }
  const suffix = context.source === "working-tree" ? " changed in working tree" : " changed";
  return `${context.changedFiles} files${suffix}`;
}

function buildFinalSummary(params: {
  current: string;
  base: string;
  status: "created" | "updated" | "dry-run";
  prUrl?: string;
  context: ChangeContext;
  title: string;
  warning?: string;
}): string {
  const rows = [
    ["Branch", `${params.current} → ${params.base}`],
    ["PR", params.prUrl ?? "dry-run only (no push/create/update)"],
    ["Status", params.status],
    ["Commits", String(params.context.commitCount)],
    ["Files", fileSummary(params.context)],
    ["Title", params.title],
  ];
  if (params.warning) rows.push(["Warning", params.warning]);

  return [
    "| 항목 | 값 |",
    "|---|---|",
    ...rows.map(([key, value]) => `| ${tableEscape(key)} | ${tableEscape(value)} |`),
  ].join("\n");
}

function buildResultMessage(summary: string, content: GeneratedPr, includeBody: boolean): string {
  if (!includeBody) return summary;
  return [summary, "", "### PR Title", content.title, "", "### PR Body", content.body].join("\n");
}

export default function prExtension(pi: ExtensionAPI) {
  registerSuccessMessageRenderer(pi, "pr");

  pi.registerCommand("pr", {
    description: "Create or update a GitHub PR with stacked-base detection and Korean reviewer-focused draft generation.",
    handler: async (args, ctx) => {
      if (!ctx.hasUI) {
        ctx.ui.notify("/pr requires interactive or RPC UI confirmation", "error");
        return;
      }

      const root = await gitRoot(pi, ctx.cwd);
      if (!root) {
        ctx.ui.notify("Not inside a git repository", "error");
        return;
      }

      const working = createCommandWorking(ctx, "pr", "PR");
      const setStatus = (text: string | undefined, details: string[] = []) => {
        working.set(text, details);
      };

      try {
        const parsed = parsePrArgs(args);
        if (!(await hasOriginRemote(pi, root))) {
          ctx.ui.notify("No `origin` remote found. PR creation requires a GitHub remote.", "error");
          return;
        }

        const ghError = await ensureGhReady(pi, root);
        if (ghError) {
          ctx.ui.notify(ghError, "error");
          return;
        }

        const current = await currentBranch(pi, root);
        if (!current) {
          ctx.ui.notify("Cannot create a PR from detached HEAD", "error");
          return;
        }

        const mainBranch = await defaultBranch(pi, root);
        if (current === mainBranch) {
          ctx.ui.notify(`Refusing to create a PR from the default branch (${mainBranch})`, "error");
          return;
        }

        setStatus("Inspecting current branch…", [current]);
        const existing = await existingPrForBranch(pi, root, current);
        let baseChoice = await chooseBaseBranch(pi, root, ctx, parsed, current, mainBranch, existing);
        if (!baseChoice) {
          ctx.ui.notify("Cancelled", "info");
          return;
        }
        baseChoice = await confirmBaseOverride(ctx, baseChoice);
        if (!baseChoice) {
          ctx.ui.notify("Cancelled", "info");
          return;
        }

        if (baseChoice.base === current) {
          ctx.ui.notify("Base branch cannot be the current branch", "error");
          return;
        }

        setStatus("Resolving base ref…", [`${current} → ${baseChoice.base}`]);
        const baseRef = await resolveBaseRef(pi, root, baseChoice.base);
        if (!baseRef) {
          setStatus(undefined);
          ctx.ui.notify(`Base branch not found locally or on origin: ${baseChoice.base}`, "error");
          return;
        }
        const resolvedBase: ResolvedBaseChoice = { ...baseChoice, baseRef };

        const dirty = await git(pi, root, ["status", "--short"], 20_000);
        const source = await chooseChangeSource(ctx, sanitizeStatusShort(dirty.stdout));
        if (!source) {
          ctx.ui.notify("Cancelled", "info");
          return;
        }

        setStatus(source === "working-tree" ? "Gathering working tree changes…" : "Gathering committed changes…", [`${current} → ${resolvedBase.base}`]);
        const context = source === "working-tree"
          ? await collectWorkingTreeContext(pi, root, resolvedBase.baseRef)
          : await collectCommittedContext(pi, root, resolvedBase.baseRef);

        if (context.changedFiles === 0 && !context.log.trim()) {
          setStatus(undefined);
          const sourceLabel = source === "working-tree" ? "working tree changes" : "committed changes";
          ctx.ui.notify(`No ${sourceLabel} found for PR draft`, "info");
          return;
        }

        setStatus("Gathering PR template…", [`${current} → ${resolvedBase.base}`]);
        const template = (await findPrTemplate(root)) ?? DEFAULT_PR_TEMPLATE;
        const modelInput = buildModelInput({
          template,
          current,
          base: resolvedBase.base,
          baseRef: resolvedBase.baseRef,
          baseChoice: resolvedBase,
          existing,
          context,
        });

        setStatus("Generating reviewer-focused PR draft…", [source === "working-tree" ? "working tree scope" : "committed scope", "Why + What"]);
        const generated = await generatePrDraft(ctx, modelInput);
        const suggested = { ...generated, title: withIssueKeyPrefix(generated.title, current) };
        setStatus(undefined);

        const title = parsed.title?.trim() || await promptPrTitle(ctx, suggested.title);
        if (!title) {
          ctx.ui.notify("Cancelled", "info");
          return;
        }

        const finalDecision = await editPrContent(ctx, { ...suggested, title }, {
          base: resolvedBase.base,
          current,
          existing,
          source,
          warning: resolvedBase.overrideWarning,
        });
        if (!finalDecision) {
          ctx.ui.notify("Cancelled", "info");
          return;
        }

        if (finalDecision.action === "dry-run") {
          const summary = buildFinalSummary({
            current,
            base: resolvedBase.base,
            status: "dry-run",
            context,
            title: finalDecision.content.title,
            warning: resolvedBase.overrideWarning,
          });
          setStatus(undefined);
          ctx.ui.notify("Dry-run complete. No push/create/update performed.", "info");
          pi.sendMessage(
            { customType: "pr", content: buildResultMessage(summary, finalDecision.content, true), display: true },
            { triggerTurn: false },
          );
          return;
        }

        setStatus("Pushing branch…", [`${current} → origin`]);
        const push = await git(pi, root, ["push", "-u", "origin", "HEAD"], 120_000);
        if (push.code !== 0) {
          setStatus(undefined);
          ctx.ui.notify(`Push failed:\n${formatPushFailure(push.stdout, push.stderr)}`, "error");
          return;
        }

        let prUrl: string;
        let status: "created" | "updated";
        if (finalDecision.action === "update") {
          const pr = existing ?? await existingPrForBranch(pi, root, current);
          if (!pr) {
            ctx.ui.notify("No existing PR found to update after push", "error");
            return;
          }
          setStatus("Updating PR…", [`#${pr.number}`, `base: ${resolvedBase.base}`]);
          prUrl = await updatePr(pi, root, pr, finalDecision.content);
          status = "updated";
        } else {
          const draft = finalDecision.action === "create-draft";
          setStatus(draft ? "Creating draft PR…" : "Creating PR…", [`base: ${resolvedBase.base}`, "assignee: @me"]);
          const created = await createPr(pi, root, current, resolvedBase.base, finalDecision.content, draft);
          prUrl = created.url;
          status = created.updatedExisting ? "updated" : "created";
        }

        if (prUrl && !parsed.noOpen) await pi.exec("open", [prUrl], { cwd: root, timeout: 10_000 }).catch(() => undefined);
        const summary = buildFinalSummary({
          current,
          base: resolvedBase.base,
          status,
          prUrl,
          context,
          title: finalDecision.content.title,
          warning: resolvedBase.overrideWarning,
        });
        setStatus(undefined);
        ctx.ui.notify(`PR ${status}: ${prUrl}`, "info");
        pi.sendMessage(
          { customType: "pr", content: buildResultMessage(summary, finalDecision.content, false), display: true },
          { triggerTurn: false },
        );
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        ctx.ui.notify(`/pr failed: ${message}`, "error");
      } finally {
        working.clear();
      }
    },
  });
}
