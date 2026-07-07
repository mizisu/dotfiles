import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, readdirSync, unlinkSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { Input, Key, Markdown, matchesKey, truncateToWidth, visibleWidth, wrapTextWithAnsi, type Focusable, type MarkdownTheme } from "@mariozechner/pi-tui";

type Role = "user" | "assistant" | "tool" | "system" | "error";

type TranscriptItem = {
  role: Role;
  text: string;
};

const SIDE_TOOLS = "read,grep,find,ls,web_fetch,web_search";
const WEB_FETCH_SEARCH_EXTENSION = join(dirname(fileURLToPath(import.meta.url)), "web-fetch-search.ts");
const MAX_STORED_ITEMS = 200;
const SIDE_KEYS = ["~"];
const ABORT_GRACE_MS = 5_000;
const KILL_GRACE_MS = 1_000;
const SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
const SPINNER_INTERVAL_MS = 80;

type ForkSession = {
  dir: string;
  id: string;
  sessionFile: string;
  leafId?: string;
  createdAt: number;
};

function matchesSideKey(data: string, keys: string[]): boolean {
  return keys.some((key) => {
    if (data === key) return true;
    try {
      return matchesKey(data, key);
    } catch {
      return false;
    }
  });
}

function sideKeyHint(keys: string[]): string {
  return keys.join("/");
}

function shortId(id: string | undefined): string | undefined {
  return id ? id.slice(0, 8) : undefined;
}

function getPiInvocation(args: string[]): { command: string; args: string[] } {
  const currentScript = process.argv[1];
  const isBunVirtualScript = currentScript?.startsWith("/$bunfs/root/");
  if (currentScript && !isBunVirtualScript && existsSync(currentScript)) {
    return { command: process.execPath, args: [currentScript, ...args] };
  }

  const execName = basename(process.execPath).toLowerCase();
  const isGenericRuntime = /^(node|bun)(\.exe)?$/.test(execName);
  if (!isGenericRuntime) return { command: process.execPath, args };

  return { command: "pi", args };
}

function textFromContent(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((part: any) => part?.type === "text" && typeof part.text === "string")
    .map((part: any) => part.text)
    .join("\n")
    .trim();
}

function formatArgs(args: unknown): string {
  if (!args || typeof args !== "object") return "";
  const text = JSON.stringify(args);
  return text.length > 90 ? `${text.slice(0, 90)}…` : text;
}

function getSideMarkdownTheme(theme: any): MarkdownTheme {
  const underline = (text: string) => `\x1b[4m${text}\x1b[24m`;
  return {
    heading: (text) => theme.fg("accent", theme.bold(text)),
    link: (text) => theme.fg("accent", underline(text)),
    linkUrl: (text) => theme.fg("dim", text),
    code: (text) => theme.fg("warning", text),
    codeBlock: (text) => theme.fg("text", text),
    codeBlockBorder: (text) => theme.fg("dim", text),
    quote: (text) => theme.fg("muted", text),
    quoteBorder: (text) => theme.fg("dim", text),
    hr: (text) => theme.fg("dim", text),
    listBullet: (text) => theme.fg("accent", text),
    bold: (text) => theme.bold(text),
    italic: (text) => theme.italic(text),
    strikethrough: (text) => theme.strikethrough(text),
    underline,
    codeBlockIndent: "  ",
  };
}

function renderMarkdownLines(text: string, width: number, theme: any): string[] {
  try {
    return new Markdown(
      text,
      0,
      0,
      getSideMarkdownTheme(theme),
      { color: (value: string) => theme.fg("text", value) },
      { preserveOrderedListMarkers: true },
    ).render(Math.max(1, width));
  } catch {
    return wrapTextWithAnsi(theme.fg("text", text), Math.max(1, width));
  }
}

class SideRpcClient {
  transcript: TranscriptItem[] = [];
  busy = false;
  onChange?: () => void;

  private proc?: ChildProcessWithoutNullStreams;
  private buffer = "";
  private assistant?: TranscriptItem;
  private disposed = false;
  private abortTimer?: ReturnType<typeof setTimeout>;
  private killTimer?: ReturnType<typeof setTimeout>;

  constructor(
    private readonly cwd: string,
    private readonly args: string[],
    private readonly forkSession?: ForkSession,
  ) {}

  contextLabel(): string {
    if (!this.forkSession) return "ephemeral";
    const leaf = shortId(this.forkSession.leafId);
    return leaf ? `fork leaf ${leaf}` : "forked session";
  }

  isStale(currentLeafId: string | undefined): boolean {
    return !!this.forkSession?.leafId && !!currentLeafId && this.forkSession.leafId !== currentLeafId;
  }

  start(): void {
    if (this.proc || this.disposed) return;

    const invocation = getPiInvocation(this.args);
    const proc = spawn(invocation.command, invocation.args, {
      cwd: this.cwd,
      env: { ...process.env, PI_SKIP_VERSION_CHECK: process.env.PI_SKIP_VERSION_CHECK ?? "1" },
      shell: false,
      stdio: ["pipe", "pipe", "pipe"],
    });

    this.proc = proc;

    proc.stdout.on("data", (chunk) => this.onStdout(String(chunk)));
    proc.stderr.on("data", (chunk) => {
      const text = String(chunk).trim();
      if (text) this.push("error", text);
    });
    proc.on("error", (error) => {
      this.clearAbortTimer();
      this.clearKillTimer();
      this.push("error", `failed to start side agent: ${error.message}`);
      this.busy = false;
      this.proc = undefined;
      this.emit();
    });
    proc.on("exit", (code, signal) => {
      this.clearAbortTimer();
      this.clearKillTimer();
      this.proc = undefined;
      this.busy = false;
      this.assistant = undefined;
      this.cleanupFork();
      if (!this.disposed) this.push("system", `side agent exited (${signal ?? code ?? "unknown"})`);
      this.emit();
    });
  }

  send(text: string): void {
    const message = text.trim();
    if (!message) return;
    if (this.busy) {
      this.push("system", "side agent is still working; wait or press Ctrl+C to abort");
      return;
    }

    this.start();
    if (!this.proc?.stdin.writable) {
      this.push("error", "side agent is not available");
      return;
    }

    this.clearAbortTimer();
    this.push("user", message);
    this.busy = true;
    this.assistant = undefined;
    this.proc.stdin.write(`${JSON.stringify({ type: "prompt", message })}\n`);
    this.emit();
  }

  abort(): void {
    if (!this.proc) return;
    if (!this.proc.stdin.writable) {
      this.push("system", "side agent stdin is closed; killing side agent");
      this.killProcess();
      return;
    }

    try {
      this.proc.stdin.write(`${JSON.stringify({ type: "abort" })}\n`);
    } catch {
      // Fall through to the kill fallback below.
    }
    this.push("system", "abort requested");
    this.clearAbortTimer();
    this.abortTimer = setTimeout(() => {
      if (!this.busy || !this.proc) return;
      this.push("system", "abort timed out; killing side agent");
      this.killProcess();
    }, ABORT_GRACE_MS);
    this.abortTimer.unref?.();
  }

  dispose(): void {
    this.disposed = true;
    this.onChange = undefined;
    this.clearAbortTimer();
    this.killProcess();
    this.proc = undefined;
    this.cleanupFork();
  }

  private killProcess(): void {
    const proc = this.proc;
    if (!proc) return;
    try {
      proc.kill("SIGTERM");
    } catch {
      // Ignore cleanup errors.
    }
    this.clearKillTimer();
    this.killTimer = setTimeout(() => {
      try {
        proc.kill("SIGKILL");
      } catch {
        // Ignore cleanup errors.
      }
    }, KILL_GRACE_MS);
    this.killTimer.unref?.();
  }

  private clearAbortTimer(): void {
    if (!this.abortTimer) return;
    clearTimeout(this.abortTimer);
    this.abortTimer = undefined;
  }

  private clearKillTimer(): void {
    if (!this.killTimer) return;
    clearTimeout(this.killTimer);
    this.killTimer = undefined;
  }

  private cleanupFork(): void {
    if (!this.forkSession || !existsSync(this.forkSession.dir)) return;
    const suffix = `_${this.forkSession.id}.jsonl`;
    try {
      for (const file of readdirSync(this.forkSession.dir)) {
        if (file.endsWith(suffix)) unlinkSync(join(this.forkSession.dir, file));
      }
    } catch {
      // Best-effort cleanup; the process exit retry handles files still in use.
    }
  }

  private onStdout(chunk: string): void {
    this.buffer += chunk;
    while (true) {
      const index = this.buffer.indexOf("\n");
      if (index === -1) return;
      let line = this.buffer.slice(0, index);
      this.buffer = this.buffer.slice(index + 1);
      if (line.endsWith("\r")) line = line.slice(0, -1);
      if (!line.trim()) continue;
      this.onLine(line);
    }
  }

  private onLine(line: string): void {
    let event: any;
    try {
      event = JSON.parse(line);
    } catch {
      this.push("error", line);
      return;
    }

    if (event.type === "response" && event.success === false) {
      this.clearAbortTimer();
      this.busy = false;
      this.push("error", event.error ?? "side agent command failed");
      return;
    }

    if (event.type === "agent_start") {
      this.busy = true;
      this.emit();
      return;
    }

    if (event.type === "agent_end") {
      this.clearAbortTimer();
      this.busy = false;
      this.assistant = undefined;
      this.emit();
      return;
    }

    if (event.type === "tool_execution_start") {
      this.push("tool", `→ ${event.toolName ?? "tool"} ${formatArgs(event.args)}`.trim());
      return;
    }

    if (event.type === "message_update") {
      const update = event.assistantMessageEvent;
      if (update?.type === "text_delta" && typeof update.delta === "string") {
        this.ensureAssistant().text += update.delta;
        this.emit();
      } else if (update?.type === "error") {
        this.clearAbortTimer();
        this.busy = false;
        this.push("error", update.errorMessage ?? "side agent error");
      }
      return;
    }

    if (event.type === "message_end" && event.message?.role === "assistant") {
      const text = textFromContent(event.message.content);
      if (text) this.ensureAssistant().text = text;
      this.assistant = undefined;
      this.emit();
    }
  }

  private ensureAssistant(): TranscriptItem {
    if (!this.assistant) {
      this.assistant = { role: "assistant", text: "" };
      this.transcript.push(this.assistant);
      this.trim();
    }
    return this.assistant;
  }

  private push(role: Role, text: string): void {
    this.transcript.push({ role, text });
    this.trim();
    this.emit();
  }

  private trim(): void {
    if (this.transcript.length > MAX_STORED_ITEMS) {
      this.transcript.splice(0, this.transcript.length - MAX_STORED_ITEMS);
    }
  }

  private emit(): void {
    this.onChange?.();
  }
}

type SideChat = {
  id: number;
  client: SideRpcClient;
};

class SideChatManager {
  onChange?: () => void;

  private chats: SideChat[] = [];
  private activeIndex = 0;
  private nextId = 1;
  private draft = "";
  private statusUpdater?: (text: string | undefined) => void;
  private spinnerIndex = 0;
  private spinnerTimer?: ReturnType<typeof setInterval>;

  constructor(private readonly buildClient: (ctx: ExtensionContext) => SideRpcClient) {}

  get spinnerFrame(): string {
    return SPINNER_FRAMES[this.spinnerIndex] ?? "⠋";
  }

  get active(): SideChat | undefined {
    return this.chats[this.activeIndex];
  }

  get activeNumber(): number {
    return this.active ? this.activeIndex + 1 : 0;
  }

  get count(): number {
    return this.chats.length;
  }

  getDraft(): string {
    return this.draft;
  }

  setDraft(value: string): void {
    this.draft = value;
  }

  setStatusUpdater(updater: ((text: string | undefined) => void) | undefined): void {
    this.statusUpdater = updater;
    this.updateStatus();
  }

  ensure(ctx: ExtensionContext): SideChat {
    return this.active ?? this.create(ctx);
  }

  create(ctx: ExtensionContext): SideChat {
    const chat = { id: this.nextId++, client: this.buildClient(ctx) };
    chat.client.onChange = () => this.emit();
    chat.client.start();
    this.chats.push(chat);
    this.activeIndex = this.chats.length - 1;
    this.emit();
    return chat;
  }

  next(): void {
    if (this.chats.length < 2) return;
    this.activeIndex = (this.activeIndex + 1) % this.chats.length;
    this.emit();
  }

  closeActive(): void {
    const chat = this.active;
    if (!chat) return;
    chat.client.dispose();
    this.chats.splice(this.activeIndex, 1);
    this.activeIndex = Math.min(this.activeIndex, Math.max(0, this.chats.length - 1));
    this.emit();
  }

  clean(): void {
    for (const chat of this.chats) chat.client.dispose();
    this.chats = [];
    this.activeIndex = 0;
    this.nextId = 1;
    this.draft = "";
    this.emit();
  }

  refresh(): void {
    this.emit();
  }

  dispose(): void {
    this.onChange = undefined;
    this.clean();
    this.clearSpinner();
    this.statusUpdater?.(undefined);
    this.statusUpdater = undefined;
  }

  private emit(): void {
    this.syncSpinner();
    this.updateStatus();
    this.onChange?.();
  }

  private busyChats(): SideChat[] {
    return this.chats.filter((chat) => chat.client.busy);
  }

  private syncSpinner(): void {
    if (this.busyChats().length === 0) {
      this.clearSpinner();
      return;
    }

    if (this.spinnerTimer) return;
    this.spinnerTimer = setInterval(() => {
      if (this.busyChats().length === 0) {
        this.clearSpinner();
        this.updateStatus();
        this.onChange?.();
        return;
      }

      this.spinnerIndex = (this.spinnerIndex + 1) % SPINNER_FRAMES.length;
      this.updateStatus();
      this.onChange?.();
    }, SPINNER_INTERVAL_MS);
    this.spinnerTimer.unref?.();
  }

  private clearSpinner(): void {
    if (this.spinnerTimer) clearInterval(this.spinnerTimer);
    this.spinnerTimer = undefined;
    this.spinnerIndex = 0;
  }

  private updateStatus(): void {
    if (!this.statusUpdater) return;
    const busy = this.busyChats();
    if (busy.length === 0) {
      this.statusUpdater(undefined);
      return;
    }

    const labels = busy.map((chat) => `#${chat.id}`).join(", ");
    this.statusUpdater(busy.length === 1 ? `side: ${this.spinnerFrame} ${labels}` : `side: ${this.spinnerFrame} ${busy.length} (${labels})`);
  }
}

class SidePanel implements Focusable {
  private _focused = false;
  private input = new Input();
  private cachedWidth?: number;
  private cachedLines?: string[];
  private scrollOffset = 0;
  private maxScrollOffset = 0;
  private visibleTranscriptLines = 1;
  private detail?: { itemIndex: number; scrollOffset: number; maxScrollOffset: number };

  get focused(): boolean {
    return this._focused;
  }

  set focused(value: boolean) {
    this._focused = value;
    this.input.focused = value && !this.detail;
  }

  constructor(
    private readonly manager: SideChatManager,
    private readonly ctx: ExtensionContext,
    private readonly tui: any,
    private readonly theme: any,
    private readonly sideKeys: string[],
    private readonly done: () => void,
  ) {
    this.input.setValue(this.manager.getDraft());
  }

  handleInput(data: string): void {
    if (matchesSideKey(data, this.sideKeys) || matchesKey(data, Key.ctrl("d"))) {
      this.close();
      return;
    }

    if (this.detail) {
      this.handleDetailInput(data);
      return;
    }

    if (matchesKey(data, Key.escape)) {
      this.close();
      return;
    }

    if (matchesKey(data, Key.ctrl("n")) || matchesKey(data, Key.ctrl("r"))) {
      this.scrollOffset = 0;
      this.manager.create(this.ctx);
      this.refresh();
      return;
    }

    if (matchesKey(data, Key.tab)) {
      this.scrollOffset = 0;
      this.manager.next();
      this.refresh();
      return;
    }

    if (matchesKey(data, Key.ctrl("o"))) {
      this.openDetail();
      return;
    }

    if (matchesKey(data, Key.ctrl("c"))) {
      const chat = this.manager.active;
      if (chat?.client.busy) chat.client.abort();
      else if (chat) {
        this.scrollOffset = 0;
        this.manager.closeActive();
      } else this.close();
      this.refresh();
      return;
    }

    if (matchesKey(data, Key.up)) {
      this.scrollBy(1);
      return;
    }

    if (matchesKey(data, Key.down)) {
      this.scrollBy(-1);
      return;
    }

    if (matchesKey(data, Key.pageUp)) {
      this.scrollBy(this.pageSize());
      return;
    }

    if (matchesKey(data, Key.pageDown)) {
      this.scrollBy(-this.pageSize());
      return;
    }

    if (matchesKey(data, Key.enter)) {
      const text = this.input.getValue().trim();
      if (text) {
        this.scrollOffset = 0;
        this.input.setValue("");
        this.manager.setDraft("");
        this.manager.ensure(this.ctx).client.send(text);
      }
      this.refresh();
      return;
    }

    this.input.handleInput(data);
    this.manager.setDraft(this.input.getValue());
    this.refresh();
  }

  render(width: number): string[] {
    if (this.detail) return this.renderDetail(width);
    if (this.cachedWidth === width && this.cachedLines) return this.cachedLines;

    const w = Math.max(1, width);
    const inner = Math.max(1, w - 2);
    const lines: string[] = [];
    const terminalRows = Math.max(8, Math.floor((this.tui.terminal?.rows ?? 30) * 0.8));
    const inputLines = this.input.render(Math.max(1, inner - 2));
    const maxTranscriptLines = Math.max(4, terminalRows - inputLines.length - 7);

    const row = (content = "") => {
      const fitted = truncateToWidth(content, inner, "…");
      const pad = Math.max(0, inner - visibleWidth(fitted));
      lines.push(`${this.theme.fg("border", "│")}${fitted}${" ".repeat(pad)}${this.theme.fg("border", "│")}`);
    };

    lines.push(this.theme.fg("border", `╭${"─".repeat(inner)}╮`));
    row(` ${this.theme.fg("accent", this.theme.bold(this.title()))}`);
    row("");

    const transcriptLines = this.renderTranscript(inner);
    this.visibleTranscriptLines = maxTranscriptLines;
    this.maxScrollOffset = Math.max(0, transcriptLines.length - maxTranscriptLines);
    this.scrollOffset = Math.min(this.scrollOffset, this.maxScrollOffset);
    const start = Math.max(0, transcriptLines.length - maxTranscriptLines - this.scrollOffset);
    const visibleTranscript = transcriptLines.slice(start, start + maxTranscriptLines);
    const hiddenBefore = start;
    const hiddenAfter = Math.max(0, transcriptLines.length - start - visibleTranscript.length);
    if (hiddenBefore > 0 || hiddenAfter > 0) {
      const scrollInfo = [
        hiddenBefore > 0 ? `↑ ${hiddenBefore} earlier` : "",
        hiddenAfter > 0 ? `↓ ${hiddenAfter} later` : "",
      ]
        .filter(Boolean)
        .join(" • ");
      row(` ${this.theme.fg("dim", scrollInfo)}`);
    }
    for (const line of visibleTranscript) row(line);
    if (transcriptLines.length === 0) {
      row(` ${this.theme.fg("dim", this.manager.active ? "Ask inside this panel. Main session is untouched." : "No side chats. Ctrl+N/Ctrl+R or type to create one.")}`);
    }

    while (lines.length < terminalRows - inputLines.length - 3) row("");
    row("");
    for (const line of inputLines) row(` ${line}`);
    row(` ${this.theme.fg("dim", `Enter send • ↑↓/Pg scroll • Ctrl+O detail • Ctrl+R fresh fork • Ctrl+N new • Tab next • Ctrl+C abort/kill • ${sideKeyHint(this.sideKeys)}/Esc hide`)}`);
    lines.push(this.theme.fg("border", `╰${"─".repeat(inner)}╯`));

    this.cachedWidth = width;
    this.cachedLines = lines;
    return lines;
  }

  invalidate(): void {
    this.cachedWidth = undefined;
    this.cachedLines = undefined;
    this.input.invalidate();
  }

  dispose(): void {
    this.manager.setDraft(this.input.getValue());
  }

  private close(): void {
    this.manager.setDraft(this.input.getValue());
    this.done();
  }

  private title(): string {
    const chat = this.manager.active;
    if (!chat) return "Side Chat · no chats";
    const stale = chat.client.isStale(this.ctx.sessionManager.getLeafId() ?? undefined);
    const context = stale ? `${chat.client.contextLabel()} stale` : chat.client.contextLabel();
    return `Side Chat ${this.manager.activeNumber}/${this.manager.count} · #${chat.id} · ${chat.client.busy ? this.manager.spinnerFrame : "idle"} · ${context}`;
  }

  private openDetail(): void {
    const transcript = this.manager.active?.client.transcript ?? [];
    for (let index = transcript.length - 1; index >= 0; index--) {
      const item = transcript[index];
      if (item && item.text.trim() && item.role !== "tool" && item.role !== "system") {
        this.detail = { itemIndex: index, scrollOffset: 0, maxScrollOffset: 0 };
        this.input.focused = false;
        this.refresh();
        return;
      }
    }
  }

  private handleDetailInput(data: string): void {
    if (matchesKey(data, Key.escape) || matchesKey(data, Key.left)) {
      this.detail = undefined;
      this.input.focused = this._focused;
      this.refresh();
      return;
    }

    if (matchesKey(data, Key.ctrl("c"))) {
      this.close();
      return;
    }

    if (matchesKey(data, Key.up)) {
      this.scrollDetailBy(-1);
      return;
    }

    if (matchesKey(data, Key.down)) {
      this.scrollDetailBy(1);
      return;
    }

    if (matchesKey(data, Key.pageUp)) {
      this.scrollDetailBy(-this.detailPageSize());
      return;
    }

    if (matchesKey(data, Key.pageDown)) {
      this.scrollDetailBy(this.detailPageSize());
    }
  }

  private scrollDetailBy(delta: number): void {
    if (!this.detail) return;
    const next = Math.max(0, Math.min(this.detail.maxScrollOffset, this.detail.scrollOffset + delta));
    if (next === this.detail.scrollOffset) return;
    this.detail.scrollOffset = next;
    this.refresh();
  }

  private detailPageSize(): number {
    return Math.max(1, Math.floor((this.tui.terminal?.rows ?? 30) * 0.6));
  }

  private renderDetail(width: number): string[] {
    const w = Math.max(1, width);
    const inner = Math.max(1, w - 2);
    const contentWidth = Math.max(1, inner - 2);
    const terminalRows = Math.max(8, Math.floor((this.tui.terminal?.rows ?? 30) * 0.8));
    const lines: string[] = [];
    const row = (content = "") => {
      const fitted = truncateToWidth(content, inner, "…");
      const pad = Math.max(0, inner - visibleWidth(fitted));
      lines.push(`${this.theme.fg("border", "│")}${fitted}${" ".repeat(pad)}${this.theme.fg("border", "│")}`);
    };

    const chat = this.manager.active;
    const item = this.detail && chat?.client.transcript[this.detail.itemIndex];
    const title = item ? `${this.labelText(item.role)} detail` : "detail";
    lines.push(this.theme.fg("border", `╭${"─".repeat(inner)}╮`));
    row(` ${this.theme.fg("accent", this.theme.bold(title))}`);
    row(` ${this.theme.fg("dim", "↑↓/PgUp/PgDn scroll • ←/Esc back • Ctrl+C hide")}`);
    row(this.theme.fg("border", "─".repeat(inner)));

    const content = item ? this.renderItemBody(item, contentWidth) : [this.theme.fg("error", "No transcript item selected.")];
    const maxBodyLines = Math.max(1, terminalRows - 6);
    if (this.detail) {
      this.detail.maxScrollOffset = Math.max(0, content.length - maxBodyLines);
      this.detail.scrollOffset = Math.max(0, Math.min(this.detail.scrollOffset, this.detail.maxScrollOffset));
    }
    const scroll = this.detail?.scrollOffset ?? 0;
    for (const line of content.slice(scroll, scroll + maxBodyLines)) row(` ${line}`);
    while (lines.length < terminalRows - 2) row("");
    const end = Math.min(content.length, scroll + maxBodyLines);
    row(` ${this.theme.fg("dim", `${content.length === 0 ? 0 : scroll + 1}-${end} / ${content.length} lines`)}`);
    lines.push(this.theme.fg("border", `╰${"─".repeat(inner)}╯`));
    return lines;
  }

  private scrollBy(delta: number): void {
    const next = Math.max(0, Math.min(this.maxScrollOffset, this.scrollOffset + delta));
    if (next === this.scrollOffset) return;
    this.scrollOffset = next;
    this.refresh();
  }

  private pageSize(): number {
    return Math.max(1, this.visibleTranscriptLines - 1);
  }

  private renderTranscript(width: number): string[] {
    const lines: string[] = [];
    const chat = this.manager.active;
    if (!chat) return lines;
    for (const item of chat.client.transcript) {
      const label = this.label(item.role);
      const text = item.text || (item.role === "assistant" ? "…" : "");
      if (item.role === "assistant") {
        addRendered(lines, this.renderItemBody(item, Math.max(1, width - visibleWidth(label) - 1)), width, `${label} `);
      } else {
        addWrapped(lines, this.color(item.role, text), width, `${label} `);
      }
    }
    return lines;
  }

  private renderItemBody(item: TranscriptItem, width: number): string[] {
    const text = item.text || (item.role === "assistant" ? "…" : "");
    if (item.role === "assistant") return renderMarkdownLines(text, width, this.theme);
    return wrapTextWithAnsi(this.color(item.role, text), Math.max(1, width));
  }

  private labelText(role: Role): string {
    return role === "user" ? "you" : role === "assistant" ? "side" : role;
  }

  private label(role: Role): string {
    const color = role === "error" ? "error" : role === "tool" ? "muted" : role === "system" ? "dim" : "accent";
    return this.theme.fg(color, `${this.labelText(role)}:`);
  }

  private color(role: Role, text: string): string {
    if (role === "error") return this.theme.fg("error", text);
    if (role === "tool" || role === "system") return this.theme.fg("dim", text);
    return this.theme.fg("text", text);
  }

  private refresh(): void {
    this.invalidate();
    this.tui.requestRender();
  }
}

function addWrapped(lines: string[], text: string, width: number, prefix = ""): void {
  addRendered(lines, wrapTextWithAnsi(text, Math.max(1, width - visibleWidth(prefix))), width, prefix);
}

function addRendered(lines: string[], rendered: string[], width: number, prefix = ""): void {
  const prefixWidth = visibleWidth(prefix);
  if (rendered.length === 0) {
    lines.push(truncateToWidth(prefix, width));
    return;
  }

  const continuation = " ".repeat(prefixWidth);
  for (let index = 0; index < rendered.length; index++) {
    lines.push(truncateToWidth(`${index === 0 ? prefix : continuation}${rendered[index]}`, width));
  }
}

export default function sideExtension(pi: ExtensionAPI) {
  function buildClient(ctx: ExtensionContext): SideRpcClient {
    const sessionFile = ctx.sessionManager.getSessionFile();
    const args = ["--mode", "rpc", "--no-extensions", "-e", WEB_FETCH_SEARCH_EXTENSION, "--tools", SIDE_TOOLS];
    let forkSession: ForkSession | undefined;
    if (sessionFile) {
      forkSession = {
        dir: ctx.sessionManager.getSessionDir() || dirname(sessionFile),
        id: `side-${randomUUID()}`,
        sessionFile,
        leafId: ctx.sessionManager.getLeafId() ?? undefined,
        createdAt: Date.now(),
      };
      args.push("--fork", sessionFile, "--session-id", forkSession.id, "--session-dir", forkSession.dir);
    } else {
      args.push("--no-session");
    }
    if (ctx.model) args.push("--model", `${ctx.model.provider}/${ctx.model.id}`);
    args.push("--thinking", pi.getThinkingLevel());
    return new SideRpcClient(ctx.cwd, args, forkSession);
  }

  const manager = new SideChatManager(buildClient);
  let sideOpen = false;
  let unsubscribeSideKeys: (() => void) | undefined;

  async function openSide(ctx: ExtensionContext): Promise<void> {
    if (sideOpen) return;
    if (ctx.mode !== "tui") {
      ctx.ui.notify("/side requires interactive TUI mode", "error");
      return;
    }

    sideOpen = true;
    manager.ensure(ctx);
    const sideKeys = SIDE_KEYS;

    try {
      await ctx.ui.custom<void>((tui, theme, _keybindings, done) => {
        const panel = new SidePanel(manager, ctx, tui, theme, sideKeys, () => done(undefined));
        manager.onChange = () => {
          panel.invalidate();
          tui.requestRender();
        };
        return panel;
      }, {
        overlay: true,
        overlayOptions: {
          anchor: "right-center",
          width: "50%",
          minWidth: 60,
          maxHeight: "80%",
          margin: 0,
        },
      });
    } finally {
      sideOpen = false;
      manager.onChange = undefined;
    }
  }

  pi.on("session_start", (_event, ctx) => {
    manager.setStatusUpdater((text) => ctx.ui.setStatus("side", text));

    unsubscribeSideKeys?.();
    unsubscribeSideKeys = undefined;
    if (ctx.mode === "tui") {
      const sideKeys = SIDE_KEYS;
      unsubscribeSideKeys = ctx.ui.onTerminalInput((data) => {
        if (!matchesSideKey(data, sideKeys)) return undefined;
        if (sideOpen) return undefined;
        void openSide(ctx);
        return { consume: true };
      });
    }
  });

  pi.on("agent_end", () => {
    manager.refresh();
  });

  pi.registerCommand("side", {
    description: `Open a side-chat panel backed by read-only pi agent forks. Quake key: ${sideKeyHint(SIDE_KEYS)}. Use /side clean to close them.`,
    handler: async (args: string, ctx: ExtensionCommandContext) => {
      const command = (args ?? "").trim();
      if (command === "clean") {
        manager.clean();
        ctx.ui.notify("side chats cleaned", "info");
        return;
      }

      if (command) ctx.ui.notify("/side opens the panel; use /side clean to close all side chats", "info");
      await openSide(ctx);
    },
  });

  pi.on("session_shutdown", (_event, ctx) => {
    unsubscribeSideKeys?.();
    unsubscribeSideKeys = undefined;
    ctx.ui.setStatus("side", undefined);
    manager.setStatusUpdater(undefined);
    manager.dispose();
  });
}
