import { complete, type Message } from "@mariozechner/pi-ai";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { DynamicBorder } from "@mariozechner/pi-coding-agent";
import { Key, matchesKey, truncateToWidth, visibleWidth, wrapTextWithAnsi } from "@mariozechner/pi-tui";
import { createCommandWorking, type CommandWorking } from "./shared/command-working.js";

const MAX_CONTEXT_BYTES = 60_000;
const MAX_ANSWER_BYTES = 20_000;

const SYSTEM_PROMPT = `You answer side questions about an ongoing coding session.

Use the supplied conversation context only. Do not claim to have inspected files or run commands. Answer concisely and directly. If the context is insufficient, say what is missing and suggest the smallest next lookup.`;

type BtwStatus = "pending" | "done" | "error";

type BtwThread = {
  id: number;
  question: string;
  context: string;
  status: BtwStatus;
  createdAt: number;
  answer?: string;
  error?: string;
  abort: AbortController;
};

function textFromContent(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";

  return content
    .map((part: any) => {
      if (part?.type === "text" && typeof part.text === "string") return part.text;
      if (part?.type === "toolCall") return `[tool call: ${part.name ?? "unknown"}]`;
      if (part?.type === "thinking" && typeof part.thinking === "string") return part.thinking;
      return "";
    })
    .filter(Boolean)
    .join("\n");
}

function truncateHeadByBytes(text: string, maxBytes: number): string {
  if (Buffer.byteLength(text, "utf8") <= maxBytes) return text;

  const lines = text.split(/\r\n|\r|\n/);
  const kept: string[] = [];
  let size = 0;
  for (let index = lines.length - 1; index >= 0; index--) {
    const line = lines[index];
    const lineSize = Buffer.byteLength(line, "utf8") + 1;
    if (kept.length > 0 && size + lineSize > maxBytes) break;
    kept.push(line);
    size += lineSize;
  }

  kept.reverse();
  return `[Earlier conversation truncated]\n${kept.join("\n")}`;
}

function truncateTailByBytes(text: string, maxBytes: number): string {
  if (Buffer.byteLength(text, "utf8") <= maxBytes) return text;

  const lines = text.split(/\r\n|\r|\n/);
  const kept: string[] = [];
  let size = 0;
  for (const line of lines) {
    const lineSize = Buffer.byteLength(line, "utf8") + 1;
    if (kept.length > 0 && size + lineSize > maxBytes) break;
    kept.push(line);
    size += lineSize;
  }

  return `${kept.join("\n")}\n\n[Output truncated]`;
}

function buildConversationText(branch: any[]): string {
  const chunks: string[] = [];

  for (const entry of branch) {
    if (entry?.type !== "message") continue;
    const message = entry.message;
    if (!message || typeof message.role !== "string") continue;

    const text = textFromContent(message.content).trim();
    if (!text) continue;

    const label = message.role === "toolResult"
      ? `tool result${message.toolName ? ` (${message.toolName})` : ""}`
      : message.role;
    chunks.push(`## ${label}\n${text}`);
  }

  return truncateHeadByBytes(chunks.join("\n\n"), MAX_CONTEXT_BYTES);
}

function extractResponseText(response: { content?: Array<{ type: string; text?: string; thinking?: string }> }): string {
  const text = (response.content ?? [])
    .filter((part): part is { type: "text"; text: string } => part.type === "text" && typeof part.text === "string")
    .map((part) => part.text)
    .join("\n")
    .trim();

  if (text) return text;

  return (response.content ?? [])
    .filter((part): part is { type: "thinking"; thinking: string } => part.type === "thinking" && typeof part.thinking === "string")
    .map((part) => part.thinking)
    .join("\n")
    .trim();
}

function makePrompt(thread: BtwThread): string {
  return `Conversation context:\n\n${thread.context || "(no prior conversation context)"}\n\nSide question:\n${thread.question}`;
}

function threadContent(thread: BtwThread): string {
  if (thread.status === "error") {
    return `**BTW side question**\n\n**Q:** ${thread.question}\n\n**Error:** ${thread.error ?? "Unknown error"}`;
  }

  return `**BTW side question**\n\n**Q:** ${thread.question}\n\n${thread.answer ?? "(no answer)"}`;
}

function addWrapped(lines: string[], text: string, width: number, prefix = ""): void {
  const prefixWidth = visibleWidth(prefix);
  const wrapped = wrapTextWithAnsi(text, Math.max(1, width - prefixWidth));
  if (wrapped.length === 0) {
    lines.push(truncateToWidth(prefix, width));
    return;
  }

  const continuation = " ".repeat(prefixWidth);
  for (let index = 0; index < wrapped.length; index++) {
    lines.push(truncateToWidth(`${index === 0 ? prefix : continuation}${wrapped[index]}`, width));
  }
}

export default function btwExtension(pi: ExtensionAPI) {
  const threads: BtwThread[] = [];
  let nextId = 1;
  let uiRef: any;
  let workingRef: CommandWorking | undefined;

  function updateWidget(): void {
    if (!uiRef) return;

    const pendingThreads = threads.filter((thread) => thread.status === "pending");
    if (workingRef) {
      if (pendingThreads.length === 0) {
        workingRef.clear();
      } else {
        workingRef.set(`Answering ${pendingThreads.length} /btw question${pendingThreads.length === 1 ? "" : "s"}…`);
      }
    }

    uiRef.setWidget("btw", undefined);
  }

  function removeThread(thread: BtwThread): void {
    const index = threads.indexOf(thread);
    if (index !== -1) threads.splice(index, 1);
    thread.abort.abort();
    updateWidget();
  }

  async function answerThread(thread: BtwThread, ctx: any): Promise<void> {
    thread.status = "pending";
    updateWidget();

    try {
      const auth = await ctx.modelRegistry.getApiKeyAndHeaders(ctx.model);
      if (!auth.ok) throw new Error(auth.error);
      if (!auth.apiKey) throw new Error(`No API key for ${ctx.model.provider}`);

      const messages: Message[] = [{
        role: "user",
        content: [{ type: "text", text: makePrompt(thread) }],
        timestamp: Date.now(),
      } as Message];

      const response = await complete(
        ctx.model,
        { systemPrompt: SYSTEM_PROMPT, messages },
        { apiKey: auth.apiKey, headers: auth.headers, signal: thread.abort.signal },
      );

      if (response.stopReason === "aborted" || thread.abort.signal.aborted) {
        removeThread(thread);
        return;
      }

      if (response.stopReason === "error") {
        thread.error = response.errorMessage ?? "Unknown model error";
        thread.status = "error";
        updateWidget();
        return;
      }

      thread.answer = truncateTailByBytes(extractResponseText(response) || "(empty response)", MAX_ANSWER_BYTES);
      thread.status = "done";
    } catch (error) {
      if (thread.abort.signal.aborted) {
        removeThread(thread);
        return;
      }
      thread.error = error instanceof Error ? error.message : String(error);
      thread.status = "error";
    }

    updateWidget();
  }

  function clearThreads(): void {
    for (const thread of threads) thread.abort.abort();
    threads.length = 0;
    workingRef?.clear();
    updateWidget();
  }

  pi.on("session_start", (_event, ctx) => {
    uiRef = ctx.hasUI ? ctx.ui : undefined;
    clearThreads();
  });

  pi.on("session_shutdown", () => {
    clearThreads();
    workingRef?.clear();
    workingRef = undefined;
    uiRef = undefined;
  });

  async function openReview(ctx: any): Promise<void> {
    const reviewable = () => threads.filter((thread) => thread.status !== "pending");
    if (reviewable().length === 0) {
      const pending = threads.filter((thread) => thread.status === "pending").length;
      ctx.ui.notify(pending ? `${pending} /btw question${pending === 1 ? " is" : "s are"} still running` : "No /btw results", "info");
      return;
    }

    let selected = 0;
    await ctx.ui.custom<void>((tui: any, theme: any, _keybindings: any, done: (value: void) => void) => {
      const border = new DynamicBorder((text: string) => theme.fg("accent", text));

      const current = () => {
        const items = reviewable();
        if (selected >= items.length) selected = Math.max(0, items.length - 1);
        return items[selected];
      };

      const refresh = () => {
        border.invalidate();
        tui.requestRender();
      };

      return {
        render(width: number): string[] {
          const items = reviewable();
          if (items.length === 0) return [];
          const item = current();
          const lines: string[] = [];

          lines.push(...border.render(width));
          lines.push(truncateToWidth(` ${theme.fg("accent", theme.bold("/btw"))}${theme.fg("dim", ` ${selected + 1}/${items.length}`)}`, width));
          lines.push("");
          addWrapped(lines, theme.fg("muted", `Q: ${item.question}`), width, " ");
          lines.push("");

          if (item.status === "error") {
            addWrapped(lines, theme.fg("error", `Error: ${item.error ?? "Unknown error"}`), width, " ");
          } else {
            for (const paragraph of (item.answer ?? "(no answer)").split(/\n{2,}/)) {
              addWrapped(lines, theme.fg("text", paragraph), width, " ");
              lines.push("");
            }
            if (lines.at(-1) === "") lines.pop();
          }

          lines.push("");
          const hints = [
            items.length > 1 ? `${theme.fg("dim", "↑↓/j/k")} navigate` : "",
            `${theme.fg("dim", "enter")} keep`,
            `${theme.fg("dim", "d")} dismiss`,
            `${theme.fg("dim", "esc")} close`,
          ].filter(Boolean).join("  ");
          lines.push(truncateToWidth(` ${hints}`, width));
          lines.push(...border.render(width));
          return lines;
        },
        invalidate: () => border.invalidate(),
        handleInput(data: string): void {
          const items = reviewable();
          if (items.length === 0) {
            done(undefined);
            return;
          }

          const item = current();
          if (matchesKey(data, Key.escape) || matchesKey(data, Key.ctrl("c"))) {
            done(undefined);
            return;
          }

          if (matchesKey(data, Key.enter)) {
            pi.sendMessage({ customType: "btw", content: threadContent(item), display: true }, { triggerTurn: false });
            removeThread(item);
            if (reviewable().length === 0) done(undefined);
            else refresh();
            return;
          }

          if (data === "d") {
            removeThread(item);
            if (reviewable().length === 0) done(undefined);
            else refresh();
            return;
          }

          if (matchesKey(data, Key.up) || data === "k") {
            selected = Math.max(0, selected - 1);
            refresh();
            return;
          }

          if (matchesKey(data, Key.down) || data === "j") {
            selected = Math.min(items.length - 1, selected + 1);
            refresh();
          }
        },
      };
    }, {
      overlay: true,
      overlayOptions: {
        width: "80%",
        minWidth: 50,
        maxHeight: "80%",
      },
    });
  }

  pi.registerCommand("btw", {
    description: "Ask a quick side question in the background. Use /btw with no args to open result popup.",
    handler: async (args, ctx) => {
      if (!ctx.hasUI) {
        ctx.ui.notify("/btw requires interactive mode", "error");
        return;
      }

      uiRef = ctx.ui;
      const text = (args ?? "").trim();
      if (!text) {
        await openReview(ctx);
        return;
      }

      if (text === "clear") {
        clearThreads();
        ctx.ui.notify("Cleared /btw questions", "info");
        return;
      }

      if (!ctx.model) {
        ctx.ui.notify("No model selected", "error");
        return;
      }

      workingRef ??= createCommandWorking(ctx, "btw", "BTW");
      const thread: BtwThread = {
        id: nextId++,
        question: text,
        context: buildConversationText(ctx.sessionManager.getBranch()),
        status: "pending",
        createdAt: Date.now(),
        abort: new AbortController(),
      };
      threads.push(thread);
      updateWidget();
      ctx.ui.notify(`Started /btw #${thread.id}`, "info");
      void answerThread(thread, ctx);
    },
  });
}
