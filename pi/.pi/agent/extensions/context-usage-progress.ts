import type { AssistantMessage } from "@mariozechner/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { truncateToWidth, visibleWidth } from "@mariozechner/pi-tui";

const BAR_WIDTH = 12;
const LEGACY_STATUS_KEY = "context-usage-progress";
const CONTEXT_BUCKETS = ["system", "user", "assistant", "tools", "bash", "summary", "custom"] as const;

type ContextEntry = ReturnType<ExtensionContext["sessionManager"]["getBranch"]>[number];
type ContentBlock = {
	type: string;
	text?: string;
	thinking?: string;
	name?: string;
	arguments?: unknown;
};
type ContextMessage =
	| AssistantMessage
	| { role: "user"; content: string | ContentBlock[] }
	| { role: "toolResult"; content: string | ContentBlock[] }
	| { role: "custom"; content: string | ContentBlock[] }
	| { role: "bashExecution"; command: string; output: string; excludeFromContext?: boolean }
	| { role: "branchSummary" | "compactionSummary"; summary: string };
type ContextBucket = (typeof CONTEXT_BUCKETS)[number];
type ContextBreakdown = Record<ContextBucket, number>;
type ContextBreakdownResult = {
	breakdown: ContextBreakdown;
	total: number;
};

const CONTEXT_BUCKET_META: Record<ContextBucket, { label: string; color: string }> = {
	system: { label: "sys", color: "muted" },
	user: { label: "user", color: "text" },
	assistant: { label: "asst", color: "accent" },
	tools: { label: "tool", color: "warning" },
	bash: { label: "bash", color: "bashMode" },
	summary: { label: "sum", color: "dim" },
	custom: { label: "ext", color: "success" },
};

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

function createEmptyBreakdown(): ContextBreakdown {
	return {
		system: 0,
		user: 0,
		assistant: 0,
		tools: 0,
		bash: 0,
		summary: 0,
		custom: 0,
	};
}

function addBreakdown(target: ContextBreakdown, source: ContextBreakdown): void {
	for (const bucket of CONTEXT_BUCKETS) {
		target[bucket] += source[bucket];
	}
}

function scaleBreakdown(breakdown: ContextBreakdown, factor: number): ContextBreakdown {
	const scaled = createEmptyBreakdown();
	for (const bucket of CONTEXT_BUCKETS) {
		scaled[bucket] = breakdown[bucket] * factor;
	}
	return scaled;
}

function sumBreakdown(breakdown: ContextBreakdown): number {
	let total = 0;
	for (const bucket of CONTEXT_BUCKETS) {
		total += breakdown[bucket];
	}
	return total;
}

function estimateCharsAsTokens(chars: number): number {
	return Math.ceil(chars / 4);
}

function estimateContentTokens(content: string | ContentBlock[], includeImages: boolean): number {
	let chars = 0;

	if (typeof content === "string") {
		chars = content.length;
	} else {
		for (const block of content) {
			if (block.type === "text" && typeof block.text === "string") {
				chars += block.text.length;
			}
			if (includeImages && block.type === "image") {
				chars += 4800;
			}
		}
	}

	return estimateCharsAsTokens(chars);
}

function estimateAssistantTokens(message: AssistantMessage): number {
	let chars = 0;

	for (const block of message.content) {
		if (block.type === "text") {
			chars += block.text.length;
		} else if (block.type === "thinking") {
			chars += block.thinking.length;
		} else if (block.type === "toolCall") {
			chars += block.name.length + JSON.stringify(block.arguments).length;
		}
	}

	return estimateCharsAsTokens(chars);
}

function calculateUsageTokens(message: AssistantMessage): number {
	return (
		message.usage.totalTokens ||
		message.usage.input + message.usage.output + message.usage.cacheRead + message.usage.cacheWrite
	);
}

function isUsableAssistantMessage(message: ContextMessage): message is AssistantMessage {
	if (message.role !== "assistant") return false;
	return message.stopReason !== "aborted" && message.stopReason !== "error";
}

function buildContextMessages(ctx: ExtensionContext): ContextMessage[] {
	const branch = ctx.sessionManager.getBranch();
	const messages: ContextMessage[] = [];
	let latestCompaction: Extract<ContextEntry, { type: "compaction" }> | null = null;

	for (const entry of branch) {
		if (entry.type === "compaction") {
			latestCompaction = entry;
		}
	}

	const appendEntry = (entry: ContextEntry) => {
		if (entry.type === "message") {
			const message = entry.message as ContextMessage;
			if (message.role === "bashExecution" && message.excludeFromContext) return;
			messages.push(message);
			return;
		}

		if (entry.type === "custom_message") {
			messages.push({ role: "custom", content: entry.content });
			return;
		}

		if (entry.type === "branch_summary" && entry.summary) {
			messages.push({ role: "branchSummary", summary: entry.summary });
		}
	};

	if (!latestCompaction) {
		for (const entry of branch) {
			appendEntry(entry);
		}
		return messages;
	}

	messages.push({ role: "compactionSummary", summary: latestCompaction.summary });

	const compactionIndex = branch.findIndex((entry) => entry.type === "compaction" && entry.id === latestCompaction.id);
	let foundFirstKept = false;
	for (let i = 0; i < compactionIndex; i++) {
		const entry = branch[i];
		if (entry.id === latestCompaction.firstKeptEntryId) {
			foundFirstKept = true;
		}
		if (foundFirstKept) {
			appendEntry(entry);
		}
	}

	for (let i = compactionIndex + 1; i < branch.length; i++) {
		appendEntry(branch[i]);
	}

	return messages;
}

function estimateMessageBreakdown(message: ContextMessage): ContextBreakdown {
	const breakdown = createEmptyBreakdown();

	switch (message.role) {
		case "user":
			breakdown.user += estimateContentTokens(message.content, false);
			break;
		case "assistant":
			breakdown.assistant += estimateAssistantTokens(message);
			break;
		case "toolResult":
			breakdown.tools += estimateContentTokens(message.content, true);
			break;
		case "custom":
			breakdown.custom += estimateContentTokens(message.content, true);
			break;
		case "bashExecution":
			if (!message.excludeFromContext) {
				breakdown.bash += estimateCharsAsTokens(message.command.length + message.output.length);
			}
			break;
		case "branchSummary":
		case "compactionSummary":
			breakdown.summary += estimateCharsAsTokens(message.summary.length);
			break;
	}

	return breakdown;
}

function calculateContextBreakdown(
	ctx: ExtensionContext,
	contextTokens: number | null,
): ContextBreakdownResult | null {
	const messages = buildContextMessages(ctx);
	const baseBreakdown = createEmptyBreakdown();
	baseBreakdown.system = estimateCharsAsTokens(ctx.getSystemPrompt().length);

	let lastAssistantIndex = -1;
	let lastAssistantTokens = 0;

	for (let i = messages.length - 1; i >= 0; i--) {
		const message = messages[i];
		if (isUsableAssistantMessage(message)) {
			lastAssistantIndex = i;
			lastAssistantTokens = calculateUsageTokens(message);
			break;
		}
	}

	if (contextTokens === null || lastAssistantIndex === -1 || lastAssistantTokens <= 0) {
		for (const message of messages) {
			addBreakdown(baseBreakdown, estimateMessageBreakdown(message));
		}
		const total = sumBreakdown(baseBreakdown);
		return total > 0 ? { breakdown: baseBreakdown, total } : null;
	}

	const prefixBreakdown = createEmptyBreakdown();
	prefixBreakdown.system = baseBreakdown.system;
	const trailingBreakdown = createEmptyBreakdown();

	for (let i = 0; i < messages.length; i++) {
		const bucketBreakdown = estimateMessageBreakdown(messages[i]);
		if (i <= lastAssistantIndex) {
			addBreakdown(prefixBreakdown, bucketBreakdown);
		} else {
			addBreakdown(trailingBreakdown, bucketBreakdown);
		}
	}

	const prefixEstimatedTotal = sumBreakdown(prefixBreakdown);
	const scaledPrefix =
		prefixEstimatedTotal > 0 ? scaleBreakdown(prefixBreakdown, lastAssistantTokens / prefixEstimatedTotal) : prefixBreakdown;
	const combinedBreakdown = createEmptyBreakdown();
	addBreakdown(combinedBreakdown, scaledPrefix);
	addBreakdown(combinedBreakdown, trailingBreakdown);

	return {
		breakdown: combinedBreakdown,
		total: contextTokens,
	};
}

function getContextUsageColor(percent: number | null): string {
	if (percent === null) return "dim";
	if (percent > 90) return "error";
	if (percent > 70) return "warning";
	return "accent";
}

function allocateBarSegments(result: ContextBreakdownResult, usedWidth: number): Record<ContextBucket, number> {
	const widths = createEmptyBreakdown();
	if (usedWidth <= 0 || result.total <= 0) return widths;

	const rawWidths = CONTEXT_BUCKETS.map((bucket) => ({
		bucket,
		raw: (result.breakdown[bucket] / result.total) * usedWidth,
	}));

	let assigned = 0;
	for (const item of rawWidths) {
		const whole = Math.floor(item.raw);
		widths[item.bucket] = whole;
		assigned += whole;
	}

	const remaining = usedWidth - assigned;
	if (remaining > 0) {
		const remainders = rawWidths
			.filter((item) => result.breakdown[item.bucket] > 0)
			.sort((a, b) => {
				const remainderDiff = b.raw - Math.floor(b.raw) - (a.raw - Math.floor(a.raw));
				if (remainderDiff !== 0) return remainderDiff;
				return result.breakdown[b.bucket] - result.breakdown[a.bucket];
			});

		for (let i = 0; i < remaining && i < remainders.length; i++) {
			widths[remainders[i].bucket] += 1;
		}
	}

	return widths;
}

function renderContextUsage(
	theme: any,
	percent: number | null,
	contextWindow: number,
	breakdown: ContextBreakdownResult | null,
): string {
	const usedWidth = percent === null ? 0 : Math.max(0, Math.min(BAR_WIDTH, Math.round((percent / 100) * BAR_WIDTH)));
	const color = getContextUsageColor(percent);
	const percentText = percent === null ? "?" : `${percent.toFixed(1)}%`;
	const usageText = `${percentText}/${formatTokens(contextWindow)}`;

	if (!breakdown || percent === null) {
		const bar = percent === null ? "░".repeat(BAR_WIDTH) : "█".repeat(usedWidth) + "░".repeat(BAR_WIDTH - usedWidth);
		return `${theme.fg(color, `[${bar}]`)} ${theme.fg(color, usageText)}`;
	}

	const segments = allocateBarSegments(breakdown, usedWidth);
	const usedBar = CONTEXT_BUCKETS.map((bucket) => {
		const width = segments[bucket];
		if (width <= 0) return "";
		return theme.fg(CONTEXT_BUCKET_META[bucket].color, "█".repeat(width));
	}).join("");
	const emptyBar = theme.fg("dim", "░".repeat(BAR_WIDTH - usedWidth));
	const bar = `${theme.fg("dim", "[")}${usedBar}${emptyBar}${theme.fg("dim", "]")}`;

	return `${bar} ${theme.fg(color, usageText)}`;
}

function renderContextLegend(theme: any, result: ContextBreakdownResult | null): string | null {
	if (!result || result.total <= 0) return null;

	const parts = CONTEXT_BUCKETS.map((bucket) => {
		if (result.breakdown[bucket] <= 0) return null;
		const meta = CONTEXT_BUCKET_META[bucket];
		return `${theme.fg(meta.color, "█")} ${theme.fg("dim", meta.label)}`;
	}).filter((part): part is string => part !== null);

	if (parts.length === 0) return null;
	return `${theme.fg("dim", "legend ")}${parts.join("  ")}`;
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
				const contextBreakdown = calculateContextBreakdown(ctx, contextUsage?.tokens ?? null);
				const contextDisplay = renderContextUsage(theme, contextUsage?.percent ?? null, contextWindow, contextBreakdown);
				const contextLegend = renderContextLegend(theme, contextBreakdown);

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

				if (contextLegend) {
					lines.push(truncateToWidth(contextLegend, width, theme.fg("dim", "...")));
				}

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
