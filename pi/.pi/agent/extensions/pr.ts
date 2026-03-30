/**
 * /pr — Create GitHub PR in isolated context
 *
 * Analyzes diff and session context via separate LLM call (no pollution of main context).
 * Follows project's pull_request_template.md if found.
 * Focuses on "why" over "what".
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { complete, getModel } from "@mariozechner/pi-ai";
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

// --- git helpers ---

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

function findPrTemplate(cwd: string): string | undefined {
	const candidates = [
		".github/pull_request_template.md",
		".github/PULL_REQUEST_TEMPLATE.md",
		"docs/pull_request_template.md",
	];
	for (const c of candidates) {
		const full = path.join(cwd, c);
		if (fs.existsSync(full)) return fs.readFileSync(full, "utf-8");
	}
	// Check PULL_REQUEST_TEMPLATE directory
	const dir = path.join(cwd, ".github/PULL_REQUEST_TEMPLATE");
	if (fs.existsSync(dir) && fs.statSync(dir).isDirectory()) {
		const files = fs.readdirSync(dir).filter((f) => f.endsWith(".md"));
		if (files.length > 0) return fs.readFileSync(path.join(dir, files[0]), "utf-8");
	}
	return undefined;
}

// --- session context (same pattern as commit.ts) ---

function truncate(text: string, max: number): string {
	return text.length <= max ? text : `${text.slice(0, max)}…`;
}

function getTextContent(content: unknown): string {
	if (typeof content === "string") return content.trim();
	if (!Array.isArray(content)) return "";
	return content
		.filter(
			(part): part is { type: "text"; text: string } =>
				!!part && typeof part === "object" && (part as any).type === "text" && typeof (part as any).text === "string",
		)
		.map((part) => part.text)
		.join("\n")
		.trim();
}

function buildSessionContext(ctx: any): string {
	const messages = ctx.sessionManager?.buildSessionContext?.()?.messages;
	if (!Array.isArray(messages)) return "";

	const summaries = messages
		.filter((msg: any) => msg.role === "compactionSummary" || msg.role === "branchSummary")
		.slice(-2)
		.map((msg: any) => {
			if (msg.role === "compactionSummary") return `### Earlier session summary\n${truncate(msg.summary, 2500)}`;
			return `### Current branch summary\n${truncate(msg.summary, 2000)}`;
		});

	const recent = messages
		.filter((msg: any) => msg.role === "user" || msg.role === "assistant")
		.slice(-10)
		.map((msg: any) => {
			const text = truncate(getTextContent(msg.content), 1500);
			if (!text) return "";
			return `### ${msg.role === "user" ? "User" : "Assistant"}\n${text}`;
		})
		.filter(Boolean);

	return truncate([...summaries, ...recent].join("\n\n").trim(), 12000);
}

function extractText(resp: any): string {
	return resp.content
		.filter((c: any) => c.type === "text")
		.map((c: any) => c.text)
		.join("");
}

// --- branch picker UI ---

async function openBranchPicker(ctx: ExtensionContext): Promise<string | null> {
	const branches = getBranches(ctx.cwd);
	if (branches.length === 0) {
		ctx.ui.notify("No remote branches found", "warning");
		return null;
	}

	return ctx.ui.custom<string | null>((tui, theme, _kb, done) => {
		const termRows = tui.terminal.rows || 24;
		const maxVisible = Math.min(20, Math.max(5, termRows - 8));

		const borderTop = new DynamicBorder((s: string) => theme.fg("accent", s));
		const borderBottom = new DynamicBorder((s: string) => theme.fg("accent", s));
		const searchInput = new Input();

		const allItems: SelectItem[] = branches.map((b) => ({ value: b, label: b }));
		const listTheme = {
			selectedPrefix: (t: string) => theme.fg("accent", t),
			selectedText: (t: string) => theme.fg("accent", t),
			description: (t: string) => theme.fg("muted", t),
			scrollInfo: (t: string) => theme.fg("dim", t),
			noMatch: () => theme.fg("warning", "  No matching branches"),
		};

		let filteredItems: SelectItem[] = allItems;
		let selectList = new SelectList(filteredItems, maxVisible, listTheme);
		const applyFilter = (query: string) => {
			filteredItems = query.trim()
				? fuzzyFilter(allItems, query.trim(), (item) => item.value)
				: allItems;
			selectList = new SelectList(filteredItems, maxVisible, listTheme);
		};

		let lastQuery = "";
		let _focused = false;

		const comp: Component & Focusable = {
			get focused() { return _focused; },
			set focused(v: boolean) { _focused = v; searchInput.focused = v; },

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

// --- LLM prompt ---

const SYSTEM = `You generate a GitHub PR title and body.

Rules:
- Title: concise, imperative mood (e.g. "Add retry logic for flaky API calls")
- Body: fill in the PR template sections if provided. If no template, use: ## Summary, ## Changes, ## Why
- For every change, prioritize explaining WHY over what. The diff already shows what changed.
- If session context contains decision-making (why an approach was chosen, alternatives considered), include that.
- Session context and conversation history are hints about intent — if they conflict with the diff, trust the diff.
- Do not invent changes not present in the diff.

Output ONLY valid JSON — no markdown fences, no explanation:
{
  "title": "PR title here",
  "body": "PR body in markdown"
}`;

// --- extension ---

export default function (pi: ExtensionAPI) {
	pi.registerCommand("pr", {
		description: "Create a GitHub PR (isolated context, fuzzy branch picker)",
		handler: async (_args, ctx) => {
			if (!ctx.model) { ctx.ui.notify("No model selected", "error"); return; }

			// 1. pick base branch
			const base = await openBranchPicker(ctx);
			if (!base) return;

			// 2. check state
			ctx.ui.setStatus("pr", "Gathering…");
			const [branch, status, log, diff] = await Promise.all([
				pi.exec("git", ["branch", "--show-current"]),
				pi.exec("git", ["status", "--short"]),
				pi.exec("git", ["log", "--oneline", `${base}..HEAD`]),
				pi.exec("git", ["diff", `${base}..HEAD`]),
			]);

			if (!diff.stdout.trim() && !log.stdout.trim()) {
				ctx.ui.setStatus("pr", undefined);
				ctx.ui.notify(`No changes between ${base} and HEAD`, "info");
				return;
			}

			const hasUncommitted = status.stdout.trim().length > 0;
			if (hasUncommitted) {
				ctx.ui.setStatus("pr", undefined);
				const ok = await ctx.ui.confirm("Uncommitted changes", "There are uncommitted changes. Continue anyway?");
				if (!ok) return;
				ctx.ui.setStatus("pr", "Gathering…");
			}

			// 3. gather context
			const prTemplate = findPrTemplate(ctx.cwd);
			const sessionContext = buildSessionContext(ctx);

			// 4. generate via isolated LLM call
			ctx.ui.setStatus("pr", "Generating PR…");
			const sonnet = getModel("anthropic", "claude-sonnet-4-6");
			const auth = await ctx.modelRegistry.getApiKeyAndHeaders(sonnet);
			if (!auth.ok) {
				ctx.ui.setStatus("pr", undefined);
				ctx.ui.notify(`Auth error: ${auth.error}`, "error");
				return;
			}
			const resp = await complete(
				sonnet,
				{
					systemPrompt: SYSTEM,
					messages: [{
						role: "user",
						content: [{
							type: "text",
							text: [
								prTemplate ? `## PR Template\n${prTemplate}` : "",
								sessionContext ? `## Session Context\n${sessionContext}` : "",
								`## Branch\n${branch.stdout.trim()} → ${base}`,
								`## Commits\n${log.stdout}`,
								`## Diff\n${truncate(diff.stdout, 80000)}`,
							].filter(Boolean).join("\n\n"),
						}],
						timestamp: Date.now(),
					}],
				},
				{ apiKey: auth.apiKey, headers: auth.headers },
			);
			ctx.ui.setStatus("pr", undefined);

			// 5. parse response
			const text = extractText(resp);
			let title: string;
			let body: string;
			try {
				const stripped = text.replace(/^```(?:json)?\s*\n?/gm, "").replace(/^```\s*$/gm, "");
				const start = stripped.indexOf("{");
				if (start < 0) throw new Error("no JSON found");
				let depth = 0, end = -1;
				for (let i = start; i < stripped.length; i++) {
					if (stripped[i] === "{") depth++;
					else if (stripped[i] === "}") { depth--; if (depth === 0) { end = i; break; } }
				}
				if (end < 0) throw new Error("no JSON found");
				const parsed = JSON.parse(stripped.slice(start, end + 1));
				title = parsed.title;
				body = parsed.body;
				if (!title || !body) throw new Error("missing title or body");
			} catch (e) {
				ctx.ui.notify(`Failed to parse PR content: ${e}`, "error");
				return;
			}

			// 6. confirm
			const preview = `${title}\n${"─".repeat(40)}\n${body}`;
			if (!(await ctx.ui.confirm("PR Preview", preview))) {
				ctx.ui.notify("Cancelled", "info");
				return;
			}

			// 7. ensure upstream
			ctx.ui.setStatus("pr", "Creating PR…");
			const upstream = await pi.exec("git", ["rev-parse", "--abbrev-ref", "@{upstream}"]);
			if (upstream.code !== 0) {
				const push = await pi.exec("git", ["push", "-u", "origin", "HEAD"]);
				if (push.code !== 0) {
					ctx.ui.setStatus("pr", undefined);
					ctx.ui.notify(`Push failed: ${push.stderr}`, "error");
					return;
				}
			}

			// 8. create PR
			const bodyFile = path.join(os.tmpdir(), `pi-pr-${Date.now()}.md`);
			fs.writeFileSync(bodyFile, body);
			const ghResult = await pi.exec("gh", ["pr", "create", "--draft", "--title", title, "--body-file", bodyFile, "--base", base]);
			fs.unlinkSync(bodyFile);
			ctx.ui.setStatus("pr", undefined);

			if (ghResult.code !== 0) {
				ctx.ui.notify(`gh pr create failed: ${ghResult.stderr}`, "error");
				return;
			}

			const prUrl = ghResult.stdout.trim();
			await pi.exec("open", [prUrl]);
			ctx.ui.notify(`PR created: ${prUrl}`, "success");
			pi.sendMessage(
				{ customType: "pr", content: `Created draft PR: ${prUrl}\n\n**${title}**`, display: true },
				{ triggerTurn: false },
			);
		},
	});
}
