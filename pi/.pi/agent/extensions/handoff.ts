import { complete, type Message } from "@mariozechner/pi-ai";
import { BorderedLoader, convertToLlm, serializeConversation, type ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { spawn } from "node:child_process";
import { constants } from "node:fs";
import { access, mkdir, readFile, unlink, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { basename, join } from "node:path";
import { registerSuccessMessageRenderer } from "./shared/success-message-renderer.js";

const MAX_GIT_OUTPUT_CHARS = 16_000;

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

  pi.registerCommand("handoff", {
    description: "Generate a markdown handoff file for review or continuation.",
    handler: async (args, ctx) => {
      if (!ctx.hasUI) {
        ctx.ui.notify("/handoff requires interactive or RPC UI", "error");
        return;
      }

      if (!ctx.model) {
        ctx.ui.notify("No model selected", "error");
        return;
      }

      const goal = (args ?? "").trim();
      if (!goal) {
        ctx.ui.notify("Usage: /handoff <goal for review or next agent>", "error");
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
