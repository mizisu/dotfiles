/**
 * /commit — Smart commit in isolated context
 *
 * Analyzes git changes via separate LLM call (no diff in main context).
 * Splits by purpose, follows convention from last 3 git log entries.
 * Supports file-level and hunk-level splitting.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { complete } from "@mariozechner/pi-ai";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { resolveMediumModel } from "./shared/model-slots.js";
import { registerSuccessMessageRenderer } from "./shared/success-message-renderer.js";

const SYSTEM = `You analyze git changes and produce a commit plan.

Input: recent git log (for convention), git status, diff with per-file numbered hunks, untracked files.

Output ONLY valid JSON — no markdown fences, no explanation:
{
  "commits": [
    {
      "subject": "following convention from git log",
      "description": "intent of the change — not a file list, but WHY. separate aspects if needed.",
      "files": {
        "path/file.ts": "all",
        "path/other.ts": [0, 2]
      }
    }
  ]
}

Rules:
- files value: "all" = whole file, [0, 2] = hunk indices (0-based, per file)
- Group by PURPOSE (why changed), not by file
- Subject: MUST use Conventional Commits format: <type>(<optional scope>): <description>
  - Types: feat, fix, refactor, chore, docs, style, test, perf, ci, build
  - Match language and tone from git log, but ALWAYS use this format
  - NEVER include issue tracker references (e.g. JIRA tags like [XXX-123], PROJECT-456)
- Description: omit or set "" when the subject alone sufficiently conveys the intent. Include only when additional context about WHY is needed.
- EVERY COMMIT MUST BE INDEPENDENTLY BUILDABLE AND RUNNABLE. No commit may leave the codebase in a broken state.
  - Never split tightly coupled changes (e.g. interface + implementation, import + usage, rename across files) into separate commits
  - If a function is added in file A and called in file B, both MUST be in the same commit
  - If splitting would break compilation, type-checking, or runtime behavior at any intermediate commit, DO NOT split — keep them together
  - When in doubt, fewer bigger commits that work > many small commits that break
- Order commits by dependency
- Use hunk indices only when one file's changes serve different purposes
- Git diff, git status, and untracked files are the source of truth
- Explicit user context and session context are hints about intent, scope, and commit boundaries
- If session context conflicts with the diff, trust the diff
- Do not invent work that is not present in the changes`;

// --- diff parser ---

interface Hunk {
	index: number;
	body: string;
	fingerprint: string; // +/- lines only, for matching after rebase
}

interface DiffFile {
	path: string;
	header: string;
	hunks: Hunk[];
}

function parseDiff(raw: string): DiffFile[] {
	const files: DiffFile[] = [];
	for (const chunk of raw.split(/(?=^diff --git )/m)) {
		if (!chunk.startsWith("diff --git ")) continue;
		const m = chunk.match(/^diff --git a\/.+ b\/(.+)$/m);
		if (!m) continue;
		const parts = chunk.split(/(?=^@@ )/m);
		const hunks: Hunk[] = [];
		for (let i = 1; i < parts.length; i++) {
			const fp = parts[i]
				.split("\n")
				.filter((l) => (l.startsWith("+") || l.startsWith("-")) && !l.startsWith("+++") && !l.startsWith("---"))
				.join("\n");
			hunks.push({ index: i - 1, body: parts[i], fingerprint: fp });
		}
		files.push({ path: m[1], header: parts[0], hunks });
	}
	return files;
}

function formatForLLM(files: DiffFile[], untracked: Record<string, string>): string {
	let out = "";
	for (const f of files) {
		out += f.header;
		for (const h of f.hunks) out += `[hunk ${h.index}]\n${h.body}`;
	}
	for (const [name, content] of Object.entries(untracked))
		out += `\n--- new file: ${name} ---\n${content}\n`;
	return out;
}

function extractText(resp: any): string {
	return resp.content
		.filter((c: any) => c.type === "text")
		.map((c: any) => c.text)
		.join("");
}

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

function buildCommitSessionContext(ctx: any): string {
	const messages = ctx.sessionManager?.buildSessionContext?.()?.messages;
	if (!Array.isArray(messages)) return "";

	const summaries = messages
		.filter((msg: any) => msg.role === "compactionSummary" || msg.role === "branchSummary")
		.slice(-2)
		.map((msg: any) => {
			if (msg.role === "compactionSummary") {
				return `### Earlier session summary\n${truncate(msg.summary, 2500)}`;
			}
			return `### Current branch summary\n${truncate(msg.summary, 2000)}`;
		});

	const recent = messages
		.filter((msg: any) => msg.role === "user" || msg.role === "assistant")
		.slice(-6)
		.map((msg: any) => {
			const text = truncate(getTextContent(msg.content), 1200);
			if (!text) return "";
			return `### ${msg.role === "user" ? "Recent user intent" : "Recent assistant context"}\n${text}`;
		})
		.filter(Boolean);

	return truncate([...summaries, ...recent].join("\n\n").trim(), 8000);
}

// --- extension ---

export default function (pi: ExtensionAPI) {
	registerSuccessMessageRenderer(pi, "commit");

	pi.registerCommand("commit", {
		description: "Smart commit: split changes by context (isolated)",
		handler: async (args, ctx) => {
			// 1. gather
			ctx.ui.setStatus("commit", "Gathering…");
			const [log, status, diff, untracked] = await Promise.all([
				pi.exec("git", ["log", "-3", "--format=%s%n%b---"]),
				pi.exec("git", ["status", "--short"]),
				pi.exec("git", ["diff", "--relative", "HEAD"]),
				pi.exec("git", ["ls-files", "--others", "--exclude-standard"]),
			]);

			const untrackedList = untracked.stdout.trim().split("\n").filter(Boolean);
			if (!diff.stdout.trim() && !untrackedList.length) {
				ctx.ui.setStatus("commit", undefined);
				ctx.ui.notify("No changes to commit", "info");
				return;
			}

			const untrackedContents: Record<string, string> = {};
			for (const f of untrackedList) {
				untrackedContents[f] = (await pi.exec("cat", [f])).stdout;
			}

			const diffFiles = parseDiff(diff.stdout);
			const diffText = formatForLLM(diffFiles, untrackedContents);
			const sessionContext = buildCommitSessionContext(ctx);

			// 2. analyze (separate context — diffs never enter main conversation)
			ctx.ui.setStatus("commit", "Analyzing…");
			const resolved = await resolveMediumModel(ctx);
			if (resolved.fallbackReason) ctx.ui.notify(resolved.fallbackReason, "warning");
			if (!resolved.model || !resolved.auth) {
				ctx.ui.setStatus("commit", undefined);
				ctx.ui.notify(resolved.error ?? "No model selected", "error");
				return;
			}
			const { model, auth } = resolved;
			const resp = await complete(
				model,
				{
					systemPrompt: SYSTEM,
					messages: [
						{
							role: "user",
							content: [
								{
									type: "text",
									text: [
										args?.trim() ? `## Explicit Commit Intent\n${args.trim()}` : "",
										sessionContext ? `## Current Session Context\n${sessionContext}` : "",
										`## Git Log\n${log.stdout}`,
										`## Status\n${status.stdout}`,
										`## Changes\n${diffText}`,
									]
										.filter(Boolean)
										.join("\n\n"),
								},
							],
							timestamp: Date.now(),
						},
					],
				},
				{ apiKey: auth.apiKey, headers: auth.headers },
			);
			ctx.ui.setStatus("commit", undefined);

			// 3. parse plan
			const text = extractText(resp);
			let commits: { subject: string; description: string; files: Record<string, "all" | number[]> }[];
			try {
				// Strip markdown fences if present
				const stripped = text.replace(/^```(?:json)?\s*\n?/gm, "").replace(/^```\s*$/gm, "");
				// Find balanced JSON object by counting braces
				const start = stripped.indexOf("{");
				if (start < 0) throw new Error("no JSON found");
				let depth = 0;
				let end = -1;
				for (let i = start; i < stripped.length; i++) {
					if (stripped[i] === "{") depth++;
					else if (stripped[i] === "}") { depth--; if (depth === 0) { end = i; break; } }
				}
				if (end < 0) throw new Error("no JSON found");
				commits = JSON.parse(stripped.slice(start, end + 1)).commits;
				if (!commits?.length) throw new Error("empty plan");
			} catch (e) {
				ctx.ui.notify(`Plan parse failed: ${e}`, "error");
				return;
			}

			// 4. show plan
			let display = "";
			for (let i = 0; i < commits.length; i++) {
				const c = commits[i];
				const fileList = Object.entries(c.files)
					.map(([f, v]) => (v === "all" ? f : `${f} (partial)`))
					.join(", ");
				display += `[${i + 1}/${commits.length}] ${c.subject}\n`;
				if (c.description) display += `  ${c.description}\n`;
				display += `  → ${fileList}\n\n`;
			}

			if (!(await ctx.ui.confirm("Commit Plan", display))) {
				ctx.ui.notify("Cancelled", "info");
				return;
			}

			// 5. execute
			await pi.exec("git", ["reset", "HEAD", "--quiet"]);

			const completedCommits: typeof commits = [];
			let fixError: string | undefined;

			for (let i = 0; i < commits.length; i++) {
				const c = commits[i];
				ctx.ui.setStatus("commit", `Committing ${i + 1}/${commits.length}…`);

				for (const [file, spec] of Object.entries(c.files)) {
					if (spec === "all") {
						await pi.exec("git", ["add", "--", file]);
						continue;
					}

					// hunk-level: get current diff, match by fingerprint
					const cur = parseDiff((await pi.exec("git", ["diff", "--relative", "HEAD", "--", file])).stdout);
					const curFile = cur[0];
					if (!curFile) {
						await pi.exec("git", ["add", "--", file]);
						continue;
					}

					const origFile = diffFiles.find((f) => f.path === file);
					if (!origFile) {
						await pi.exec("git", ["add", "--", file]);
						continue;
					}

					const selected: string[] = [];
					for (const idx of spec) {
						const orig = origFile.hunks[idx];
						if (!orig) continue;
						const match = curFile.hunks.find((h) => h.fingerprint === orig.fingerprint);
						if (match) selected.push(match.body);
					}

					if (!selected.length) {
						await pi.exec("git", ["add", "--", file]);
						continue;
					}

					const patch = curFile.header + selected.join("");
					const patchPath = path.join(os.tmpdir(), `pi-commit-${Date.now()}.patch`);
					fs.writeFileSync(patchPath, patch);
					const res = await pi.exec("git", ["apply", "--cached", patchPath]);
					fs.unlinkSync(patchPath);

					if (res.code !== 0) {
						ctx.ui.notify(`Patch failed for ${file}, staging whole file`, "warning");
						await pi.exec("git", ["add", "--", file]);
					}
				}

				// --- commit with pre-commit hook handling ---
				const commitArgs = ["commit", "-m", c.subject];
				if (c.description) commitArgs.push("-m", c.description);
				let commitRes = await pi.exec("git", commitArgs);

				// Auto-retry: if pre-commit hook modified files (e.g. formatter), re-stage and retry
				if (commitRes.code !== 0) {
					const dirty = (await pi.exec("git", ["diff", "--name-only"])).stdout.trim();
					if (dirty) {
						const commitFileSet = new Set(Object.keys(c.files));
						const modified = dirty.split("\n").filter((f) => commitFileSet.has(f));
						if (modified.length > 0) {
							for (const f of modified) await pi.exec("git", ["add", "--", f]);
							commitRes = await pi.exec("git", commitArgs);
						}
					}
				}

				if (commitRes.code === 0) {
					completedCommits.push(c);
					continue;
				}

				// Still failed — present choices
				const errorOutput = [commitRes.stdout, commitRes.stderr].filter(Boolean).join("\n").trim();
				ctx.ui.notify(errorOutput, "error");
				let aborted = false;

				while (true) {
					const choice = await ctx.ui.select(`Commit ${i + 1}/${commits.length} failed`, [
						"Retry",
						"Retry (--no-verify)",
						"Skip",
						"Abort",
						"Fix (send to agent)",
					]);

					if (choice === "Retry" || choice === "Retry (--no-verify)") {
						for (const [file] of Object.entries(c.files)) await pi.exec("git", ["add", "--", file]);
						const retryArgs = choice === "Retry (--no-verify)" ? [...commitArgs, "--no-verify"] : commitArgs;
						const retry = await pi.exec("git", retryArgs);
						if (retry.code === 0) {
							completedCommits.push(c);
							break;
						}
						const retryError = [retry.stdout, retry.stderr].filter(Boolean).join("\n").trim();
						ctx.ui.notify(retryError, "error");
						continue;
					}

					if (choice === "Skip") {
						await pi.exec("git", ["reset", "HEAD", "--quiet"]);
						break;
					}

					if (choice === "Fix (send to agent)") {
						await pi.exec("git", ["reset", "HEAD", "--quiet"]);
						fixError = errorOutput;
						aborted = true;
						break;
					}

					// "Abort" or dialog dismissed
					await pi.exec("git", ["reset", "HEAD", "--quiet"]);
					aborted = true;
					break;
				}

				if (aborted) break;
			}

			ctx.ui.setStatus("commit", undefined);

			// 6. inject summary — only successful commits
			if (completedCommits.length > 0) {
				const summary = completedCommits.map((c, i) => `${i + 1}. ${c.subject}`).join("\n");
				pi.sendMessage(
					{ customType: "commit", content: `✓ Committed ${completedCommits.length} change(s):\n${summary}`, display: true },
					{ triggerTurn: false },
				);
			}

			// 7. optional push
			if (completedCommits.length > 0 && !fixError) {
				if (await ctx.ui.confirm("Push", "Push to remote?")) {
					ctx.ui.setStatus("commit", "Pushing…");
					const branch = (await pi.exec("git", ["rev-parse", "--abbrev-ref", "HEAD"])).stdout.trim();
					const pushRes = await pi.exec("git", ["push", "-u", "origin", branch]);
					ctx.ui.setStatus("commit", undefined);
					if (pushRes.code === 0) {
						ctx.ui.notify("Pushed successfully", "info");
					} else {
						const pushError = [pushRes.stdout, pushRes.stderr].filter(Boolean).join("\n").trim();
						ctx.ui.notify(`Push failed: ${pushError}`, "error");
					}
				}
			}

			if (fixError) {
				pi.sendUserMessage(
					`Pre-commit hook failed during /commit. Please fix the issues:\n\`\`\`\n${fixError}\n\`\`\``,
				);
			} else if (completedCommits.length === 0) {
				ctx.ui.notify("No commits were made", "info");
			}
		},
	});
}
