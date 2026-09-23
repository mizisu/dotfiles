import { compact, type ExtensionAPI } from "@earendil-works/pi-coding-agent";

const COMPACTION_PROVIDER = "openai-codex";
const COMPACTION_MODEL = "gpt-5.6-luna";
const COMPACTION_THINKING = "medium";
const STATUS_KEY = "compaction-model";

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export default function compactionModelExtension(pi: ExtensionAPI) {
  pi.on("session_before_compact", async (event, ctx) => {
    const model = ctx.modelRegistry.find(COMPACTION_PROVIDER, COMPACTION_MODEL);
    if (!model) {
      ctx.ui.notify(
        `Compaction model not found: ${COMPACTION_PROVIDER}/${COMPACTION_MODEL}; using the active model`,
        "warning",
      );
      return;
    }

    if (ctx.model && model.contextWindow < ctx.model.contextWindow) {
      ctx.ui.notify(
        `Compaction model context (${model.contextWindow.toLocaleString()}) is smaller than the active model context (${ctx.model.contextWindow.toLocaleString()}); using the active model`,
        "warning",
      );
      return;
    }

    const reference = `${model.provider}/${model.id}`;
    ctx.ui.setStatus(STATUS_KEY, `compacting with ${model.id} · ${COMPACTION_THINKING}`);

    try {
      const result = await compact(
        event.preparation,
        model,
        undefined,
        undefined,
        event.customInstructions,
        event.signal,
        COMPACTION_THINKING,
        (model, context, options) => ctx.modelRegistry.streamSimple(model, context, options),
      );

      if (!result.summary.trim()) {
        ctx.ui.notify(`Compaction returned an empty summary from ${reference}; using the active model`, "warning");
        return;
      }

      return { compaction: result };
    } catch (error) {
      if (!event.signal.aborted) {
        ctx.ui.notify(`Compaction failed with ${reference}: ${errorMessage(error)}; using the active model`, "warning");
      }
      return;
    } finally {
      ctx.ui.setStatus(STATUS_KEY, undefined);
    }
  });
}
