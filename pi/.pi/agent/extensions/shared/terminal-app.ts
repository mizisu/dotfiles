import { spawn, spawnSync } from "node:child_process";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { isRex, openRexPopup } from "./rex.js";

export type CommandResult = { code: number | null; error?: string };
type App = "terminal" | "nvim" | "lazygit";

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function getShell(): { command: string; args: string[] } {
  return process.platform === "win32"
    ? { command: process.env.COMSPEC || "cmd.exe", args: [] }
    : { command: process.env.SHELL || "/bin/sh", args: ["-l"] };
}

function openTmuxPopup(ctx: ExtensionContext, command: string): CommandResult | undefined {
  if (!process.env.TMUX) return undefined;
  const check = spawnSync("tmux", ["display-message", "-p", "#{pane_id}"], {
    encoding: "utf-8", timeout: 1_000,
  });
  if (check.status !== 0) {
    return { code: check.status, error: check.error?.message || check.stderr.trim() || "tmux is not available" };
  }
  try {
    const child = spawn("tmux", ["display-popup", "-B", "-E", "-d", ctx.cwd, "-w", "100%", "-h", "100%", command], {
      stdio: "ignore", detached: true,
    });
    child.on("error", (error) => ctx.ui.notify(`tmux popup failed: ${error.message}`, "error"));
    child.unref();
    return { code: 0 };
  } catch (error) {
    return { code: null, error: errorMessage(error) };
  }
}

export async function openTerminalApp(
  ctx: ExtensionContext,
  app: App,
  popup: (ctx: ExtensionContext) => CommandResult | undefined = (ctx) => openTmuxPopup(ctx, app),
): Promise<void> {
  if (ctx.mode !== "tui") {
    if (ctx.hasUI) ctx.ui.notify(`${app} requires the interactive TUI`, "warning");
    return;
  }
  if (isRex()) return openRexPopup(ctx, app);

  const popupResult = popup(ctx);
  if (popupResult?.code === 0) return;
  if (!ctx.isIdle()) {
    const reason = popupResult?.error ? `tmux popup failed: ${popupResult.error}` : "tmux is not available";
    ctx.ui.notify(`${reason}. Wait for the current agent turn to finish before opening inline ${app}.`, "warning");
    return;
  }
  if (popupResult?.error) {
    ctx.ui.notify(`tmux popup failed; falling back to inline ${app}: ${popupResult.error}`, "warning");
  }

  const result = await ctx.ui.custom<CommandResult>((tui, _theme, _keys, done) => {
    setImmediate(() => {
      let result: CommandResult = { code: null };
      try {
        tui.stop();
        const { command, args } = app === "terminal" ? getShell() : { command: app, args: [] };
        const child = spawnSync(command, args, {
          cwd: ctx.cwd, stdio: "inherit", shell: app !== "terminal" && process.platform === "win32",
        });
        result = { code: child.status, error: child.error?.message };
      } catch (error) {
        result.error = errorMessage(error);
      } finally {
        try {
          tui.start();
          tui.requestRender(true);
        } catch (error) {
          result.error ??= errorMessage(error);
        }
        done(result);
      }
    });
    return { render: () => [], invalidate: () => {} };
  });
  if (result.error) ctx.ui.notify(`${app} failed: ${result.error}`, "error");
  else if (result.code !== null && result.code !== 0) ctx.ui.notify(`${app} exited with code ${result.code}`, "warning");
}
