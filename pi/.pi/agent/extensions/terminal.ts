import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { matchesKey } from "@earendil-works/pi-tui";
import { errorMessage, getShell, openTerminalApp, type CommandResult } from "./shared/terminal-app.js";

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

function openTerminal(ctx: ExtensionContext): Promise<void> {
  return openTerminalApp(ctx, "terminal", openTmuxPopup);
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
