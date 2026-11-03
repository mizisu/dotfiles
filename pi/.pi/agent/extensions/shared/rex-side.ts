import { randomUUID } from "node:crypto";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { SessionManager, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { matchesKey } from "@earendil-works/pi-tui";
import { createRexFloat, rexBlocks, rexCall, showRexBlock, type RexBlock, type RexBounds } from "./rex.js";

const TOOLS = ["read", "grep", "find", "ls"];
const BOUNDS: RexBounds = [0.48, 0.1, 0.5, 0.8];
type Host = {
  session: string;
  parent: string;
  tag: string;
  sessionDir: string;
  sourceSession?: string;
  leaf?: string | null;
};

function invocation(args: string[]): string[] {
  const script = process.argv[1];
  if (script && !script.startsWith("/$bunfs/root/") && existsSync(script)) return [process.execPath, script, ...args];
  return /^(node|bun)(\.exe)?$/.test(basename(process.execPath)) ? ["pi", ...args] : [process.execPath, ...args];
}

export function rexSideExtension(pi: ExtensionAPI, extensionPath: string): void {
  const child = process.env.PI_SIDE_CHILD === "1";
  let host: Host | undefined = child ? JSON.parse(Buffer.from(process.env.PI_REX_SIDE_HOST ?? "", "base64").toString()) : undefined;
  let unsubscribe: (() => void) | undefined;

  function ensureHost(ctx: ExtensionContext): Host {
    host ??= {
      session: process.env.REX_SESSION!, parent: process.env.REX_BLOCK!,
      tag: randomUUID(), sessionDir: mkdtempSync(join(tmpdir(), "pi-rex-side-")),
    };
    if (!child) {
      host.sourceSession = ctx.sessionManager.getSessionFile();
      host.leaf = ctx.sessionManager.getLeafId();
    }
    return host;
  }

  function prefix(current: Host): string { return `pi-side:${current.parent}:${current.tag}:`; }
  function panes(current: Host): RexBlock[] {
    const start = prefix(current);
    return rexBlocks(current.session).filter((block) => block.label?.startsWith(start))
      .sort((a, b) => Number(a.label!.slice(start.length)) - Number(b.label!.slice(start.length)));
  }

  function hideOthers(current: Host, except?: string): void {
    for (const pane of panes(current)) {
      if (pane.block_id !== except && pane.placement !== "detached") {
        rexCall("session.detach_block", current.session, { block_id: pane.block_id });
      }
    }
  }

  function show(current: Host, block: string): void {
    hideOthers(current, block);
    showRexBlock(current.session, block, current.parent, BOUNDS);
  }

  function create(ctx: ExtensionContext, current: Host): void {
    const all = panes(current);
    const id = Number(all.at(-1)?.label?.slice(prefix(current).length) ?? 0) + 1;
    const args = ["--no-extensions", "-e", extensionPath, "--tools", TOOLS.join(","), "--name", `Side #${id}`,
      ctx.isProjectTrusted() ? "--approve" : "--no-approve"];
    let fork: string | undefined;
    if (current.sourceSession && current.leaf && existsSync(current.sourceSession)) {
      fork = SessionManager.open(current.sourceSession, current.sessionDir).createBranchedSession(current.leaf);
    }
    if (fork) args.push("--session", fork, "--session-dir", current.sessionDir);
    else args.push("--no-session");
    if (ctx.model) args.push("--model", `${ctx.model.provider}/${ctx.model.id}`);
    args.push("--thinking", pi.getThinkingLevel());
    const command = ["env", "-u", "NVIM", "PI_SIDE_CHILD=1", `PI_SIDE_ID=${id}`,
      `PI_REX_SIDE_HOST=${Buffer.from(JSON.stringify(current)).toString("base64")}`, ...invocation(args)];
    // Create first: a failed launch must not hide the existing side chat.
    const block = createRexFloat(current.session, current.parent, `${prefix(current)}${id}`, ctx.cwd, command, BOUNDS);
    hideOthers(current, block);
  }

  function guard(ctx: ExtensionContext, action: (current: Host) => void): void {
    if (ctx.mode !== "tui") {
      if (ctx.hasUI) ctx.ui.notify("Side Chat requires interactive TUI mode", "warning");
      return;
    }
    try { action(ensureHost(ctx)); }
    catch (error) { ctx.ui.notify(`Side Chat: ${error instanceof Error ? error.message : String(error)}`, "error"); }
  }

  function open(ctx: ExtensionContext): void {
    guard(ctx, (current) => {
      const all = panes(current);
      const target = all.find((pane) => pane.placement === "placed") ?? all.at(-1);
      if (target) show(current, target.block_id);
      else create(ctx, current);
    });
  }

  function clean(): void {
    if (!host) return;
    // Only close this extension instance's own side panes; never its parent.
    for (const pane of panes(host)) rexCall("block.close", host.session, { block_id: pane.block_id });
    rmSync(host.sessionDir, { recursive: true, force: true });
    host = undefined;
  }

  if (child) {
    const cycle = (ctx: ExtensionContext, delta: number) => guard(ctx, (current) => {
      const all = panes(current);
      if (all.length < 2) return;
      const index = all.findIndex((pane) => pane.block_id === process.env.REX_BLOCK);
      show(current, all[(Math.max(0, index) + delta + all.length) % all.length]!.block_id);
    });
    pi.registerShortcut("ctrl+tab", { description: "Next Side Chat", handler: (ctx) => cycle(ctx, 1) });
    pi.registerShortcut("ctrl+shift+tab", { description: "Previous Side Chat", handler: (ctx) => cycle(ctx, -1) });
    pi.registerShortcut("ctrl+n", { description: "New Side Chat", handler: (ctx) => guard(ctx, (current) => create(ctx, current)) });
    pi.on("tool_call", (event) => {
      if (!TOOLS.includes(event.toolName)) return { block: true, reason: "Side Chat is read-only" };
    });
    pi.on("user_bash", () => ({ result: {
      output: "Side Chat is read-only; user bash is disabled.", exitCode: 1, cancelled: false, truncated: false,
    } }));
  } else {
    pi.registerCommand("side", {
      description: "Open a read-only Rex Side Chat. /side clean removes this session's chats.",
      handler: async (args, ctx) => {
        if (args.trim() === "clean") {
          try { clean(); ctx.ui.notify("side chats cleaned", "info"); }
          catch (error) { ctx.ui.notify(String(error), "error"); }
        } else if (args.trim()) ctx.ui.notify("Usage: /side [clean]", "warning");
        else open(ctx);
      },
    });
  }

  pi.on("session_start", (_event, ctx) => {
    unsubscribe?.();
    unsubscribe = undefined;
    if (ctx.mode !== "tui") return;
    if (child) ctx.ui.setStatus("side", `side #${process.env.PI_SIDE_ID ?? "?"}`);
    unsubscribe = ctx.ui.onTerminalInput((data) => {
      if (!matchesKey(data, "alt+s")) return undefined;
      if (child) guard(ctx, (current) => {
        rexCall("session.detach_block", current.session, { block_id: process.env.REX_BLOCK! });
        rexCall("session.focus_block", current.session, { block_id: current.parent });
      });
      else open(ctx);
      return { consume: true };
    });
  });
  pi.on("session_shutdown", (_event, ctx) => {
    unsubscribe?.();
    unsubscribe = undefined;
    if (child) ctx.ui.setStatus("side", undefined);
    else {
      try { clean(); }
      catch (error) { if (ctx.hasUI) ctx.ui.notify(`Side Chat cleanup: ${String(error)}`, "warning"); }
    }
  });
}
