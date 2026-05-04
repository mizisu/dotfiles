import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Box, Text } from "@mariozechner/pi-tui";

function messageText(content: string | Array<{ type?: string; text?: string }>): string {
  if (typeof content === "string") return content;
  return content
    .filter((part): part is { type: string; text: string } => part?.type === "text" && typeof part.text === "string")
    .map((part) => part.text)
    .join("\n");
}

export function registerSuccessMessageRenderer(pi: ExtensionAPI, customType: string, label = customType): void {
  pi.registerMessageRenderer(customType, (message, _options, theme) => {
    const header = theme.fg("success", theme.bold(`[${label}]`));
    const body = theme.fg("text", messageText(message.content));
    const box = new Box(1, 1, (text) => theme.bg("customMessageBg", text));
    box.addChild(new Text(`${header}\n${body}`, 0, 0));
    return box;
  });
}
