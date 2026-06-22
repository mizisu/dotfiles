import { compact, type ExtensionAPI } from "@mariozechner/pi-coding-agent";

export default function compactionsExtension(pi: ExtensionAPI) {
  pi.on("session_before_compact", async (event, ctx) => {
    const { preparation, customInstructions, signal } = event;
    const model = ctx.model;

    if (!model) {
      if (!signal.aborted) {
        ctx.ui.notify("Current-model compaction unavailable; using default compaction. No current model selected.", "warning");
      }
      return undefined;
    }

    const modelLabel = `${model.provider}/${model.id}`;
    let auth;
    try {
      auth = await ctx.modelRegistry.getApiKeyAndHeaders(model);
      if (!auth.ok) throw new Error(auth.error);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (!signal.aborted) {
        ctx.ui.notify(`Current-model compaction unavailable; using default compaction. ${message}`, "warning");
      }
      return undefined;
    }

    const thinkingLevel = pi.getThinkingLevel();
    if (!signal.aborted) {
      ctx.ui.notify(
        `Compacting ${preparation.messagesToSummarize.length} messages (${preparation.tokensBefore.toLocaleString()} tokens) with current model ${modelLabel}...`,
        "info",
      );
    }

    try {
      const result = await compact(
        preparation,
        model,
        auth.apiKey,
        auth.headers,
        customInstructions,
        signal,
        thinkingLevel,
        undefined,
        auth.env,
      );

      if (!signal.aborted) ctx.ui.notify(`Compaction complete (${modelLabel})`, "info");
      return {
        compaction: {
          ...result,
          details: {
            ...(result as any).details,
            modelSlot: "current",
            model: modelLabel,
            thinkingLevel,
          },
        },
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (!signal.aborted) {
        ctx.ui.notify(`Current-model compaction failed; using default compaction. ${message}`, "warning");
      }
      return undefined;
    }
  });
}
