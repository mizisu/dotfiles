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
import { complete } from "@mariozechner/pi-ai";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { openBaseBranchPicker } from "./shared/branch-picker.js";
import { resolveMediumModel } from "./shared/model-slots.js";
import { registerSuccessMessageRenderer } from "./shared/success-message-renderer.js";

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

// --- LLM prompt ---

const SYSTEM = `You generate a GitHub PR title and body.

Rules:
- Title: imperative mood, under 72 characters, specific about the actual change.
  - Derive from the diff and commits, not just the branch name.
  - If there's one clear theme, capture it precisely. If multiple changes, pick the most significant one.
  - Good: "Add exponential backoff to payment webhook retries"
  - Good: "Fix race condition in concurrent session cleanup"
  - Good: "Replace hand-rolled CSV parser with pandas read_csv"
  - Bad: "Update code", "Fix bug", "Refactor stuff", "Changes" (too vague)
  - Bad: "Add exponential backoff to payment webhook retries to fix flaky API calls that were causing issues in production" (too long)
  - Do NOT use conventional commit prefixes (feat:, fix:, chore:, …). Just write a plain descriptive title.
- Body: keep it concise and scannable.
  - Fill in the PR template sections if provided.
  - If no template, use only the sections that add value: ## Summary and ## Why.
  - Prefer 3-6 bullets total for the whole body.
  - Each bullet should be short, concrete, and usually a single sentence.
  - Do not repeat the diff file-by-file or mention trivial implementation details.
- Prioritize explaining WHY over what. The diff already shows what changed.
- Focus on the most reviewer-relevant 1-3 changes, not every small edit.
- If session context contains decision-making (why an approach was chosen, alternatives considered), include only the parts that materially help reviewers.
- Session context and conversation history are hints about intent — if they conflict with the diff, trust the diff.
- Do not invent changes not present in the diff.
- Describe the problem or fix itself, not who reported it. Never reference reviewers or tools (e.g. "coderabbit", "reviewer pointed out"). Instead of "Fix issue raised by coderabbit", write "Fix null check on empty input".
- Always use "- " (dash) for bullet points. Never use "* " or other bullet styles. Even when a section has only one item, use "- ".
- Add a Mermaid diagram only when it is clearly necessary to explain a non-trivial architectural change.
  - Good use cases: new component/module relationships, changed data flow or state transitions, request/response sequences, before/after architecture comparison.
  - Bad use cases: simple bug fixes, config changes, renaming, single-file tweaks.
  - Use the simplest diagram type that fits: flowchart (dependency/flow), sequenceDiagram (interactions), stateDiagram-v2 (state machines), graph TD (hierarchies).
  - Keep diagrams compact (under ~15 nodes). Wrap in a \`\`\`mermaid fenced code block.

Output ONLY valid JSON — no markdown fences, no explanation:
{
  "title": "PR title here",
  "body": "PR body in markdown"
}`;

// --- extension ---

export default function (pi: ExtensionAPI) {
	registerSuccessMessageRenderer(pi, "pr");

	pi.registerCommand("pr", {
		description: "Create a GitHub PR (isolated context, fuzzy branch picker)",
		handler: async (_args, ctx) => {
			// 1. pick base branch
			const base = await openBaseBranchPicker(ctx);
			if (!base) return;

			// 2. check state
			ctx.ui.setStatus("pr", "Gathering…");
			const baseRef = `origin/${base}`;
			const [branch, status, log, diff] = await Promise.all([
				pi.exec("git", ["branch", "--show-current"]),
				pi.exec("git", ["status", "--short"]),
				pi.exec("git", ["log", "--oneline", `${baseRef}..HEAD`]),
				pi.exec("git", ["diff", `${baseRef}...HEAD`]),
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
			const resolved = await resolveMediumModel(ctx);
			if (resolved.fallbackReason) ctx.ui.notify(resolved.fallbackReason, "warning");
			if (!resolved.model || !resolved.auth) {
				ctx.ui.setStatus("pr", undefined);
				ctx.ui.notify(resolved.error ?? "No model selected", "error");
				return;
			}
			const { model, auth } = resolved;
			const resp = await complete(
				model,
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
				{ customType: "pr", content: `✓ Created draft PR: ${prUrl}\nTitle: ${title}`, display: true },
				{ triggerTurn: false },
			);
		},
	});
}
