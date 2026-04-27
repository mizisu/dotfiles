import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { truncateToWidth, visibleWidth } from "@mariozechner/pi-tui";

const BAR_WIDTH = 12;
const FOOTER_PADDING = " ";

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

function renderCwd(ctx: ExtensionContext, branch: string | null): string {
  let cwd = ctx.cwd;
  const home = process.env.HOME || process.env.USERPROFILE;

  if (home && cwd.startsWith(home)) {
    cwd = `~${cwd.slice(home.length)}`;
  }

  return branch ? `${cwd} (${branch})` : cwd;
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
    const unsubscribeBranch = footerData.onBranchChange(() => tui.requestRender());

    return {
      dispose: unsubscribeBranch,
      invalidate() {},
      render(width: number): string[] {
        const lines: string[] = [];
        const sessionName = ctx.sessionManager.getSessionName();

        if (sessionName) {
          lines.push(theme.fg("dim", paddedLine(`Session: ${sessionName}`, width)));
        }

        const cwdLine = renderCwd(ctx, footerData.getGitBranch());
        const contextLine = renderContextUsage(theme, ctx);
        const modelLine = theme.fg("dim", renderModel(pi, ctx));

        lines.push(theme.fg("dim", paddedLine(cwdLine, width)));
        lines.push(paddedLeftRight(contextLine, modelLine, width));

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
