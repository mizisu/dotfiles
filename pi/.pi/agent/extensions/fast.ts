import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

const STATE_KEY = "fast-mode";

function supportsFast(model: ExtensionContext["model"]): boolean {
  return !!model && model.id.startsWith("gpt-") && (
    (model.provider === "openai-codex" && model.api === "openai-codex-responses") ||
    (model.provider === "openai" && model.api === "openai-responses")
  );
}

export default function fastExtension(pi: ExtensionAPI) {
  let enabled = false;

  const updateStatus = (ctx: ExtensionContext) => {
    if (!ctx.hasUI) return;
    ctx.ui.setStatus(STATE_KEY, enabled && supportsFast(ctx.model) ? "fast" : undefined);
  };

  const restore = (_event: unknown, ctx: ExtensionContext) => {
    const entry = ctx.sessionManager.getBranch().findLast(
      (entry) => entry.type === "custom" && entry.customType === STATE_KEY,
    );
    enabled = entry?.type === "custom" && entry.data === true;
    updateStatus(ctx);
  };

  pi.on("session_start", restore);
  pi.on("session_tree", restore);
  pi.on("model_select", (_event, ctx) => updateStatus(ctx));
  pi.on("session_shutdown", (_event, ctx) => {
    if (ctx.hasUI) ctx.ui.setStatus(STATE_KEY, undefined);
  });

  pi.registerCommand("fast", {
    description: "Toggle Fast mode for OpenAI GPT requests (higher usage/cost)",
    async handler(args, ctx) {
      if (args.trim()) {
        ctx.ui.notify("Usage: /fast (toggles ON/OFF)", "warning");
        return;
      }
      if (!enabled && !supportsFast(ctx.model)) {
        ctx.ui.notify("Fast mode requires an OpenAI or Codex GPT Responses model.", "warning");
        return;
      }

      pi.appendEntry(STATE_KEY, !enabled);
      enabled = !enabled;
      updateStatus(ctx);
      ctx.ui.notify(
        enabled
          ? "Fast ON — priority processing from the next request; higher usage/cost."
          : "Fast OFF — standard processing from the next request.",
        "info",
      );
    },
  });

  pi.on("before_provider_request", ({ payload }, ctx) => {
    if (!supportsFast(ctx.model) || !payload || typeof payload !== "object" || Array.isArray(payload)) return;
    if (!("model" in payload) || payload.model !== ctx.model?.id) return;

    // shortcut: payload-only changes may undercount Pi's Fast costs; use provider options if exact estimates are needed.
    return { ...payload, service_tier: enabled ? "priority" : "default" };
  });
}
