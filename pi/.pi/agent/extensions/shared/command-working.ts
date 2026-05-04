import { truncateToWidth, type Component } from "@mariozechner/pi-tui";

const SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
const SPINNER_INTERVAL_MS = 80;

class CommandWorkingWidget implements Component {
  private frameIndex = 0;
  private interval: ReturnType<typeof setInterval> | undefined;

  constructor(
    private readonly tui: any,
    private readonly theme: any,
    private readonly title: string,
    private readonly message: string,
    private readonly details: string[],
  ) {
    this.interval = setInterval(() => {
      this.frameIndex = (this.frameIndex + 1) % SPINNER_FRAMES.length;
      this.tui.requestRender();
    }, SPINNER_INTERVAL_MS);
  }

  render(width: number): string[] {
    const frame = this.theme.fg("accent", SPINNER_FRAMES[this.frameIndex] ?? "⠋");
    const title = this.theme.fg("accent", this.theme.bold(this.title));
    const message = this.theme.fg("muted", this.message);
    const lines = [
      "",
      truncateToWidth(` ${frame} ${title}`, width, "…"),
      truncateToWidth(`   ${message}`, width, "…"),
    ];

    for (const detail of this.details.slice(0, 4)) {
      lines.push(truncateToWidth(`   ${this.theme.fg("dim", detail)}`, width, "…"));
    }

    if (this.details.length > 4) {
      lines.push(truncateToWidth(`   ${this.theme.fg("dim", `… ${this.details.length - 4} more`)}`, width, "…"));
    }

    return lines;
  }

  invalidate(): void {}

  dispose(): void {
    if (this.interval) clearInterval(this.interval);
    this.interval = undefined;
  }
}

export interface CommandWorking {
  set(message: string | undefined, details?: string[]): void;
  clear(): void;
}

export function createCommandWorking(ctx: any, key: string, title: string): CommandWorking {
  const widgetKey = `command-working:${key}`;

  return {
    set(message: string | undefined, details: string[] = []) {
      ctx.ui.setStatus(key, message);
      ctx.ui.setWidget(
        widgetKey,
        message
          ? (tui: any, theme: any) => new CommandWorkingWidget(tui, theme, title, message, details)
          : undefined,
        { placement: "aboveEditor" },
      );
    },
    clear() {
      ctx.ui.setStatus(key, undefined);
      ctx.ui.setWidget(widgetKey, undefined);
    },
  };
}
