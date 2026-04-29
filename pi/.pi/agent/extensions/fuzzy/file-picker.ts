import type { ExtensionContext } from "@mariozechner/pi-coding-agent";
import { DynamicBorder } from "@mariozechner/pi-coding-agent";
import {
  Input,
  Key,
  SelectList,
  fuzzyFilter,
  matchesKey,
  truncateToWidth,
  visibleWidth,
  type Component,
  type Focusable,
  type SelectItem,
  type SelectListLayoutOptions,
} from "@mariozechner/pi-tui";

const PICKER_MAX_VISIBLE = 30;
const MAX_DISPLAY_FOLDERS = 3;

function pickerEntriesFromFiles(files: string[]): string[] {
  const directories = new Set<string>();

  for (const file of files) {
    const parts = file.split("/").filter(Boolean);
    for (let i = 1; i < parts.length; i++) {
      directories.add(`${parts.slice(0, i).join("/")}/`);
    }
  }

  return [...directories, ...files].sort((a, b) => a.localeCompare(b));
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

function toPickerItems(entries: string[]): SelectItem[] {
  return entries.map((entry) => ({
    value: entry,
    label: formatDisplayPath(entry),
  }));
}

function folderPriority(value: string, query: string): number {
  if (!query.endsWith("/")) return 3;
  if (!value.endsWith("/")) return 3;
  if (value === query) return 0;
  if (value.startsWith(query)) return 1;
  return 2;
}

function filterPickerItems(items: SelectItem[], query: string, cwd: string): SelectItem[] {
  const trimmedQuery = query.trim();
  if (!trimmedQuery) return items;

  const filtered = fuzzyFilter(items, trimmedQuery, (item) => `${item.value} ${cwd}/${item.value}`);
  if (!trimmedQuery.endsWith("/")) return filtered;

  return [...filtered].sort(
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
    const allItems = toPickerItems(entries);
    const selectTheme = {
      selectedPrefix: (text: string) => theme.fg("accent", text),
      selectedText: (text: string) => theme.fg("accent", text),
      description: (text: string) => theme.fg("muted", text),
      scrollInfo: (text: string) => theme.fg("dim", text),
      noMatch: (_text: string) => theme.fg("warning", "  No matching files or folders"),
    };
    const selectLayout: SelectListLayoutOptions = {
      truncatePrimary: ({ text, maxWidth }) => truncateStartToWidth(text, maxWidth),
    };

    const choose = (value: string) => {
      ctx.ui.pasteToEditor(`@${value} `);
      done(undefined);
    };

    const createSelectList = (items: SelectItem[]) => {
      const list = new SelectList(items, maxVisible, selectTheme, selectLayout);
      list.onSelect = (item) => choose(item.value);
      list.onCancel = () => done(undefined);
      return list;
    };

    if (initialQuery) searchInput.setValue(initialQuery);

    let filteredItems = filterPickerItems(allItems, searchInput.getValue(), ctx.cwd);
    let selectList = createSelectList(filteredItems);
    let lastQuery = searchInput.getValue();
    let focused = false;

    const applyFilter = (query: string) => {
      filteredItems = filterPickerItems(allItems, query, ctx.cwd);
      selectList = createSelectList(filteredItems);
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
        lines.push(...selectList.render(width));
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
        selectList.invalidate();
      },

      handleInput(data: string): void {
        if (matchesKey(data, Key.escape) || matchesKey(data, Key.ctrl("c"))) {
          done(undefined);
          return;
        }

        if (matchesKey(data, Key.enter)) {
          const selected = selectList.getSelectedItem();
          if (selected) choose(selected.value);
          else done(undefined);
          return;
        }

        if (matchesKey(data, Key.up) || matchesKey(data, Key.down)) {
          selectList.handleInput(data);
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
