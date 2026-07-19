import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { matchesKey } from "@mariozechner/pi-tui";

const SIDE_TOOLS = "read,grep,find,ls,web_fetch,web_search";
const SIDE_TOOL_NAMES = new Set(SIDE_TOOLS.split(","));
const SIDE_EXTENSION = fileURLToPath(import.meta.url);
const WEB_EXTENSION = join(dirname(SIDE_EXTENSION), "web-fetch-search.ts");
const IS_CHILD = process.env.PI_SIDE_CHILD === "1";
const TMUX_TIMEOUT_MS = 2_000;

type SideHost = {
  parentPane: string;
  mainSocket: string;
  sideSocket: string;
  homeSession: string;
  parentClient: string;
  sessionDir: string;
  sourceSession?: string;
};

type SidePane = {
  pane: string;
  id: number;
  active: boolean;
};

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function runTmux(args: string[], serverArgs: string[] = []): string {
  const result = spawnSync("tmux", [...serverArgs, ...args], {
    encoding: "utf-8",
    env: process.env,
    timeout: TMUX_TIMEOUT_MS,
  });

  if (result.error || result.status !== 0) {
    throw new Error(result.error ? errorMessage(result.error) : (result.stderr || `tmux exited with ${result.status}`).trim());
  }

  return (result.stdout || "").trim();
}

function tryTmux(args: string[], serverArgs: string[] = []): string | undefined {
  try {
    return runTmux(args, serverArgs);
  } catch {
    return undefined;
  }
}

function mainServer(host: SideHost): string[] {
  return ["-S", host.mainSocket];
}

function sideServer(host: SideHost, fresh = false): string[] {
  return fresh ? ["-L", host.sideSocket, "-f", "/dev/null"] : ["-L", host.sideSocket];
}

function isPaneId(value: string | undefined): value is string {
  return !!value && /^%\d+$/.test(value);
}

function getPiInvocation(args: string[]): { command: string; args: string[] } {
  const currentScript = process.argv[1];
  const isBunVirtualScript = currentScript?.startsWith("/$bunfs/root/");
  if (currentScript && !isBunVirtualScript && existsSync(currentScript)) {
    return { command: process.execPath, args: [currentScript, ...args] };
  }

  const execName = basename(process.execPath).toLowerCase();
  if (!/^(node|bun)(\.exe)?$/.test(execName)) return { command: process.execPath, args };
  return { command: "pi", args };
}

function listSidePanes(host: SideHost): SidePane[] {
  const output = tryTmux([
    "list-panes",
    "-a",
    "-F",
    "#{pane_id}|#{@pi-side-parent}|#{@pi-side-id}|#{window_active}",
  ], sideServer(host));

  if (!output) return [];
  return output
    .split("\n")
    .map((line) => line.split("|"))
    .filter((parts) => parts[1] === host.parentPane)
    .map(([pane, , rawId, active]) => ({
      pane: pane!,
      id: Number(rawId),
      active: active === "1",
    }))
    .filter((item) => isPaneId(item.pane) && Number.isInteger(item.id))
    .sort((left, right) => left.id - right.id);
}

function nextIndex(index: number, length: number, delta: number): number {
  return (index + delta + length) % length;
}

if (process.env.PI_SIDE_SELF_CHECK === "1") {
  assert.deepEqual([nextIndex(0, 3, -1), nextIndex(0, 3, 1), nextIndex(2, 3, 1)], [2, 1, 0]);
}

function cycleSide(host: SideHost, delta: number): void {
  const panes = listSidePanes(host);
  if (panes.length < 2) return;

  const currentPane = process.env.TMUX_PANE;
  const current = panes.find((pane) => pane.pane === currentPane) ?? panes.find((pane) => pane.active) ?? panes[0]!;
  const index = panes.findIndex((pane) => pane.pane === current.pane);
  runTmux(["select-window", "-t", panes[nextIndex(index, panes.length, delta)]!.pane], sideServer(host));
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

function openPopup(ctx: ExtensionContext, host: SideHost): void {
  const command = `env -u TMUX ${["tmux", "-L", host.sideSocket, "attach-session", "-t", host.homeSession]
    .map(shellQuote)
    .join(" ")}`;
  const popup = spawn("tmux", [
    ...mainServer(host),
    "display-popup",
    "-E",
    "-d",
    ctx.cwd,
    "-x",
    "R",
    "-y",
    "C",
    "-w",
    "50%",
    "-h",
    "80%",
    "-T",
    "Side Chat",
    "-c",
    host.parentClient,
    "-t",
    host.parentPane,
    command,
  ], {
    detached: true,
    env: process.env,
    stdio: "ignore",
  });
  popup.on("error", (error) => ctx.ui.notify(`Side Chat: ${error.message}`, "error"));
  popup.unref();
}

function closePopup(host: SideHost): void {
  const popup = spawn("tmux", [...mainServer(host), "display-popup", "-C", "-c", host.parentClient], {
    detached: true,
    env: process.env,
    stdio: "ignore",
  });
  popup.on("error", () => {});
  popup.unref();
}

function createSide(
  ctx: ExtensionContext,
  pi: ExtensionAPI,
  host: SideHost,
  panes = listSidePanes(host),
): void {
  const id = (panes.at(-1)?.id ?? 0) + 1;
  const sessionId = `side-${randomUUID()}`;
  const args = [
    "--no-extensions",
    "-e",
    SIDE_EXTENSION,
    "-e",
    WEB_EXTENSION,
    "--tools",
    SIDE_TOOLS,
    "--name",
    `Side #${id}`,
    ctx.isProjectTrusted() ? "--approve" : "--no-approve",
  ];

  if (host.sourceSession && existsSync(host.sourceSession)) {
    args.push(
      "--fork",
      host.sourceSession,
      "--session-id",
      sessionId,
      "--session-dir",
      host.sessionDir,
    );
  } else {
    args.push("--no-session");
  }

  if (ctx.model) args.push("--model", `${ctx.model.provider}/${ctx.model.id}`);
  args.push("--thinking", pi.getThinkingLevel());

  const invocation = getPiInvocation(args);
  const envArgs = [
    "-e",
    "PI_SIDE_CHILD=1",
    "-e",
    `PI_SIDE_ID=${id}`,
    "-e",
    `PI_SIDE_PARENT_PANE=${host.parentPane}`,
    "-e",
    `PI_SIDE_MAIN_SOCKET=${host.mainSocket}`,
    "-e",
    `PI_SIDE_SOCKET=${host.sideSocket}`,
    "-e",
    `PI_SIDE_HOME_SESSION=${host.homeSession}`,
    "-e",
    `PI_SIDE_PARENT_CLIENT=${host.parentClient}`,
    "-e",
    `PI_SIDE_SESSION_DIR=${host.sessionDir}`,
  ];
  if (host.sourceSession) envArgs.push("-e", `PI_SIDE_SOURCE_SESSION=${host.sourceSession}`);

  const first = panes.length === 0;
  const tmuxArgs = first
    ? [
        "new-session",
        "-d",
        "-P",
        "-F",
        "#{pane_id}",
        "-s",
        host.homeSession,
        "-n",
        `side-${id}`,
        "-c",
        ctx.cwd,
        ...envArgs,
        invocation.command,
        ...invocation.args,
      ]
    : [
        "new-window",
        "-d",
        "-P",
        "-F",
        "#{pane_id}",
        "-t",
        `${host.homeSession}:`,
        "-n",
        `side-${id}`,
        "-c",
        ctx.cwd,
        ...envArgs,
        invocation.command,
        ...invocation.args,
      ];

  const pane = runTmux(tmuxArgs, sideServer(host, first));
  if (!isPaneId(pane)) throw new Error(`tmux returned an invalid pane id: ${pane || "empty"}`);

  try {
    const setup = first
      ? [
          "set-option", "-t", host.homeSession, "status", "off",
          ";", "set-option", "-s", "extended-keys", "on",
          ";", "set-option", "-s", "extended-keys-format", "csi-u",
          ";", "set-option", "-s", "escape-time", "10",
          ";",
        ]
      : [];
    setup.push(
      "set-option", "-p", "-t", pane, "@pi-side-parent", host.parentPane,
      ";", "set-option", "-p", "-t", pane, "@pi-side-id", String(id),
      ";", "select-pane", "-t", pane, "-T", `Side #${id}`,
      ";", "select-window", "-t", pane,
    );
    runTmux(setup, sideServer(host));
  } catch (error) {
    if (first) tryTmux(["kill-server"], sideServer(host));
    else tryTmux(["kill-pane", "-t", pane], sideServer(host));
    throw error;
  }
}

function readChildHost(): SideHost {
  const parentPane = process.env.PI_SIDE_PARENT_PANE;
  const mainSocket = process.env.PI_SIDE_MAIN_SOCKET;
  const sideSocket = process.env.PI_SIDE_SOCKET;
  const homeSession = process.env.PI_SIDE_HOME_SESSION;
  const parentClient = process.env.PI_SIDE_PARENT_CLIENT;
  const sessionDir = process.env.PI_SIDE_SESSION_DIR;
  if (!isPaneId(parentPane) || !mainSocket || !sideSocket || !homeSession || !parentClient || !sessionDir) {
    throw new Error("side child is missing its tmux host environment");
  }

  return {
    parentPane,
    mainSocket,
    sideSocket,
    homeSession,
    parentClient,
    sessionDir,
    sourceSession: process.env.PI_SIDE_SOURCE_SESSION,
  };
}

function cleanHost(host: SideHost): void {
  tryTmux(["kill-server"], sideServer(host));
  rmSync(host.sessionDir, { recursive: true, force: true });
}

export default function sideExtension(pi: ExtensionAPI) {
  const childHost = IS_CHILD ? readChildHost() : undefined;
  let host: SideHost | undefined;
  let unsubscribeTilde: (() => void) | undefined;

  function ensureHost(ctx: ExtensionContext): SideHost {
    if (host && tryTmux(["has-session", "-t", host.homeSession], sideServer(host)) !== undefined) return host;
    if (host) cleanHost(host);

    const parentPane = process.env.TMUX_PANE;
    const mainSocket = process.env.TMUX?.split(",", 1)[0];
    if (!isPaneId(parentPane) || !mainSocket) throw new Error("Side Chat requires tmux");

    const parentClient = runTmux(
      ["display-message", "-p", "-t", parentPane, "#{client_name}"],
      ["-S", mainSocket],
    );
    if (!parentClient) throw new Error("no tmux client is displaying the parent pane");

    host = {
      parentPane,
      mainSocket,
      sideSocket: `pi-side-${process.pid}-${parentPane.slice(1)}`,
      homeSession: "side",
      parentClient,
      sessionDir: mkdtempSync(join(tmpdir(), "pi-side-")),
      sourceSession: ctx.sessionManager.getSessionFile(),
    };
    return host;
  }

  function useHost(ctx: ExtensionContext, action: (sideHost: SideHost) => void): void {
    if (ctx.mode !== "tui") {
      ctx.ui.notify("Side Chat requires interactive TUI mode", "error");
      return;
    }

    try {
      action(childHost ?? ensureHost(ctx));
    } catch (error) {
      ctx.ui.notify(`Side Chat: ${errorMessage(error)}`, "error");
    }
  }

  function showPopup(ctx: ExtensionContext): void {
    useHost(ctx, (sideHost) => {
      const panes = listSidePanes(sideHost);
      if (panes.length === 0) createSide(ctx, pi, sideHost, panes);
      openPopup(ctx, sideHost);
    });
  }

  if (IS_CHILD) {
    pi.registerShortcut("ctrl+tab", {
      description: "Next Side Chat",
      handler: (ctx) => useHost(ctx, (sideHost) => cycleSide(sideHost, 1)),
    });

    pi.registerShortcut("ctrl+shift+tab", {
      description: "Previous Side Chat",
      handler: (ctx) => useHost(ctx, (sideHost) => cycleSide(sideHost, -1)),
    });

    pi.registerShortcut("ctrl+n", {
      description: "New Side Chat",
      handler: (ctx) => useHost(ctx, (sideHost) => createSide(ctx, pi, sideHost)),
    });

    pi.on("tool_call", (event) => {
      if (!SIDE_TOOL_NAMES.has(event.toolName)) {
        return { block: true, reason: "Side Chat is read-only" };
      }
    });

    pi.on("user_bash", () => ({
      result: {
        output: "Side Chat is read-only; user bash is disabled.",
        exitCode: 1,
        cancelled: false,
        truncated: false,
      },
    }));
  } else {
    pi.registerCommand("side", {
      description: "Open a native read-only Pi Side Chat popup. Use /side clean to remove all chats.",
      handler: async (args, ctx) => {
        const command = (args ?? "").trim();
        if (command === "clean") {
          if (host) cleanHost(host);
          host = undefined;
          ctx.ui.notify("side chats cleaned", "info");
          return;
        }
        if (command) {
          ctx.ui.notify("Usage: /side [clean]", "warning");
          return;
        }

        showPopup(ctx);
      },
    });
  }

  pi.on("session_start", (_event, ctx) => {
    unsubscribeTilde?.();
    unsubscribeTilde = undefined;
    if (ctx.mode !== "tui") return;

    if (IS_CHILD) ctx.ui.setStatus("side", `side #${process.env.PI_SIDE_ID ?? "?"}`);
    unsubscribeTilde = ctx.ui.onTerminalInput((data) => {
      if (!matchesKey(data, "~")) return undefined;
      if (IS_CHILD) useHost(ctx, closePopup);
      else showPopup(ctx);
      return { consume: true };
    });
  });

  pi.on("session_shutdown", (_event, ctx) => {
    unsubscribeTilde?.();
    unsubscribeTilde = undefined;
    if (IS_CHILD) ctx.ui.setStatus("side", undefined);
    else if (host) {
      cleanHost(host);
      host = undefined;
    }
  });
}
