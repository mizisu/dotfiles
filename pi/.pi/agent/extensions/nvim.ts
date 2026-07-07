import { spawn, spawnSync } from "node:child_process";
import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";

type CommandResult = {
  code: number | null;
  error?: string;
};

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function openTmuxPopup(ctx: ExtensionContext, command: string): CommandResult | undefined {
  if (!process.env.TMUX) return undefined;

  const check = spawnSync("tmux", ["display-message", "-p", "#{pane_id}"], {
    env: process.env,
    encoding: "utf-8",
    timeout: 1000,
  });

  if (check.status !== 0) {
    return {
      code: check.status,
      error: check.error ? errorMessage(check.error) : (check.stderr || "tmux is not available").trim(),
    };
  }

  try {
    const child = spawn("tmux", ["display-popup", "-B", "-E", "-d", ctx.cwd, "-w", "100%", "-h", "100%", command], {
      env: process.env,
      stdio: "ignore",
      detached: true,
    });

    child.on("error", () => {});
    child.unref();
    return { code: 0 };
  } catch (error) {
    return { code: null, error: errorMessage(error) };
  }
}

async function openDirectNvim(ctx: ExtensionContext): Promise<void> {
  const result = await ctx.ui.custom<CommandResult>((tui, _theme, _keybindings, done) => {
    let settled = false;

    const finish = (result: CommandResult) => {
      if (settled) return;
      settled = true;
      try {
        tui.start();
        tui.requestRender(true);
      } finally {
        done(result);
      }
    };

    setImmediate(() => {
      try {
        tui.stop();

        const child = spawnSync("nvim", [], {
          cwd: ctx.cwd,
          stdio: "inherit",
          env: process.env,
          shell: process.platform === "win32",
        });

        finish({ code: child.status, error: child.error ? errorMessage(child.error) : undefined });
      } catch (error) {
        finish({ code: null, error: errorMessage(error) });
      }
    });

    return { render: () => [], invalidate: () => {} };
  });

  if (result.error) {
    ctx.ui.notify(`nvim failed: ${result.error}`, "error");
  } else if (result.code !== null && result.code !== 0) {
    ctx.ui.notify(`nvim exited with code ${result.code}`, "warning");
  }
}

async function openNvim(ctx: ExtensionContext): Promise<void> {
  if (ctx.mode !== "tui") {
    if (ctx.hasUI) ctx.ui.notify("nvim requires the interactive TUI", "warning");
    return;
  }

  const popupResult = openTmuxPopup(ctx, "nvim");
  if (popupResult?.code === 0) return;

  if (!ctx.isIdle()) {
    const reason = popupResult?.error ? `tmux popup failed: ${popupResult.error}` : "tmux is not available";
    ctx.ui.notify(`${reason}. Wait for the current agent turn to finish before opening inline nvim.`, "warning");
    return;
  }

  if (popupResult?.error) {
    ctx.ui.notify(`tmux popup failed; falling back to inline nvim: ${popupResult.error}`, "warning");
  }
  await openDirectNvim(ctx);
}

export default function nvimExtension(pi: ExtensionAPI) {
  pi.registerShortcut("ctrl+e", {
    description: "Open nvim",
    handler: openNvim,
  });

  pi.registerCommand("nvim", {
    description: "Open nvim",
    handler: async (_args, ctx) => openNvim(ctx),
  });
}
