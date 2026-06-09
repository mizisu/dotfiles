import { complete, type Message } from "@mariozechner/pi-ai";
import { BorderedLoader, convertToLlm, DynamicBorder, serializeConversation, type ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Input, Key, SelectList, fuzzyFilter, matchesKey, truncateToWidth, type Component, type Focusable, type SelectItem } from "@mariozechner/pi-tui";
import { spawn } from "node:child_process";
import { constants } from "node:fs";
import { access, mkdir, readdir, readFile, stat, unlink, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { basename, join } from "node:path";
import { registerSuccessMessageRenderer } from "./shared/success-message-renderer.js";

const MAX_GIT_OUTPUT_CHARS = 16_000;
const HANDOFF_MANAGER_MAX_VISIBLE = 24;

type HandoffFile = {
  path: string;
  project: string;
  fileName: string;
  title: string;
  mtimeMs: number;
  size: number;
  isCurrentProject: boolean;
};

type HandoffManagerSelection = {
  action: "insert" | "delete";
  file: HandoffFile;
};

const SYSTEM_PROMPT = `You create a handoff markdown file for code review or for another coding agent to continue the work.

Rules:
- Start with exactly one concise top-level title: # Handoff: <short topic>
- Use the same language as the user when practical.
- Use only the provided conversation history and git summary as sources.
- Do not invent tests, verification, requirements, files, or decisions.
- If verification is unclear, explicitly say it is not confirmed.
- Be concise, but make the result self-contained enough for a reviewer or next agent.

Recommended structure:
# Handoff: <short topic>

## Goal

## Current State

## Git State

## Important Files

## Decisions / Constraints

## Verification

## Review Focus / Next Steps

## Suggested Prompt
`;

function entryToMessage(entry: any): any | undefined {
  if (entry.type === "message") return entry.message;
  if (entry.type === "compaction") {
    return {
      role: "compactionSummary",
      summary: entry.summary,
      tokensBefore: entry.tokensBefore,
      timestamp: new Date(entry.timestamp).getTime(),
    };
  }
  return undefined;
}

function getHandoffMessages(branch: any[]): any[] {
  let compactionIndex = -1;
  for (let index = branch.length - 1; index >= 0; index--) {
    if (branch[index].type === "compaction") {
      compactionIndex = index;
      break;
    }
  }

  if (compactionIndex < 0) return branch.map(entryToMessage).filter((message) => message !== undefined);

  const compaction = branch[compactionIndex];
  const firstKeptIndex = branch.findIndex((entry) => entry.id === compaction.firstKeptEntryId);
  const compactedBranch = [
    compaction,
    ...(firstKeptIndex >= 0 ? branch.slice(firstKeptIndex, compactionIndex) : []),
    ...branch.slice(compactionIndex + 1),
  ];
  return compactedBranch.map(entryToMessage).filter((message) => message !== undefined);
}

function truncateText(value: string, maxChars = MAX_GIT_OUTPUT_CHARS): string {
  if (value.length <= maxChars) return value;
  const note = "\n[truncated]\n";
  const head = Math.floor((maxChars - note.length) * 0.7);
  const tail = Math.max(0, maxChars - note.length - head);
  return `${value.slice(0, head)}${note}${value.slice(value.length - tail)}`;
}

function isSensitiveOutputLine(line: string): boolean {
  const normalized = line.replace(/\\/g, "/");
  return normalized.includes("agent/auth.json") || /(^|[\s/])\.env(?:$|[\s./])/.test(normalized);
}

function filterSensitiveLines(output: string): { text: string; omitted: number } {
  let omitted = 0;
  const lines = output.split("\n").filter((line) => {
    const sensitive = isSensitiveOutputLine(line);
    if (sensitive) omitted++;
    return !sensitive;
  });
  return { text: lines.join("\n").trim(), omitted };
}

async function git(pi: ExtensionAPI, cwd: string, args: string[], timeout = 20_000): Promise<string> {
  const result = await pi.exec("git", args, { cwd, timeout });
  return result.code === 0 ? result.stdout.trim() : "";
}

async function gitRoot(pi: ExtensionAPI, cwd: string): Promise<string | undefined> {
  const root = await git(pi, cwd, ["rev-parse", "--show-toplevel"], 10_000);
  return root || undefined;
}

async function collectGitSummary(pi: ExtensionAPI, cwd: string): Promise<{ root?: string; text: string }> {
  const root = await gitRoot(pi, cwd);
  if (!root) return { text: `Not inside a git repository.\nCWD: ${cwd}` };

  const [branch, head, statusRaw, diffStatRaw, changedRaw, recentLog] = await Promise.all([
    git(pi, root, ["branch", "--show-current"], 10_000),
    git(pi, root, ["rev-parse", "--short", "HEAD"], 10_000),
    git(pi, root, ["status", "--short"], 20_000),
    git(pi, root, ["diff", "--stat", "HEAD"], 30_000),
    git(pi, root, ["diff", "--name-only", "HEAD"], 30_000),
    git(pi, root, ["log", "--oneline", "-5"], 20_000),
  ]);

  const status = filterSensitiveLines(statusRaw);
  const diffStat = filterSensitiveLines(diffStatRaw);
  const changed = filterSensitiveLines(changedRaw);
  const omitted = status.omitted + diffStat.omitted + changed.omitted;

  const lines = [
    `Repository: ${root}`,
    `Branch: ${branch || "(detached)"}`,
    `HEAD: ${head || "unknown"}`,
    omitted > 0 ? `Sensitive git output lines omitted: ${omitted}` : "",
    "",
    "Recent commits:",
    recentLog || "(none)",
    "",
    "Status:",
    status.text || "(clean)",
    "",
    "Diff stat:",
    diffStat.text || "(no tracked diff)",
    "",
    "Changed tracked files:",
    changed.text || "(none)",
  ].filter((line, index, all) => line || all[index - 1] !== "");

  return { root, text: truncateText(lines.join("\n")) };
}

function formatTimestamp(date = new Date()): string {
  const pad = (value: number) => String(value).padStart(2, "0");
  return [
    date.getFullYear(),
    pad(date.getMonth() + 1),
    pad(date.getDate()),
    pad(date.getHours()),
    pad(date.getMinutes()),
    pad(date.getSeconds()),
  ].join("-");
}

function titleFromMarkdown(markdown: string, fallback: string): string {
  const match = markdown.match(/^#\s+(?:Handoff:\s*)?(.+)$/m);
  return match?.[1]?.trim() || fallback.trim() || "handoff";
}

function slugifyFilename(value: string): string {
  return value
    .normalize("NFC")
    .toLowerCase()
    .replace(/[<>:"/\\|?*\x00-\x1f]+/g, "-")
    .replace(/[`'’“”()[\]{}#*_~]+/g, "")
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 80)
    || "handoff";
}

function agentDir(): string {
  return process.env.PI_CODING_AGENT_DIR?.trim() || join(homedir(), ".pi", "agent");
}

function projectSlug(root: string | undefined, cwd: string): string {
  return slugifyFilename(basename(root || cwd) || "project");
}

function handoffsRootDir(): string {
  return join(agentDir(), "handoffs");
}

function fallbackTitleFromFilename(fileName: string): string {
  const stem = fileName.replace(/\.md$/i, "");
  const withoutTimestamp = stem.replace(/^\d{4}-\d{2}-\d{2}-\d{2}-\d{2}-\d{2}-/, "");
  return withoutTimestamp.replace(/-/g, " ").trim() || stem || "handoff";
}

function formatDisplayDate(ms: number): string {
  if (!Number.isFinite(ms)) return "unknown";
  const date = new Date(ms);
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function readHandoffTitle(filePath: string, fallback: string): Promise<string> {
  try {
    const markdown = await readFile(filePath, "utf8");
    return titleFromMarkdown(markdown, fallback);
  } catch {
    return fallback;
  }
}

async function loadHandoffFile(project: string, filePath: string, fileName: string, currentProject: string): Promise<HandoffFile | undefined> {
  try {
    const info = await stat(filePath);
    if (!info.isFile()) return undefined;

    const fallback = fallbackTitleFromFilename(fileName);
    const title = await readHandoffTitle(filePath, fallback);
    return {
      path: filePath,
      project,
      fileName,
      title,
      mtimeMs: info.mtimeMs,
      size: info.size,
      isCurrentProject: project === currentProject,
    };
  } catch {
    return undefined;
  }
}

async function listHandoffFiles(currentProject: string): Promise<HandoffFile[]> {
  const root = handoffsRootDir();
  let entries;
  try {
    entries = await readdir(root, { withFileTypes: true });
  } catch (error: any) {
    if (error?.code === "ENOENT") return [];
    throw error;
  }

  const files: HandoffFile[] = [];
  for (const entry of entries) {
    if (entry.isDirectory()) {
      const project = entry.name;
      const projectDir = join(root, project);
      let projectEntries;
      try {
        projectEntries = await readdir(projectDir, { withFileTypes: true });
      } catch {
        continue;
      }

      for (const projectEntry of projectEntries) {
        if (!projectEntry.isFile() || !projectEntry.name.toLowerCase().endsWith(".md")) continue;
        const handoff = await loadHandoffFile(project, join(projectDir, projectEntry.name), projectEntry.name, currentProject);
        if (handoff) files.push(handoff);
      }
      continue;
    }

    if (!entry.isFile() || !entry.name.toLowerCase().endsWith(".md")) continue;
    const handoff = await loadHandoffFile("handoffs", join(root, entry.name), entry.name, currentProject);
    if (handoff) files.push(handoff);
  }

  return files.sort((a, b) => {
    if (a.isCurrentProject !== b.isCurrentProject) return a.isCurrentProject ? -1 : 1;
    const timeDiff = b.mtimeMs - a.mtimeMs;
    if (timeDiff !== 0) return timeDiff;
    return `${a.project}/${a.fileName}`.localeCompare(`${b.project}/${b.fileName}`);
  });
}

function handoffToSelectItem(file: HandoffFile): SelectItem {
  return {
    value: file.path,
    label: `${formatDisplayDate(file.mtimeMs)}  ${file.title}`,
  };
}

function filterHandoffItems(items: SelectItem[], query: string): SelectItem[] {
  const trimmed = query.trim();
  if (!trimmed) return items;
  return fuzzyFilter(items, trimmed, (item) => `${item.label} ${item.description ?? ""} ${item.value}`);
}

async function uniqueHandoffPath(directory: string, filename: string): Promise<string> {
  const extension = ".md";
  const stem = filename.endsWith(extension) ? filename.slice(0, -extension.length) : filename;

  for (let index = 0; index < 100; index++) {
    const suffix = index === 0 ? "" : `-${index + 1}`;
    const candidate = join(directory, `${stem}${suffix}${extension}`);
    try {
      await access(candidate, constants.F_OK);
    } catch {
      return candidate;
    }
  }

  return join(directory, `${stem}-${Date.now()}${extension}`);
}

function extractAssistantText(response: any): string {
  return (response.content ?? [])
    .filter((part: any): part is { type: "text"; text: string } => part?.type === "text" && typeof part.text === "string")
    .map((part: { text: string }) => part.text)
    .join("\n")
    .trim();
}

function externalEditorCommand(): string | undefined {
  return process.env.VISUAL?.trim() || process.env.EDITOR?.trim() || undefined;
}

async function showHandoffManager(ctx: any, files: HandoffFile[], currentProject: string, initialQuery = ""): Promise<HandoffManagerSelection | undefined> {
  const filesByPath = new Map(files.map((file) => [file.path, file]));
  const currentProjectCount = files.filter((file) => file.isCurrentProject).length;

  return ctx.ui.custom<HandoffManagerSelection | undefined>((tui: any, theme: any, _keybindings: any, done: (value: HandoffManagerSelection | undefined) => void) => {
    const rows = tui.terminal.rows || 24;
    const maxVisible = Math.min(HANDOFF_MANAGER_MAX_VISIBLE, Math.max(5, rows - 10));
    const borderTop = new DynamicBorder((s: string) => theme.fg("accent", s));
    const borderBottom = new DynamicBorder((s: string) => theme.fg("accent", s));
    const searchInput = new Input();
    if (initialQuery) searchInput.setValue(initialQuery);

    const allItems = files.map(handoffToSelectItem);
    const selectTheme = {
      selectedPrefix: (text: string) => theme.fg("accent", text),
      selectedText: (text: string) => theme.fg("accent", text),
      description: (text: string) => theme.fg("muted", text),
      scrollInfo: (text: string) => theme.fg("dim", text),
      noMatch: (_text: string) => theme.fg("warning", "  No matching handoffs"),
    };

    const createSelectList = (items: SelectItem[]) => {
      const list = new SelectList(items, maxVisible, selectTheme);
      list.onSelect = (item) => finish("insert", item.value);
      list.onCancel = () => done(undefined);
      return list;
    };

    let filteredItems = filterHandoffItems(allItems, searchInput.getValue());
    let selectList = createSelectList(filteredItems);
    let lastQuery = searchInput.getValue();
    let focused = false;

    const finish = (action: "insert" | "delete", selectedPath?: string) => {
      const path = selectedPath ?? selectList.getSelectedItem()?.value;
      const file = path ? filesByPath.get(path) : undefined;
      if (!file) return;
      done({ action, file });
    };

    const applyFilter = (query: string) => {
      filteredItems = filterHandoffItems(allItems, query);
      selectList = createSelectList(filteredItems);
    };

    const component: Component & Focusable = {
      get focused(): boolean {
        return focused;
      },
      set focused(value: boolean) {
        focused = value;
        searchInput.focused = value;
      },

      render(width: number): string[] {
        const innerWidth = Math.max(1, width - 2);
        const query = searchInput.getValue();
        const matchInfo = query
          ? theme.fg("dim", ` ${filteredItems.length}/${files.length}`)
          : theme.fg("dim", ` ${files.length} handoff${files.length === 1 ? "" : "s"}`);
        const separator = theme.fg("dim", ` ${"─".repeat(Math.max(1, innerWidth))}`);

        const lines: string[] = [];
        lines.push(...borderTop.render(width));
        lines.push(truncateToWidth(` ${theme.fg("accent", theme.bold("Handoff Manager"))}${matchInfo}`, width));
        lines.push(truncateToWidth(` ${theme.fg("muted", "current project")} ${theme.fg("accent", currentProject)}${theme.fg("dim", ` (${currentProjectCount})`)}`, width));
        lines.push("");
        for (const line of searchInput.render(innerWidth)) {
          lines.push(truncateToWidth(` ${line}`, width));
        }
        lines.push(truncateToWidth(separator, width));
        lines.push(...selectList.render(width));
        lines.push("");
        lines.push(truncateToWidth(` ${theme.fg("dim", "↑↓")} ${theme.fg("muted", "navigate")}  ${theme.fg("dim", "enter")} ${theme.fg("muted", "insert @path")}  ${theme.fg("dim", "ctrl+d")} ${theme.fg("muted", "delete")}  ${theme.fg("dim", "esc")} ${theme.fg("muted", "cancel")}`, width));
        lines.push(...borderBottom.render(width));
        return lines;
      },

      invalidate(): void {
        borderTop.invalidate();
        borderBottom.invalidate();
        searchInput.invalidate();
        selectList.invalidate();
      },

      handleInput(data: string): void {
        if (matchesKey(data, Key.escape) || matchesKey(data, Key.ctrl("c"))) {
          done(undefined);
          return;
        }

        if (matchesKey(data, Key.enter)) {
          finish("insert");
          return;
        }

        if (matchesKey(data, Key.ctrl("d"))) {
          finish("delete");
          return;
        }

        if (matchesKey(data, Key.up) || matchesKey(data, Key.down)) {
          selectList.handleInput(data);
          tui.requestRender();
          return;
        }

        searchInput.handleInput(data);
        const nextQuery = searchInput.getValue();
        if (nextQuery !== lastQuery) {
          applyFilter(nextQuery);
          lastQuery = nextQuery;
        }
        tui.requestRender();
      },
    };

    return component;
  }, {
    overlay: true,
    overlayOptions: {
      anchor: "center",
      width: "90%",
      minWidth: 48,
      maxHeight: "85%",
      margin: 2,
    },
  });
}

async function manageHandoffs(pi: ExtensionAPI, ctx: any, initialQuery = ""): Promise<void> {
  if (!ctx.hasUI) {
    ctx.ui.notify("/handoffs requires interactive or RPC UI", "error");
    return;
  }

  await ctx.waitForIdle();

  const root = await gitRoot(pi, ctx.cwd);
  const currentProject = projectSlug(root, ctx.cwd);

  while (true) {
    let files: HandoffFile[];
    try {
      files = await listHandoffFiles(currentProject);
    } catch (error) {
      ctx.ui.notify(`Failed to list handoffs: ${errorText(error)}`, "error");
      return;
    }

    if (files.length === 0) {
      ctx.ui.notify("No saved handoffs. Generate one with /handoff <goal>.", "warning");
      return;
    }

    const selection = await showHandoffManager(ctx, files, currentProject, initialQuery);
    if (!selection) {
      ctx.ui.notify("Cancelled", "info");
      return;
    }

    if (selection.action === "insert") {
      ctx.ui.pasteToEditor(`@${selection.file.path} `);
      ctx.ui.notify(`Inserted handoff: ${selection.file.fileName}`, "info");
      return;
    }

    const confirmed = await ctx.ui.confirm("Delete handoff?", `${selection.file.title}\n${selection.file.path}`);
    if (!confirmed) continue;

    try {
      await unlink(selection.file.path);
      ctx.ui.notify(`Deleted handoff: ${selection.file.fileName}`, "info");
    } catch (error) {
      ctx.ui.notify(`Failed to delete handoff: ${errorText(error)}`, "error");
    }
  }
}

async function editInExternalEditor(ctx: any, title: string, prefill: string): Promise<string | undefined> {
  const editorCmd = externalEditorCommand();
  if (!editorCmd) {
    ctx.ui.notify("$VISUAL or $EDITOR is not set; using inline editor", "warning");
    return ctx.ui.editor(title, prefill);
  }

  let errorMessage: string | undefined;
  const edited = await ctx.ui.custom<string | undefined>((tui: any, theme: any, _kb: any, done: (value: string | undefined) => void) => {
    const loader = new BorderedLoader(tui, theme, `Opening external editor: ${editorCmd}`);
    let finished = false;
    const finish = (value: string | undefined) => {
      if (finished) return;
      finished = true;
      done(value);
    };
    loader.onAbort = () => finish(undefined);

    const run = async () => {
      const tempFile = join(tmpdir(), `pi-handoff-${Date.now()}.md`);
      try {
        await writeFile(tempFile, prefill, "utf8");
        tui.stop();

        const [editor, ...editorArgs] = editorCmd.split(" ").filter(Boolean);
        process.stdout.write(`Launching external editor: ${editorCmd}\nPi will resume when the editor exits.\n`);
        const status = await new Promise<number | null>((resolve) => {
          const child = spawn(editor, [...editorArgs, tempFile], {
            stdio: "inherit",
            shell: process.platform === "win32",
          });
          child.on("error", () => resolve(null));
          child.on("close", (code) => resolve(code));
        });

        if (status !== 0) {
          errorMessage = status === null ? `Failed to launch external editor: ${editorCmd}` : `External editor exited with code ${status}`;
          return undefined;
        }

        return (await readFile(tempFile, "utf8")).replace(/\n$/, "");
      } finally {
        await unlink(tempFile).catch(() => undefined);
        tui.start();
        tui.requestRender(true);
      }
    };

    run()
      .then(finish)
      .catch((error) => {
        errorMessage = error instanceof Error ? error.message : String(error);
        finish(undefined);
      });

    return loader;
  });

  if (edited === undefined && errorMessage) ctx.ui.notify(errorMessage, "error");
  return edited;
}

export default function handoffExtension(pi: ExtensionAPI) {
  registerSuccessMessageRenderer(pi, "handoff");

  pi.registerCommand("handoffs", {
    description: "Manage saved handoff files: insert @references or delete old handoffs.",
    handler: async (args, ctx) => {
      await manageHandoffs(pi, ctx, (args ?? "").trim());
    },
  });

  pi.registerCommand("handoff", {
    description: "Generate a markdown handoff file for review or continuation; run without args to manage saved handoffs.",
    handler: async (args, ctx) => {
      const goal = (args ?? "").trim();
      if (!goal) {
        await manageHandoffs(pi, ctx);
        return;
      }

      if (!ctx.hasUI) {
        ctx.ui.notify("/handoff requires interactive or RPC UI", "error");
        return;
      }

      if (!ctx.model) {
        ctx.ui.notify("No model selected", "error");
        return;
      }

      await ctx.waitForIdle();

      const messages = getHandoffMessages(ctx.sessionManager.getBranch());
      if (messages.length === 0) {
        ctx.ui.notify("No conversation to hand off", "error");
        return;
      }

      const gitSummary = await collectGitSummary(pi, ctx.cwd);
      const conversationText = serializeConversation(convertToLlm(messages));
      const sessionFile = ctx.sessionManager.getSessionFile() ?? "(ephemeral)";
      const leafId = ctx.sessionManager.getLeafId?.() ?? "(unknown)";
      let generationError: string | undefined;

      const generated = await ctx.ui.custom<string | null>((tui, theme, _kb, done) => {
        const loader = new BorderedLoader(tui, theme, "Generating handoff markdown...");
        loader.onAbort = () => done(null);

        const generate = async () => {
          const auth = await ctx.modelRegistry.getApiKeyAndHeaders(ctx.model!);
          if (!auth.ok || !auth.apiKey) throw new Error(auth.ok ? `No API key for ${ctx.model!.provider}` : auth.error);

          const userMessage: Message = {
            role: "user",
            content: [{
              type: "text",
              text: [
                `## Handoff Goal\n${goal}`,
                `## Session Metadata\nSession file: ${sessionFile}\nLeaf id: ${leafId}`,
                `## Git Summary\n${gitSummary.text}`,
                `## Conversation History\n${conversationText}`,
              ].join("\n\n"),
            }],
            timestamp: Date.now(),
          } as Message;

          const response = await complete(
            ctx.model!,
            { systemPrompt: SYSTEM_PROMPT, messages: [userMessage] },
            { apiKey: auth.apiKey, headers: auth.headers, signal: loader.signal },
          );

          if (response.stopReason === "aborted") return null;
          if (response.stopReason === "error") throw new Error(response.errorMessage ?? "model error");

          const text = extractAssistantText(response);
          if (!text) throw new Error("model returned an empty handoff");
          return text;
        };

        generate()
          .then(done)
          .catch((error) => {
            generationError = error instanceof Error ? error.message : String(error);
            done(null);
          });

        return loader;
      });

      if (generated === null) {
        ctx.ui.notify(generationError ? `/handoff failed: ${generationError}` : "Cancelled", generationError ? "error" : "info");
        return;
      }

      const edited = await editInExternalEditor(ctx, "Edit handoff markdown", generated);
      if (edited === undefined) {
        ctx.ui.notify("Cancelled", "info");
        return;
      }

      const markdown = edited.trim();
      if (!markdown) {
        ctx.ui.notify("Handoff is empty; nothing saved", "error");
        return;
      }

      const timestamp = formatTimestamp();
      const slug = slugifyFilename(titleFromMarkdown(markdown, goal));
      const directory = join(agentDir(), "handoffs", projectSlug(gitSummary.root, ctx.cwd));
      await mkdir(directory, { recursive: true });

      const filePath = await uniqueHandoffPath(directory, `${timestamp}-${slug}.md`);
      await writeFile(filePath, `${markdown}\n`, "utf8");

      const nextPrompt = `Read this handoff and continue from the current repository state:\n@${filePath}`;
      pi.sendMessage(
        {
          customType: "handoff",
          content: `✓ Handoff saved:\n${filePath}\n\nNext agent prompt:\n${nextPrompt}`,
          display: true,
          details: { path: filePath, goal, sessionFile, leafId },
        },
        { triggerTurn: false },
      );
      ctx.ui.notify(`Handoff saved: ${filePath}`, "info");
    },
  });
}
