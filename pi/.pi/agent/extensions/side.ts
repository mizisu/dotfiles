import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { existsSync } from "node:fs";
import { basename } from "node:path";
import type { ExtensionAPI, ExtensionCommandContext } from "@mariozechner/pi-coding-agent";
import { Input, Key, matchesKey, truncateToWidth, visibleWidth, wrapTextWithAnsi, type Focusable } from "@mariozechner/pi-tui";

type Role = "user" | "assistant" | "tool" | "system" | "error";

type TranscriptItem = {
  role: Role;
  text: string;
};

const SIDE_TOOLS = "read,grep,find,ls";
const MAX_STORED_ITEMS = 200;

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

class SideRpcClient {
  transcript: TranscriptItem[] = [];
  busy = false;
  onChange?: () => void;

  private proc?: ChildProcessWithoutNullStreams;
  private buffer = "";
  private assistant?: TranscriptItem;
  private disposed = false;

  constructor(
    private readonly cwd: string,
    private readonly args: string[],
  ) {}

  start(): void {
    if (this.proc || this.disposed) return;

    const invocation = getPiInvocation(this.args);
    const proc = spawn(invocation.command, invocation.args, {
      cwd: this.cwd,
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
      this.push("error", `failed to start side agent: ${error.message}`);
      this.busy = false;
      this.proc = undefined;
      this.emit();
    });
    proc.on("exit", (code, signal) => {
      this.proc = undefined;
      this.busy = false;
      this.assistant = undefined;
      if (!this.disposed) this.push("system", `side agent exited (${signal ?? code ?? "unknown"})`);
      this.emit();
    });
  }

  send(text: string): void {
    const message = text.trim();
    if (!message) return;
    if (this.busy) {
      this.push("system", "side agent is busy; wait or press Ctrl+C to abort");
      return;
    }

    this.start();
    if (!this.proc?.stdin.writable) {
      this.push("error", "side agent is not available");
      return;
    }

    this.push("user", message);
    this.busy = true;
    this.assistant = undefined;
    this.proc.stdin.write(`${JSON.stringify({ type: "prompt", message })}\n`);
    this.emit();
  }

  abort(): void {
    if (!this.proc?.stdin.writable) return;
    this.proc.stdin.write(`${JSON.stringify({ type: "abort" })}\n`);
    this.push("system", "abort requested");
  }

  dispose(): void {
    this.disposed = true;
    this.onChange = undefined;
    this.proc?.kill("SIGTERM");
    this.proc = undefined;
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

class SidePanel implements Focusable {
  private _focused = false;
  private input = new Input();
  private cachedWidth?: number;
  private cachedLines?: string[];

  get focused(): boolean {
    return this._focused;
  }

  set focused(value: boolean) {
    this._focused = value;
    this.input.focused = value;
  }

  constructor(
    private readonly client: SideRpcClient,
    private readonly tui: any,
    private readonly theme: any,
    private readonly done: () => void,
  ) {}

  handleInput(data: string): void {
    if (matchesKey(data, Key.escape) || matchesKey(data, Key.ctrl("d"))) {
      this.done();
      return;
    }

    if (matchesKey(data, Key.ctrl("c"))) {
      if (this.client.busy) this.client.abort();
      else this.done();
      this.refresh();
      return;
    }

    if (matchesKey(data, Key.enter)) {
      const text = this.input.getValue().trim();
      if (text) {
        this.input.setValue("");
        this.client.send(text);
      }
      this.refresh();
      return;
    }

    this.input.handleInput(data);
    this.refresh();
  }

  render(width: number): string[] {
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
    row(` ${this.theme.fg("accent", this.theme.bold("Side Chat"))}`);
    row("");

    const transcriptLines = this.renderTranscript(inner);
    const hidden = Math.max(0, transcriptLines.length - maxTranscriptLines);
    if (hidden > 0) row(` ${this.theme.fg("dim", `… ${hidden} earlier lines`)}`);
    for (const line of transcriptLines.slice(-maxTranscriptLines)) row(line);
    if (transcriptLines.length === 0) row(` ${this.theme.fg("dim", "Ask inside this panel. Main session is untouched.")}`);

    while (lines.length < terminalRows - inputLines.length - 3) row("");
    row("");
    for (const line of inputLines) row(` ${line}`);
    row(` ${this.theme.fg("dim", "Enter send • Ctrl+C abort • Esc close")}`);
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

  private renderTranscript(width: number): string[] {
    const lines: string[] = [];
    for (const item of this.client.transcript) {
      const label = this.label(item.role);
      const text = item.text || (item.role === "assistant" ? "…" : "");
      addWrapped(lines, this.color(item.role, text), width, `${label} `);
    }
    return lines;
  }

  private label(role: Role): string {
    const label = role === "user" ? "you" : role === "assistant" ? "side" : role;
    const color = role === "error" ? "error" : role === "tool" ? "muted" : role === "system" ? "dim" : "accent";
    return this.theme.fg(color, `${label}:`);
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

export default function sideExtension(pi: ExtensionAPI) {
  let client: SideRpcClient | undefined;

  function buildClient(ctx: ExtensionCommandContext): SideRpcClient {
    const sessionFile = ctx.sessionManager.getSessionFile();
    const args = ["--mode", "rpc", "--no-extensions", "--tools", SIDE_TOOLS];
    if (sessionFile) args.push("--fork", sessionFile);
    else args.push("--no-session");
    if (ctx.model) args.push("--model", `${ctx.model.provider}/${ctx.model.id}`);
    args.push("--thinking", pi.getThinkingLevel());
    return new SideRpcClient(ctx.cwd, args);
  }

  pi.registerCommand("side", {
    description: "Open a side-chat panel backed by a read-only pi agent forked from the current session.",
    handler: async (args, ctx) => {
      if (ctx.mode !== "tui") {
        ctx.ui.notify("/side requires interactive TUI mode", "error");
        return;
      }

      if ((args ?? "").trim()) ctx.ui.notify("/side opens the panel; type your message inside it", "info");

      client ??= buildClient(ctx);
      client.start();

      await ctx.ui.custom<void>((tui, theme, _keybindings, done) => {
        const panel = new SidePanel(client!, tui, theme, () => done(undefined));
        client!.onChange = () => {
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

      if (client) client.onChange = undefined;
    },
  });

  pi.on("session_shutdown", () => {
    client?.dispose();
    client = undefined;
  });
}
