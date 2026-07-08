import type { ExtensionContext } from "@mariozechner/pi-coding-agent";
import { DynamicBorder } from "@mariozechner/pi-coding-agent";
import {
  Input,
  Key,
  matchesKey,
  truncateToWidth,
  visibleWidth,
  type Component,
  type Focusable,
} from "@mariozechner/pi-tui";

const PICKER_MAX_VISIBLE = 30;
const MAX_DISPLAY_FOLDERS = 3;

interface PickerItem {
  value: string;
  label: string;
  searchText: string;
}

interface FuzzyMatchResult {
  matches: boolean;
  score: number;
}

interface PickerListTheme {
  selectedText: (text: string) => string;
  scrollInfo: (text: string) => string;
  noMatch: () => string;
}

function pickerEntriesFromFiles(files: string[]): string[] {
  const directories = new Set<string>();

  for (const file of files) {
    let slashIndex = file.indexOf("/");
    while (slashIndex !== -1) {
      directories.add(`${file.slice(0, slashIndex)}/`);
      slashIndex = file.indexOf("/", slashIndex + 1);
    }
  }

  return [...directories, ...files].sort();
}

function formatDisplayPath(entry: string): string {
  const isDirectory = entry.endsWith("/");
  const parts = entry.split("/").filter(Boolean);

  if (isDirectory) {
    if (parts.length <= MAX_DISPLAY_FOLDERS) return entry;
    return `…/${parts.slice(-MAX_DISPLAY_FOLDERS).join("/")}/`;
  }

  if (parts.length <= MAX_DISPLAY_FOLDERS + 1) return entry;

  const fileName = parts.at(-1)!;
  const folders = parts.slice(0, -1).slice(-MAX_DISPLAY_FOLDERS);
  return `…/${[...folders, fileName].join("/")}`;
}

function toPickerItems(entries: string[], cwd: string): PickerItem[] {
  const normalizedCwd = cwd.replace(/\\/g, "/");
  const cwdPrefix = normalizedCwd.endsWith("/") ? normalizedCwd : `${normalizedCwd}/`;

  return entries.map((entry) => ({
    value: entry,
    label: formatDisplayPath(entry),
    searchText: `${entry} ${cwdPrefix}${entry}`.toLowerCase(),
  }));
}

function isFuzzyBoundary(char: string): boolean {
  return char === " " || char === "-" || char === "_" || char === "." || char === "/" || char === ":";
}

function fuzzyMatchNormalized(queryLower: string, textLower: string): FuzzyMatchResult {
  if (queryLower.length === 0) return { matches: true, score: 0 };
  if (queryLower.length > textLower.length) return { matches: false, score: 0 };

  let queryIndex = 0;
  let score = 0;
  let lastMatchIndex = -1;
  let consecutiveMatches = 0;

  for (let i = 0; i < textLower.length && queryIndex < queryLower.length; i++) {
    if (textLower[i] !== queryLower[queryIndex]) continue;

    const isWordBoundary = i === 0 || isFuzzyBoundary(textLower[i - 1]!);

    if (lastMatchIndex === i - 1) {
      consecutiveMatches++;
      score -= consecutiveMatches * 5;
    } else {
      consecutiveMatches = 0;
      if (lastMatchIndex >= 0) score += (i - lastMatchIndex - 1) * 2;
    }

    if (isWordBoundary) score -= 10;
    score += i * 0.1;

    lastMatchIndex = i;
    queryIndex++;
  }

  if (queryIndex < queryLower.length) return { matches: false, score: 0 };
  if (queryLower === textLower) score -= 100;
  return { matches: true, score };
}

function fuzzyMatchLower(queryLower: string, textLower: string): FuzzyMatchResult {
  const primaryMatch = fuzzyMatchNormalized(queryLower, textLower);
  if (primaryMatch.matches) return primaryMatch;

  const alphaNumericMatch = queryLower.match(/^([a-z]+)([0-9]+)$/);
  const numericAlphaMatch = queryLower.match(/^([0-9]+)([a-z]+)$/);
  const swappedQuery = alphaNumericMatch
    ? `${alphaNumericMatch[2] ?? ""}${alphaNumericMatch[1] ?? ""}`
    : numericAlphaMatch
      ? `${numericAlphaMatch[2] ?? ""}${numericAlphaMatch[1] ?? ""}`
      : "";

  if (!swappedQuery) return primaryMatch;

  const swappedMatch = fuzzyMatchNormalized(swappedQuery, textLower);
  if (!swappedMatch.matches) return primaryMatch;
  return { matches: true, score: swappedMatch.score + 5 };
}

function folderPriority(value: string, query: string): number {
  if (!query.endsWith("/")) return 3;
  if (!value.endsWith("/")) return 3;
  if (value === query) return 0;
  if (value.startsWith(query)) return 1;
  return 2;
}

function filterPickerItems(items: PickerItem[], query: string): PickerItem[] {
  const trimmedQuery = query.trim();
  if (!trimmedQuery) return items;

  const tokens = trimmedQuery.toLowerCase().split(/[\s/]+/).filter(Boolean);
  if (tokens.length === 0) return items;

  const results: Array<{ item: PickerItem; score: number }> = [];
  for (const item of items) {
    let score = 0;
    let matched = true;

    for (const token of tokens) {
      const match = fuzzyMatchLower(token, item.searchText);
      if (!match.matches) {
        matched = false;
        break;
      }
      score += match.score;
    }

    if (matched) results.push({ item, score });
  }

  const filtered = results.sort((a, b) => a.score - b.score).map((result) => result.item);
  if (!trimmedQuery.endsWith("/")) return filtered;

  return filtered.sort(
    (a, b) => folderPriority(a.value, trimmedQuery) - folderPriority(b.value, trimmedQuery),
  );
}

function truncateStartToWidth(text: string, maxWidth: number): string {
  if (maxWidth <= 0) return "";
  if (visibleWidth(text) <= maxWidth) return text;

  const ellipsis = "…";
  const ellipsisWidth = visibleWidth(ellipsis);
  if (maxWidth <= ellipsisWidth) return truncateToWidth(ellipsis, maxWidth, "");

  const suffixWidth = maxWidth - ellipsisWidth;
  let suffix = "";

  for (const char of Array.from(text).reverse()) {
    const next = `${char}${suffix}`;
    if (visibleWidth(next) > suffixWidth) break;
    suffix = next;
  }

  return `${ellipsis}${suffix}`;
}

class FastPickerList implements Component {
  private items: PickerItem[];
  private selectedIndex = 0;

  constructor(items: PickerItem[], private readonly maxVisible: number, private readonly theme: PickerListTheme) {
    this.items = items;
  }

  setItems(items: PickerItem[]): void {
    this.items = items;
    this.selectedIndex = 0;
  }

  getSelectedItem(): PickerItem | null {
    return this.items[this.selectedIndex] ?? null;
  }

  render(width: number): string[] {
    if (this.items.length === 0) return [this.theme.noMatch()];

    const startIndex = Math.max(
      0,
      Math.min(this.selectedIndex - Math.floor(this.maxVisible / 2), this.items.length - this.maxVisible),
    );
    const endIndex = Math.min(startIndex + this.maxVisible, this.items.length);
    const lines: string[] = [];

    for (let i = startIndex; i < endIndex; i++) {
      const item = this.items[i];
      if (!item) continue;

      const isSelected = i === this.selectedIndex;
      const prefix = isSelected ? "→ " : "  ";
      const maxWidth = Math.max(1, width - visibleWidth(prefix) - 2);
      const truncatedValue = truncateStartToWidth(item.label || item.value, maxWidth);
      const line = `${prefix}${truncatedValue}`;
      lines.push(isSelected ? this.theme.selectedText(line) : line);
    }

    if (startIndex > 0 || endIndex < this.items.length) {
      const scrollText = `  (${this.selectedIndex + 1}/${this.items.length})`;
      lines.push(this.theme.scrollInfo(truncateToWidth(scrollText, Math.max(1, width - 2), "")));
    }

    return lines;
  }

  handleInput(data: string): void {
    if (this.items.length === 0) return;

    if (matchesKey(data, Key.up)) {
      this.selectedIndex = this.selectedIndex === 0 ? this.items.length - 1 : this.selectedIndex - 1;
    } else if (matchesKey(data, Key.down)) {
      this.selectedIndex = this.selectedIndex === this.items.length - 1 ? 0 : this.selectedIndex + 1;
    }
  }

  invalidate(): void {}
}

export async function showFuzzyFilePicker(
  ctx: ExtensionContext,
  files: string[],
  initialQuery = "",
): Promise<void> {
  if (!ctx.hasUI) return;

  const entries = pickerEntriesFromFiles(files);
  if (entries.length === 0) {
    ctx.ui.notify("No files or folders found", "warning");
    return;
  }

  await ctx.ui.custom<void>((tui, theme, _keybindings, done) => {
    const rows = tui.terminal.rows || 24;
    const overlayRows = Math.max(10, Math.floor(rows * 0.8));
    const maxVisible = Math.min(PICKER_MAX_VISIBLE, Math.max(5, overlayRows - 8));
    const borderTop = new DynamicBorder((s: string) => theme.fg("accent", s));
    const borderBottom = new DynamicBorder((s: string) => theme.fg("accent", s));
    const searchInput = new Input();
    const allItems = toPickerItems(entries, ctx.cwd);
    const listTheme: PickerListTheme = {
      selectedText: (text: string) => theme.fg("accent", text),
      scrollInfo: (text: string) => theme.fg("dim", text),
      noMatch: () => theme.fg("warning", "  No matching files or folders"),
    };

    const choose = (value: string) => {
      ctx.ui.pasteToEditor(`@${value} `);
      done(undefined);
    };

    if (initialQuery) searchInput.setValue(initialQuery);

    let filteredItems = filterPickerItems(allItems, searchInput.getValue());
    const pickerList = new FastPickerList(filteredItems, maxVisible, listTheme);
    let lastQuery = searchInput.getValue();
    let focused = false;

    const applyFilter = (query: string) => {
      filteredItems = filterPickerItems(allItems, query);
      pickerList.setItems(filteredItems);
    };

    const component: Component & Focusable = {
      get focused(): boolean {
        return focused;
      },
      set focused(value: boolean) {
        focused = value;
        searchInput.focused = value;
      },

      render(width: number): string[] {
        const innerWidth = Math.max(1, width - 2);
        const query = searchInput.getValue();
        const matchInfo = query
          ? theme.fg("dim", ` ${filteredItems.length}/${entries.length}`)
          : theme.fg("dim", ` ${entries.length} entries`);
        const separator = theme.fg("dim", ` ${"─".repeat(Math.max(1, innerWidth))}`);

        const lines: string[] = [];
        lines.push(...borderTop.render(width));
        lines.push(
          truncateToWidth(
            ` ${theme.fg("accent", theme.bold("🔍 Files & Folders"))}${matchInfo}${theme.fg("dim", " fuzzy")}`,
            width,
          ),
        );
        lines.push("");
        for (const line of searchInput.render(innerWidth)) {
          lines.push(truncateToWidth(` ${line}`, width));
        }
        lines.push(truncateToWidth(separator, width));
        lines.push(...pickerList.render(width));
        lines.push("");
        lines.push(
          truncateToWidth(
            ` ${theme.fg("dim", "↑↓")} ${theme.fg("muted", "navigate")}  ${theme.fg("dim", "enter")} ${theme.fg("muted", "insert @path")}  ${theme.fg("dim", "esc")} ${theme.fg("muted", "cancel")}`,
            width,
          ),
        );
        lines.push(...borderBottom.render(width));
        return lines;
      },

      invalidate(): void {
        borderTop.invalidate();
        borderBottom.invalidate();
        searchInput.invalidate();
        pickerList.invalidate();
      },

      handleInput(data: string): void {
        if (matchesKey(data, Key.escape) || matchesKey(data, Key.ctrl("c"))) {
          done(undefined);
          return;
        }

        if (matchesKey(data, Key.enter)) {
          const selected = pickerList.getSelectedItem();
          if (selected) choose(selected.value);
          else done(undefined);
          return;
        }

        if (matchesKey(data, Key.up) || matchesKey(data, Key.down)) {
          pickerList.handleInput(data);
          tui.requestRender();
          return;
        }

        searchInput.handleInput(data);
        const nextQuery = searchInput.getValue();
        if (nextQuery !== lastQuery) {
          applyFilter(nextQuery);
          lastQuery = nextQuery;
        }
        tui.requestRender();
      },
    };

    return component;
  }, {
    overlay: true,
    overlayOptions: {
      anchor: "center",
      width: "80%",
      minWidth: 40,
      maxHeight: "80%",
      margin: 2,
    },
  });
}
