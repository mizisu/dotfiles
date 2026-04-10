import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { compact } from "@mariozechner/pi-coding-agent";
import { resolveMediumModel } from "./shared/model-slots.js";

export default function (pi: ExtensionAPI) {
	pi.on("session_before_compact", async (event, ctx) => {
		const { preparation, customInstructions, signal } = event;

		const resolved = await resolveMediumModel(ctx);
		if (resolved.fallbackReason) ctx.ui.notify(resolved.fallbackReason, "warning");
		if (!resolved.model || !resolved.auth) {
			ctx.ui.notify(`${resolved.error ?? "No model selected"}, falling back to default compaction`, "warning");
			return;
		}

		const { model, auth } = resolved;
		const modelLabel = `${model.provider}/${model.id}`;

		ctx.ui.notify(
			`Compacting ${preparation.messagesToSummarize.length} messages (${preparation.tokensBefore.toLocaleString()} tokens) with ${modelLabel}...`,
			"info",
		);

		try {
			const result = await compact(preparation, model, auth.apiKey ?? "", auth.headers, customInstructions, signal);

			ctx.ui.notify(`Compaction complete (${modelLabel})`, "info");

			return { compaction: result };
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			if (!signal.aborted) ctx.ui.notify(`Compaction failed: ${message}`, "error");
			return;
		}
	});
}
