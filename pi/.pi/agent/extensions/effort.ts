import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";

const LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh"] as const;
type ThinkingLevel = (typeof LEVELS)[number];

const SHORTCUTS = {
	off: "off",
	mid: "medium",
	max: "xhigh",
} as const satisfies Record<string, ThinkingLevel>;

type EffortShortcut = keyof typeof SHORTCUTS;

function isThinkingLevel(value: string): value is ThinkingLevel {
	return (LEVELS as readonly string[]).includes(value);
}

function isEffortShortcut(value: string): value is EffortShortcut {
	return value in SHORTCUTS;
}

function notify(
	hasUI: boolean,
	ui: { notify(message: string, level?: "info" | "warning" | "error"): void },
	message: string,
	level: "info" | "warning" | "error" = "info",
) {
	if (hasUI) ui.notify(message, level);
	else console.log(message);
}

export default function (pi: ExtensionAPI) {
	pi.registerCommand("effort", {
		description: "Choose thinking level or set off/mid/max",
		getArgumentCompletions: (prefix) => {
			const normalized = prefix.toLowerCase();
			const items = Object.keys(SHORTCUTS)
				.filter((value) => value.startsWith(normalized))
				.map((value) => ({ value, label: value }));
			return items.length > 0 ? items : null;
		},
		handler: async (args, ctx) => {
			const raw = (args ?? "").trim().toLowerCase();
			const current = pi.getThinkingLevel();

			if (!raw) {
				if (!ctx.hasUI) {
					notify(
						ctx.hasUI,
						ctx.ui,
						`Current thinking level: ${current}. Use /effort off, /effort mid, or /effort max.`,
					);
					return;
				}

				const selection = await ctx.ui.select(
					`Select thinking level (current: ${current})`,
					LEVELS.map((level) => (level === current ? `${level} (current)` : level)),
				);

				if (!selection) return;

				const requested = selection.replace(" (current)", "");
				if (!isThinkingLevel(requested)) return;

				pi.setThinkingLevel(requested);
				const applied = pi.getThinkingLevel();
				notify(
					ctx.hasUI,
					ctx.ui,
					applied === requested
						? `Thinking level set to ${applied}`
						: `Requested ${requested}, applied ${applied} (clamped by model capability)`,
					applied === requested ? "info" : "warning",
				);
				return;
			}

			if (!isEffortShortcut(raw)) {
				notify(
					ctx.hasUI,
					ctx.ui,
					"Usage: /effort | /effort off | /effort mid | /effort max",
					"error",
				);
				return;
			}

			const requested = SHORTCUTS[raw];
			pi.setThinkingLevel(requested);
			const applied = pi.getThinkingLevel();

			notify(
				ctx.hasUI,
				ctx.ui,
				applied === requested
					? `Thinking level set to ${applied} (${raw})`
					: `Requested ${raw} → ${requested}, applied ${applied} (clamped by model capability)`,
				applied === requested ? "info" : "warning",
			);
		},
	});
}
