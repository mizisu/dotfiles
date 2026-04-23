import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { complete } from "@mariozechner/pi-ai";
import { resolveSmallModel } from "./shared/model-slots.js";

const MAX_NAME_LENGTH = 72;
const MAX_USER_MESSAGE_LENGTH = 1400;

function normalizeText(text: string): string {
	return text
		.replace(/[\r\n\t]+/g, " ")
		.replace(/ +/g, " ")
		.trim();
}

function extractText(content: unknown): string {
	if (typeof content === "string") return normalizeText(content);
	if (!Array.isArray(content)) return "";

	const textParts = content
		.filter(
			(part): part is { type?: string; text?: unknown } =>
				!!part && typeof part === "object" && "type" in part && "text" in part && typeof (part as { text?: unknown }).text === "string",
		)
		.filter((part) => part.type === "text")
		.map((part) => part.text as string);

	return normalizeText(textParts.join(" "));
}

function trimName(name: string): string {
	const clean = normalizeText(name)
		.replace(/^['"`]+|['"`]+$/g, "")
		.replace(/^[\-:•*\s]+|[\-:•*\s]+$/g, "")
		.trim();

	if (clean.length <= MAX_NAME_LENGTH) return clean;

	const candidate = clean.slice(0, MAX_NAME_LENGTH + 1);
	const cut = candidate.lastIndexOf(" ");
	return (cut > 10 ? candidate.slice(0, cut) : candidate).trim();
}

function fallbackName(input: string): string {
	return normalizeText(input)
		.split(" ")
		.filter(Boolean)
		.slice(0, 12)
		.join(" ")
		.slice(0, MAX_NAME_LENGTH) || "새 세션";
}

function buildModelPrompt(prompt: string): { systemPrompt: string; messages: { role: "user"; content: { type: "text"; text: string }[]; timestamp: number }[] } {
	return {
		systemPrompt:
			"You create session titles for coding work. Describe the work to be done, not the user's wording. Focus on the action, target, and relevant scope, like 'session-auto-name 제목 길이 늘리기', '로그인 버그 원인 분석 및 수정', 'PR 템플릿 체크리스트 항목 추가', or '캐시 무효화 흐름 설명'. Avoid complaint-style or conversational summaries like '요약이 이상한 것 같아' or '이거 봐줘'. Match the user's language. Prefer titles that are specific enough to distinguish similar tasks, and do not over-shorten them. Return 1 line only, no markdown, no quotes, no prefix, under 72 characters.",
		messages: [
			{
				role: "user",
				content: [
					{
						type: "text",
						text: `First user request:\n${prompt}`,
					},
				],
				timestamp: Date.now(),
			},
		],
	};
}

type NamingContext = Parameters<typeof resolveSmallModel>[0] & { signal?: AbortSignal };

async function generateSessionName(prompt: string, ctx: NamingContext): Promise<string> {
	const resolved = await resolveSmallModel(ctx);
	if (!resolved.model || !resolved.auth?.apiKey) return fallbackName(prompt);

	try {
		const response = await complete(
			resolved.model,
			buildModelPrompt(prompt),
			{
				apiKey: resolved.auth.apiKey,
				headers: resolved.auth.headers,
				signal: ctx.signal,
			},
		);

		const generated = response.content
			.filter((block): block is { type: "text"; text: string } =>
				!!block && typeof block === "object" && block.type === "text" && typeof block.text === "string",
			)
			.map((block) => block.text)
			.join("\n")
			.split("\n")[0]
			.trim();

		return trimName(generated) || fallbackName(prompt);
	} catch {
		return fallbackName(prompt);
	}
}

function hasUserMessage(entries: unknown[]): boolean {
	return entries.some((entry) => {
		if (!entry || typeof entry !== "object") return false;
		const maybeMessage = (entry as { type?: string; message?: { role?: string } }).message;
		return (entry as { type?: string }).type === "message" && maybeMessage?.role === "user";
	});
}

export default function (pi: ExtensionAPI) {
	let shouldAutoName = false;
	let hasRun = false;
	let running = false;

	pi.on("session_start", async (_event, ctx) => {
		shouldAutoName = !pi.getSessionName() && !hasUserMessage(ctx.sessionManager.getBranch());
		hasRun = false;
		running = false;
	});

	pi.on("message_end", async (event, ctx) => {
		if (!shouldAutoName || hasRun || running) return;
		const message = (event as any).message;
		if (!message || message.role !== "user") return;
		if (pi.getSessionName()) {
			hasRun = true;
			return;
		}

		const prompt = extractText(message.content);
		if (!prompt) return;

		hasRun = true;
		running = true;
		try {
			const name = await generateSessionName(prompt.slice(0, MAX_USER_MESSAGE_LENGTH), ctx);
			pi.setSessionName(name);
		} finally {
			running = false;
		}
	});
}
