/**
 * Mermaid Render Extension
 *
 * Ported from https://github.com/can1357/oh-my-pi
 *
 * Two capabilities:
 *   1. render_mermaid tool — LLM이 직접 호출하여 Mermaid → ASCII 변환
 *   2. 어시스턴트 메시지의 ```mermaid 코드블록 자동 프리렌더 + 인라인 ASCII 치환
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import {
	DEFAULT_MAX_BYTES,
	DEFAULT_MAX_LINES,
	truncateHead,
} from "@mariozechner/pi-coding-agent";
import { Text } from "@mariozechner/pi-tui";
import { Type } from "@sinclair/typebox";
import { renderMermaidASCII, type AsciiRenderOptions } from "beautiful-mermaid";

// ── Helpers ─────────────────────────────────────────────────────────────────

function renderSafe(source: string, options?: AsciiRenderOptions): string | null {
	try {
		return renderMermaidASCII(source, { colorMode: "none", ...options });
	} catch {
		return null;
	}
}

function extractMermaidBlocks(markdown: string): { source: string; start: number; end: number }[] {
	const blocks: { source: string; start: number; end: number }[] = [];
	const regex = /```mermaid\s*\n([\s\S]*?)```/g;
	for (let m = regex.exec(markdown); m !== null; m = regex.exec(markdown)) {
		blocks.push({ source: m[1].trim(), start: m.index, end: m.index + m[0].length });
	}
	return blocks;
}

function sanitizeConfig(c: Record<string, unknown> | undefined): AsciiRenderOptions {
	const base: AsciiRenderOptions = { colorMode: "none" };
	if (!c) return base;
	return {
		...base,
		useAscii: typeof c.useAscii === "boolean" ? c.useAscii : undefined,
		paddingX: typeof c.paddingX === "number" ? Math.max(0, Math.floor(c.paddingX)) : undefined,
		paddingY: typeof c.paddingY === "number" ? Math.max(0, Math.floor(c.paddingY)) : undefined,
		boxBorderPadding: typeof c.boxBorderPadding === "number" ? Math.max(0, Math.floor(c.boxBorderPadding)) : undefined,
	};
}

// ── Cache (hash → rendered ASCII) ───────────────────────────────────────────

const cache = new Map<string, string>();
const failed = new Set<string>();

const MAX_DIAGRAM_WIDTH = 140;

function hashSource(source: string): string {
	// Simple hash for cache key
	let h = 0;
	for (let i = 0; i < source.length; i++) {
		h = ((h << 5) - h + source.charCodeAt(i)) | 0;
	}
	return String(h);
}

function getMaxLineWidth(text: string): number {
	return text.split("\n").reduce((max, line) => Math.max(max, line.length), 0);
}

function prerenderBlocks(markdown: string): boolean {
	const blocks = extractMermaidBlocks(markdown);
	let hasNew = false;
	for (const { source } of blocks) {
		const key = hashSource(source);
		if (cache.has(key) || failed.has(key)) continue;
		const ascii = renderSafe(source);
		if (ascii) {
			cache.set(key, ascii);
			hasNew = true;
		} else {
			failed.add(key);
		}
	}
	return hasNew;
}

// ── Extension ───────────────────────────────────────────────────────────────

export default function (pi: ExtensionAPI) {
	// ── 1. render_mermaid Tool ──────────────────────────────────────────────

	pi.registerTool({
		name: "render_mermaid",
		label: "RenderMermaid",
		description: [
			"Convert Mermaid graph source into ASCII diagram output.",
			"",
			"Parameters:",
			"- `mermaid` (required): Mermaid graph text to render.",
			"- `config` (optional): JSON render configuration (spacing and layout options).",
			"Behavior:",
			"- Returns ASCII diagram text.",
			"- Returns an error when the Mermaid input is invalid or rendering fails.",
		].join("\n"),
		promptSnippet: "Render Mermaid diagram source to ASCII art",
		promptGuidelines: [
			"Always use English labels in Mermaid node text — CJK characters break box alignment in ASCII output.",
			"Keep Mermaid labels short and compact. Prefer 2-4 words per node. Put detailed explanation in bullets outside the diagram.",
			"Split complex explanations into multiple small diagrams instead of one very wide diagram.",
			"When you need a diagram, call render_mermaid instead of emitting a ```mermaid code block. Never output both the rendered diagram and the source block.",
			"After calling render_mermaid, do not paste the ASCII diagram again in the assistant message unless the user explicitly asks for the raw text.",
		],
		parameters: Type.Object({
			mermaid: Type.String({ description: "Mermaid graph source text" }),
			config: Type.Optional(
				Type.Object({
					useAscii: Type.Optional(Type.Boolean()),
					paddingX: Type.Optional(Type.Number()),
					paddingY: Type.Optional(Type.Number()),
					boxBorderPadding: Type.Optional(Type.Number()),
				}),
			),
		}),

		async execute(_toolCallId, params) {
			const ascii = renderMermaidASCII(params.mermaid, sanitizeConfig(params.config ?? undefined));
			const maxWidth = getMaxLineWidth(ascii);
			if (maxWidth > MAX_DIAGRAM_WIDTH) {
				throw new Error(
					`Diagram is too wide for terminal rendering (${maxWidth} columns). Retry with much shorter English labels and split the content into multiple smaller diagrams.`
				);
			}
			const key = hashSource(params.mermaid.trim());
			cache.set(key, ascii);

			return {
				content: [
					{
						type: "text",
						text: "Rendered Mermaid diagram successfully. The full ASCII diagram is already shown in the tool output above. Do not repeat the diagram verbatim unless the user asks for the raw text.",
					},
				],
				details: { ascii },
			};
		},

		renderCall(args, theme) {
			const src = typeof args.mermaid === "string" ? args.mermaid : "";
			const firstLine = src.split("\n")[0] ?? "";
			let text = theme.fg("toolTitle", theme.bold("render_mermaid "));
			text += theme.fg("dim", firstLine.length > 60 ? firstLine.slice(0, 57) + "…" : firstLine);
			return new Text(text, 0, 0);
		},

		renderResult(result, { expanded }, theme) {
			const ascii = typeof result.details?.ascii === "string" ? result.details.ascii : undefined;
			if (!ascii) return new Text(theme.fg("error", "No output"), 0, 0);

			if (!expanded) {
				const lines = ascii.split("\n");
				const preview = lines.slice(0, 3).join("\n");
				const suffix = lines.length > 3 ? `\n${theme.fg("dim", `… ${lines.length - 3} more lines`)}` : "";
				return new Text(preview + suffix, 0, 0);
			}
			return new Text(ascii, 0, 0);
		},
	});

	// ── 2. Inline mermaid pre-rendering ─────────────────────────────────────
	// Assistant 메시지의 ```mermaid 블록을 감지하면 ASCII로 변환하여
	// 다음 LLM 컨텍스트에 렌더된 결과를 보여줌

	pi.on("message_end", async (event) => {
		const msg = event.message;
		if (msg.role !== "assistant") return;
		for (const c of msg.content) {
			if (c.type === "text" && c.text) {
				prerenderBlocks(c.text);
			}
		}
	});

	// context 이벤트에서 assistant 메시지 내 ```mermaid 블록을 렌더된 ASCII로 치환
	pi.on("context", async (event) => {
		if (cache.size === 0) return;
		let changed = false;
		for (const msg of event.messages) {
			if (msg.type !== "message") continue;
			if (msg.message.role !== "assistant") continue;
			for (const c of msg.message.content) {
				if (c.type !== "text" || !c.text) continue;
				const blocks = extractMermaidBlocks(c.text);
				if (blocks.length === 0) continue;
				// Replace blocks from end to preserve indices
				let text = c.text;
				for (let i = blocks.length - 1; i >= 0; i--) {
					const b = blocks[i];
					const key = hashSource(b.source);
					const ascii = cache.get(key);
					if (ascii) {
						// Replace ```mermaid ... ``` with rendered ASCII wrapped in a code block
						text = text.slice(0, b.start) + "```\n" + ascii + "\n```" + text.slice(b.end);
						changed = true;
					}
				}
				c.text = text;
			}
		}
		if (changed) return { messages: event.messages };
	});
}
