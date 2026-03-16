/**
 * /btw - Concurrent ephemeral side questions
 *
 * Ask quick questions about the current conversation. Multiple questions run
 * simultaneously in the background. Results are shown in a widget and reviewed
 * via /btw (no args).
 *
 * Usage:
 *   /btw what was the name of that config file?   — fire question
 *   /btw how does the auth flow work?              — another one
 *   /btw                                           — review results
 *
 * Review:
 *   ↑↓     navigate between results
 *   Enter  keep (add to conversation context)
 *   d      dismiss
 *   Tab    ask follow-up
 *   Esc    close review
 */

import { complete, type Message, type UserMessage } from "@mariozechner/pi-ai";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { DynamicBorder, getMarkdownTheme } from "@mariozechner/pi-coding-agent";
import { Container, Input, Markdown, matchesKey, Text } from "@mariozechner/pi-tui";

const SYSTEM_PROMPT = `You are answering a quick side question about an ongoing coding session.

You have full visibility into the conversation so far. Answer concisely and directly.
If the answer is in the conversation context, reference it specifically.
If you genuinely don't know, say so briefly.

Keep your response short — this is a quick reference, not a deep dive.`;

interface BtwThread {
	id: number;
	baseMessages: Message[];
	messages: Message[];
	status: "pending" | "done" | "error";
	latestQuestion: string;
	latestAnswer?: string;
	error?: string;
	abort?: AbortController;
}

function buildMessages(branch: any[]): Message[] {
	const messages: Message[] = [];
	for (const entry of branch) {
		if (entry.type !== "message") continue;
		const msg = entry.message;
		if (!msg || !("role" in msg)) continue;
		if (msg.role === "user" || msg.role === "assistant" || msg.role === "toolResult") {
			messages.push(msg);
		}
	}
	return messages;
}

function extractText(response: { content: { type: string; text?: string; thinking?: string }[] }): string {
	const textParts = response.content
		.filter((c): c is { type: "text"; text: string } => c.type === "text" && typeof c.text === "string")
		.map((c) => c.text);
	if (textParts.length > 0) return textParts.join("\n");
	// Fallback: extract thinking content if no text blocks
	const thinkingParts = response.content
		.filter((c): c is { type: "thinking"; thinking: string } => c.type === "thinking" && typeof c.thinking === "string")
		.map((c) => c.thinking);
	if (thinkingParts.length > 0) return thinkingParts.join("\n");
	return "";
}

function getTextContent(msg: Message): string {
	if (typeof msg.content === "string") return msg.content;
	return (msg.content as any[])
		.filter((c: any) => c.type === "text")
		.map((c: any) => c.text)
		.join("");
}

export default function (pi: ExtensionAPI) {
	const threads: BtwThread[] = [];
	let nextId = 0;
	let uiRef: any = null;

	function updateWidget() {
		if (!uiRef) return;
		if (threads.length === 0) {
			uiRef.setWidget("btw", undefined);
			return;
		}
		const pending = threads.filter((t) => t.status === "pending").length;
		const done = threads.filter((t) => t.status === "done").length;
		const errors = threads.filter((t) => t.status === "error").length;
		const parts: string[] = [];
		if (pending > 0) parts.push(`${pending} ⏳`);
		if (done > 0) parts.push(`${done} ✓`);
		if (errors > 0) parts.push(`${errors} ✗`);
		uiRef.setWidget("btw", [`/btw ${parts.join("  ")} — /btw to review`]);
	}

	function fireQuestion(thread: BtwThread, model: any, modelRegistry: any) {
		const userMsg: UserMessage = {
			role: "user",
			content: [{ type: "text", text: thread.latestQuestion }],
			timestamp: Date.now(),
		};
		const allMessages = [...thread.baseMessages, ...thread.messages, userMsg];
		thread.abort = new AbortController();
		thread.status = "pending";
		updateWidget();

		(async () => {
			try {
				const apiKey = await modelRegistry.getApiKey(model);
				const response = await complete(
					model,
					{ systemPrompt: SYSTEM_PROMPT, messages: allMessages },
					{ apiKey, signal: thread.abort.signal },
				);
				if (response.stopReason === "aborted") {
					const i = threads.indexOf(thread);
					if (i >= 0) threads.splice(i, 1);
				} else if (response.stopReason === "error") {
					thread.error = response.errorMessage ?? "Unknown error";
					thread.status = "error";
				} else {
					const answer = extractText(response);
					thread.latestAnswer = answer || "(empty response)";
					thread.messages.push(userMsg);
					thread.messages.push(response as Message);
					thread.status = "done";
				}
			} catch (e: any) {
				thread.error = e?.message ?? String(e);
				thread.status = "error";
			}
			updateWidget();
		})();
	}

	// --- /btw command: fire-and-forget ---

	pi.registerCommand("btw", {
		description: "Quick side question (concurrent, non-blocking)",
		handler: async (args, ctx) => {
			if (!ctx.hasUI) {
				ctx.ui.notify("/btw requires interactive mode", "error");
				return;
			}

			uiRef = ctx.ui;

			// No args → open review
			if (!args?.trim()) {
				await openReview(ctx);
				return;
			}

			if (!ctx.model) {
				ctx.ui.notify("No model selected", "error");
				return;
			}

			const thread: BtwThread = {
				id: nextId++,
				baseMessages: buildMessages(ctx.sessionManager.getBranch()),
				messages: [],
				status: "pending",
				latestQuestion: args.trim(),
			};
			threads.push(thread);
			fireQuestion(thread, ctx.model, ctx.modelRegistry);
		},
	});

	// --- Review logic (/btw with no args) ---

	async function openReview(ctx: { ui: any; model?: any; modelRegistry?: any }) {
		const ready = threads.filter((t) => t.status !== "pending");
		if (ready.length === 0) {
			const pending = threads.filter((t) => t.status === "pending").length;
			ctx.ui.notify(pending > 0 ? `${pending} btw still thinking…` : "No btw results", "info");
			return;
		}

		let idx = 0;
		let followUpThread: BtwThread | null = null;

		await ctx.ui.custom<void>(
			(tui: any, theme: any, _kb: any, done: (r: void) => void) => {
				const container = new Container();
				const mdTheme = getMarkdownTheme();

				function rebuild() {
					container.clear();
					const items = threads.filter((t) => t.status !== "pending");
					if (items.length === 0) return;
					if (idx >= items.length) idx = items.length - 1;

					const item = items[idx];
					const border = new DynamicBorder((s: string) => theme.fg("accent", s));

					container.addChild(border);

					// Header
					const counter = items.length > 1 ? `  ${idx + 1}/${items.length}` : "";
					const turns = item.messages.length / 2;
					const turnInfo = turns > 1 ? `  (${turns} turns)` : "";
					container.addChild(
						new Text(
							" " + theme.fg("accent", theme.bold("/btw")) + theme.fg("dim", counter + turnInfo),
							1,
							0,
						),
					);

					// Body
					if (item.status === "error") {
						container.addChild(new Text(" " + theme.fg("error", `Error: ${item.error}`), 1, 0));
					} else {
						for (let i = 0; i < item.messages.length; i += 2) {
							if (i > 0) container.addChild(new Text("", 0, 0));
							container.addChild(
								new Text(" " + theme.fg("dim", "Q: " + getTextContent(item.messages[i])), 1, 0),
							);
							const answerText = extractText(item.messages[i + 1] as any);
							if (answerText.trim()) {
								container.addChild(new Markdown(answerText, 1, 1, mdTheme));
							} else {
								container.addChild(new Text(" " + theme.fg("warning", "(no answer text)"), 1, 0));
							}
						}
					}

					// Hints
					const hints: string[] = [];
					if (items.length > 1) hints.push(theme.fg("dim", "↑↓") + " navigate");
					hints.push(theme.fg("dim", "enter") + " keep");
					hints.push(theme.fg("dim", "d") + " dismiss");
					if (item.status === "done") hints.push(theme.fg("dim", "tab") + " follow-up");
					hints.push(theme.fg("dim", "esc") + " close");
					container.addChild(new Text(" " + hints.join("  "), 1, 0));
					container.addChild(border);
				}

				rebuild();

				return {
					render: (w: number) => {
						const items = threads.filter((t) => t.status !== "pending");
						if (items.length === 0) return [];
						return container.render(w);
					},
					invalidate: () => {
						rebuild();
						container.invalidate();
					},
					handleInput: (data: string) => {
						const items = threads.filter((t) => t.status !== "pending");
						if (items.length === 0) {
							done(undefined);
							return;
						}
						if (idx >= items.length) idx = items.length - 1;
						const item = items[idx];

						if (matchesKey(data, "escape")) {
							done(undefined);
						} else if (matchesKey(data, "enter")) {
							// Keep: add all turns to context
							let content = "";
							for (let i = 0; i < item.messages.length; i += 2) {
								content += `**Q:** ${getTextContent(item.messages[i])}\n\n${extractText(item.messages[i + 1] as any)}\n\n`;
							}
							pi.sendMessage(
								{ customType: "btw", content: content.trim(), display: true },
								{ triggerTurn: false },
							);
							const ti = threads.indexOf(item);
							if (ti >= 0) threads.splice(ti, 1);
							updateWidget();
							rebuild();
							if (threads.filter((t) => t.status !== "pending").length === 0) done(undefined);
							else tui.requestRender();
						} else if (matchesKey(data, "d")) {
							// Dismiss
							const ti = threads.indexOf(item);
							if (ti >= 0) threads.splice(ti, 1);
							updateWidget();
							rebuild();
							if (threads.filter((t) => t.status !== "pending").length === 0) done(undefined);
							else tui.requestRender();
						} else if (matchesKey(data, "tab") && item.status === "done") {
							followUpThread = item;
							done(undefined);
						} else if (matchesKey(data, "up") || matchesKey(data, "k")) {
							idx = Math.max(0, idx - 1);
							rebuild();
							tui.requestRender();
						} else if (matchesKey(data, "down") || matchesKey(data, "j")) {
							idx = Math.min(items.length - 1, idx + 1);
							rebuild();
							tui.requestRender();
						}
					},
				};
			},
			{ overlay: true },
		);

		// Follow-up: show input, fire new question on same thread
		if (followUpThread && ctx.model) {
			const thread = followUpThread;
			const newQuestion = await ctx.ui.custom<string | null>((_tui: any, theme: any, _kb: any, done: (r: string | null) => void) => {
				const container = new Container();
				const border = new DynamicBorder((s: string) => theme.fg("accent", s));
				const input = new Input();
				input.focused = true;
				input.onSubmit = (v: string) => {
					if (v.trim()) done(v.trim());
				};
				input.onEscape = () => done(null);

				container.addChild(border);
				container.addChild(new Text(" " + theme.fg("accent", "Follow-up question:"), 1, 0));
				container.addChild(input);
				container.addChild(
					new Text(" " + theme.fg("dim", "enter") + " submit  " + theme.fg("dim", "esc") + " cancel", 1, 0),
				);
				container.addChild(border);

				return {
					render: (w: number) => container.render(w),
					invalidate: () => container.invalidate(),
					handleInput: (data: string) => input.handleInput(data),
				};
			});

			if (newQuestion) {
				thread.latestQuestion = newQuestion;
				fireQuestion(thread, ctx.model, ctx.modelRegistry);
			}
		}
	}
}
