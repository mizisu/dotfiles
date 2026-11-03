import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

export type RexBlock = {
  block_id: string;
  label?: string;
  window_id?: string;
  placement: "placed" | "detached";
};
export type RexBounds = [number, number, number, number];
const POPUP_BOUNDS: RexBounds = [0.025, 0.05, 0.95, 0.9];

export function isRex(): boolean {
  return Boolean(process.env.REX_SESSION && process.env.REX_BLOCK && !process.env.TMUX && !process.env.STY);
}

export function rexCall<T = unknown>(method: string, session: string, args: Record<string, unknown> = {}): T {
  const result = spawnSync("rex", ["--autostart=false", "--timeout", "3s", "api", "call", method, "-"], {
    input: JSON.stringify({ ...args, session_id: session }),
    encoding: "utf-8",
    timeout: 5_000,
    maxBuffer: 2 * 1024 * 1024,
  });
  if (result.error || result.status !== 0) {
    throw new Error(result.error?.message || result.stderr.trim() || `Rex ${method} failed (${result.status})`);
  }
  return JSON.parse(result.stdout) as T;
}

export function rexBlocks(session: string): RexBlock[] {
  return rexCall<{ blocks: RexBlock[] }>("session.list_blocks", session).blocks ?? [];
}

export function showRexBlock(session: string, block: string, parent: string, bounds = POPUP_BOUNDS): void {
  const blocks = rexBlocks(session);
  const target = blocks.find((entry) => entry.block_id === block);
  const anchor = blocks.find((entry) => entry.block_id === parent);
  if (!target || !anchor?.window_id) throw new Error("The popup or its parent pane no longer exists");
  if (target.placement === "detached" || target.window_id !== anchor.window_id) {
    rexCall("session.move_block", session, { block_id: block, anchor_block_id: parent });
    try {
      rexCall("session.float_block", session, { block_id: block, bounds });
    } catch (error) {
      // Restore a hidden popup rather than leave an unintended tiled split.
      rexCall("session.detach_block", session, { block_id: block });
      throw error;
    }
  }
  const view = rexCall<{ windows: { layers: { layer_id: string; kind: string; blocks: RexBlock[] }[] }[] }>("session.view", session);
  const layer = view.windows.flatMap((window) => window.layers).find((entry) => entry.blocks.some((item) => item.block_id === block));
  if (layer?.kind === "floating") rexCall("session.raise_layer", session, { layer_id: layer.layer_id });
  rexCall("session.focus_block", session, { block_id: block });
}

export function createRexFloat(
  session: string,
  parent: string,
  label: string,
  cwd: string,
  command?: string[],
  bounds = POPUP_BOUNDS,
): string {
  const anchor = rexBlocks(session).find((entry) => entry.block_id === parent);
  if (!anchor?.window_id) throw new Error("The parent Rex pane is not in a window");
  const result = rexCall<{ block_ids: string[] }>("session.new_layer", session, {
    window_id: anchor.window_id,
    bounds,
    focus: true,
    layout: { block: { flavor: "com.superlogical.terminal.shell", label, options: { cwd, command } } },
  });
  if (!result.block_ids?.[0]) throw new Error("Rex did not return a popup block ID");
  return result.block_ids[0];
}

function liveNvim(socket: string): boolean {
  if (!existsSync(socket)) return false;
  return spawnSync("nvim", ["--server", socket, "--remote-expr", "1"], { timeout: 1_000, stdio: "ignore" }).status === 0;
}

async function editorSocket(ctx: ExtensionContext, session: string, parent: string): Promise<string | null> {
  if (process.env.NVIM && liveNvim(process.env.NVIM)) return process.env.NVIM;
  const blocks = rexBlocks(session);
  const window = blocks.find((block) => block.block_id === parent)?.window_id;
  const candidates = blocks.filter((block) => block.window_id === window).map((block) => ({
    label: `Neovim [${block.block_id.slice(-6)}]`,
    socket: join(homedir(), ".cache/nvim", `rex-${block.block_id.replace(/^block:/, "")}.pipe`),
  })).filter((candidate) => liveNvim(candidate.socket));
  if (candidates.length === 0) return ""; // lazygit's edit command opens a local editor.
  if (candidates.length === 1) return candidates[0]!.socket;
  const selected = await ctx.ui.select("lazygit: edit files in which Neovim?", candidates.map((item) => item.label));
  return candidates.find((item) => item.label === selected)?.socket ?? null;
}

export async function openRexPopup(ctx: ExtensionContext, kind: "terminal" | "nvim" | "lazygit"): Promise<void> {
  const session = process.env.REX_SESSION!;
  const parent = process.env.REX_BLOCK!;
  const label = `pi-popup:${parent}:${kind}`;
  try {
    const existing = rexBlocks(session).find((block) => block.label === label);
    if (existing) {
      const processInfo = rexCall<{ last_exit?: unknown }>("com.superlogical.terminal.process", session, { block_id: existing.block_id, args: {} });
      if (!processInfo.last_exit) {
        showRexBlock(session, existing.block_id, parent);
        if (kind === "nvim" || kind === "lazygit") rexCall("session.zoom_block", session, { block_id: existing.block_id, zoom: true });
        return;
      }
      rexCall("block.close", session, { block_id: existing.block_id });
    }
    let command: string[] | undefined;
    if (kind === "nvim") command = ["env", "-u", "NVIM", "nvim"];
    if (kind === "lazygit") {
      const socket = await editorSocket(ctx, session, parent);
      if (socket === null) return;
      command = ["env", `NVIM=${socket}`, "lazygit"];
    }
    const block = createRexFloat(session, parent, label, ctx.cwd, command);
    if (kind === "nvim" || kind === "lazygit") rexCall("session.zoom_block", session, { block_id: block, zoom: true });
  } catch (error) {
    ctx.ui.notify(`Rex ${kind}: ${error instanceof Error ? error.message : String(error)}`, "error");
  }
}
