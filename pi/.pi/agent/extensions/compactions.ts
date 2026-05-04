import { compact, type ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { resolveSmallModel } from "./shared/model-slots.js";

export default function compactionsExtension(pi: ExtensionAPI) {
  pi.on("session_before_compact", async (event, ctx) => {
    const { preparation, customInstructions, signal } = event;

    let resolved;
    try {
      resolved = await resolveSmallModel(ctx);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (!signal.aborted) {
        ctx.ui.notify(`Small-model compaction unavailable; using default compaction. ${message}`, "warning");
      }
      return undefined;
    }

    const modelLabel = resolved.reference;
    if (!signal.aborted) {
      ctx.ui.notify(
        `Compacting ${preparation.messagesToSummarize.length} messages (${preparation.tokensBefore.toLocaleString()} tokens) with small model ${modelLabel}...`,
        "info",
      );
    }

    try {
      const result = await compact(
        preparation,
        resolved.model,
        resolved.auth.apiKey ?? "",
        resolved.auth.headers,
        customInstructions,
        signal,
      );

      if (!signal.aborted) ctx.ui.notify(`Compaction complete (${modelLabel})`, "info");
      return {
        compaction: {
          ...result,
          details: {
            ...(result as any).details,
            modelSlot: "small",
            model: modelLabel,
          },
        },
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (!signal.aborted) {
        ctx.ui.notify(`Small-model compaction failed; using default compaction. ${message}`, "warning");
      }
      return undefined;
    }
  });
}
