/**
 * File Picker Extension (local fuzzy filter)
 *
 * Replaces the built-in "@" file autocomplete with a full-screen fuzzy file/folder picker.
 *
 * Usage:
 *   - Type `@` to open the picker
 *   - Or type `/files` command
 *   - Type to fuzzy-search files and folders
 *   - ↑↓ to navigate, Enter to select, Esc to cancel
 *   - Selected entry is inserted as `@path/to/file ` or `@path/to/folder/ ` in the editor
 */

import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { DynamicBorder } from "@mariozechner/pi-coding-agent";
import {
	Input,
	SelectList,
	fuzzyFilter,
	matchesKey,
	Key,
	type SelectItem,
	type Component,
	type Focusable,
} from "@mariozechner/pi-tui";
import { spawnSync } from "node:child_process";

function getEntries(cwd: string): string[] {
	// Try fd first (fast, respects .gitignore)
	const fdFiles = spawnSync("fd", ["--type", "f", "--hidden", "--follow", "--exclude", ".git"], {
		cwd,
		encoding: "utf-8",
		timeout: 10000,
	});
	const fdDirs = spawnSync("fd", ["--type", "d", "--hidden", "--follow", "--exclude", ".git"], {
		cwd,
		encoding: "utf-8",
		timeout: 10000,
	});

	if ((fdFiles.status === 0 && fdFiles.stdout) || (fdDirs.status === 0 && fdDirs.stdout)) {
		const files = (fdFiles.stdout || "").trim().split("\n").filter(Boolean);
		const dirs = (fdDirs.stdout || "")
			.trim()
			.split("\n")
			.filter(Boolean)
			.map((d) => (d.endsWith("/") ? d : d + "/"));
		return [...files, ...dirs];
	}

	// Fallback to find
	const findFiles = spawnSync("find", [".", "-type", "f", "-not", "-path", "*/.git/*", "-maxdepth", "10"], {
		cwd,
		encoding: "utf-8",
		timeout: 10000,
	});
	const findDirs = spawnSync("find", [".", "-type", "d", "-not", "-path", "*/.git/*", "-not", "-path", ".", "-maxdepth", "10"], {
		cwd,
		encoding: "utf-8",
		timeout: 10000,
	});

	const normalize = (p: string) => (p.startsWith("./") ? p.slice(2) : p);

	if ((findFiles.status === 0 && findFiles.stdout) || (findDirs.status === 0 && findDirs.stdout)) {
		const files = (findFiles.stdout || "")
			.trim()
			.split("\n")
			.filter(Boolean)
			.map(normalize);
		const dirs = (findDirs.stdout || "")
			.trim()
			.split("\n")
			.filter(Boolean)
			.map(normalize)
			.filter(Boolean)
			.map((d) => (d.endsWith("/") ? d : d + "/"));
		return [...files, ...dirs];
	}

	return [];
}

export default function (pi: ExtensionAPI) {
	async function openFilePicker(ctx: ExtensionContext) {
		const entries = getEntries(ctx.cwd);

		if (entries.length === 0) {
			ctx.ui.notify("No files or folders found", "warning");
			return;
		}

		const result = await ctx.ui.custom<string | null>((tui, theme, _kb, done) => {
			const termRows = tui.terminal.rows || 24;
			const maxVisible = Math.min(30, Math.max(5, termRows - 8));

			const borderTop = new DynamicBorder((s: string) => theme.fg("accent", s));
			const borderBottom = new DynamicBorder((s: string) => theme.fg("accent", s));
			const searchInput = new Input();

			const allItems: SelectItem[] = entries.map((f) => ({ value: f, label: f }));
			const listTheme = {
				selectedPrefix: (t: string) => theme.fg("accent", t),
				selectedText: (t: string) => theme.fg("accent", t),
				description: (t: string) => theme.fg("muted", t),
				scrollInfo: (t: string) => theme.fg("dim", t),
				noMatch: () => theme.fg("warning", "  No matching entries"),
			};

			const getFolderPriority = (value: string, query: string) => {
				if (!query.endsWith("/")) return 3;

				const isDir = value.endsWith("/");
				if (!isDir) return 3;
				if (value === query) return 0;
				if (value.startsWith(query)) return 1;
				return 2;
			};

			let filteredItems: SelectItem[] = allItems;
			let selectList = new SelectList(filteredItems, maxVisible, listTheme);
			const applyFilter = (query: string) => {
				const trimmedQuery = query.trim();
				const baseItems = trimmedQuery
					? fuzzyFilter(allItems, trimmedQuery, (item) => `${item.value} ${ctx.cwd}/${item.value}`)
					: allItems;

				filteredItems = trimmedQuery.endsWith("/")
					? [...baseItems].sort((a, b) => getFolderPriority(a.value, trimmedQuery) - getFolderPriority(b.value, trimmedQuery))
					: baseItems;
				selectList = new SelectList(filteredItems, maxVisible, listTheme);
			};

			let lastQuery = "";
			let _focused = false;

			const comp: Component & Focusable = {
				get focused(): boolean {
					return _focused;
				},
				set focused(v: boolean) {
					_focused = v;
					searchInput.focused = v;
				},

				render(width: number): string[] {
					const lines: string[] = [];
					lines.push(...borderTop.render(width));

					const query = searchInput.getValue();
					const matchInfo = query
						? theme.fg("dim", ` ${filteredItems.length}/${entries.length}`)
						: theme.fg("dim", ` ${entries.length} entries`);
					lines.push(" " + theme.fg("accent", theme.bold("🔍 Files & Folders")) + matchInfo + theme.fg("dim", " local"));
					lines.push("");

					for (const line of searchInput.render(width - 2)) {
						lines.push(" " + line);
					}

					lines.push(theme.fg("dim", " " + "─".repeat(Math.max(1, width - 2))));
					lines.push(...selectList.render(width));
					lines.push("");
					lines.push(
						" " +
							theme.fg("dim", "↑↓") +
							theme.fg("muted", " navigate  ") +
							theme.fg("dim", "enter") +
							theme.fg("muted", " select  ") +
							theme.fg("dim", "esc") +
							theme.fg("muted", " cancel"),
					);
					lines.push(...borderBottom.render(width));
					return lines;
				},

				invalidate() {
					borderTop.invalidate();
					borderBottom.invalidate();
					searchInput.invalidate();
					selectList.invalidate();
				},

				handleInput(data: string) {
					if (matchesKey(data, Key.escape) || matchesKey(data, Key.ctrl("c"))) {
						done(null);
						return;
					}

					if (matchesKey(data, Key.enter)) {
						const selected = selectList.getSelectedItem();
						done(selected ? selected.value : null);
						return;
					}

					if (
						matchesKey(data, Key.up) ||
						matchesKey(data, Key.down) ||
						matchesKey(data, Key.pageUp) ||
						matchesKey(data, Key.pageDown)
					) {
						selectList.handleInput(data);
						tui.requestRender();
						return;
					}

					searchInput.handleInput(data);
					const newQuery = searchInput.getValue();
					if (newQuery !== lastQuery) {
						applyFilter(newQuery);
						lastQuery = newQuery;
					}
					tui.requestRender();
				},
			};

			return comp;
		}, { overlay: true });

		if (result) {
			ctx.ui.pasteToEditor(`@${result} `);
		}
	}

	pi.registerShortcut("@", {
		description: "Open file picker",
		handler: async (ctx) => {
			await openFilePicker(ctx);
		},
	});

	pi.registerCommand("files", {
		description: "Open file picker (@)",
		handler: async (_args, ctx) => {
			await openFilePicker(ctx);
		},
	});
}
