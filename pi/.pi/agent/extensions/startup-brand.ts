import type { ExtensionAPI, ExtensionContext, Theme } from "@mariozechner/pi-coding-agent";
import { truncateToWidth, visibleWidth } from "@mariozechner/pi-tui";

// Adapted from FredySandoval/pi-logo logo-041 (MIT):
// https://github.com/FredySandoval/pi-logo
const BRAND_ROWS = [
  "┏━━━━━━━━━━━━━━━━━━━━┓",
  "┃                    ┃",
  "┃ ████████████       ┃",
  "┃ ████    ████       ┃",
  "┃ ████    ████       ┃",
  "┃ ████████    ████   ┃",
  "┃ ████        ████   ┃",
  "┃ ████        ████   ┃",
  "┃                    ┃",
  "┗━━━━━━━━━━━━━━━━━━━━┛",
];

const MINI_BRAND_ROWS = ["█▀█", "█▀ █"];
const LEFT_PADDING = "  ";
const LOGO_GAP = "  ";
const BRAND_WIDTH = Math.max(...BRAND_ROWS.map((line) => visibleWidth(line)));
const SIDE_BY_SIDE_MIN_WIDTH = 52;
const STACKED_MIN_WIDTH = visibleWidth(LEFT_PADDING) + BRAND_WIDTH;

function fit(line: string, width: number, ellipsis = "…"): string {
  return width <= 0 ? "" : truncateToWidth(line, width, ellipsis);
}

function padToWidth(line: string, width: number): string {
  return `${line}${" ".repeat(Math.max(0, width - visibleWidth(line)))}`;
}

function renderLogoRow(theme: Theme, line: string, index: number): string {
  const color = index === 0 || index === BRAND_ROWS.length - 1 ? "borderAccent" : "accent";
  return theme.fg(color, padToWidth(line, BRAND_WIDTH));
}

function renderWideBrand(theme: Theme, width: number): string[] {
  const detailWidth = width - visibleWidth(LEFT_PADDING) - BRAND_WIDTH - visibleWidth(LOGO_GAP);
  const details = [
    "",
    theme.fg("accent", "pi"),
    theme.fg("muted", "coding agent ready"),
    "",
    theme.fg("dim", "/ commands · ! bash"),
    theme.fg("dim", "esc interrupt · ctrl+c clear"),
    theme.fg("dim", "ask me to use or extend Pi"),
    "",
    "",
    "",
  ];

  return [
    "",
    ...BRAND_ROWS.map((line, index) =>
      fit(`${LEFT_PADDING}${renderLogoRow(theme, line, index)}${LOGO_GAP}${fit(details[index] ?? "", detailWidth)}`, width),
    ),
    "",
  ];
}

function renderStackedBrand(theme: Theme, width: number): string[] {
  const caption = width >= 38 ? "coding agent ready · ask, edit, ship" : "coding agent ready";

  return [
    "",
    ...BRAND_ROWS.map((line, index) => fit(`${LEFT_PADDING}${renderLogoRow(theme, line, index)}`, width, "")),
    fit(`${LEFT_PADDING}${theme.fg("muted", caption)}`, width),
    "",
  ];
}

function renderMiniBrand(theme: Theme, width: number): string[] {
  return [
    "",
    ...MINI_BRAND_ROWS.map((line) => fit(theme.fg("accent", line), width, "")),
    fit(theme.fg("muted", "pi ready"), width),
    "",
  ];
}

function renderBrand(theme: Theme, width: number): string[] {
  if (width >= SIDE_BY_SIDE_MIN_WIDTH) {
    return renderWideBrand(theme, width);
  }

  if (width >= STACKED_MIN_WIDTH) {
    return renderStackedBrand(theme, width);
  }

  return renderMiniBrand(theme, width);
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
