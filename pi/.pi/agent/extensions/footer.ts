import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { resolve as resolvePath } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";

const BAR_WIDTH = 12;
const FOOTER_PADDING = " ";
const FOOTER_BOTTOM_PADDING_LINES = 1;
const GIT_DIFF_REFRESH_MS = 3000;
const GIT_DIFF_TIMEOUT_MS = 1000;
const GIT_DIFF_MAX_BUFFER = 4 * 1024 * 1024;
const PR_REFRESH_MS = 60_000;
const PR_TIMEOUT_MS = 5_000;

type GitDiffStats = {
  files: number;
  added: number;
  deleted: number;
};

function execGit(cwd: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      "git",
      args,
      { cwd, timeout: GIT_DIFF_TIMEOUT_MS, maxBuffer: GIT_DIFF_MAX_BUFFER },
      (error, stdout) => {
        if (error) {
          reject(error);
          return;
        }

        resolve(String(stdout));
      },
    );
  });
}

function readGitDiff(cwd: string): Promise<string> {
  return execGit(cwd, ["diff", "--no-color", "--no-ext-diff", "--unified=0", "HEAD", "--"]);
}

function readGitUntrackedFiles(cwd: string): Promise<string> {
  return execGit(cwd, ["ls-files", "--others", "--exclude-standard", "-z"]);
}

function parseGitDiffStats(diff: string): GitDiffStats | null {
  let files = 0;
  let added = 0;
  let deleted = 0;

  for (const line of diff.split("\n")) {
    if (line.startsWith("diff --git ")) {
      files += 1;
      continue;
    }

    if (line.startsWith("+") && !line.startsWith("+++ ")) {
      added += 1;
      continue;
    }

    if (line.startsWith("-") && !line.startsWith("--- ")) {
      deleted += 1;
    }
  }

  return files > 0 ? { files, added, deleted } : null;
}

function parseGitUntrackedFiles(output: string): string[] {
  if (!output) return [];
  return output.split("\0").filter(Boolean);
}

function countBufferLines(buffer: Buffer): number {
  if (buffer.length === 0) return 0;

  let lines = 0;
  for (const byte of buffer) {
    if (byte === 0x0a) lines += 1;
  }

  return buffer[buffer.length - 1] === 0x0a ? lines : lines + 1;
}

async function countUntrackedFileLines(cwd: string, file: string): Promise<number> {
  try {
    return countBufferLines(await readFile(resolvePath(cwd, file)));
  } catch {
    return 0;
  }
}

async function loadGitDiffStats(cwd: string): Promise<GitDiffStats | null> {
  const [diff, untrackedOutput] = await Promise.all([
    readGitDiff(cwd),
    readGitUntrackedFiles(cwd),
  ]);
  const stats = parseGitDiffStats(diff) ?? { files: 0, added: 0, deleted: 0 };
  const untrackedFiles = parseGitUntrackedFiles(untrackedOutput);

  const untrackedLineCounts = await Promise.all(
    untrackedFiles.map((file) => countUntrackedFileLines(cwd, file)),
  );

  stats.files += untrackedFiles.length;
  stats.added += untrackedLineCounts.reduce((total, lines) => total + lines, 0);

  return stats.files > 0 ? stats : null;
}

async function loadPullRequestNumber(
  pi: ExtensionAPI,
  cwd: string,
  signal: AbortSignal,
): Promise<number | null> {
  try {
    // No selector: gh resolves the current branch, including its fork/upstream config.
    // Passing a numeric branch name as a selector would instead look up that PR number.
    const result = await pi.exec("gh", ["pr", "view", "--json", "number,state"], {
      cwd,
      signal,
      timeout: PR_TIMEOUT_MS,
    });
    if (result.code !== 0 || result.killed) return null;

    const pr = JSON.parse(result.stdout);
    return pr?.state === "OPEN" && Number.isSafeInteger(pr.number) && pr.number > 0
      ? pr.number
      : null;
  } catch {
    // No PR, missing gh/auth, offline, and malformed output all leave the footer usable.
    return null;
  }
}

function formatTokens(count: number): string {
  if (!Number.isFinite(count) || count <= 0) return "?";
  if (count < 1000) return Math.round(count).toString();
  if (count < 10000) return `${(count / 1000).toFixed(1)}k`;
  if (count < 1000000) return `${Math.round(count / 1000)}k`;
  if (count < 10000000) return `${(count / 1000000).toFixed(1)}M`;
  return `${Math.round(count / 1000000)}M`;
}

function contextUsageColor(percent: number | null): string {
  if (percent === null) return "dim";
  if (percent > 90) return "error";
  if (percent > 70) return "warning";
  return "accent";
}

function renderContextUsage(theme: any, ctx: ExtensionContext): string {
  const usage = ctx.getContextUsage();
  const percent = usage?.percent ?? null;
  const contextWindow = usage?.contextWindow ?? ctx.model?.contextWindow ?? 0;
  const usedWidth = percent === null
    ? 0
    : Math.max(0, Math.min(BAR_WIDTH, Math.round((percent / 100) * BAR_WIDTH)));

  const color = contextUsageColor(percent);
  const bar = percent === null
    ? "░".repeat(BAR_WIDTH)
    : "█".repeat(usedWidth) + "░".repeat(BAR_WIDTH - usedWidth);
  const percentText = percent === null ? "?" : `${percent.toFixed(1)}%`;
  const windowText = contextWindow > 0 ? `/${formatTokens(contextWindow)}` : "";

  return `${theme.fg(color, `[${bar}]`)} ${theme.fg(color, `${percentText}${windowText}`)}`;
}

function renderGitDiffStats(theme: any, stats: GitDiffStats | null, compact: boolean): string | null {
  if (!stats || stats.files <= 0) return null;

  const fileText = compact
    ? `Δ${stats.files}`
    : `${stats.files} file${stats.files === 1 ? "" : "s"} changed`;
  const parts = [theme.fg("dim", fileText)];

  if (stats.added > 0) parts.push(theme.fg("success", `+${stats.added}`));
  if (stats.deleted > 0) parts.push(theme.fg("error", `-${stats.deleted}`));

  return parts.join(" ");
}

function formatCwd(ctx: ExtensionContext): string {
  let cwd = ctx.cwd;
  const home = process.env.HOME || process.env.USERPROFILE;

  if (home && cwd.startsWith(home)) {
    cwd = `~${cwd.slice(home.length)}`;
  }

  return cwd;
}

function truncateCwdWithBranch(cwd: string, branchSuffix: string, width: number): string | null {
  const branchWidth = visibleWidth(branchSuffix);
  const cwdWidth = width - branchWidth;

  if (branchSuffix && cwdWidth < 4) return null;
  return `${truncateToWidth(cwd, cwdWidth, "...")}${branchSuffix}`;
}

function paddedCwdLine(
  theme: any,
  ctx: ExtensionContext,
  branch: string | null,
  prNumber: number | null,
  stats: GitDiffStats | null,
  width: number,
): string {
  const innerWidth = footerContentWidth(width);
  const cwd = formatCwd(ctx);
  const prSuffix = prNumber === null ? "" : ` #${prNumber}`;
  const branchSuffix = branch ? ` (${branch}${prSuffix})` : "";

  for (const compact of [false, true]) {
    const statsText = renderGitDiffStats(theme, stats, compact);
    if (!statsText) break;

    const availableCwdWidth = innerWidth - visibleWidth(statsText) - 1;
    if (availableCwdWidth < 8) continue;

    const cwdText = truncateCwdWithBranch(cwd, branchSuffix, availableCwdWidth);
    if (!cwdText) continue;

    return `${FOOTER_PADDING}${theme.fg("dim", cwdText)} ${statsText}`;
  }

  const cwdText = truncateCwdWithBranch(cwd, branchSuffix, innerWidth) ?? `${cwd}${branchSuffix}`;
  return paddedLine(theme.fg("dim", cwdText), width);
}

function renderModel(pi: ExtensionAPI, ctx: ExtensionContext, fastModeEnabled: boolean): string {
  const parts = [ctx.model?.id ?? "no-model"];

  if (ctx.model?.reasoning) {
    const thinkingLevel = pi.getThinkingLevel();
    parts.push(thinkingLevel === "off" ? "thinking off" : thinkingLevel);
  }
  if (fastModeEnabled) parts.push("fast");

  return parts.join(" • ");
}

function footerContentWidth(width: number): number {
  return Math.max(1, width - FOOTER_PADDING.length * 2);
}

function paddedLine(text: string, width: number): string {
  return `${FOOTER_PADDING}${truncateToWidth(text, footerContentWidth(width), "...")}`;
}

function paddedLeftRight(left: string, right: string, width: number): string {
  const innerWidth = footerContentWidth(width);
  const rightWidth = visibleWidth(right);
  const availableLeftWidth = innerWidth - rightWidth - 1;

  if (availableLeftWidth < 8) {
    return paddedLine(left, width);
  }

  const fittedLeft = truncateToWidth(left, availableLeftWidth, "...");
  const gap = Math.max(1, innerWidth - visibleWidth(fittedLeft) - rightWidth);
  return `${FOOTER_PADDING}${fittedLeft}${" ".repeat(gap)}${right}`;
}

function installFooter(pi: ExtensionAPI, ctx: ExtensionContext): void {
  if (ctx.mode !== "tui") return;

  ctx.ui.setFooter((tui, theme, footerData) => {
    let diffStats: GitDiffStats | null = null;
    let refreshInFlight = false;
    let disposed = false;
    let prNumber: number | null = null;
    let prBranch: string | null = null;
    let prLastRefresh = -Infinity;
    let prController: AbortController | undefined;

    const refreshPullRequest = async () => {
      if (disposed) return;

      const branch = footerData.getGitBranch();
      if (branch !== prBranch) {
        prController?.abort();
        prController = undefined;
        prBranch = branch;
        prLastRefresh = -Infinity;
        prNumber = null;
        tui.requestRender();
      }

      if (!branch || branch === "detached" || prController) return;
      if (Date.now() - prLastRefresh < PR_REFRESH_MS) return;

      const controller = new AbortController();
      prController = controller;
      prLastRefresh = Date.now();
      const nextNumber = await loadPullRequestNumber(pi, ctx.cwd, controller.signal);

      // A branch switch (even A -> B -> A) or disposal invalidates this request.
      if (prController !== controller) return;
      prController = undefined;
      if (disposed || branch !== footerData.getGitBranch()) return;

      if (prNumber !== nextNumber) {
        prNumber = nextNumber;
        tui.requestRender();
      }
    };

    const refreshDiffStats = async () => {
      if (disposed || refreshInFlight) return;

      if (!footerData.getGitBranch()) {
        if (diffStats !== null) {
          diffStats = null;
          tui.requestRender();
        }
        return;
      }

      refreshInFlight = true;
      try {
        diffStats = await loadGitDiffStats(ctx.cwd);
      } catch {
        diffStats = null;
      } finally {
        refreshInFlight = false;
      }

      if (!disposed) tui.requestRender();
    };

    const refresh = () => {
      void refreshDiffStats();
      void refreshPullRequest();
    };
    const interval = setInterval(refresh, GIT_DIFF_REFRESH_MS);
    const unsubscribeBranch = footerData.onBranchChange(() => {
      refresh();
      tui.requestRender();
    });
    refresh();

    return {
      dispose() {
        disposed = true;
        clearInterval(interval);
        prController?.abort();
        unsubscribeBranch();
      },
      invalidate() {},
      render(width: number): string[] {
        const lines: string[] = [];
        const sessionName = ctx.sessionManager.getSessionName();
        if (sessionName) {
          lines.push(paddedLine(theme.fg("dim", `Session: ${sessionName}`), width));
        }

        const branch = footerData.getGitBranch();
        const contextLine = renderContextUsage(theme, ctx);
        const fastModeEnabled = footerData.getExtensionStatuses?.().has("fast") ?? false;
        const modelLine = theme.fg("dim", renderModel(pi, ctx, fastModeEnabled));

        lines.push(paddedCwdLine(theme, ctx, branch, branch === prBranch ? prNumber : null, diffStats, width));
        lines.push(paddedLeftRight(contextLine, modelLine, width));
        const goalStatus = footerData.getExtensionStatuses().get("goal");
        if (goalStatus) lines.push(paddedLine(theme.fg("dim", goalStatus), width));
        lines.push(...Array.from({ length: FOOTER_BOTTOM_PADDING_LINES }, () => ""));

        return lines;
      },
    };
  });
}

export default function (pi: ExtensionAPI) {
  pi.on("session_start", async (_event, ctx) => {
    installFooter(pi, ctx);
  });

  pi.on("session_shutdown", async (_event, ctx) => {
    if (ctx.mode !== "tui") return;
    ctx.ui.setFooter(undefined);
  });
}
