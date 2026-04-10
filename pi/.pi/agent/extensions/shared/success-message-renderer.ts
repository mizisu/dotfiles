import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Box, Text } from "@mariozechner/pi-tui";

function getMessageText(content: string | Array<{ type: string; text?: string }>): string {
	if (typeof content === "string") return content;
	return content
		.filter(
			(part): part is { type: "text"; text: string } =>
				part.type === "text" && typeof part.text === "string",
		)
		.map((part) => part.text)
		.join("\n");
}

export function registerSuccessMessageRenderer(pi: ExtensionAPI, customType: string, label = customType) {
	pi.registerMessageRenderer(customType, (message, _options, theme) => {
		const box = new Box(1, 1, (text) => theme.bg("toolSuccessBg", text));
		const header = theme.fg("success", `\x1b[1m[${label}]\x1b[22m`);
		const body = theme.fg("text", getMessageText(message.content));
		box.addChild(new Text(`${header}\n${body}`, 0, 0));
		return box;
	});
}
