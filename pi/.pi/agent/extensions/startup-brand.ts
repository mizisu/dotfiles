import type { ExtensionAPI, ExtensionContext, Theme } from "@mariozechner/pi-coding-agent";
import { truncateToWidth } from "@mariozechner/pi-tui";

function getPiLogoLines(theme: Theme): string[] {
	const pad = "  ";
	const fill = (count: number) => theme.fg("text", "█".repeat(count));
	return [
		"",
		`${pad}${fill(8)}`,
		`${pad}${fill(3)}   ${fill(3)}`,
		`${pad}${fill(3)}   ${fill(3)}`,
		`${pad}${fill(6)}   ${fill(3)}`,
		`${pad}${fill(3)}     ${fill(3)}`,
		`${pad}${fill(3)}     ${fill(3)}`,
		"",
	];
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
