import type { AssistantMessage } from "@mariozechner/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { truncateToWidth, visibleWidth } from "@mariozechner/pi-tui";

const BAR_WIDTH = 12;
const LEGACY_STATUS_KEY = "context-usage-progress";

function sanitizeStatusText(text: string): string {
	return text
		.replace(/[\r\n\t]/g, " ")
		.replace(/ +/g, " ")
		.trim();
}

function stripAnsi(text: string): string {
	return text.replace(/\x1b\[[0-9;]*m/g, "");
}

function formatTokens(count: number): string {
	if (count < 1000) return count.toString();
	if (count < 10000) return `${(count / 1000).toFixed(1)}k`;
	if (count < 1000000) return `${Math.round(count / 1000)}k`;
	if (count < 10000000) return `${(count / 1000000).toFixed(1)}M`;
	return `${Math.round(count / 1000000)}M`;
}

function getContextUsageColor(percent: number | null): string {
	if (percent === null) return "dim";
	if (percent > 90) return "error";
	if (percent > 70) return "warning";
	return "accent";
}

function renderContextUsage(
	theme: any,
	percent: number | null,
	contextWindow: number,
): string {
	const usedWidth = percent === null ? 0 : Math.max(0, Math.min(BAR_WIDTH, Math.round((percent / 100) * BAR_WIDTH)));
	const color = getContextUsageColor(percent);
	const percentText = percent === null ? "?" : `${percent.toFixed(1)}%`;
	const usageText = `${percentText}/${formatTokens(contextWindow)}`;

	const bar = percent === null ? "░".repeat(BAR_WIDTH) : "█".repeat(usedWidth) + "░".repeat(BAR_WIDTH - usedWidth);
	return `${theme.fg(color, `[${bar}]`)} ${theme.fg(color, usageText)}`;
}

function installFooter(pi: ExtensionAPI, ctx: ExtensionContext): void {
	if (!ctx.hasUI) return;

	ctx.ui.setStatus(LEGACY_STATUS_KEY, undefined);

	ctx.ui.setFooter((tui, theme, footerData) => {
		const unsub = footerData.onBranchChange(() => tui.requestRender());

		return {
			dispose: unsub,
			invalidate() {},
			render(width: number): string[] {
				let totalInput = 0;
				let totalOutput = 0;
				let totalCacheRead = 0;
				let totalCacheWrite = 0;
				let totalCost = 0;

				for (const entry of ctx.sessionManager.getEntries()) {
					if (entry.type === "message" && entry.message.role === "assistant") {
						const message = entry.message as AssistantMessage;
						totalInput += message.usage.input;
						totalOutput += message.usage.output;
						totalCacheRead += message.usage.cacheRead;
						totalCacheWrite += message.usage.cacheWrite;
						totalCost += message.usage.cost.total;
					}
				}

				const contextUsage = ctx.getContextUsage();
				const contextWindow = contextUsage?.contextWindow ?? ctx.model?.contextWindow ?? 0;
				const contextDisplay = renderContextUsage(theme, contextUsage?.percent ?? null, contextWindow);

				let pwd = ctx.cwd;
				const home = process.env.HOME || process.env.USERPROFILE;
				if (home && pwd.startsWith(home)) {
					pwd = `~${pwd.slice(home.length)}`;
				}

				const branch = footerData.getGitBranch();
				if (branch) pwd = `${pwd} (${branch})`;

				const sessionName = ctx.sessionManager.getSessionName();
				if (sessionName) pwd = `${pwd} • ${sessionName}`;

				if (visibleWidth(pwd) > width) {
					pwd = truncateToWidth(pwd, width, "...");
				}

				const statsParts: string[] = [];
				if (totalInput) statsParts.push(`↑${formatTokens(totalInput)}`);
				if (totalOutput) statsParts.push(`↓${formatTokens(totalOutput)}`);
				if (totalCacheRead) statsParts.push(`R${formatTokens(totalCacheRead)}`);
				if (totalCacheWrite) statsParts.push(`W${formatTokens(totalCacheWrite)}`);

				const usingSubscription = ctx.model ? ctx.modelRegistry.isUsingOAuth(ctx.model) : false;
				if (totalCost || usingSubscription) {
					statsParts.push(`$${totalCost.toFixed(3)}${usingSubscription ? " (sub)" : ""}`);
				}
				statsParts.push(contextDisplay);

				let statsLeft = statsParts.join(" ");
				let statsLeftWidth = visibleWidth(statsLeft);
				if (statsLeftWidth > width) {
					const plainStatsLeft = stripAnsi(statsLeft);
					statsLeft = `${plainStatsLeft.substring(0, Math.max(1, width - 3))}...`;
					statsLeftWidth = visibleWidth(statsLeft);
				}

				const modelName = ctx.model?.id || "no-model";
				let rightSideWithoutProvider = modelName;
				if (ctx.model?.reasoning) {
					const thinkingLevel = pi.getThinkingLevel();
					rightSideWithoutProvider =
						thinkingLevel === "off" ? `${modelName} • thinking off` : `${modelName} • ${thinkingLevel}`;
				}

				let rightSide = rightSideWithoutProvider;
				if (footerData.getAvailableProviderCount() > 1 && ctx.model) {
					rightSide = `(${ctx.model.provider}) ${rightSideWithoutProvider}`;
					if (statsLeftWidth + 2 + visibleWidth(rightSide) > width) {
						rightSide = rightSideWithoutProvider;
					}
				}

				const rightSideWidth = visibleWidth(rightSide);
				const totalNeeded = statsLeftWidth + 2 + rightSideWidth;

				let statsLine: string;
				if (totalNeeded <= width) {
					const padding = " ".repeat(width - statsLeftWidth - rightSideWidth);
					statsLine = statsLeft + padding + rightSide;
				} else {
					const availableForRight = width - statsLeftWidth - 2;
					if (availableForRight > 3) {
						const plainRightSide = stripAnsi(rightSide);
						const truncatedPlain = plainRightSide.substring(0, availableForRight);
						const padding = " ".repeat(width - statsLeftWidth - truncatedPlain.length);
						statsLine = statsLeft + padding + truncatedPlain;
					} else {
						statsLine = statsLeft;
					}
				}

				const dimStatsLeft = theme.fg("dim", statsLeft);
				const remainder = statsLine.slice(statsLeft.length);
				const dimRemainder = theme.fg("dim", remainder);
				const lines = [theme.fg("dim", pwd), dimStatsLeft + dimRemainder];

				const extensionStatuses = footerData.getExtensionStatuses();
				if (extensionStatuses.size > 0) {
					const sortedStatuses = Array.from(extensionStatuses.entries())
						.sort(([a], [b]) => a.localeCompare(b))
						.map(([, text]) => sanitizeStatusText(text));
					const statusLine = sortedStatuses.join(" ");
					lines.push(truncateToWidth(statusLine, width, theme.fg("dim", "...")));
				}

				return lines;
			},
		};
	});
}

export default function (pi: ExtensionAPI) {
	pi.on("session_start", async (_event, ctx) => {
		installFooter(pi, ctx);
	});

	pi.on("session_switch", async (_event, ctx) => {
		installFooter(pi, ctx);
	});
}
