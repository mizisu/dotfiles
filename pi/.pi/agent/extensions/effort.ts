import { DynamicBorder, getSelectListTheme, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Container, Input, SelectList, Text } from "@earendil-works/pi-tui";

const LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;
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
  max: "max",
} as const satisfies Record<string, ThinkingLevel>;

type EffortInput = keyof typeof ALIASES;

function isThinkingLevel(value: string): value is ThinkingLevel {
  return (LEVELS as readonly string[]).includes(value);
}

function isEffortInput(value: string): value is EffortInput {
  return Object.hasOwn(ALIASES, value);
}

function notify(ctx: { hasUI: boolean; ui: { notify(message: string, level?: "info" | "warning" | "error"): void } }, message: string, level: "info" | "warning" | "error" = "info") {
  if (ctx.hasUI) ctx.ui.notify(message, level);
  else console.log(message);
}

function applyThinkingLevel(pi: ExtensionAPI, ctx: ExtensionContext, requested: ThinkingLevel, label: string = requested): void {
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

async function promptThinkingLevel(ctx: ExtensionContext, current: ThinkingLevel): Promise<string | undefined> {
  const title = `Select thinking level (current: ${current})`;
  if (ctx.mode !== "tui") {
    return ctx.ui.select(title, LEVELS.map((level) => level === current ? `${level} (current)` : level));
  }

  return ctx.ui.custom<string | undefined>((tui, theme, keybindings, done) => {
    const container = new Container();
    const input = new Input({ placeholder: "Type a level: high, xhigh, max…" });
    const list = new SelectList(
      LEVELS.map((level) => ({
        value: level,
        label: level === current ? `${level} (current)` : level,
      })),
      LEVELS.length,
      getSelectListTheme(),
    );
    list.setSelectedIndex(LEVELS.indexOf(current));
    list.onSelect = (item) => done(item.value);
    list.onCancel = () => done(undefined);

    container.addChild(new DynamicBorder());
    container.addChild(new Text(theme.fg("accent", title), 0, 0));
    container.addChild(input);
    container.addChild(list);
    container.addChild(new Text(theme.fg("dim", "Type to filter · ↑↓ select · Enter apply · Esc cancel"), 0, 0));
    container.addChild(new DynamicBorder());

    return {
      get focused() { return input.focused; },
      set focused(value: boolean) { input.focused = value; },
      render: (width: number) => container.render(width),
      invalidate: () => container.invalidate(),
      handleInput(data: string) {
        if (
          keybindings.matches(data, "tui.select.up") ||
          keybindings.matches(data, "tui.select.down") ||
          keybindings.matches(data, "tui.select.confirm") ||
          keybindings.matches(data, "tui.select.cancel")
        ) {
          list.handleInput(data);
        } else {
          const previous = input.getValue();
          input.handleInput(data);
          if (input.getValue() !== previous) {
            const query = input.getValue().trim().toLowerCase();
            list.setFilter(isEffortInput(query) ? ALIASES[query] : query);
            if (!query) list.setSelectedIndex(LEVELS.indexOf(current));
          }
        }
        tui.requestRender();
      },
    };
  });
}

export default function effortExtension(pi: ExtensionAPI) {
  async function selectThinkingLevel(ctx: ExtensionContext): Promise<void> {
    const current = pi.getThinkingLevel();
    if (!ctx.hasUI) {
      notify(ctx, `Current thinking level: ${current}. Use /effort off|min|low|mid|high|max.`);
      return;
    }

    const choice = await promptThinkingLevel(ctx, current);
    if (!choice) return;

    const requested = choice.replace(" (current)", "");
    if (!isThinkingLevel(requested)) return;
    applyThinkingLevel(pi, ctx, requested);
  }

  pi.registerShortcut("ctrl+s", {
    description: "Select thinking level",
    handler: selectThinkingLevel,
  });

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
      if (!raw) {
        await selectThinkingLevel(ctx);
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
