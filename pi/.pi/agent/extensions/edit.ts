import {
  createEditToolDefinition,
  createReadToolDefinition,
  getLanguageFromPath,
  highlightCode,
  keyHint,
  renderDiff,
  type ExtensionAPI,
  type ThemeColor,
} from "@mariozechner/pi-coding-agent";
import { Container, Spacer, Text, type Component } from "@mariozechner/pi-tui";

const READ_COLLAPSED_PREVIEW_LINES = 10;

type ThemeLike = {
  bold(text: string): string;
  fg(color: ThemeColor, text: string): string;
};

type RenderOptions = {
  expanded: boolean;
  isPartial: boolean;
};

function str(value: unknown): string | null {
  if (typeof value === "string") return value;
  if (value == null) return "";
  return null;
}

function recordFromArgs(args: unknown): Record<string, unknown> | undefined {
  return typeof args === "object" && args !== null ? (args as Record<string, unknown>) : undefined;
}

function pathFromArgs(args: unknown): string | null {
  const record = recordFromArgs(args);
  return str(record?.file_path ?? record?.path);
}

function lineOffsetFromArgs(args: unknown): number {
  const record = recordFromArgs(args);
  const raw = record?.offset;
  const value = typeof raw === "number" ? raw : typeof raw === "string" ? Number(raw) : 1;
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : 1;
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

function textOutputFromResult(result: unknown): string {
  const content = (result as { content?: Array<{ type?: string; text?: string }> } | undefined)?.content ?? [];
  return normalizeDisplayText(
    content
      .filter((block) => block?.type === "text")
      .map((block) => block.text ?? "")
      .join("\n"),
  );
}

const READ_NOTICE_RE = /^\[(?:Current model does not support images|Showing lines|Line \d+|First line|Truncated|Output truncated|\d+ more lines in file|.*truncated)/i;

function isReadNoticeLine(line: string): boolean {
  return READ_NOTICE_RE.test(line.trim());
}

function isImageReadOutput(output: string): boolean {
  return /^Read image file\b/.test(output.trimStart());
}

function plainToolOutput(output: string, theme: ThemeLike, color: ThemeColor = "toolOutput"): string {
  const lines = output.split("\n").map((line) => theme.fg(color, replaceTabs(line)));
  return lines.length > 0 ? `\n${lines.join("\n")}` : "";
}

function formatReadResultWithLineNumbers(
  args: unknown,
  result: unknown,
  options: RenderOptions,
  theme: ThemeLike,
  isError: boolean,
): string {
  const output = textOutputFromResult(result);
  if (!output) return "";
  if (isError) return plainToolOutput(output, theme, "error");
  if (isImageReadOutput(output)) return plainToolOutput(output, theme);

  const rawPath = pathFromArgs(args);
  const lang = rawPath ? getLanguageFromPath(rawPath) : undefined;
  const rawLines = output.split("\n");
  const noticeIndexes = new Set<number>();

  for (let i = 0; i < rawLines.length; i++) {
    if (!isReadNoticeLine(rawLines[i] ?? "")) continue;
    noticeIndexes.add(i);
    if (i > 0 && rawLines[i - 1] === "") noticeIndexes.add(i - 1);
  }

  const entries = rawLines.map((line, index) => ({
    kind: noticeIndexes.has(index) ? "notice" as const : "content" as const,
    line,
  }));
  const contentLines = entries.filter((entry) => entry.kind === "content").map((entry) => entry.line);

  if (contentLines.length === 0) {
    return plainToolOutput(output, theme, "warning");
  }

  const highlightedContent = lang
    ? highlightCode(replaceTabs(contentLines.join("\n")), lang)
    : contentLines.map((line) => theme.fg("toolOutput", replaceTabs(line)));

  const maxContentLines = options.expanded ? contentLines.length : READ_COLLAPSED_PREVIEW_LINES;
  const remaining = Math.max(0, contentLines.length - maxContentLines);
  const firstLineNumber = lineOffsetFromArgs(args);
  const lastVisibleLineNumber = firstLineNumber + Math.min(contentLines.length, maxContentLines) - 1;
  const gutterWidth = Math.max(String(firstLineNumber).length, String(lastVisibleLineNumber).length);
  const displayLines: string[] = [];
  let contentIndex = 0;
  let shownContent = 0;
  let lineNumber = firstLineNumber;
  let insertedCollapsedHint = false;

  const insertCollapsedHint = () => {
    if (remaining <= 0 || insertedCollapsedHint) return;
    displayLines.push(
      `${theme.fg("muted", `... (${remaining} more lines,`)} ${keyHint("app.tools.expand", "to expand")}${theme.fg("muted", ")")}`,
    );
    insertedCollapsedHint = true;
  };

  for (const entry of entries) {
    if (entry.kind === "notice") {
      insertCollapsedHint();
      if (entry.line === "") {
        displayLines.push("");
      } else {
        displayLines.push(theme.fg("warning", replaceTabs(entry.line)));
      }
      continue;
    }

    const highlightedLine = highlightedContent[contentIndex] ?? theme.fg("toolOutput", replaceTabs(entry.line));
    if (shownContent < maxContentLines) {
      const gutter = theme.fg("dim", `${String(lineNumber).padStart(gutterWidth, " ")} │ `);
      displayLines.push(`${gutter}${highlightedLine}`);
      shownContent++;
    }
    contentIndex++;
    lineNumber++;
  }

  insertCollapsedHint();
  return displayLines.length > 0 ? `\n${displayLines.join("\n")}` : "";
}

function parseDiffLine(line: string): { prefix: string; lineNum: string; content: string } | null {
  const match = line.match(/^([+\-\s])(\s*\d*)\s(.*)$/);
  if (!match) return null;
  return { prefix: match[1] ?? " ", lineNum: match[2] ?? "", content: match[3] ?? "" };
}

function diffColor(prefix: string): ThemeColor {
  if (prefix === "+") return "toolDiffAdded";
  if (prefix === "-") return "toolDiffRemoved";
  return "toolDiffContext";
}

function highlightDiffContent(content: string, lang: string | undefined, theme: ThemeLike): string {
  const normalized = replaceTabs(content);
  if (!lang) return theme.fg("toolOutput", normalized);
  return highlightCode(normalized, lang)[0] ?? "";
}

function renderSyntaxDiff(diffText: string, rawPath: string | null, theme: ThemeLike): string {
  const lang = rawPath ? getLanguageFromPath(rawPath) : undefined;
  if (!lang) return renderDiff(diffText);

  return diffText
    .split("\n")
    .map((line) => {
      const parsed = parseDiffLine(line);
      if (!parsed) return theme.fg("toolDiffContext", line);

      const color = diffColor(parsed.prefix);
      const gutter = theme.fg(color, `${parsed.prefix}${parsed.lineNum} `);

      if (parsed.lineNum.trim() === "" && parsed.content.trim() === "...") {
        return theme.fg("toolDiffContext", `${parsed.prefix}${parsed.lineNum} ${parsed.content}`);
      }

      return `${gutter}${highlightDiffContent(parsed.content, lang, theme)}`;
    })
    .join("\n");
}

function formatEditCall(args: unknown, theme: ThemeLike): string {
  return `${theme.fg("toolTitle", theme.bold("edit"))} ${renderPath(pathFromArgs(args), theme)}`;
}

function restyleEditCallComponent(component: Component, args: unknown, theme: ThemeLike): Component {
  const preview = (component as any)?.preview;
  if (!preview || typeof preview !== "object" || typeof preview.diff !== "string") return component;

  const container = component as any;
  if (typeof container.clear !== "function" || typeof container.addChild !== "function") return component;

  container.clear();
  container.addChild(new Text(formatEditCall(args, theme), 0, 0));
  container.addChild(new Spacer(1));
  container.addChild(new Text(renderSyntaxDiff(preview.diff, pathFromArgs(args), theme), 0, 0));
  return component;
}

export default function editExtension(pi: ExtensionAPI) {
  const baseReadTool = createReadToolDefinition(process.cwd());
  const baseEditTool = createEditToolDefinition(process.cwd());

  pi.registerTool({
    ...baseReadTool,
    async execute(toolCallId, params, signal, onUpdate, ctx) {
      return createReadToolDefinition(ctx.cwd).execute(toolCallId, params, signal, onUpdate, ctx);
    },
    renderResult(result, options, theme, context) {
      const text = context.lastComponent instanceof Text ? context.lastComponent : new Text("", 0, 0);
      text.setText(formatReadResultWithLineNumbers(context.args, result, options, theme, context.isError));
      return text;
    },
  });

  pi.registerTool({
    ...baseEditTool,
    async execute(toolCallId, params, signal, onUpdate, ctx) {
      return createEditToolDefinition(ctx.cwd).execute(toolCallId, params, signal, onUpdate, ctx);
    },
    renderCall(args, theme, context) {
      const component = baseEditTool.renderCall?.(args, theme, context) ?? new Text(formatEditCall(args, theme), 0, 0);
      return restyleEditCallComponent(component, args, theme);
    },
    renderResult(result, options, theme, context) {
      const component = baseEditTool.renderResult?.(result, options, theme, context) ?? new Container();
      const callComponent = (context.state as any)?.callComponent;
      if (callComponent) restyleEditCallComponent(callComponent, context.args, theme);
      return component;
    },
  });
}
