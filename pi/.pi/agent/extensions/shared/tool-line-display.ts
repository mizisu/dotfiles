import type { ThemeColor } from "@mariozechner/pi-coding-agent";

export type LineDisplayTheme = {
  fg(color: ThemeColor, text: string): string;
};

export type LineMarker = " " | "+" | "-";

export function lineNumberWidth(...lineNumbers: number[]): number {
  const maxLineNumber = Math.max(1, ...lineNumbers.filter((lineNumber) => Number.isFinite(lineNumber) && lineNumber > 0));
  return String(Math.floor(maxLineNumber)).length;
}

export function lineGutter(
  theme: LineDisplayTheme,
  lineNumber: number,
  width: number,
  color: ThemeColor = "dim",
  marker: LineMarker = " ",
): string {
  return theme.fg(color, `${marker}${String(Math.floor(lineNumber)).padStart(width, " ")} │ `);
}

export function blankLineGutter(
  theme: LineDisplayTheme,
  width: number,
  color: ThemeColor = "dim",
  marker: LineMarker = " ",
): string {
  return theme.fg(color, `${marker}${" ".repeat(Math.max(1, width))} │ `);
}

export function numberedLine(
  theme: LineDisplayTheme,
  lineNumber: number,
  width: number,
  content: string,
  color: ThemeColor = "dim",
  marker: LineMarker = " ",
): string {
  return `${lineGutter(theme, lineNumber, width, color, marker)}${content}`;
}
