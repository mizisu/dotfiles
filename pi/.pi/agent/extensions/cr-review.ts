/**
 * /cr-review — CodeRabbit review with selective apply
 *
 * Runs `cr review --plain` against the PR's base branch,
 * presents findings in a multi-select picker, and sends only
 * chosen items to the main context for AI to apply.
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { DynamicBorder } from "@mariozechner/pi-coding-agent";
import {
	Input,
	SelectList,
	matchesKey,
	wrapTextWithAnsi,
	Key,
	type SelectItem,
	type Component,
	type Focusable,
} from "@mariozechner/pi-tui";
import { openBaseBranchPicker } from "./shared/branch-picker.js";

// --- review output parser ---

interface ReviewItem {
	title: string;
	content: string;
}

interface PickerResult {
	items: ReviewItem[];
	comment?: string;
}

function parseReviewItems(output: string): ReviewItem[] {
	const items: ReviewItem[] = [];
	// Split by "File:" headers that cr review --prompt-only produces
	const filePattern = /^File:\s*(.+)$/gm;
	const matches = [...output.matchAll(filePattern)];

	if (matches.length > 0) {
		for (let i = 0; i < matches.length; i++) {
			const start = matches[i].index!;
			const end = i + 1 < matches.length ? matches[i + 1].index! : output.length;
			items.push({ title: matches[i][1].trim(), content: output.slice(start, end).trim() });
		}
		return items;
	}

	// Fallback: split by markdown ## or ### headers
	const headerPattern = /^#{2,3}\s+(.+)$/gm;
	const headers = [...output.matchAll(headerPattern)];

	if (headers.length > 1) {
		for (let i = 0; i < headers.length; i++) {
			const start = headers[i].index!;
			const end = i + 1 < headers.length ? headers[i + 1].index! : output.length;
			items.push({ title: headers[i][1].trim(), content: output.slice(start, end).trim() });
		}
		return items;
	}

	// Fallback: split by separator lines (===, ---)
	const sections = output.split(/\n={3,}\n|\n-{3,}\n/).map((s) => s.trim()).filter(Boolean);
	if (sections.length > 1) {
		return sections.map((section) => {
			const firstLine = section.split("\n")[0];
			return { title: firstLine.slice(0, 80), content: section };
		});
	}

	// Single block — return as one item
	return [{ title: "Full review", content: output }];
}

function extractSummary(content: string, maxLen = 60): string {
	const lines = content.split("\n");
	for (const line of lines) {
		const trimmed = line.trim();
		if (!trimmed || trimmed.startsWith("File:") || /^[-=]{3,}$/.test(trimmed) || /^#{1,3}\s/.test(trimmed)) continue;
		return trimmed.length > maxLen ? trimmed.slice(0, maxLen - 1) + "…" : trimmed;
	}
	return "";
}

// --- review item picker (multi-select, no search input) ---

async function showReviewPicker(
	ctx: ExtensionCommandContext,
	items: ReviewItem[],
): Promise<PickerResult | null> {
	return ctx.ui.custom<PickerResult | null>((tui, theme, _kb, done) => {
		const termRows = tui.terminal.rows || 24;
		const available = Math.max(8, termRows - 8);
		const maxVisible = Math.min(items.length, Math.max(3, Math.ceil(available * 0.4)));
		const maxPreviewLines = Math.max(3, available - maxVisible - 1);

		const borderTop = new DynamicBorder((s: string) => theme.fg("accent", s));
		const borderBottom = new DynamicBorder((s: string) => theme.fg("accent", s));

		const checked = new Set<string>();
		const allItems: SelectItem[] = items.map((item, i) => ({
			value: String(i),
			label: item.title,
			description: extractSummary(item.content),
		}));

		const listTheme = {
			selectedPrefix: (t: string) => theme.fg("accent", t),
			selectedText: (t: string) => theme.fg("accent", t),
			description: (t: string) => theme.fg("muted", t),
			scrollInfo: (t: string) => theme.fg("dim", t),
			noMatch: () => theme.fg("warning", "  No items"),
		};

		const selectList = new SelectList(allItems, maxVisible, listTheme, {
			truncatePrimary: ({ text, maxWidth, item }) => {
				const icon = checked.has(item.value)
					? theme.fg("success", "◉ ")
					: theme.fg("dim", "○ ");
				const available = maxWidth - 2;
				const truncated = text.length <= available ? text : `${text.slice(0, available - 1)}…`;
				return icon + truncated;
			},
		});

		let mode: "select" | "comment" = "select";
		const commentInput = new Input();
		let _focused = false;

		const comp: Component & Focusable = {
			get focused() { return _focused; },
			set focused(v: boolean) { _focused = v; commentInput.focused = v && mode === "comment"; },

			render(width: number): string[] {
				const lines: string[] = [];
				lines.push(...borderTop.render(width));
				const countInfo = checked.size > 0
					? theme.fg("accent", ` ${checked.size}/${items.length} selected`)
					: theme.fg("dim", ` ${items.length} items`);
				lines.push(" " + theme.fg("accent", theme.bold("🔍 CodeRabbit Review")) + countInfo);
				lines.push("");
				lines.push(...selectList.render(width));
				// Preview of highlighted item
				const selectedItem = selectList.getSelectedItem();
				if (selectedItem) {
					lines.push(theme.fg("dim", " " + "─".repeat(Math.max(1, width - 2))));
					const preview = items[Number(selectedItem.value)].content;
					const wrapped = wrapTextWithAnsi(preview, Math.max(1, width - 4));
					for (let j = 0; j < Math.min(wrapped.length, maxPreviewLines); j++) {
						lines.push("  " + theme.fg("muted", wrapped[j]));
					}
					if (wrapped.length > maxPreviewLines) {
						lines.push("  " + theme.fg("dim", `… ${wrapped.length - maxPreviewLines} more lines`));
					}
				}
				if (mode === "comment") {
					lines.push(theme.fg("dim", " " + "─".repeat(Math.max(1, width - 2))));
					lines.push(" " + theme.fg("accent", "💬 Comment:"));
					for (const line of commentInput.render(width - 4)) lines.push("  " + line);
					lines.push("");
					lines.push(
						" " +
							theme.fg("dim", "enter") + theme.fg("muted", " apply  ") +
							theme.fg("dim", "esc") + theme.fg("muted", " back"),
					);
				} else {
					lines.push("");
					lines.push(
						" " +
							theme.fg("dim", "space") + theme.fg("muted", " toggle  ") +
							theme.fg("dim", "a") + theme.fg("muted", " all  ") +
							theme.fg("dim", "enter") + theme.fg("muted", " apply  ") +
							theme.fg("dim", "c") + theme.fg("muted", " comment  ") +
							theme.fg("dim", "esc") + theme.fg("muted", " cancel"),
					);
				}
				lines.push(...borderBottom.render(width));
				return lines;
			},

			invalidate() {
				borderTop.invalidate();
				borderBottom.invalidate();
				selectList.invalidate();
				commentInput.invalidate();
			},

			handleInput(data: string) {
				if (matchesKey(data, Key.ctrl("c"))) {
					done(null);
					return;
				}
				if (mode === "comment") {
					if (matchesKey(data, Key.escape)) {
						mode = "select";
						commentInput.focused = false;
						tui.requestRender();
						return;
					}
					if (matchesKey(data, Key.enter)) {
						const comment = commentInput.getValue().trim();
						done(checked.size > 0
							? { items: [...checked].sort().map((i) => items[Number(i)]), comment: comment || undefined }
							: null);
						return;
					}
					commentInput.handleInput(data);
					tui.requestRender();
					return;
				}
				if (matchesKey(data, Key.escape)) {
					done(null);
					return;
				}
				if (matchesKey(data, Key.enter)) {
					done(checked.size > 0
						? { items: [...checked].sort().map((i) => items[Number(i)]) }
						: null);
					return;
				}
				if (data === "c" && checked.size > 0) {
					mode = "comment";
					commentInput.focused = true;
					tui.requestRender();
					return;
				}
				if (data === " ") {
					const current = selectList.getSelectedItem();
					if (current) {
						if (checked.has(current.value)) checked.delete(current.value);
						else checked.add(current.value);
						selectList.invalidate();
					}
					tui.requestRender();
					return;
				}
				if (data === "a") {
					if (checked.size === items.length) {
						checked.clear();
					} else {
						for (let i = 0; i < items.length; i++) checked.add(String(i));
					}
					selectList.invalidate();
					tui.requestRender();
					return;
				}
				if (matchesKey(data, Key.up) || matchesKey(data, Key.down) ||
					matchesKey(data, Key.pageUp) || matchesKey(data, Key.pageDown)) {
					selectList.handleInput(data);
					tui.requestRender();
					return;
				}
			},
		};

		return comp;
	}, { overlay: true });
}

// --- extension ---

export default function (pi: ExtensionAPI) {
	pi.registerCommand("cr-review", {
		description: "CodeRabbit review: select & apply suggestions",
		handler: async (_args, ctx) => {
			// 1. Get base branch: auto-detect from PR, fall back to branch picker
			ctx.ui.setStatus("cr-review", "Detecting base branch…");
			const baseRef = await pi.exec("gh", ["pr", "view", "--json", "baseRefName", "-q", ".baseRefName"]);
			ctx.ui.setStatus("cr-review", undefined);

			let base: string;
			if (baseRef.code === 0 && baseRef.stdout.trim()) {
				base = baseRef.stdout.trim();
			} else {
				const picked = await openBaseBranchPicker(ctx);
				if (!picked) return;
				base = picked;
			}

			// 2. Fetch base branch
			ctx.ui.setStatus("cr-review", `Fetching ${base}…`);
			await pi.exec("git", ["fetch", "origin", `${base}:${base}`]);

			// 3. Run CodeRabbit review
			ctx.ui.setStatus("cr-review", "Running CodeRabbit review…");
			const review = await pi.exec("cr", ["review", `--base=${base}`, "--plain"]);
			ctx.ui.setStatus("cr-review", undefined);

			if (review.code !== 0) {
				ctx.ui.notify(`cr review failed: ${review.stderr}`, "error");
				return;
			}

			const output = review.stdout.trim();
			if (!output) {
				ctx.ui.notify("No review output", "info");
				return;
			}

			// 4. Parse into review items
			const items = parseReviewItems(output);

			// 5. Review picker (multi-select with optional comment)
			const result = await showReviewPicker(ctx, items);
			if (!result || result.items.length === 0) {
				ctx.ui.notify("No items selected", "info");
				return;
			}

			// 6. Send selected to main context
			const message = result.items.map((item) => item.content).join("\n\n---\n\n");
			const commentPart = result.comment ? `\n\n사용자 코멘트: ${result.comment}\n\n` : " ";
			pi.sendUserMessage(
				`CodeRabbit review에서 ${result.items.length}개 항목을 선택했습니다 (base: ${base}).${commentPart}각 항목을 확인하고 코드를 수정해주세요:\n\n${message}`,
			);
		},
	});
}
