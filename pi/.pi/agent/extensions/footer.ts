import { execFile } from "node:child_process";
import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { truncateToWidth, visibleWidth } from "@mariozechner/pi-tui";

const BAR_WIDTH = 12;
const FOOTER_PADDING = " ";
const FOOTER_BOTTOM_PADDING_LINES = 1;
const GIT_DIFF_REFRESH_MS = 3000;
const GIT_DIFF_TIMEOUT_MS = 1000;
const GIT_DIFF_MAX_BUFFER = 4 * 1024 * 1024;

type GitDiffStats = {
  files: number;
  added: number;
  modified: number;
  deleted: number;
};

function readGitDiff(cwd: string): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      "git",
      ["diff", "--no-color", "--no-ext-diff", "--unified=0", "HEAD", "--"],
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

function parseGitDiffStats(diff: string): GitDiffStats | null {
  let files = 0;
  let added = 0;
  let modified = 0;
  let deleted = 0;
  let addRun = 0;
  let deleteRun = 0;

  const flushRun = () => {
    if (addRun === 0 && deleteRun === 0) return;

    const paired = Math.min(addRun, deleteRun);
    modified += paired;
    added += addRun - paired;
    deleted += deleteRun - paired;
    addRun = 0;
    deleteRun = 0;
  };

  for (const line of diff.split("\n")) {
    if (line.startsWith("diff --git ")) {
      flushRun();
      files += 1;
      continue;
    }

    if (line.startsWith("\\")) continue;

    if (line.startsWith("+")) {
      if (line.startsWith("+++ ")) {
        flushRun();
      } else {
        addRun += 1;
      }
      continue;
    }

    if (line.startsWith("-")) {
      if (line.startsWith("--- ")) {
        flushRun();
      } else {
        deleteRun += 1;
      }
      continue;
    }

    flushRun();
  }

  flushRun();

  return files > 0 ? { files, added, modified, deleted } : null;
}

async function loadGitDiffStats(cwd: string): Promise<GitDiffStats | null> {
  return parseGitDiffStats(await readGitDiff(cwd));
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
  if (stats.modified > 0) parts.push(theme.fg("warning", `~${stats.modified}`));
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
  stats: GitDiffStats | null,
  width: number,
): string {
  const innerWidth = footerContentWidth(width);
  const cwd = formatCwd(ctx);
  const branchSuffix = branch ? ` (${branch})` : "";
  const plainCwd = `${cwd}${branchSuffix}`;

  for (const compact of [false, true]) {
    const statsText = renderGitDiffStats(theme, stats, compact);
    if (!statsText) break;

    const availableCwdWidth = innerWidth - visibleWidth(statsText) - 1;
    if (availableCwdWidth < 8) continue;

    const cwdText = truncateCwdWithBranch(cwd, branchSuffix, availableCwdWidth);
    if (!cwdText) continue;

    return `${FOOTER_PADDING}${theme.fg("dim", cwdText)} ${statsText}`;
  }

  return paddedLine(theme.fg("dim", plainCwd), width);
}

function renderModel(pi: ExtensionAPI, ctx: ExtensionContext): string {
  const modelName = ctx.model?.id ?? "no-model";
  if (!ctx.model?.reasoning) return modelName;

  const thinkingLevel = pi.getThinkingLevel();
  return thinkingLevel === "off" ? `${modelName} • thinking off` : `${modelName} • ${thinkingLevel}`;
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
  if (!ctx.hasUI) return;

  ctx.ui.setFooter((tui, theme, footerData) => {
    let diffStats: GitDiffStats | null = null;
    let refreshInFlight = false;
    let disposed = false;

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

    const interval = setInterval(() => void refreshDiffStats(), GIT_DIFF_REFRESH_MS);
    const unsubscribeBranch = footerData.onBranchChange(() => {
      void refreshDiffStats();
      tui.requestRender();
    });
    void refreshDiffStats();

    return {
      dispose() {
        disposed = true;
        clearInterval(interval);
        unsubscribeBranch();
      },
      invalidate() {},
      render(width: number): string[] {
        const lines: string[] = [];
        const sessionName = ctx.sessionManager.getSessionName();

        if (sessionName) {
          lines.push(theme.fg("dim", paddedLine(`Session: ${sessionName}`, width)));
        }

        const branch = footerData.getGitBranch();
        const contextLine = renderContextUsage(theme, ctx);
        const modelLine = theme.fg("dim", renderModel(pi, ctx));

        lines.push(paddedCwdLine(theme, ctx, branch, diffStats, width));
        lines.push(paddedLeftRight(contextLine, modelLine, width));
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
    if (!ctx.hasUI) return;
    ctx.ui.setFooter(undefined);
  });
}
