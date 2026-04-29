import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";

const LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh"] as const;
type ThinkingLevel = (typeof LEVELS)[number];

const ALIASES = {
  off: "off",
  none: "off",
  minimal: "minimal",
  min: "minimal",
  low: "low",
  medium: "medium",
  med: "medium",
  mid: "medium",
  high: "high",
  xhigh: "xhigh",
  max: "xhigh",
} as const satisfies Record<string, ThinkingLevel>;

type EffortInput = keyof typeof ALIASES;

function isThinkingLevel(value: string): value is ThinkingLevel {
  return (LEVELS as readonly string[]).includes(value);
}

function isEffortInput(value: string): value is EffortInput {
  return value in ALIASES;
}

function notify(ctx: { hasUI: boolean; ui: { notify(message: string, level?: "info" | "warning" | "error"): void } }, message: string, level: "info" | "warning" | "error" = "info") {
  if (ctx.hasUI) ctx.ui.notify(message, level);
  else console.log(message);
}

function applyThinkingLevel(pi: ExtensionAPI, ctx: Parameters<Parameters<ExtensionAPI["registerCommand"]>[1]["handler"]>[1], requested: ThinkingLevel, label = requested): void {
  pi.setThinkingLevel(requested);
  const applied = pi.getThinkingLevel();
  notify(
    ctx,
    applied === requested
      ? `Thinking level set to ${applied}`
      : `Requested ${label} → ${requested}, applied ${applied} (clamped by model capability)`,
    applied === requested ? "info" : "warning",
  );
}

export default function effortExtension(pi: ExtensionAPI) {
  pi.registerCommand("effort", {
    description: "Set thinking level. Usage: /effort [off|min|low|mid|high|max]",
    getArgumentCompletions(prefix) {
      const query = prefix.trim().toLowerCase();
      const values = [...new Set([...Object.keys(ALIASES), ...LEVELS])].sort();
      const matches = values
        .filter((value) => value.startsWith(query))
        .map((value) => ({ value, label: value }));
      return matches.length ? matches : null;
    },
    async handler(args, ctx) {
      const raw = (args ?? "").trim().toLowerCase();
      const current = pi.getThinkingLevel();

      if (!raw) {
        if (!ctx.hasUI) {
          notify(ctx, `Current thinking level: ${current}. Use /effort off|min|low|mid|high|max.`);
          return;
        }

        const choice = await ctx.ui.select(
          `Select thinking level (current: ${current})`,
          LEVELS.map((level) => level === current ? `${level} (current)` : level),
        );
        if (!choice) return;

        const requested = choice.replace(" (current)", "");
        if (!isThinkingLevel(requested)) return;
        applyThinkingLevel(pi, ctx, requested);
        return;
      }

      if (!isEffortInput(raw)) {
        notify(ctx, "Usage: /effort | /effort off|min|low|mid|high|max", "error");
        return;
      }

      applyThinkingLevel(pi, ctx, ALIASES[raw], raw);
    },
  });
}
