/**
 * /btw - Ephemeral side questions (inspired by Claude Code's /btw)
 *
 * Ask a quick question about the current conversation without adding to history.
 * The answer appears in a dismissible overlay and is never stored in the session.
 *
 * Usage: /btw what was the name of that config file?
 */

import { complete, type Message, type UserMessage } from "@mariozechner/pi-ai";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { BorderedLoader, DynamicBorder, getMarkdownTheme } from "@mariozechner/pi-coding-agent";
import { Container, Markdown, matchesKey, Text } from "@mariozechner/pi-tui";

const SYSTEM_PROMPT = `You are answering a quick side question about an ongoing coding session.

You have full visibility into the conversation so far. Answer concisely and directly.
If the answer is in the conversation context, reference it specifically.
If you genuinely don't know, say so briefly.

Keep your response short — this is a quick reference, not a deep dive.`;

function buildMessages(branch: any[]): Message[] {
	const messages: Message[] = [];

	for (const entry of branch) {
		if (entry.type !== "message") continue;
		const msg = entry.message;
		if (!msg || !("role" in msg)) continue;

		if (msg.role === "user" || msg.role === "assistant") {
			messages.push(msg);
		}
	}

	return messages;
}

function extractText(response: { content: { type: string; text?: string }[] }): string {
	return response.content
		.filter((c): c is { type: "text"; text: string } => c.type === "text" && typeof c.text === "string")
		.map((c) => c.text)
		.join("\n");
}

export default function (pi: ExtensionAPI) {
	pi.registerCommand("btw", {
		description: "Quick side question (ephemeral, no history)",
		handler: async (args, ctx) => {
			if (!args?.trim()) {
				ctx.ui.notify("Usage: /btw <question>", "error");
				return;
			}

			if (!ctx.hasUI) {
				ctx.ui.notify("/btw requires interactive mode", "error");
				return;
			}

			if (!ctx.model) {
				ctx.ui.notify("No model selected", "error");
				return;
			}

			// Build conversation context
			const branch = ctx.sessionManager.getBranch();
			const messages = buildMessages(branch);

			// Append the side question as the final user message
			const question: UserMessage = {
				role: "user",
				content: [{ type: "text", text: args.trim() }],
				timestamp: Date.now(),
			};
			messages.push(question);

			// Phase 1: Loading overlay + LLM call
			const answer = await ctx.ui.custom<string | null>((tui, theme, _kb, done) => {
				const loader = new BorderedLoader(tui, theme, `Thinking with ${ctx.model!.id}...`);
				loader.onAbort = () => done(null);

				const doComplete = async () => {
					const apiKey = await ctx.modelRegistry.getApiKey(ctx.model!);
					const response = await complete(ctx.model!, { systemPrompt: SYSTEM_PROMPT, messages }, { apiKey, signal: loader.signal });

					if (response.stopReason === "aborted") return null;
					return extractText(response);
				};

				doComplete()
					.then(done)
					.catch(() => done(null));

				return loader;
			});

			if (!answer) return;

			// Phase 2: Answer overlay
			await ctx.ui.custom(
				(_tui, theme, _kb, done) => {
					const container = new Container();
					const border = new DynamicBorder((s: string) => theme.fg("accent", s));
					const mdTheme = getMarkdownTheme();

					container.addChild(border);
					container.addChild(new Text(" " + theme.fg("accent", theme.bold("/btw")) + " " + theme.fg("dim", args.trim()), 1, 0));
					container.addChild(new Markdown(answer, 1, 1, mdTheme));
					container.addChild(new Text(theme.fg("dim", "Press Space, Enter, or Esc to dismiss"), 1, 0));
					container.addChild(border);

					return {
						render: (w: number) => container.render(w),
						invalidate: () => container.invalidate(),
						handleInput: (data: string) => {
							if (matchesKey(data, "space") || matchesKey(data, "enter") || matchesKey(data, "escape")) {
								done(undefined);
							}
						},
					};
				},
				{ overlay: true },
			);
		},
	});
}
