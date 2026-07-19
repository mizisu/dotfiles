import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";

const NOTICE_DURATION_MS = 3_000;
const TMUX_TIMEOUT_MS = 1_000;

interface TmuxLocation {
  windowActive: boolean;
  windowIndex: string;
}

function formatDuration(elapsedMs: number): string {
  const totalSeconds = Math.max(1, Math.round(elapsedMs / 1_000));
  if (totalSeconds < 60) return `${totalSeconds}s`;

  const totalMinutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  if (totalMinutes < 60) {
    return seconds ? `${totalMinutes}m ${seconds}s` : `${totalMinutes}m`;
  }

  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  return minutes ? `${hours}h ${minutes}m` : `${hours}h`;
}

async function runTmux(pi: ExtensionAPI, args: string[]): Promise<string | undefined> {
  try {
    const result = await pi.exec("tmux", args, { timeout: TMUX_TIMEOUT_MS });
    if (result.code !== 0) return undefined;
    return result.stdout.trim();
  } catch {
    // Notifications must never interrupt the agent lifecycle.
    return undefined;
  }
}

async function getTmuxLocation(pi: ExtensionAPI, pane: string): Promise<TmuxLocation | undefined> {
  const output = await runTmux(pi, [
    "display-message",
    "-p",
    "-t",
    pane,
    "#{window_index}|#{window_active}",
  ]);
  if (!output) return undefined;

  const [windowIndex, windowActive] = output.split("|");
  if (!windowIndex || (windowActive !== "0" && windowActive !== "1")) return undefined;

  return {
    windowIndex,
    windowActive: windowActive === "1",
  };
}

async function setDoneBadge(pi: ExtensionAPI, pane: string, visible: boolean): Promise<void> {
  const args = visible
    ? ["set-option", "-w", "-t", pane, "@pi_done", "1"]
    : ["set-option", "-wqu", "-t", pane, "@pi_done"];
  await runTmux(pi, args);
}

async function setNotice(pi: ExtensionAPI, pane: string, text: string, token: string): Promise<void> {
  await runTmux(pi, ["set-option", "-t", pane, "@pi_notice_owner", token]);
  await runTmux(pi, ["set-option", "-t", pane, "@pi_notice", text]);
}

async function clearNoticeIfOwned(pi: ExtensionAPI, pane: string, token: string): Promise<void> {
  const owner = await runTmux(pi, ["show-option", "-qv", "-t", pane, "@pi_notice_owner"]);
  if (owner !== token) return;

  await runTmux(pi, ["set-option", "-qu", "-t", pane, "@pi_notice"]);
  await runTmux(pi, ["set-option", "-qu", "-t", pane, "@pi_notice_owner"]);
}

export default function tmuxNotifyExtension(pi: ExtensionAPI) {
  const pane = process.env.TMUX ? process.env.TMUX_PANE : undefined;
  let runStartedAt: number | undefined;
  let noticeTimer: ReturnType<typeof setTimeout> | undefined;
  let activeNoticeToken: string | undefined;
  let noticeSequence = 0;
  const inputNoticeTokens = new Map<string, string>();

  function cancelNoticeTimer(): void {
    if (!noticeTimer) return;
    clearTimeout(noticeTimer);
    noticeTimer = undefined;
  }

  async function clearCurrentNotice(): Promise<void> {
    cancelNoticeTimer();
    const token = activeNoticeToken;
    activeNoticeToken = undefined;
    if (pane && token) await clearNoticeIfOwned(pi, pane, token);
  }

  function scheduleNoticeClear(token: string): void {
    cancelNoticeTimer();
    noticeTimer = setTimeout(() => {
      noticeTimer = undefined;
      void clearNoticeIfOwned(pi, pane!, token).finally(() => {
        if (activeNoticeToken === token) activeNoticeToken = undefined;
      });
    }, NOTICE_DURATION_MS);
  }

  async function showNotice(text: string, autoClear: boolean): Promise<string | undefined> {
    if (!pane) return undefined;

    cancelNoticeTimer();
    const token = `${process.pid}-${Date.now()}-${++noticeSequence}`;
    activeNoticeToken = token;
    await setNotice(pi, pane, text, token);
    if (autoClear) scheduleNoticeClear(token);
    return token;
  }

  async function markWindowForAttention(location: TmuxLocation): Promise<void> {
    if (!pane) return;

    await setDoneBadge(pi, pane, !location.windowActive);
    if (!location.windowActive) {
      const latestLocation = await getTmuxLocation(pi, pane);
      if (latestLocation?.windowActive) await setDoneBadge(pi, pane, false);
    }
  }

  pi.on("session_start", async (_event, ctx) => {
    runStartedAt = undefined;
    inputNoticeTokens.clear();
    if (!pane || ctx.mode !== "tui") return;
    await setDoneBadge(pi, pane, false);
  });

  pi.on("agent_start", async (_event, ctx) => {
    if (!pane || ctx.mode !== "tui" || runStartedAt !== undefined) return;

    runStartedAt = Date.now();
    await clearCurrentNotice();
    await setDoneBadge(pi, pane, false);
  });

  pi.on("tool_execution_start", async (event, ctx) => {
    if (!pane || ctx.mode !== "tui" || event.toolName !== "ask_user") return;

    const location = await getTmuxLocation(pi, pane);
    if (!location) return;

    await markWindowForAttention(location);
    const elapsed = runStartedAt === undefined
      ? ""
      : ` · ${formatDuration(Date.now() - runStartedAt)}`;
    const token = await showNotice(
      `input needed · w${location.windowIndex}${elapsed}`,
      false,
    );
    if (token) inputNoticeTokens.set(event.toolCallId, token);
  });

  pi.on("tool_execution_end", async (event, ctx) => {
    if (event.toolName !== "ask_user") return;

    const token = inputNoticeTokens.get(event.toolCallId);
    inputNoticeTokens.delete(event.toolCallId);
    if (!pane || ctx.mode !== "tui" || !token || activeNoticeToken !== token) return;

    cancelNoticeTimer();
    activeNoticeToken = undefined;
    await setDoneBadge(pi, pane, false);
    await clearNoticeIfOwned(pi, pane, token);
  });

  pi.on("agent_settled", async (_event, ctx) => {
    if (!pane || ctx.mode !== "tui" || !ctx.isIdle()) return;

    const startedAt = runStartedAt;
    if (startedAt === undefined) return;
    runStartedAt = undefined;

    const elapsedMs = Date.now() - startedAt;
    const location = await getTmuxLocation(pi, pane);
    if (!location) return;

    await markWindowForAttention(location);
    await showNotice(
      `agent done · w${location.windowIndex} · ${formatDuration(elapsedMs)}`,
      true,
    );
  });

  pi.on("session_shutdown", async (_event, ctx) => {
    runStartedAt = undefined;
    inputNoticeTokens.clear();
    cancelNoticeTimer();

    if (!pane || ctx.mode !== "tui") return;
    const token = activeNoticeToken;
    activeNoticeToken = undefined;

    await setDoneBadge(pi, pane, false);
    if (token) await clearNoticeIfOwned(pi, pane, token);
  });
}
