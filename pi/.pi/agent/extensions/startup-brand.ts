import type { ExtensionAPI, ExtensionContext, Theme } from "@mariozechner/pi-coding-agent";
import { truncateToWidth } from "@mariozechner/pi-tui";

const BRAND_ROWS = [
  "  ██████╗  ██╗",
  "  ██╔══██╗ ██║",
  "  ██████╔╝ ██║",
  "  ██╔═══╝  ██║",
  "  ██║      ██║",
  "  ╚═╝      ╚═╝",
];

function renderBrand(theme: Theme, width: number): string[] {
  const lines = [
    "",
    ...BRAND_ROWS.map((line) => theme.fg("accent", line)),
    `  ${theme.fg("muted", "coding agent ready")}`,
    "",
  ];

  return lines.map((line) => truncateToWidth(line, width, "…"));
}

function showBrand(ctx: ExtensionContext): void {
  ctx.ui.setHeader((_tui, theme) => ({
    render(width: number): string[] {
      return renderBrand(theme, width);
    },
    invalidate() {},
  }));
}

export default function startupBrand(pi: ExtensionAPI) {
  let visible = false;
  let reapplyTimer: ReturnType<typeof setTimeout> | undefined;

  const clearTimer = () => {
    if (!reapplyTimer) return;
    clearTimeout(reapplyTimer);
    reapplyTimer = undefined;
  };

  const hide = (ctx?: ExtensionContext) => {
    visible = false;
    clearTimer();
    ctx?.ui.setHeader(undefined);
  };

  pi.on("session_start", (event, ctx) => {
    if (!ctx.hasUI) return;
    if (event.reason !== "startup" && event.reason !== "reload") return;

    visible = true;
    clearTimer();
    showBrand(ctx);

    if (event.reason === "reload") {
      reapplyTimer = setTimeout(() => {
        if (!visible) return;
        showBrand(ctx);
        reapplyTimer = undefined;
      }, 80);
    }
  });

  pi.on("before_agent_start", (_event, ctx) => {
    if (!ctx.hasUI || !visible) return;
    hide(ctx);
  });

  pi.on("session_shutdown", () => {
    hide();
  });
}
