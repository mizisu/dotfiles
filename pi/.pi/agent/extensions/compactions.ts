import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { compact } from "@mariozechner/pi-coding-agent";

export default function (pi: ExtensionAPI) {
	pi.on("session_before_compact", async (event, ctx) => {
		const { preparation, customInstructions, signal } = event;

		const model = ctx.modelRegistry.find("openai-codex", "gpt-5.3-codex-spark");
		if (!model) {
			ctx.ui.notify("OpenAI Codex model not found, falling back to default compaction", "warning");
			return;
		}

		const apiKey = await ctx.modelRegistry.getApiKey(model);
		if (!apiKey) {
			ctx.ui.notify("No API key for OpenAI Codex, falling back to default compaction", "warning");
			return;
		}

		ctx.ui.notify(
			`Compacting ${preparation.messagesToSummarize.length} messages (${preparation.tokensBefore.toLocaleString()} tokens) with openai-codex/gpt-5.3-codex-spark...`,
			"info",
		);

		try {
			const result = await compact(preparation, model, apiKey, customInstructions, signal);

			ctx.ui.notify("Compaction complete (openai-codex/gpt-5.3-codex-spark)", "info");

			return { compaction: result };
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			if (!signal.aborted) ctx.ui.notify(`Compaction failed: ${message}`, "error");
			return;
		}
	});
}
