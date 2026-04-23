import type { ExtensionAPI, ExtensionContext, Theme } from "@mariozechner/pi-coding-agent";
import { truncateToWidth } from "@mariozechner/pi-tui";

const LOGO_ROWS = ["1110", "1010", "1101", "1001"];
const PIXEL_WIDTH = 5;
const PIXEL_HEIGHT = 2;
const LEFT_PAD = "  ";

function getPiLogoLines(theme: Theme): string[] {
	const fill = "█".repeat(PIXEL_WIDTH);
	const empty = " ".repeat(PIXEL_WIDTH);
	const lines = [""];

	for (const row of LOGO_ROWS) {
		const rawLine = row.split("").map((cell) => (cell === "1" ? fill : empty)).join("");
		for (let i = 0; i < PIXEL_HEIGHT; i += 1) lines.push(`${LEFT_PAD}${theme.fg("text", rawLine)}`);
	}

	lines.push("");
	return lines;
}

export default function (pi: ExtensionAPI) {
	let brandVisible = false;
	let reapplyTimer: ReturnType<typeof setTimeout> | null = null;

	function clearReapplyTimer(): void {
		if (!reapplyTimer) return;
		clearTimeout(reapplyTimer);
		reapplyTimer = null;
	}

	function applyBrandHeader(ctx: ExtensionContext): void {
		ctx.ui.setHeader((_tui, theme) => ({
			invalidate() {},
			render(width: number): string[] {
				return getPiLogoLines(theme).map((line) => truncateToWidth(line, width));
			},
		}));
	}

	pi.on("session_start", async (event, ctx) => {
		if (!ctx.hasUI) return;
		if (event.reason !== "startup" && event.reason !== "reload") return;

		brandVisible = true;
		clearReapplyTimer();
		applyBrandHeader(ctx);

		if (event.reason === "reload") {
			reapplyTimer = setTimeout(() => {
				if (!brandVisible) return;
				applyBrandHeader(ctx);
				reapplyTimer = null;
			}, 80);
		}
	});

	pi.on("before_agent_start", async (_event, ctx) => {
		if (!ctx.hasUI || !brandVisible) return;
		brandVisible = false;
		clearReapplyTimer();
		ctx.ui.setHeader(undefined);
	});

	pi.on("session_shutdown", async () => {
		brandVisible = false;
		clearReapplyTimer();
	});
}
