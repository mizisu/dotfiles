import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Markdown, visibleWidth } from "@mariozechner/pi-tui";
import { renderMermaidASCII } from "beautiful-mermaid";

type MarkdownToken = {
	type?: string;
	lang?: string;
	text?: string;
};

type RenderToken = (token: unknown, width: number, nextTokenType?: string, styleContext?: unknown) => string[];

type PatchState = {
	original: RenderToken;
	wrapper: RenderToken;
	renderMermaid: (token: MarkdownToken, width: number, nextTokenType?: string) => string[] | null;
};

const PATCH_STATE_KEY = Symbol.for("pi.mermaid.inline.patch");
const MERMAID_INLINE_OVERFLOW_COLS = 24;
const MERMAID_INLINE_OVERFLOW_RATIO = 1.2;

function renderMermaidBlock(token: MarkdownToken, width: number, nextTokenType?: string): string[] | null {
	if (token.type !== "code" || token.lang !== "mermaid" || typeof token.text !== "string") {
		return null;
	}

	const source = token.text.trim();
	if (!source) {
		return null;
	}

	try {
		const ascii = renderMermaidASCII(source, {
			colorMode: "none",
			useAscii: true,
		});
		const lines = ascii.split("\n");
		if (lines.length === 0) {
			return null;
		}
		const maxLineWidth = lines.reduce((max, line) => Math.max(max, visibleWidth(line)), 0);
		const maxInlineWidth = Math.max(width + MERMAID_INLINE_OVERFLOW_COLS, Math.floor(width * MERMAID_INLINE_OVERFLOW_RATIO));
		if (maxLineWidth > maxInlineWidth) {
			return null;
		}
		return nextTokenType && nextTokenType !== "space" ? [...lines, ""] : lines;
	} catch {
		return null;
	}
}

function installMarkdownMermaidPatch(): void {
	const proto = Markdown.prototype as Markdown.prototype & {
		renderToken?: RenderToken;
		[PATCH_STATE_KEY]?: PatchState;
	};

	const existing = proto[PATCH_STATE_KEY];
	if (existing) {
		existing.renderMermaid = renderMermaidBlock;
		return;
	}

	const original = proto.renderToken;
	if (typeof original !== "function") {
		return;
	}

	const state: PatchState = {
		original,
		wrapper: function (this: unknown, token: unknown, width: number, nextTokenType?: string, styleContext?: unknown) {
			const custom = state.renderMermaid(token as MarkdownToken, width, nextTokenType);
			if (custom) {
				return custom;
			}
			return state.original.call(this, token, width, nextTokenType, styleContext);
		},
		renderMermaid: renderMermaidBlock,
	};

	proto[PATCH_STATE_KEY] = state;
	proto.renderToken = state.wrapper;
}

function uninstallMarkdownMermaidPatch(): void {
	const proto = Markdown.prototype as Markdown.prototype & {
		renderToken?: RenderToken;
		[PATCH_STATE_KEY]?: PatchState;
	};

	const state = proto[PATCH_STATE_KEY];
	if (!state) {
		return;
	}

	if (proto.renderToken === state.wrapper) {
		proto.renderToken = state.original;
	}

	delete proto[PATCH_STATE_KEY];
}

export default function (pi: ExtensionAPI) {
	installMarkdownMermaidPatch();
	pi.on("session_shutdown", async () => {
		uninstallMarkdownMermaidPatch();
	});
}
