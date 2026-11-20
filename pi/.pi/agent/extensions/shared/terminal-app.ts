import { spawnSync } from "node:child_process";
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

export async function openTerminalApp(ctx: ExtensionContext, app: App): Promise<void> {
  if (ctx.mode !== "tui") {
    if (ctx.hasUI) ctx.ui.notify(`${app} requires the interactive TUI`, "warning");
    return;
  }
  if (isRex()) return openRexPopup(ctx, app);

  if (!ctx.isIdle()) {
    ctx.ui.notify(`Wait for the current agent turn to finish before opening inline ${app}.`, "warning");
    return;
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
