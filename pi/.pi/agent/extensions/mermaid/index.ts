import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Markdown, visibleWidth } from "@mariozechner/pi-tui";
import { renderMermaidASCII } from "beautiful-mermaid";

type MarkdownToken = {
	type?: string;
	lang?: string;
	text?: string;
};

type RenderToken = (token: unknown, width: number, nextTokenType?: string, styleContext?: unknown) => string[];
type RenderMarkdown = (width: number) => string[];

type PatchState = {
	originalRenderToken: RenderToken;
	renderTokenWrapper: RenderToken;
	originalRender: RenderMarkdown;
	renderWrapper: RenderMarkdown;
	renderMermaid: (token: MarkdownToken, width: number, nextTokenType?: string) => string[] | null;
	resumeHistoryRenderActive: boolean;
	skipMermaidMarkdown: WeakSet<object>;
};

const PATCH_STATE_KEY = Symbol.for("pi.mermaid.inline.patch");
const MERMAID_INLINE_OVERFLOW_COLS = 24;
const MERMAID_INLINE_OVERFLOW_RATIO = 1.2;

function getMarkdownProto() {
	return Markdown.prototype as Markdown.prototype & {
		render?: RenderMarkdown;
		renderToken?: RenderToken;
		[PATCH_STATE_KEY]?: PatchState;
	};
}

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

function setResumeHistoryRenderActive(active: boolean): void {
	const state = getMarkdownProto()[PATCH_STATE_KEY];
	if (state) {
		state.resumeHistoryRenderActive = active;
	}
}

function installMarkdownMermaidPatch(): void {
	const proto = getMarkdownProto();

	const existing = proto[PATCH_STATE_KEY];
	if (existing) {
		existing.renderMermaid = renderMermaidBlock;
		return;
	}

	const originalRenderToken = proto.renderToken;
	const originalRender = proto.render;
	if (typeof originalRenderToken !== "function" || typeof originalRender !== "function") {
		return;
	}

	const state: PatchState = {
		originalRenderToken,
		renderTokenWrapper: function (this: unknown, token: unknown, width: number, nextTokenType?: string, styleContext?: unknown) {
			if (this && typeof this === "object" && state.skipMermaidMarkdown.has(this as object)) {
				return state.originalRenderToken.call(this, token, width, nextTokenType, styleContext);
			}

			const custom = state.renderMermaid(token as MarkdownToken, width, nextTokenType);
			if (custom) {
				return custom;
			}
			return state.originalRenderToken.call(this, token, width, nextTokenType, styleContext);
		},
		originalRender,
		renderWrapper: function (this: unknown, width: number) {
			if (state.resumeHistoryRenderActive && this && typeof this === "object") {
				state.skipMermaidMarkdown.add(this as object);
			}
			return state.originalRender.call(this, width);
		},
		renderMermaid: renderMermaidBlock,
		resumeHistoryRenderActive: false,
		skipMermaidMarkdown: new WeakSet<object>(),
	};

	proto[PATCH_STATE_KEY] = state;
	proto.render = state.renderWrapper;
	proto.renderToken = state.renderTokenWrapper;
}

function uninstallMarkdownMermaidPatch(): void {
	const proto = getMarkdownProto();
	const state = proto[PATCH_STATE_KEY];
	if (!state) {
		return;
	}

	if (proto.render === state.renderWrapper) {
		proto.render = state.originalRender;
	}

	if (proto.renderToken === state.renderTokenWrapper) {
		proto.renderToken = state.originalRenderToken;
	}

	delete proto[PATCH_STATE_KEY];
}

export default function (pi: ExtensionAPI) {
	installMarkdownMermaidPatch();

	pi.on("session_start", async (event) => {
		setResumeHistoryRenderActive(event.reason === "resume");
	});

	pi.on("agent_start", async () => {
		setResumeHistoryRenderActive(false);
	});

	pi.on("session_shutdown", async () => {
		uninstallMarkdownMermaidPatch();
	});
}
