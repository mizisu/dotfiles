// @ts-nocheck -- pi runtime resolves extension package imports.
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Container, Markdown, truncateToWidth, visibleWidth } from "@mariozechner/pi-tui";
import { renderMermaidASCII } from "beautiful-mermaid";

type MarkdownToken = {
  type?: string;
  lang?: string;
  text?: string;
};

type RenderToken = (token: unknown, width: number, nextTokenType?: string, styleContext?: unknown) => string[];
type RenderMarkdown = (width: number) => string[];
type SetExpanded = (expanded: boolean) => void;

type PatchState = {
  originalRenderToken: RenderToken;
  renderTokenWrapper: RenderToken;
  originalRender: RenderMarkdown;
  renderWrapper: RenderMarkdown;
  originalMarkdownSetExpanded?: SetExpanded;
  markdownSetExpandedWrapper: SetExpanded;
  originalContainerSetExpanded?: SetExpanded;
  containerSetExpandedWrapper: SetExpanded;
  expandedMarkdown: WeakSet<object>;
  resumeHistoryRenderActive: boolean;
  skipMermaidMarkdown: WeakSet<object>;
};

interface PiTheme {
  name?: string;
  fg?: (color: string, text: string) => string;
  getColorMode?: () => string;
}

const PATCH_STATE_KEY = Symbol.for("pi.mermaid.inline.patch");
const MAX_CACHE_ENTRIES = 80;
const MAX_SOURCE_CHARS = 16_000;
const INLINE_OVERFLOW_COLS = 24;
const INLINE_OVERFLOW_RATIO = 1.2;
const supportedLang = /^mermaid\b/i;
const MERMAID_FENCE_PATTERN = /^```[^\S\r\n]*mermaid\b/im;
const THEME_KEYS = [
  Symbol.for("@mariozechner/pi-coding-agent:theme"),
  Symbol.for("@earendil-works/pi-coding-agent:theme"),
];
const MERMAID_BORDER_CHARS = new Set(Array.from("┌┐└┘├┤┬┴┼╭╮╰╯╔╗╚╝╠╣╦╩╬+"));
const MERMAID_LINE_CHARS = new Set(Array.from("│─┃━┆┇┊┋┄┅┈┉╌╍-|"));
const MERMAID_ARROW_CHARS = new Set(Array.from("▶◀▲▼►◄↑↓←→<>"));

const renderCache = new Map<string, string[] | null>();

function markdownProto() {
  return Markdown.prototype as Markdown.prototype & {
    render?: RenderMarkdown;
    renderToken?: RenderToken;
    setExpanded?: SetExpanded;
    [PATCH_STATE_KEY]?: PatchState;
  };
}

function containerProto() {
  return Container.prototype as Container & { setExpanded?: SetExpanded };
}

function markdownText(instance: unknown): string {
  const text = (instance as { text?: unknown })?.text;
  return typeof text === "string" ? text : "";
}

function hasMermaidFence(instance: unknown): boolean {
  return MERMAID_FENCE_PATTERN.test(markdownText(instance));
}

function isMarkdownExpanded(instance: unknown): boolean {
  const state = markdownProto()[PATCH_STATE_KEY];
  return !!(state && instance && typeof instance === "object" && state.expandedMarkdown.has(instance));
}

function cacheGet(key: string): string[] | null | undefined {
  if (!renderCache.has(key)) return undefined;
  const value = renderCache.get(key);
  if (value === undefined) return undefined;
  renderCache.delete(key);
  renderCache.set(key, value);
  return value;
}

function cacheSet(key: string, value: string[] | null): void {
  renderCache.set(key, value);
  while (renderCache.size > MAX_CACHE_ENTRIES) {
    const oldest = renderCache.keys().next().value;
    if (oldest === undefined) break;
    renderCache.delete(oldest);
  }
}

function currentPiTheme(): PiTheme | undefined {
  const globals = globalThis as unknown as { [key: symbol]: PiTheme | undefined };
  for (const key of THEME_KEYS) {
    const theme = globals[key];
    if (theme?.fg) return theme;
  }
  return undefined;
}

function themeSignature(): string {
  const theme = currentPiTheme();
  return `${theme?.name ?? "default"}:${theme?.getColorMode?.() ?? ""}`;
}

function mermaidColorToken(char: string): string | undefined {
  if (char === " ") return undefined;
  if (MERMAID_ARROW_CHARS.has(char)) return "accent";
  if (MERMAID_BORDER_CHARS.has(char)) return "border";
  if (MERMAID_LINE_CHARS.has(char)) return "muted";
  return "mdCodeBlock";
}

function applyThemeColor(theme: PiTheme, token: string | undefined, text: string): string {
  if (!token || !text) return text;
  try {
    return theme.fg?.(token, text) ?? text;
  } catch {
    return text;
  }
}

function styleMermaidLine(line: string): string {
  const theme = currentPiTheme();
  if (!theme?.fg) return line;

  let result = "";
  let currentToken: string | undefined;
  let buffer = "";

  const flush = () => {
    result += applyThemeColor(theme, currentToken, buffer);
    buffer = "";
  };

  for (const char of Array.from(line)) {
    const token = mermaidColorToken(char);
    if (token !== currentToken) {
      flush();
      currentToken = token;
    }
    buffer += char;
  }

  flush();
  return result;
}

function renderMermaidBlock(token: MarkdownToken, width: number, nextTokenType?: string): string[] | null {
  if (token.type !== "code" || !supportedLang.test(token.lang ?? "") || typeof token.text !== "string") return null;

  const source = token.text.trim();
  if (!source || source.length > MAX_SOURCE_CHARS) return null;

  const cacheKey = `${width}\0${themeSignature()}\0${source}`;
  const cached = cacheGet(cacheKey);
  if (cached !== undefined) return cached ? [...cached] : null;

  try {
    const ascii = renderMermaidASCII(source, { colorMode: "none" }).trimEnd();
    if (!ascii) {
      cacheSet(cacheKey, null);
      return null;
    }

    const plainLines = ascii.split("\n").map((line) => truncateToWidth(line, Math.max(1, width), "…"));
    const maxLineWidth = plainLines.reduce((max, line) => Math.max(max, visibleWidth(line)), 0);
    const maxInlineWidth = Math.max(width + INLINE_OVERFLOW_COLS, Math.floor(width * INLINE_OVERFLOW_RATIO));
    if (maxLineWidth > maxInlineWidth) {
      cacheSet(cacheKey, null);
      return null;
    }

    const lines = plainLines.map(styleMermaidLine);
    const rendered = nextTokenType && nextTokenType !== "space" ? [...lines, ""] : lines;
    cacheSet(cacheKey, rendered);
    return [...rendered];
  } catch {
    cacheSet(cacheKey, null);
    return null;
  }
}

function setResumeHistoryRenderActive(active: boolean): void {
  const state = markdownProto()[PATCH_STATE_KEY];
  if (state) state.resumeHistoryRenderActive = active;
}

function installMarkdownPatch(): void {
  const mdProto = markdownProto();
  const cnProto = containerProto();
  const existing = mdProto[PATCH_STATE_KEY];
  if (existing) return;

  const originalRenderToken = mdProto.renderToken;
  const originalRender = mdProto.render;
  if (typeof originalRenderToken !== "function" || typeof originalRender !== "function") return;

  const state: PatchState = {
    originalRenderToken,
    renderTokenWrapper: function (this: unknown, token: unknown, width: number, nextTokenType?: string, styleContext?: unknown) {
      if (this && typeof this === "object" && state.skipMermaidMarkdown.has(this as object)) {
        return state.originalRenderToken.call(this, token, width, nextTokenType, styleContext);
      }

      if (isMarkdownExpanded(this)) {
        const custom = renderMermaidBlock(token as MarkdownToken, width);
        if (custom) {
          const source = state.originalRenderToken.call(this, token, width, nextTokenType, styleContext);
          return [...custom, "", ...source];
        }
        return state.originalRenderToken.call(this, token, width, nextTokenType, styleContext);
      }

      const custom = renderMermaidBlock(token as MarkdownToken, width, nextTokenType);
      if (custom) return custom;
      return state.originalRenderToken.call(this, token, width, nextTokenType, styleContext);
    },
    originalRender,
    renderWrapper: function (this: unknown, width: number) {
      if (state.resumeHistoryRenderActive && this && typeof this === "object") {
        state.skipMermaidMarkdown.add(this as object);
      }
      return state.originalRender.call(this, width);
    },
    originalMarkdownSetExpanded: mdProto.setExpanded,
    markdownSetExpandedWrapper: function (this: unknown, expanded: boolean) {
      const hasMermaid = hasMermaidFence(this);
      const wasExpanded = isMarkdownExpanded(this);

      if (this && typeof this === "object") {
        if (expanded) state.expandedMarkdown.add(this);
        else state.expandedMarkdown.delete(this);
      }

      state.originalMarkdownSetExpanded?.call(this, expanded);

      if (hasMermaid && wasExpanded !== expanded && typeof (this as { invalidate?: unknown })?.invalidate === "function") {
        (this as { invalidate: () => void }).invalidate();
      }
    },
    originalContainerSetExpanded: cnProto.setExpanded,
    containerSetExpandedWrapper: function (this: unknown, expanded: boolean) {
      state.originalContainerSetExpanded?.call(this, expanded);

      const children = (this as { children?: unknown })?.children;
      if (!Array.isArray(children)) return;
      for (const child of children) {
        const setExpanded = (child as { setExpanded?: unknown })?.setExpanded;
        if (typeof setExpanded === "function") setExpanded.call(child, expanded);
      }
    },
    expandedMarkdown: new WeakSet<object>(),
    resumeHistoryRenderActive: false,
    skipMermaidMarkdown: new WeakSet<object>(),
  };

  mdProto[PATCH_STATE_KEY] = state;
  mdProto.renderToken = state.renderTokenWrapper;
  mdProto.render = state.renderWrapper;
  mdProto.setExpanded = state.markdownSetExpandedWrapper;
  cnProto.setExpanded = state.containerSetExpandedWrapper;
}

function uninstallMarkdownPatch(): void {
  const mdProto = markdownProto();
  const cnProto = containerProto();
  const state = mdProto[PATCH_STATE_KEY];
  if (!state) return;

  if (mdProto.renderToken === state.renderTokenWrapper) mdProto.renderToken = state.originalRenderToken;
  if (mdProto.render === state.renderWrapper) mdProto.render = state.originalRender;
  if (mdProto.setExpanded === state.markdownSetExpandedWrapper) {
    if (state.originalMarkdownSetExpanded) mdProto.setExpanded = state.originalMarkdownSetExpanded;
    else delete mdProto.setExpanded;
  }
  if (cnProto.setExpanded === state.containerSetExpandedWrapper) {
    if (state.originalContainerSetExpanded) cnProto.setExpanded = state.originalContainerSetExpanded;
    else delete cnProto.setExpanded;
  }

  delete mdProto[PATCH_STATE_KEY];
  renderCache.clear();
}

export default function mermaidExtension(pi: ExtensionAPI) {
  installMarkdownPatch();

  pi.on("session_start", (event) => {
    setResumeHistoryRenderActive(event.reason === "resume");
  });

  pi.on("agent_start", () => {
    setResumeHistoryRenderActive(false);
  });

  pi.on("session_shutdown", () => {
    uninstallMarkdownPatch();
  });
}
