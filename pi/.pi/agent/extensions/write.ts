import {
  createWriteToolDefinition,
  getLanguageFromPath,
  highlightCode,
  keyHint,
  type ExtensionAPI,
  type ThemeColor,
} from "@mariozechner/pi-coding-agent";
import { Text } from "@mariozechner/pi-tui";
import { blankLineGutter, lineNumberWidth, numberedLine } from "./shared/tool-line-display.js";

const COLLAPSED_PREVIEW_LINES = 10;
const WRITE_PARTIAL_FULL_HIGHLIGHT_LINES = 50;

type ThemeLike = {
  bold(text: string): string;
  fg(color: ThemeColor, text: string): string;
};

type WriteHighlightCache = {
  rawPath: string;
  lang: string;
  rawContent: string;
  normalizedLines: string[];
  highlightedLines: string[];
};

class WriteCallRenderComponent extends Text {
  cache?: WriteHighlightCache;

  constructor() {
    super("", 0, 0);
  }
}

function str(value: unknown): string | null {
  if (typeof value === "string") return value;
  if (value == null) return "";
  return null;
}

function normalizeDisplayText(text: string): string {
  return text.replace(/\r/g, "");
}

function replaceTabs(text: string): string {
  return text.replace(/\t/g, "   ");
}

function shortenPath(filePath: string): string {
  const home = process.env.HOME || process.env.USERPROFILE || "";
  if (home && filePath.startsWith(home)) return `~${filePath.slice(home.length)}`;
  return filePath;
}

function renderPath(rawPath: string | null, theme: ThemeLike): string {
  if (rawPath === null) return theme.fg("error", "[invalid path arg]");
  if (!rawPath) return theme.fg("toolOutput", "...");
  return theme.fg("accent", shortenPath(rawPath));
}

function highlightSingleLine(line: string, lang: string): string {
  const highlighted = highlightCode(line, lang);
  return highlighted[0] ?? "";
}

function refreshWriteHighlightPrefix(cache: WriteHighlightCache): void {
  const prefixCount = Math.min(WRITE_PARTIAL_FULL_HIGHLIGHT_LINES, cache.normalizedLines.length);
  if (prefixCount === 0) return;

  const prefixSource = cache.normalizedLines.slice(0, prefixCount).join("\n");
  const prefixHighlighted = highlightCode(prefixSource, cache.lang);

  for (let i = 0; i < prefixCount; i++) {
    cache.highlightedLines[i] = prefixHighlighted[i] ?? highlightSingleLine(cache.normalizedLines[i] ?? "", cache.lang);
  }
}

function rebuildWriteHighlightCacheFull(rawPath: string, fileContent: string): WriteHighlightCache | undefined {
  const lang = rawPath ? getLanguageFromPath(rawPath) : undefined;
  if (!lang) return undefined;

  const displayContent = normalizeDisplayText(fileContent);
  const normalized = replaceTabs(displayContent);

  return {
    rawPath,
    lang,
    rawContent: fileContent,
    normalizedLines: normalized.split("\n"),
    highlightedLines: highlightCode(normalized, lang),
  };
}

function updateWriteHighlightCacheIncremental(
  cache: WriteHighlightCache | undefined,
  rawPath: string,
  fileContent: string,
): WriteHighlightCache | undefined {
  const lang = rawPath ? getLanguageFromPath(rawPath) : undefined;
  if (!lang) return undefined;
  if (!cache) return rebuildWriteHighlightCacheFull(rawPath, fileContent);
  if (cache.lang !== lang || cache.rawPath !== rawPath) return rebuildWriteHighlightCacheFull(rawPath, fileContent);
  if (!fileContent.startsWith(cache.rawContent)) return rebuildWriteHighlightCacheFull(rawPath, fileContent);
  if (fileContent.length === cache.rawContent.length) return cache;

  const deltaRaw = fileContent.slice(cache.rawContent.length);
  const deltaDisplay = normalizeDisplayText(deltaRaw);
  const deltaNormalized = replaceTabs(deltaDisplay);

  cache.rawContent = fileContent;

  if (cache.normalizedLines.length === 0) {
    cache.normalizedLines.push("");
    cache.highlightedLines.push("");
  }

  const segments = deltaNormalized.split("\n");
  const lastIndex = cache.normalizedLines.length - 1;
  cache.normalizedLines[lastIndex] += segments[0];
  cache.highlightedLines[lastIndex] = highlightSingleLine(cache.normalizedLines[lastIndex], cache.lang);

  for (let i = 1; i < segments.length; i++) {
    cache.normalizedLines.push(segments[i] ?? "");
    cache.highlightedLines.push(highlightSingleLine(segments[i] ?? "", cache.lang));
  }

  refreshWriteHighlightPrefix(cache);
  return cache;
}

function trimTrailingEmptyLines(lines: string[]): string[] {
  let end = lines.length;
  while (end > 0 && lines[end - 1] === "") end--;
  return lines.slice(0, end);
}

function formatWriteCall(
  args: unknown,
  options: { expanded: boolean; argsComplete: boolean; isPartial: boolean },
  theme: ThemeLike,
  cache: WriteHighlightCache | undefined,
): string {
  const record = typeof args === "object" && args !== null ? (args as Record<string, unknown>) : undefined;
  const rawPath = str(record?.file_path ?? record?.path);
  const fileContent = str(record?.content);
  const pathDisplay = renderPath(rawPath, theme);

  let text = `${theme.fg("toolTitle", theme.bold("write"))} ${pathDisplay}`;

  if (fileContent === null) {
    return `${text}\n\n${theme.fg("error", "[invalid content arg - expected string]")}`;
  }

  if (!fileContent) return text;

  const lang = rawPath ? getLanguageFromPath(rawPath) : undefined;
  const renderedLines = lang
    ? (cache?.highlightedLines ?? highlightCode(replaceTabs(normalizeDisplayText(fileContent)), lang))
    : normalizeDisplayText(fileContent).split("\n");
  const lines = trimTrailingEmptyLines(renderedLines);
  const totalLines = lines.length;
  const status = !options.argsComplete
    ? `generating ${totalLines} lines`
    : options.isPartial
      ? `writing ${totalLines} lines`
      : `${totalLines} lines`;

  text += ` ${theme.fg("muted", status)}`;

  if (lines.length === 0) return text;

  const showFull = options.expanded && !options.isPartial;
  const maxLines = showFull ? lines.length : COLLAPSED_PREVIEW_LINES;
  const followTail = !showFull;
  const start = followTail ? Math.max(0, lines.length - maxLines) : 0;
  const displayLines = lines.slice(start, start + maxLines);
  const remainingAfter = lines.length - start - displayLines.length;
  const gutterWidth = lineNumberWidth(1, totalLines);
  const previewLines: string[] = [];

  if (start > 0) {
    previewLines.push(`${blankLineGutter(theme, gutterWidth)}${theme.fg("muted", `... (${start} earlier lines, following latest output)`)}`);
  }

  previewLines.push(
    ...displayLines.map((line, index) => {
      const content = lang ? line : theme.fg("toolOutput", replaceTabs(line));
      return numberedLine(theme, start + index + 1, gutterWidth, content);
    }),
  );

  if (remainingAfter > 0) {
    previewLines.push(
      `${blankLineGutter(theme, gutterWidth)}${theme.fg("muted", `... (${remainingAfter} more lines, ${totalLines} total,`)} ${keyHint(
        "app.tools.expand",
        "to expand",
      )}${theme.fg("muted", ")")}`,
    );
  }

  text += `\n\n${previewLines.join("\n")}`;

  return text;
}

export default function writeExtension(pi: ExtensionAPI) {
  const baseWriteTool = createWriteToolDefinition(process.cwd());

  pi.registerTool({
    ...baseWriteTool,
    async execute(toolCallId, params, signal, onUpdate, ctx) {
      return createWriteToolDefinition(ctx.cwd).execute(toolCallId, params, signal, onUpdate, ctx);
    },
    renderCall(args, theme, context) {
      const record = typeof args === "object" && args !== null ? (args as Record<string, unknown>) : undefined;
      const rawPath = str(record?.file_path ?? record?.path);
      const fileContent = str(record?.content);
      const component =
        context.lastComponent instanceof WriteCallRenderComponent
          ? context.lastComponent
          : new WriteCallRenderComponent();

      if (fileContent !== null) {
        component.cache = context.argsComplete
          ? rebuildWriteHighlightCacheFull(rawPath ?? "", fileContent)
          : updateWriteHighlightCacheIncremental(component.cache, rawPath ?? "", fileContent);
      } else {
        component.cache = undefined;
      }

      component.setText(
        formatWriteCall(
          args,
          { expanded: context.expanded, argsComplete: context.argsComplete, isPartial: context.isPartial },
          theme,
          component.cache,
        ),
      );
      return component;
    },
  });
}
