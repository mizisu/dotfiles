/**
 * Code Index Extension
 *
 * Provides search_symbols and project_map tools using universal-ctags.
 * Index is built lazily on first tool call and cached to .pi/index/tags.jsonl.
 * Marked dirty on write/edit, rebuilt on next search.
 *
 * Requires: brew install universal-ctags
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import * as fs from "node:fs";
import * as path from "node:path";

const CTAGS_BIN = "/opt/homebrew/bin/ctags";

interface TagEntry {
	name: string;
	path: string;
	line: number;
	kind: string;
	scope?: string;
	scopeKind?: string;
	signature?: string;
}

export default function (pi: ExtensionAPI) {
	let dirty = true;
	let tags: TagEntry[] = [];
	let currentCwd = "";

	function indexPath(cwd: string): string {
		return path.join(cwd, ".pi", "index", "tags.jsonl");
	}

	function isStale(cwd: string): boolean {
		const p = indexPath(cwd);
		if (!fs.existsSync(p)) return true;
		return Date.now() - fs.statSync(p).mtimeMs > 10 * 60 * 1000;
	}

	function loadFromDisk(cwd: string): boolean {
		const p = indexPath(cwd);
		if (!fs.existsSync(p)) return false;
		try {
			tags = fs
				.readFileSync(p, "utf-8")
				.split("\n")
				.filter((l) => l.trim())
				.map((l) => JSON.parse(l));
			dirty = false;
			currentCwd = cwd;
			return true;
		} catch {
			return false;
		}
	}

	function saveToDisk(cwd: string): void {
		const dir = path.join(cwd, ".pi", "index");
		fs.mkdirSync(dir, { recursive: true });
		fs.writeFileSync(
			indexPath(cwd),
			tags.map((t) => JSON.stringify(t)).join("\n"),
		);
	}

	async function buildIndex(cwd: string, signal?: AbortSignal): Promise<boolean> {
		if (!fs.existsSync(CTAGS_BIN)) return false;

		const isGit = fs.existsSync(path.join(cwd, ".git"));

		const cmd = isGit
			? `git ls-files --cached --others --exclude-standard | "${CTAGS_BIN}" --output-format=json --fields=+nKS -L - -f -`
			: `"${CTAGS_BIN}" -R --output-format=json --fields=+nKS --exclude=node_modules --exclude=.git --exclude=dist --exclude=build --exclude=__pycache__ --exclude=vendor --exclude=.next --exclude='*.min.*' -f - .`;

		const result = await pi.exec("bash", ["-c", cmd], { cwd, signal, timeout: 30000 });
		if (result.code !== 0 && !result.stdout) return false;

		tags = [];
		for (const line of result.stdout.split("\n")) {
			if (!line.trim()) continue;
			try {
				const e = JSON.parse(line);
				if (e._type !== "tag") continue;
				const relPath = path.isAbsolute(e.path) ? path.relative(cwd, e.path) : e.path;
				tags.push({
					name: e.name,
					path: relPath,
					line: e.line,
					kind: e.kind,
					...(e.scope && { scope: e.scope }),
					...(e.scopeKind && { scopeKind: e.scopeKind }),
					...(e.signature && { signature: e.signature }),
				});
			} catch {}
		}

		saveToDisk(cwd);
		dirty = false;
		currentCwd = cwd;
		return true;
	}

	async function ensureIndex(cwd: string, signal?: AbortSignal): Promise<boolean> {
		if (currentCwd !== cwd) dirty = true;
		if (!dirty && tags.length > 0) return true;
		if (!isStale(cwd) && loadFromDisk(cwd)) return true;
		return buildIndex(cwd, signal);
	}

	const FAIL_MSG = "Failed to build index. Is universal-ctags installed? (brew install universal-ctags)";

	// ── Tool 1: search_symbols ──
	pi.registerTool({
		name: "search_symbols",
		label: "Search Symbols",
		description:
			"Search project symbols (functions, classes, types, methods) by name. Returns compact list of name, kind, file:line. Use BEFORE reading files to locate code quickly.",
		promptSnippet:
			"Search project symbols (functions, classes, types, methods) by name. Returns compact list of name, kind, file:line. Use BEFORE reading files to locate code quickly.",
		parameters: Type.Object({
			query: Type.String({ description: "Symbol name (case-insensitive, partial match)" }),
			kind: Type.Optional(
				Type.String({ description: "Filter: function, class, method, interface, type, constant" }),
			),
			limit: Type.Optional(Type.Number({ description: "Max results (default 20)" })),
		}),
		async execute(_toolCallId, params, signal, _onUpdate, ctx) {
			if (!(await ensureIndex(ctx.cwd, signal))) {
				return { content: [{ type: "text", text: FAIL_MSG }], details: {} };
			}

			const query = params.query.toLowerCase();
			const limit = params.limit ?? 20;

			const allMatches = tags.filter((t) => t.name.toLowerCase().includes(query));
			let results = allMatches;
			let kindDropped = false;

			if (params.kind) {
				const kind = params.kind.toLowerCase();
				const filtered = results.filter((t) => t.kind.toLowerCase() === kind);
				if (filtered.length === 0 && allMatches.length > 0) {
					// kind filter eliminated all results — show unfiltered with a hint
					kindDropped = true;
				} else {
					results = filtered;
				}
			}

			// Sort: exact match first, then starts-with, then contains
			results.sort((a, b) => {
				const al = a.name.toLowerCase();
				const bl = b.name.toLowerCase();
				const aExact = al === query ? 0 : al.startsWith(query) ? 1 : 2;
				const bExact = bl === query ? 0 : bl.startsWith(query) ? 1 : 2;
				return aExact - bExact || al.localeCompare(bl);
			});

			results = results.slice(0, limit);

			if (results.length === 0) {
				return {
					content: [{ type: "text", text: `No symbols matching "${params.query}".` }],
					details: {},
				};
			}

			const kindHint = kindDropped
				? `\n(Note: kind="${params.kind}" matched nothing. Showing all ${allMatches.length} matches without kind filter.)`
				: "";

			const lines = results.map((t) => {
				const sig = t.signature ?? "";
				const scope = t.scope ? ` [${t.scope}]` : "";
				return `${t.name}${sig}  ${t.kind}  ${t.path}:${t.line}${scope}`;
			});

			const total = tags.filter((t) => t.name.toLowerCase().includes(query)).length;
			const header =
				total > limit
					? `${limit}/${total} symbols matching "${params.query}":`
					: `${total} symbol(s) matching "${params.query}":`;

			return {
				content: [{ type: "text", text: `${header}${kindHint}\n${lines.join("\n")}` }],
				details: { shown: results.length, total },
			};
		},
	});

	// ── Tool 2: project_map ──
	pi.registerTool({
		name: "project_map",
		label: "Project Map",
		description:
			"Show directory structure with symbols (functions, classes, types, methods). Returns a compact file→symbol tree. Use to understand project layout without reading files.",
		promptSnippet:
			"Show directory structure with symbols (functions, classes, types, methods). Returns a compact file→symbol tree. Use to understand project layout without reading files.",
		parameters: Type.Object({
			path: Type.Optional(Type.String({ description: "Directory to map (default: project root)" })),
			depth: Type.Optional(Type.Number({ description: "Max directory depth (default 3)" })),
			showAll: Type.Optional(Type.Boolean({ description: "Include properties/fields (default false)" })),
		}),
		async execute(_toolCallId, params, signal, _onUpdate, ctx) {
			if (!(await ensureIndex(ctx.cwd, signal))) {
				return { content: [{ type: "text", text: FAIL_MSG }], details: {} };
			}

			const target = params.path?.replace(/^@/, "").replace(/\/$/, "") ?? "";
			const maxDepth = params.depth ?? 3;
			const noiseKinds = ["property", "member", "field", "variable", "parameter", "enumerator"];

			let filtered = target ? tags.filter((t) => t.path.startsWith(target + "/") || t.path === target) : [...tags];

			if (!params.showAll) {
				filtered = filtered.filter((t) => !noiseKinds.includes(t.kind));
			}

			// Limit depth
			const baseDepth = target ? target.split("/").filter(Boolean).length : 0;
			filtered = filtered.filter((t) => {
				const d = t.path.split("/").length - baseDepth;
				return d <= maxDepth;
			});

			// Group by file
			const byFile = new Map<string, TagEntry[]>();
			for (const t of filtered) {
				const list = byFile.get(t.path) ?? [];
				list.push(t);
				byFile.set(t.path, list);
			}

			if (byFile.size === 0) {
				return {
					content: [{ type: "text", text: `No symbols in "${target || "."}".` }],
					details: {},
				};
			}

			const maxFiles = 30;
			const sortedFiles = [...byFile.keys()].sort();
			const shown = sortedFiles.slice(0, maxFiles);

			const lines: string[] = [];
			for (const file of shown) {
				const syms = byFile
					.get(file)!
					.map((t) => {
						const sig = t.signature ?? "";
						const prefix = t.scope ? `${t.scope}.` : "";
						return `  ${prefix}${t.name}${sig} (${t.kind})`;
					})
					.join("\n");
				lines.push(`${file}\n${syms}`);
			}

			if (sortedFiles.length > maxFiles) {
				lines.push(`... +${sortedFiles.length - maxFiles} more files`);
			}

			const header = `${target || "."} — ${byFile.size} files, ${filtered.length} symbols`;

			return {
				content: [{ type: "text", text: `${header}\n\n${lines.join("\n\n")}` }],
				details: { fileCount: byFile.size, symbolCount: filtered.length },
			};
		},
	});

	// /reindex command is handled by code-search extension (runs both ctags + vector)

	// ── Lifecycle ──
	pi.on("session_start", async (_event, ctx) => {
		currentCwd = ctx.cwd;
		if (!isStale(ctx.cwd)) loadFromDisk(ctx.cwd);
		watchGitHead(ctx.cwd);
	});

	pi.on("session_shutdown", async () => {
		headWatcher?.close();
	});

	pi.on("tool_result", async (event) => {
		if (event.toolName === "write" || event.toolName === "edit") {
			dirty = true;
		}
	});

	// 브랜치 변경 감지 (.git/HEAD 감시 — 어디서 변경하든 감지)
	let headWatcher: fs.FSWatcher | undefined;

	function watchGitHead(cwd: string): void {
		headWatcher?.close();
		const headPath = path.join(cwd, ".git", "HEAD");
		if (!fs.existsSync(headPath)) return;
		try {
			headWatcher = fs.watch(headPath, () => {
				dirty = true;
			});
			headWatcher.on("error", () => headWatcher?.close());
		} catch {}
	}
}
