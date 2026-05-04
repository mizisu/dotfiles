import { complete, type Message } from "@mariozechner/pi-ai";
import { DynamicBorder, type ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Input, Key, SelectList, fuzzyFilter, matchesKey, type Component, type Focusable, type SelectItem } from "@mariozechner/pi-tui";
import { mkdtemp, readFile, readdir, stat, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { registerSuccessMessageRenderer } from "./shared/success-message-renderer.js";
import { resolveMediumModel } from "./shared/model-slots.js";
import { createCommandWorking } from "./shared/command-working.js";

const MAX_DIFF_CHARS = 100_000;
const MAX_SESSION_CONTEXT_CHARS = 12_000;
const MAX_TEMPLATE_CHARS = 30_000;
const MAX_TITLE_CHARS = 100;

const SENSITIVE_EXCLUDE_PATHS = [
  ":(exclude).env",
  ":(exclude).env.*",
  ":(exclude)**/.env",
  ":(exclude)**/.env.*",
  ":(exclude)agent/auth.json",
];

const PR_SYSTEM_PROMPT = `You generate a GitHub pull request title and body.

Return ONLY valid JSON, no markdown fences:
{
  "title": "Plain descriptive PR title",
  "body": "Markdown PR body"
}

Rules:
- Title: imperative mood, under 72 characters, specific to the actual change.
- Do not use Conventional Commit prefixes in the title.
- Body: concise and reviewer-focused.
- Fill the provided PR template when present; otherwise use useful sections like ## Summary and ## Why.
- Prefer 3-6 bullets total. Use "- " for bullets.
- Explain WHY and reviewer-relevant impact more than file-by-file details.
- Session context is a hint. If it conflicts with commits/diff, trust commits/diff.
- Do not invent changes that are not in the commits/diff.
- Do not reference tools, reviewers, or the assistant.
- Add a compact Mermaid diagram only if it clearly helps explain a non-trivial architecture or flow change.`;

interface GeneratedPr {
  title: string;
  body: string;
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
    .slice(-12)
    .map((entry: any) => {
      const message = entry.message;
      const role = typeof message.role === "string" ? message.role : "message";
      const text = truncateText(textFromContent(message.content).trim(), 1200);
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

function normalizePrContent(raw: unknown): GeneratedPr {
  const parsed = raw as any;
  const title = String(parsed?.title ?? "").replace(/\s+/g, " ").trim();
  const body = String(parsed?.body ?? "").trim();
  if (!title) throw new Error("missing title");
  if (!body) throw new Error("missing body");
  return {
    title: title.length <= MAX_TITLE_CHARS ? title : `${title.slice(0, MAX_TITLE_CHARS - 1).trimEnd()}…`,
    body,
  };
}

function parseBranchArg(args: string | undefined): string | undefined {
  const raw = (args ?? "").trim();
  if (!raw) return undefined;
  const first = raw.split(/\s+/, 1)[0];
  if (!first || first.startsWith("-")) return undefined;
  return first.replace(/^origin\//, "");
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

async function remoteBranches(pi: ExtensionAPI, root: string): Promise<string[]> {
  const result = await git(pi, root, ["branch", "-r", "--sort=-committerdate", "--format=%(refname:short)"], 10_000);
  if (result.code !== 0) return [];
  return [...new Set(result.stdout
    .split("\n")
    .map((branch) => branch.trim().replace(/^origin\//, ""))
    .filter((branch) => branch && branch !== "HEAD" && !branch.includes("/HEAD")))];
}

async function currentBranch(pi: ExtensionAPI, root: string): Promise<string | undefined> {
  const result = await git(pi, root, ["branch", "--show-current"], 10_000);
  const branch = result.stdout.trim();
  return result.code === 0 && branch ? branch : undefined;
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
    const branch = ref?.replace(/^origin\//, "");
    if (!branch || branch === "HEAD" || branch === current || !sha || !branchOrder.has(branch)) continue;
    const distance = historyIndex.get(sha);
    if (distance === undefined) continue;
    const order = branchOrder.get(branch)!;
    if (!best || distance < best.distance || (distance === best.distance && order < best.order)) {
      best = { branch, distance, order };
    }
  }

  return best?.branch ?? (branches.includes("main") ? "main" : branches[0]);
}

async function openBaseBranchPicker(pi: ExtensionAPI, root: string, ctx: any): Promise<string | undefined> {
  const branches = await remoteBranches(pi, root);
  if (branches.length === 0) {
    ctx.ui.notify("No origin remote branches found", "warning");
    return undefined;
  }

  const suggested = await suggestedBaseBranch(pi, root, branches);
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

async function generatePrContent(ctx: any, input: string): Promise<GeneratedPr> {
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
  return normalizePrContent(extractJsonObject(extractAssistantText(response)));
}

async function ensureGhReady(pi: ExtensionAPI, root: string): Promise<string | undefined> {
  const version = await pi.exec("gh", ["--version"], { cwd: root, timeout: 10_000 });
  if (version.code !== 0) return "GitHub CLI `gh` is not installed or not on PATH.";

  const auth = await pi.exec("gh", ["auth", "status"], { cwd: root, timeout: 15_000 });
  if (auth.code !== 0) return `GitHub CLI is not authenticated:\n${[auth.stdout, auth.stderr].filter(Boolean).join("\n").trim()}`;
  return undefined;
}

async function existingPrUrl(pi: ExtensionAPI, root: string): Promise<string | undefined> {
  const result = await pi.exec("gh", ["pr", "view", "--json", "url", "--jq", ".url"], { cwd: root, timeout: 20_000 });
  if (result.code !== 0) return undefined;
  return result.stdout.trim() || undefined;
}

function previewText(title: string, body: string, base: string, current: string): string {
  return [`${current} → ${base}`, "", title, "─".repeat(40), body, "", "This will push the current branch to origin and create a draft PR."].join("\n");
}

async function editPrContent(ctx: any, generated: GeneratedPr, base: string, current: string): Promise<GeneratedPr | undefined> {
  const preview = previewText(generated.title, generated.body, base, current);
  const action = await ctx.ui.select(preview, [
    "Create draft PR (Recommended)",
    "Edit title",
    "Edit body",
    "Cancel",
  ]);

  if (action === "Create draft PR (Recommended)") return generated;
  if (action === "Edit title") {
    const next = await ctx.ui.input("PR title (leave empty to keep current)", generated.title);
    if (next === undefined) return undefined;
    const title = next.trim() || generated.title;
    return editPrContent(ctx, { ...generated, title: title.slice(0, MAX_TITLE_CHARS) }, base, current);
  }
  if (action === "Edit body") {
    const body = await ctx.ui.editor("PR body", generated.body);
    if (body === undefined) return undefined;
    return editPrContent(ctx, { ...generated, body: body.trim() || generated.body }, base, current);
  }

  return undefined;
}

export default function prExtension(pi: ExtensionAPI) {
  registerSuccessMessageRenderer(pi, "pr");

  pi.registerCommand("pr", {
    description: "Create a draft GitHub PR from committed changes using the configured medium model.",
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

        let base = parseBranchArg(args);
        if (!base) base = await openBaseBranchPicker(pi, root, ctx);
        if (!base) {
          ctx.ui.notify("Cancelled", "info");
          return;
        }

        if (base === current) {
          ctx.ui.notify("Base branch cannot be the current branch", "error");
          return;
        }

        const existing = await existingPrUrl(pi, root);
        if (existing) {
          ctx.ui.notify(`PR already exists: ${existing}`, "info");
          pi.sendMessage({ customType: "pr", content: `Existing PR: ${existing}`, display: true }, { triggerTurn: false });
          return;
        }

        setStatus("Gathering PR context…", [`${current} → ${base}`]);
        const baseRef = `origin/${base}`;
        const pathspec = ["--", ".", ...SENSITIVE_EXCLUDE_PATHS];
        const [baseCheck, status, log, diff] = await Promise.all([
          git(pi, root, ["rev-parse", "--verify", baseRef], 10_000),
          git(pi, root, ["status", "--short"], 20_000),
          git(pi, root, ["log", "--oneline", `${baseRef}..HEAD`], 20_000),
          git(pi, root, ["diff", "--no-ext-diff", "--no-color", `${baseRef}...HEAD`, ...pathspec], 60_000),
        ]);

        if (baseCheck.code !== 0) {
          setStatus(undefined);
          ctx.ui.notify(`Base branch not found: ${baseRef}`, "error");
          return;
        }

        if (!log.stdout.trim() && !diff.stdout.trim()) {
          setStatus(undefined);
          ctx.ui.notify(`No committed changes between ${base} and HEAD`, "info");
          return;
        }

        if (status.stdout.trim()) {
          setStatus(undefined);
          const choice = await ctx.ui.select("Uncommitted changes detected. PR generation uses committed changes only; working tree changes will not be included.", [
            "Cancel and run /commit first (Recommended)",
            "Continue with committed changes only",
          ]);
          if (choice !== "Continue with committed changes only") {
            ctx.ui.notify("Cancelled", "info");
            return;
          }
          setStatus("Gathering PR context…", [`${current} → ${base}`]);
        }

        const [template, sessionContext] = await Promise.all([
          findPrTemplate(root),
          Promise.resolve(buildSessionContext(ctx)),
        ]);

        const modelInput = [
          template ? `## PR Template\n${template}` : "",
          sessionContext ? `## Recent Session Context\n${sessionContext}` : "",
          `## Branch\n${current} → ${base}`,
          `## Commits\n${log.stdout.trim()}`,
          `## Diff (sensitive files excluded)\n${truncateText(diff.stdout, MAX_DIFF_CHARS, "[diff truncated]")}`,
        ].filter(Boolean).join("\n\n");

        setStatus("Generating PR with medium model…", ["title/body draft"]);
        const generated = await generatePrContent(ctx, modelInput);
        setStatus(undefined);

        const finalContent = await editPrContent(ctx, generated, base, current);
        if (!finalContent) {
          ctx.ui.notify("Cancelled", "info");
          return;
        }

        setStatus("Pushing branch…", [`${current} → origin`]);
        const push = await git(pi, root, ["push", "-u", "origin", "HEAD"], 120_000);
        if (push.code !== 0) {
          setStatus(undefined);
          ctx.ui.notify(`Push failed:\n${[push.stdout, push.stderr].filter(Boolean).join("\n").trim()}`, "error");
          return;
        }

        setStatus("Creating draft PR…", [`base: ${base}`, "assignee: @me"]);
        const dir = await mkdtemp(join(tmpdir(), "pi-pr-"));
        const bodyFile = join(dir, "body.md");
        await writeFile(bodyFile, finalContent.body, "utf8");
        try {
          const result = await pi.exec("gh", [
            "pr",
            "create",
            "--draft",
            "--title",
            finalContent.title,
            "--body-file",
            bodyFile,
            "--base",
            base,
            "--assignee",
            "@me",
          ], { cwd: root, timeout: 120_000 });
          if (result.code !== 0) {
            setStatus(undefined);
            ctx.ui.notify(`gh pr create failed:\n${[result.stdout, result.stderr].filter(Boolean).join("\n").trim()}`, "error");
            return;
          }

          const prUrl = result.stdout.trim();
          if (prUrl) await pi.exec("open", [prUrl], { cwd: root, timeout: 10_000 }).catch(() => undefined);
          setStatus(undefined);
          ctx.ui.notify(`PR created: ${prUrl}`, "info");
          pi.sendMessage(
            { customType: "pr", content: `✓ Created draft PR: ${prUrl}\nTitle: ${finalContent.title}`, display: true },
            { triggerTurn: false },
          );
        } finally {
          await unlink(bodyFile).catch(() => {});
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        ctx.ui.notify(`/pr failed: ${message}`, "error");
      } finally {
        working.clear();
      }
    },
  });
}
