import type { ExtensionContext } from "@mariozechner/pi-coding-agent";
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

export type BranchPickerContext = Pick<ExtensionContext, "cwd" | "ui">;

function getBranches(cwd: string): string[] {
	const result = spawnSync("git", ["branch", "-r", "--sort=-committerdate", "--format=%(refname:short)"], {
		cwd,
		encoding: "utf-8",
		timeout: 5000,
	});
	if (result.status !== 0 || !result.stdout) return [];
	return result.stdout
		.trim()
		.split("\n")
		.filter(Boolean)
		.map((b) => b.replace(/^origin\//, ""))
		.filter((b) => b !== "HEAD");
}

function getSuggestedBaseBranch(cwd: string, branches: string[]): string | undefined {
	const currentBranch = spawnSync("git", ["branch", "--show-current"], {
		cwd,
		encoding: "utf-8",
		timeout: 5000,
	});
	const remoteTips = spawnSync("git", ["for-each-ref", "--format=%(refname:short) %(objectname)", "refs/remotes/origin"], {
		cwd,
		encoding: "utf-8",
		timeout: 5000,
	});
	const firstParentHistory = spawnSync("git", ["rev-list", "--first-parent", "HEAD"], {
		cwd,
		encoding: "utf-8",
		timeout: 5000,
	});
	if (
		currentBranch.status !== 0 ||
		!currentBranch.stdout.trim() ||
		remoteTips.status !== 0 ||
		!remoteTips.stdout ||
		firstParentHistory.status !== 0 ||
		!firstParentHistory.stdout
	) return undefined;

	const historyIndex = new Map<string, number>();
	for (const [index, sha] of firstParentHistory.stdout.trim().split("\n").filter(Boolean).entries()) {
		historyIndex.set(sha, index);
	}

	const branchOrder = new Map(branches.map((branch, index) => [branch, index]));
	const current = currentBranch.stdout.trim();
	let bestMatch: { branch: string; distance: number; order: number } | undefined;

	for (const line of remoteTips.stdout.trim().split("\n").filter(Boolean)) {
		const [ref, sha] = line.trim().split(/\s+/, 2);
		const branch = ref?.replace(/^origin\//, "");
		if (!branch || branch === "HEAD" || branch === current || !sha || !branchOrder.has(branch)) continue;

		const distance = historyIndex.get(sha);
		if (distance === undefined) continue;

		const order = branchOrder.get(branch)!;
		if (!bestMatch || distance < bestMatch.distance || (distance === bestMatch.distance && order < bestMatch.order)) {
			bestMatch = { branch, distance, order };
		}
	}

	return bestMatch?.branch;
}

function getBranchMatchPriority(branch: string, query: string): number {
	const value = branch.toLowerCase();
	const normalizedQuery = query.toLowerCase();
	const segments = value.split("/");
	const leaf = segments[segments.length - 1] ?? value;

	if (value === normalizedQuery) return 0;
	if (value.endsWith(`/${normalizedQuery}`)) return 1;
	if (leaf === normalizedQuery) return 2;
	if (segments.includes(normalizedQuery)) return 3;
	if (value.startsWith(`${normalizedQuery}/`)) return 4;
	if (leaf.startsWith(normalizedQuery)) return 5;
	if (segments.some((segment) => segment.startsWith(normalizedQuery))) return 6;
	if (value.includes(`/${normalizedQuery}`)) return 7;
	if (value.includes(normalizedQuery)) return 8;
	return 9;
}

function filterBranchItems(items: SelectItem[], query: string): SelectItem[] {
	const matches = fuzzyFilter(items, query, (item) => item.value);
	const baseOrder = new Map(matches.map((item, index) => [item.value, index]));
	return [...matches].sort((a, b) => {
		const priorityDiff = getBranchMatchPriority(a.value, query) - getBranchMatchPriority(b.value, query);
		if (priorityDiff !== 0) return priorityDiff;
		return (baseOrder.get(a.value) ?? 0) - (baseOrder.get(b.value) ?? 0);
	});
}

export async function openBaseBranchPicker(ctx: BranchPickerContext): Promise<string | null> {
	const branches = getBranches(ctx.cwd);
	if (branches.length === 0) {
		ctx.ui.notify("No remote branches found", "warning");
		return null;
	}

	const suggestedBase = getSuggestedBaseBranch(ctx.cwd, branches);

	return ctx.ui.custom<string | null>((tui, theme, _kb, done) => {
		const termRows = tui.terminal.rows || 24;
		const maxVisible = Math.min(20, Math.max(5, termRows - 8));

		const borderTop = new DynamicBorder((s: string) => theme.fg("accent", s));
		const borderBottom = new DynamicBorder((s: string) => theme.fg("accent", s));
		const searchInput = new Input();

		const allItems: SelectItem[] = branches.map((branch) => ({ value: branch, label: branch }));
		const listTheme = {
			selectedPrefix: (text: string) => theme.fg("accent", text),
			selectedText: (text: string) => theme.fg("accent", text),
			description: (text: string) => theme.fg("muted", text),
			scrollInfo: (text: string) => theme.fg("dim", text),
			noMatch: () => theme.fg("warning", "  No matching branches"),
		};

		const createSelectList = (items: SelectItem[], query: string) => {
			const list = new SelectList(items, maxVisible, listTheme);
			const selectedValue = query.trim() ? items[0]?.value : suggestedBase;
			if (selectedValue) {
				const selectedIndex = items.findIndex((item) => item.value === selectedValue);
				if (selectedIndex >= 0) list.setSelectedIndex(selectedIndex);
			}
			return list;
		};

		let filteredItems: SelectItem[] = allItems;
		let selectList = createSelectList(filteredItems, "");
		const applyFilter = (query: string) => {
			const trimmedQuery = query.trim();
			filteredItems = trimmedQuery ? filterBranchItems(allItems, trimmedQuery) : allItems;
			selectList = createSelectList(filteredItems, trimmedQuery);
		};

		let lastQuery = "";
		let focused = false;

		const comp: Component & Focusable = {
			get focused() { return focused; },
			set focused(value: boolean) { focused = value; searchInput.focused = value; },

			render(width: number): string[] {
				const lines: string[] = [];
				lines.push(...borderTop.render(width));
				const query = searchInput.getValue();
				const matchInfo = query
					? theme.fg("dim", ` ${filteredItems.length}/${branches.length}`)
					: theme.fg("dim", ` ${branches.length} branches`);
				lines.push(" " + theme.fg("accent", theme.bold("🔀 Base Branch")) + matchInfo);
				lines.push("");
				for (const line of searchInput.render(width - 2)) lines.push(" " + line);
				lines.push(theme.fg("dim", " " + "─".repeat(Math.max(1, width - 2))));
				lines.push(...selectList.render(width));
				lines.push("");
				lines.push(
					" " +
						theme.fg("dim", "↑↓") + theme.fg("muted", " navigate  ") +
						theme.fg("dim", "enter") + theme.fg("muted", " select  ") +
						theme.fg("dim", "esc") + theme.fg("muted", " cancel"),
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
				if (matchesKey(data, Key.escape) || matchesKey(data, Key.ctrl("c"))) { done(null); return; }
				if (matchesKey(data, Key.enter)) {
					done(selectList.getSelectedItem()?.value ?? null);
					return;
				}
				if (matchesKey(data, Key.up) || matchesKey(data, Key.down) || matchesKey(data, Key.pageUp) || matchesKey(data, Key.pageDown)) {
					selectList.handleInput(data);
					tui.requestRender();
					return;
				}
				searchInput.handleInput(data);
				const newQuery = searchInput.getValue();
				if (newQuery !== lastQuery) { applyFilter(newQuery); lastQuery = newQuery; }
				tui.requestRender();
			},
		};

		return comp;
	}, { overlay: true });
}
