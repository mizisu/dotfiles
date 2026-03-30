/**
 * /btw - Concurrent ephemeral side questions
 *
 * Ask quick questions about the current conversation. Multiple questions run
 * simultaneously in the background. Results are shown in a widget and reviewed
 * via /btw (no args).
 *
 * Supports tool use (read files, run bash commands) for code exploration.
 *
 * Usage:
 *   /btw what was the name of that config file?   — fire question
 *   /btw how does the auth flow work?              — another one
 *   /btw explore the review module and summarize   — uses tools
 *   /btw                                           — review results
 *
 * Review:
 *   ↑↓     navigate between results
 *   Enter  keep (add to conversation context)
 *   d      dismiss
 *   Tab    ask follow-up
 *   Esc    close review
 */

import {
	complete,
	type Message,
	type Tool,
	type ToolCall,
	type ToolResultMessage,
	type UserMessage,
} from "@mariozechner/pi-ai";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { DynamicBorder, getMarkdownTheme } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import { readFile } from "node:fs/promises";
import {
	Container,
	Input,
	Markdown,
	matchesKey,
	Text,
} from "@mariozechner/pi-tui";

const MAX_TOOL_TURNS = 15;
const MAX_OUTPUT_BYTES = 30_000;

const SYSTEM_PROMPT = `You are answering a side question about an ongoing coding session.

You have full visibility into the conversation so far, and you can use tools to read files and run commands.
Answer concisely and directly. Use tools when the answer requires looking at code or running commands.
If the answer is already in the conversation context, reference it directly without re-reading files.

Keep your final response focused and well-organized.`;

const BTW_TOOLS: Tool[] = [
	{
		name: "read",
		description: "Read contents of a file. Use offset/limit for large files.",
		parameters: Type.Object({
			path: Type.String({ description: "File path to read" }),
			offset: Type.Optional(
				Type.Number({ description: "Line number to start from (1-indexed)" }),
			),
			limit: Type.Optional(Type.Number({ description: "Max lines to read" })),
		}),
	},
	{
		name: "bash",
		description:
			"Run a bash command. Use for searching code (rg, find), listing files (ls), etc.",
		parameters: Type.Object({
			command: Type.String({ description: "Bash command to execute" }),
			timeout: Type.Optional(
				Type.Number({ description: "Timeout in seconds (default 15)" }),
			),
		}),
	},
];

function truncateOutput(text: string, maxBytes: number): string {
	if (Buffer.byteLength(text) <= maxBytes) return text;
	const lines = text.split("\n");
	let size = 0;
	let kept = 0;
	for (const line of lines) {
		const lineSize = Buffer.byteLength(line) + 1;
		if (size + lineSize > maxBytes) break;
		size += lineSize;
		kept++;
	}
	return (
		lines.slice(0, Math.max(kept, 1)).join("\n") +
		`\n\n[truncated — showing ${kept}/${lines.length} lines]`
	);
}

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
		if (
			msg.role === "user" ||
			msg.role === "assistant" ||
			msg.role === "toolResult"
		) {
			messages.push(msg);
		}
	}
	return messages;
}

function extractText(response: {
	content: { type: string; text?: string; thinking?: string }[];
}): string {
	const textParts = response.content
		.filter(
			(c): c is { type: "text"; text: string } =>
				c.type === "text" && typeof c.text === "string",
		)
		.map((c) => c.text);
	if (textParts.length > 0) return textParts.join("\n");
	// Fallback: extract thinking content if no text blocks
	const thinkingParts = response.content
		.filter(
			(c): c is { type: "thinking"; thinking: string } =>
				c.type === "thinking" && typeof c.thinking === "string",
		)
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

	async function executeToolCalls(
		toolCalls: ToolCall[],
		cwd: string,
		signal: AbortSignal,
	): Promise<ToolResultMessage[]> {
		const results: ToolResultMessage[] = [];
		for (const tc of toolCalls) {
			if (signal.aborted) break;
			try {
				let text: string;
				if (tc.name === "read") {
					const {
						path: filePath,
						offset,
						limit,
					} = tc.arguments as { path: string; offset?: number; limit?: number };
					const resolved = filePath.startsWith("/")
						? filePath
						: `${cwd}/${filePath}`;
					let content = await readFile(resolved, "utf8");
					if (offset || limit) {
						const lines = content.split("\n");
						const start = Math.max(0, (offset ?? 1) - 1);
						const end = limit ? start + limit : lines.length;
						content = lines.slice(start, end).join("\n");
					}
					text = truncateOutput(content, MAX_OUTPUT_BYTES);
				} else if (tc.name === "bash") {
					const { command, timeout } = tc.arguments as {
						command: string;
						timeout?: number;
					};
					const result = await pi.exec("bash", ["-c", command], {
						signal,
						timeout: (timeout ?? 15) * 1000,
					});
					const output = [result.stdout, result.stderr]
						.filter(Boolean)
						.join("\n");
					text = truncateOutput(output || "(no output)", MAX_OUTPUT_BYTES);
					if (result.code !== 0) text += `\n[exit code: ${result.code}]`;
				} else {
					text = `Unknown tool: ${tc.name}`;
				}
				results.push({
					role: "toolResult",
					toolCallId: tc.id,
					toolName: tc.name,
					content: [{ type: "text", text }],
					isError: false,
					timestamp: Date.now(),
				});
			} catch (e: any) {
				results.push({
					role: "toolResult",
					toolCallId: tc.id,
					toolName: tc.name,
					content: [{ type: "text", text: e?.message ?? String(e) }],
					isError: true,
					timestamp: Date.now(),
				});
			}
		}
		return results;
	}

	function fireQuestion(
		thread: BtwThread,
		model: any,
		modelRegistry: any,
		cwd: string,
	) {
		const userMsg: UserMessage = {
			role: "user",
			content: [{ type: "text", text: thread.latestQuestion }],
			timestamp: Date.now(),
		};
		thread.abort = new AbortController();
		thread.status = "pending";
		updateWidget();

		(async () => {
			try {
				const auth = await modelRegistry.getApiKeyAndHeaders(model);
				if (!auth.ok) throw new Error(auth.error);
				const signal = thread.abort!.signal;
				const loopMessages: Message[] = [
					...thread.baseMessages,
					...thread.messages,
					userMsg,
				];

				for (let turn = 0; turn < MAX_TOOL_TURNS; turn++) {
					if (signal.aborted) break;

					const response = await complete(
						model,
						{
							systemPrompt: SYSTEM_PROMPT,
							messages: loopMessages,
							tools: BTW_TOOLS,
						},
						{ apiKey: auth.apiKey, headers: auth.headers, signal },
					);

					if (response.stopReason === "aborted") {
						const i = threads.indexOf(thread);
						if (i >= 0) threads.splice(i, 1);
						updateWidget();
						return;
					}
					if (response.stopReason === "error") {
						thread.error = response.errorMessage ?? "Unknown error";
						thread.status = "error";
						updateWidget();
						return;
					}

					loopMessages.push(response as Message);

					if (response.stopReason === "toolUse") {
						const toolCalls = response.content.filter(
							(c): c is ToolCall => c.type === "toolCall",
						);
						const toolResults = await executeToolCalls(toolCalls, cwd, signal);
						loopMessages.push(...toolResults);
						continue;
					}

					// stopReason === "stop" or "length" → done
					const answer = extractText(response);
					thread.latestAnswer = answer || "(empty response)";
					thread.messages.push(userMsg);
					// Store only the user msg + final assistant response (skip intermediate tool turns)
					thread.messages.push(response as Message);
					thread.status = "done";
					updateWidget();
					return;
				}

				// Exhausted max turns
				const lastAssistant = loopMessages
					.filter((m) => m.role === "assistant")
					.pop();
				thread.latestAnswer = lastAssistant
					? extractText(lastAssistant as any)
					: "(max tool turns reached)";
				thread.messages.push(userMsg);
				if (lastAssistant) thread.messages.push(lastAssistant);
				thread.status = "done";
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
			fireQuestion(thread, ctx.model, ctx.modelRegistry, ctx.cwd);
		},
	});

	// --- Review logic (/btw with no args) ---

	async function openReview(ctx: {
		ui: any;
		model?: any;
		modelRegistry?: any;
		cwd: string;
	}) {
		const ready = threads.filter((t) => t.status !== "pending");
		if (ready.length === 0) {
			const pending = threads.filter((t) => t.status === "pending").length;
			ctx.ui.notify(
				pending > 0 ? `${pending} btw still thinking…` : "No btw results",
				"info",
			);
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
					const border = new DynamicBorder((s: string) =>
						theme.fg("accent", s),
					);

					container.addChild(border);

					// Header
					const counter =
						items.length > 1 ? `  ${idx + 1}/${items.length}` : "";
					const turns = item.messages.length / 2;
					const turnInfo = turns > 1 ? `  (${turns} turns)` : "";
					container.addChild(
						new Text(
							" " +
								theme.fg("accent", theme.bold("/btw")) +
								theme.fg("dim", counter + turnInfo),
							1,
							0,
						),
					);

					// Body
					if (item.status === "error") {
						container.addChild(
							new Text(" " + theme.fg("error", `Error: ${item.error}`), 1, 0),
						);
					} else {
						for (let i = 0; i < item.messages.length; i += 2) {
							if (i > 0) container.addChild(new Text("", 0, 0));
							container.addChild(
								new Text(
									" " +
										theme.fg("dim", "Q: " + getTextContent(item.messages[i])),
									1,
									0,
								),
							);
							const answerText = extractText(item.messages[i + 1] as any);
							if (answerText.trim()) {
								container.addChild(new Markdown(answerText, 1, 1, mdTheme));
							} else {
								container.addChild(
									new Text(" " + theme.fg("warning", "(no answer text)"), 1, 0),
								);
							}
						}
					}

					// Hints
					const hints: string[] = [];
					if (items.length > 1) hints.push(theme.fg("dim", "↑↓") + " navigate");
					hints.push(theme.fg("dim", "enter") + " keep");
					hints.push(theme.fg("dim", "d") + " dismiss");
					if (item.status === "done")
						hints.push(theme.fg("dim", "tab") + " follow-up");
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
							if (threads.filter((t) => t.status !== "pending").length === 0)
								done(undefined);
							else tui.requestRender();
						} else if (matchesKey(data, "d")) {
							// Dismiss
							const ti = threads.indexOf(item);
							if (ti >= 0) threads.splice(ti, 1);
							updateWidget();
							rebuild();
							if (threads.filter((t) => t.status !== "pending").length === 0)
								done(undefined);
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
			const newQuestion = await ctx.ui.custom<string | null>(
				(_tui: any, theme: any, _kb: any, done: (r: string | null) => void) => {
					const container = new Container();
					const border = new DynamicBorder((s: string) =>
						theme.fg("accent", s),
					);
					const input = new Input();
					input.focused = true;
					input.onSubmit = (v: string) => {
						if (v.trim()) done(v.trim());
					};
					input.onEscape = () => done(null);

					container.addChild(border);
					container.addChild(
						new Text(" " + theme.fg("accent", "Follow-up question:"), 1, 0),
					);
					container.addChild(input);
					container.addChild(
						new Text(
							" " +
								theme.fg("dim", "enter") +
								" submit  " +
								theme.fg("dim", "esc") +
								" cancel",
							1,
							0,
						),
					);
					container.addChild(border);

					return {
						render: (w: number) => container.render(w),
						invalidate: () => container.invalidate(),
						handleInput: (data: string) => input.handleInput(data),
					};
				},
			);

			if (newQuestion) {
				thread.latestQuestion = newQuestion;
				fireQuestion(thread, ctx.model, ctx.modelRegistry, ctx.cwd);
			}
		}
	}
}
