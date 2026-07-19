import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { matchesKey } from "@mariozechner/pi-tui";

type CommandResult = {
  code: number | null;
  error?: string;
};

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function getShell(): { command: string; args: string[] } {
  if (process.platform === "win32") {
    return { command: process.env.COMSPEC || "cmd.exe", args: [] };
  }
  return { command: process.env.SHELL || "/bin/sh", args: ["-l"] };
}

function runTmux(args: string[]): CommandResult {
  const result = spawnSync("tmux", args, {
    env: process.env,
    encoding: "utf-8",
    timeout: 1_000,
  });

  if (result.status === 0) return { code: 0 };
  return {
    code: result.status,
    error: result.error ? errorMessage(result.error) : (result.stderr || "tmux command failed").trim(),
  };
}

function popupSocketName(pane: string): string {
  const identity = `${process.env.TMUX}\0${pane}`;
  const suffix = createHash("sha256").update(identity).digest("hex").slice(0, 12);
  return `pi-terminal-${suffix}`;
}

function ensurePopupSession(ctx: ExtensionContext, pane: string): { socketName?: string; result: CommandResult } {
  const socketName = popupSocketName(pane);
  const sessionName = "terminal";
  const target = `=${sessionName}`;
  const hasSessionArgs = ["-L", socketName, "has-session", "-t", target];

  if (runTmux(hasSessionArgs).code !== 0) {
    const shell = getShell();
    const created = runTmux([
      "-L",
      socketName,
      "-f",
      "/dev/null",
      "new-session",
      "-d",
      "-s",
      sessionName,
      "-c",
      ctx.cwd,
      shell.command,
      ...shell.args,
    ]);

    // A second shortcut invocation may have created the session concurrently.
    if (created.code !== 0 && runTmux(hasSessionArgs).code !== 0) return { result: created };
  }

  const configured = runTmux([
    "-L",
    socketName,
    "set-option",
    "-g",
    "status",
    "off",
    ";",
    "set-option",
    "-g",
    "prefix",
    "None",
    ";",
    "set-option",
    "-s",
    "extended-keys",
    "on",
    ";",
    "set-option",
    "-s",
    "extended-keys-format",
    "csi-u",
    ";",
    "set-option",
    "-s",
    "terminal-features[100]",
    "tmux*:hyperlinks",
    ";",
    "bind-key",
    "-n",
    "C-/",
    "detach-client",
    ";",
    "bind-key",
    "-n",
    "C-_",
    "detach-client",
  ]);
  if (configured.code !== 0) return { result: configured };

  return { socketName, result: { code: 0 } };
}

function openTmuxPopup(ctx: ExtensionContext): CommandResult | undefined {
  const pane = process.env.TMUX_PANE;
  if (!process.env.TMUX || !pane) return undefined;

  const check = spawnSync("tmux", ["display-message", "-p", "-t", pane, "#{client_name}"], {
    env: process.env,
    encoding: "utf-8",
    timeout: 1_000,
  });
  const client = check.stdout?.trim();

  if (check.status !== 0 || !client) {
    return {
      code: check.status,
      error: check.error
        ? errorMessage(check.error)
        : (check.stderr || "no tmux client is displaying the Pi pane").trim(),
    };
  }

  const prepared = ensurePopupSession(ctx, pane);
  if (prepared.result.code !== 0 || !prepared.socketName) return prepared.result;

  try {
    const child = spawn(
      "tmux",
      [
        "display-popup",
        "-B",
        "-c",
        client,
        "-t",
        pane,
        "-E",
        "-e",
        "TMUX=",
        "-d",
        ctx.cwd,
        "-w",
        "100%",
        "-h",
        "90%",
        "tmux",
        "-L",
        prepared.socketName,
        "attach-session",
        "-t",
        "=terminal",
      ],
      {
        env: process.env,
        stdio: "ignore",
        detached: true,
      },
    );

    child.on("error", () => {});
    child.unref();
    return { code: 0 };
  } catch (error) {
    return { code: null, error: errorMessage(error) };
  }
}

async function openDirectTerminal(ctx: ExtensionContext): Promise<void> {
  const result = await ctx.ui.custom<CommandResult>((tui, _theme, _keybindings, done) => {
    let settled = false;

    const finish = (commandResult: CommandResult) => {
      if (settled) return;
      settled = true;
      try {
        tui.start();
        tui.requestRender(true);
      } finally {
        done(commandResult);
      }
    };

    setImmediate(() => {
      try {
        tui.stop();
        const shell = getShell();
        const child = spawnSync(shell.command, shell.args, {
          cwd: ctx.cwd,
          stdio: "inherit",
          env: process.env,
        });
        finish({ code: child.status, error: child.error ? errorMessage(child.error) : undefined });
      } catch (error) {
        finish({ code: null, error: errorMessage(error) });
      }
    });

    return { render: () => [], invalidate: () => {} };
  });

  if (result.error) {
    ctx.ui.notify(`terminal failed: ${result.error}`, "error");
  } else if (result.code !== null && result.code !== 0) {
    ctx.ui.notify(`terminal exited with code ${result.code}`, "warning");
  }
}

async function openTerminal(ctx: ExtensionContext): Promise<void> {
  if (ctx.mode !== "tui") {
    if (ctx.hasUI) ctx.ui.notify("terminal requires the interactive TUI", "warning");
    return;
  }

  const popupResult = openTmuxPopup(ctx);
  if (popupResult?.code === 0) return;

  if (!ctx.isIdle()) {
    const reason = popupResult?.error ? `tmux popup failed: ${popupResult.error}` : "tmux is not available";
    ctx.ui.notify(`${reason}. Wait for the current agent turn to finish before opening an inline terminal.`, "warning");
    return;
  }

  if (popupResult?.error) {
    ctx.ui.notify(`tmux popup failed; falling back to an inline terminal: ${popupResult.error}`, "warning");
  }
  await openDirectTerminal(ctx);
}

export default function terminalExtension(pi: ExtensionAPI) {
  let unsubscribeLegacyShortcut: (() => void) | undefined;

  pi.registerShortcut("ctrl+/", {
    description: "Open terminal",
    handler: openTerminal,
  });

  pi.on("session_start", (_event, ctx) => {
    unsubscribeLegacyShortcut?.();
    unsubscribeLegacyShortcut = undefined;
    if (ctx.mode !== "tui") return;

    // This terminal reports the physical Ctrl+/ chord as CSI-u Ctrl+_.
    // Legacy terminals may instead send the ambiguous 0x1f control byte.
    unsubscribeLegacyShortcut = ctx.ui.onTerminalInput((data) => {
      if (data !== "\x1f" && !matchesKey(data, "ctrl+_")) return undefined;
      void openTerminal(ctx).catch((error) => {
        ctx.ui.notify(`terminal failed: ${errorMessage(error)}`, "error");
      });
      return { consume: true };
    });
  });

  pi.on("session_shutdown", () => {
    unsubscribeLegacyShortcut?.();
    unsubscribeLegacyShortcut = undefined;
  });
}
