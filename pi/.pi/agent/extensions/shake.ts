import { mkdir, writeFile } from "node:fs/promises";
import { isAbsolute, join, relative } from "node:path";
import type { ExtensionAPI, ExtensionCommandContext } from "@mariozechner/pi-coding-agent";

const BLOCK_MIN_CHARS = 1_600;

type Stats = { images: number; toolResults: number; blocks: number; changed: number; artifacts: Artifact[] };
type Artifact = { label: string; tokens: number; text: string };
type ContentBlock = { type: string; id?: string; name?: string; text?: string; arguments?: unknown; [key: string]: unknown };
type MessageLike = {
  role?: string;
  content?: string | ContentBlock[];
  timestamp?: number;
  toolCallId?: string;
  toolName?: string;
  prunedAt?: number;
};
type EntryLike = { type: string; timestamp?: string; message?: MessageLike; content?: string | ContentBlock[] };

function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

function isText(block: ContentBlock): block is ContentBlock & { text: string } {
  return block.type === "text" && typeof block.text === "string";
}

function entryIsOld(entry: EntryLike, cutoff: number): boolean {
  const time = entry.message?.timestamp ?? Date.parse(entry.timestamp ?? "");
  return Number.isFinite(time) && time <= cutoff;
}

function collectToolCalls(entries: EntryLike[]): Map<string, ContentBlock> {
  const calls = new Map<string, ContentBlock>();
  for (const entry of entries) {
    const message = entry.message;
    if (entry.type !== "message" || message?.role !== "assistant" || !Array.isArray(message.content)) continue;
    for (const block of message.content) {
      if (block.type === "toolCall" && typeof block.id === "string") calls.set(block.id, block);
    }
  }
  return calls;
}

function isProtectedToolResult(message: MessageLike, toolCalls: Map<string, ContentBlock>): boolean {
  if (message.role !== "toolResult") return false;
  if (message.toolName === "skill") return true;

  const call = message.toolCallId ? toolCalls.get(message.toolCallId) : undefined;
  if (message.toolName === "read" && call?.name === "read") {
    const readPath = (call.arguments as { path?: unknown } | undefined)?.path;
    return typeof readPath === "string" && readPath.startsWith("skill://");
  }

  return false;
}

function toolResultText(message: MessageLike): string {
  if (typeof message.content === "string") return message.content;
  if (!Array.isArray(message.content)) return "";
  return message.content.filter(isText).map((block) => block.text).join("\n");
}

function artifactRef(file: string): string {
  const rel = relative(process.cwd(), file);
  return rel && !rel.startsWith("..") && !isAbsolute(rel) ? rel : file;
}

function addArtifact(stats: Stats, label: string, text: string): { index: number; tokens: number } {
  const tokens = estimateTokens(text);
  stats.artifacts.push({ label, tokens, text });
  return { index: stats.artifacts.length, tokens };
}

function placeholder(label: string, text: string, stats: Stats, artifactFile: string): string {
  const { index, tokens } = addArtifact(stats, label, text);
  return `[shaken ~${tokens} tokens — recover: ${artifactRef(artifactFile)}#region-${index}]`;
}

function blockRanges(text: string): Array<{ start: number; end: number }> {
  const ranges: Array<{ start: number; end: number }> = [];
  const stack: string[] = [];
  let fenceStart = -1;
  let xmlStart = -1;
  let lineStart = 0;

  for (let i = 0; i <= text.length; i++) {
    if (i !== text.length && text[i] !== "\n") continue;
    const line = text.slice(lineStart, i);
    const trimmed = line.trimStart();

    if (trimmed.startsWith("```") || trimmed.startsWith("~~~")) {
      if (fenceStart < 0) fenceStart = lineStart;
      else {
        ranges.push({ start: fenceStart, end: i });
        fenceStart = -1;
      }
      lineStart = i + 1;
      continue;
    }

    if (fenceStart < 0 && line === trimmed) {
      const open = /^<([a-z_-]+)(?:\s+[^>]*)?>$/.exec(trimmed);
      const close = /^<\/([a-z_-]+)>$/.exec(trimmed);
      if (open?.[1]) {
        if (stack.length === 0) xmlStart = lineStart;
        stack.push(open[1]);
      } else if (close?.[1] && stack[stack.length - 1] === close[1]) {
        stack.pop();
        if (stack.length === 0 && xmlStart >= 0) {
          ranges.push({ start: xmlStart, end: i });
          xmlStart = -1;
        }
      }
    }

    lineStart = i + 1;
  }

  const merged: Array<{ start: number; end: number }> = [];
  for (const range of ranges
    .filter((range) => range.end - range.start >= BLOCK_MIN_CHARS)
    .sort((a, b) => a.start - b.start)) {
    const last = merged[merged.length - 1];
    if (last && range.start < last.end) continue;
    merged.push(range);
  }
  return merged;
}

function shakeTextBlocks(text: string, stats: Stats, artifactFile: string, label: string): string {
  let next = text;
  for (const range of blockRanges(text).reverse()) {
    const original = next.slice(range.start, range.end);
    next = `${next.slice(0, range.start)}${placeholder(label, original, stats, artifactFile)}${next.slice(range.end)}`;
    stats.blocks++;
  }
  return next;
}

function shakeContent(content: string | ContentBlock[] | undefined, stats: Stats, artifactFile: string, label: string): string | ContentBlock[] | undefined {
  if (typeof content === "string") return shakeTextBlocks(content, stats, artifactFile, label);
  if (!Array.isArray(content)) return content;

  let changed = false;
  const kept: ContentBlock[] = [];
  for (const block of content) {
    if (block.type === "image") {
      stats.images++;
      changed = true;
      continue;
    }
    if (isText(block)) {
      const text = shakeTextBlocks(block.text, stats, artifactFile, label);
      kept.push(text === block.text ? block : { ...block, text });
      changed ||= text !== block.text;
      continue;
    }
    kept.push(block);
  }

  if (kept.length === 0) return [{ type: "text", text: "[image removed by /shake]" }];
  return changed ? kept : content;
}

function shakeMessage<T extends MessageLike>(message: T, stats: Stats, artifactFile: string, toolCalls: Map<string, ContentBlock>): T {
  if (isProtectedToolResult(message, toolCalls)) return message;

  if (message.role === "toolResult") {
    const text = toolResultText(message);
    if (message.prunedAt === undefined && text.length > 0 && !text.startsWith("[shaken ")) {
      const imageCount = Array.isArray(message.content) ? message.content.filter((block) => block.type === "image").length : 0;
      stats.images += imageCount;
      stats.toolResults++;
      return { ...message, prunedAt: Date.now(), content: [{ type: "text", text: placeholder(message.toolName ?? "tool", text, stats, artifactFile) }] };
    }
  }

  const content = shakeContent(message.content, stats, artifactFile, message.role ?? "message");
  return content === message.content ? message : { ...message, content };
}

function shakeEntries(entries: EntryLike[], artifactFile: string, cutoff = Date.now()): Stats {
  const stats: Stats = { images: 0, toolResults: 0, blocks: 0, changed: 0, artifacts: [] };
  const toolCalls = collectToolCalls(entries);
  for (const entry of entries) {
    if (!entryIsOld(entry, cutoff)) continue;

    if (entry.type === "message" && entry.message) {
      const shaken = shakeMessage(entry.message, stats, artifactFile, toolCalls);
      if (shaken !== entry.message) {
        entry.message = shaken;
        stats.changed++;
      }
      continue;
    }

    if (entry.type === "custom_message") {
      const content = shakeContent(entry.content, stats, artifactFile, entry.type);
      if (content !== entry.content) {
        entry.content = content;
        stats.changed++;
      }
    }
  }
  return stats;
}

function formatStats(stats: Stats): string {
  return [
    stats.images && `${stats.images} image${stats.images === 1 ? "" : "s"}`,
    stats.toolResults && `${stats.toolResults} tool result${stats.toolResults === 1 ? "" : "s"}`,
    stats.blocks && `${stats.blocks} block${stats.blocks === 1 ? "" : "s"}`,
  ]
    .filter(Boolean)
    .join(" + ");
}

async function saveArtifact(file: string, artifacts: Artifact[]): Promise<void> {
  if (artifacts.length === 0) return;
  await mkdir(join(process.cwd(), "agent", "shake-artifacts"), { recursive: true });
  await writeFile(
    file,
    artifacts
      .map((item, i) => `## region-${i + 1} (${item.label}, ~${item.tokens} tokens)\n\n${item.text}\n`)
      .join("\n---\n\n"),
  );
}

function notify(ctx: { hasUI: boolean; ui: { notify(message: string, level?: "info" | "warning" | "error"): void } }, message: string, level: "info" | "warning" | "error" = "info"): void {
  if (ctx.hasUI) ctx.ui.notify(message, level);
  else console.log(message);
}

async function rewriteSession(ctx: ExtensionCommandContext): Promise<boolean> {
  const rewrite = (ctx.sessionManager as unknown as { _rewriteFile?: () => void | Promise<void> })._rewriteFile;
  if (typeof rewrite !== "function") return false;
  await rewrite.call(ctx.sessionManager);
  return true;
}

export default function shakeExtension(pi: ExtensionAPI) {
  pi.registerCommand("shake", {
    description: "Rewrite old images and tool/text content into placeholders",
    async handler(args, ctx) {
      const arg = (args ?? "").trim().toLowerCase();
      if (arg && arg !== "elide") {
        notify(ctx, "Usage: /shake", "error");
        return;
      }

      const artifactFile = join(process.cwd(), "agent", "shake-artifacts", `shake-${Date.now()}.md`);
      const stats = shakeEntries(ctx.sessionManager.getBranch() as EntryLike[], artifactFile);
      if (stats.changed === 0) {
        notify(ctx, "/shake: nothing eligible.");
        return;
      }

      await saveArtifact(artifactFile, stats.artifacts);
      if (!(await rewriteSession(ctx))) {
        notify(ctx, `/shake: ${formatStats(stats)} elided in memory; footer may not refresh until session reload.`, "warning");
        return;
      }

      notify(ctx, `/shake: ${formatStats(stats)} elided.`);
    },
  });
}

export function demo(): void {
  const now = Date.now();
  const artifactFile = join(process.cwd(), "agent", "shake-artifacts", "demo.md");
  const bigFence = `keep\n\`\`\`txt\n${"x".repeat(BLOCK_MIN_CHARS)}\n\`\`\``;
  const entries: EntryLike[] = [
    { type: "message", message: { role: "user", timestamp: now, content: [{ type: "image", data: "...", mimeType: "image/png" }] } },
    { type: "message", message: { role: "toolResult", toolName: "read", timestamp: now, content: [{ type: "text", text: "small" }] } },
    { type: "message", message: { role: "assistant", timestamp: now, content: [{ type: "text", text: bigFence }] } },
  ];
  const result = shakeEntries(entries, artifactFile, now + 1);
  if (result.images !== 1 || result.toolResults !== 1 || result.blocks !== 1 || result.artifacts.length !== 2) throw new Error("shake self-check failed");
}

if (process.env.PI_SHAKE_SELF_CHECK === "1") demo();
