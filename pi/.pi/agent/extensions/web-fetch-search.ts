/**
 * Web Fetch & Search Extension (No API keys required!)
 *
 * Inspired by https://github.com/can1357/oh-my-pi
 *
 * Two tools:
 *   - web_fetch:  Fetch a URL → clean Markdown (via Jina Reader, no key needed)
 *   - web_search: Search the web via DuckDuckGo HTML (no key needed)
 *
 * Optional API keys for better results:
 *   BRAVE_API_KEY  → Brave Search (higher quality, snippets)
 *   JINA_API_KEY   → Jina Search (semantic search)
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import {
	DEFAULT_MAX_BYTES,
	DEFAULT_MAX_LINES,
	formatSize,
	truncateHead,
} from "@mariozechner/pi-coding-agent";
import { Text } from "@mariozechner/pi-tui";
import { Type } from "typebox";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// ─── Constants ──────────────────────────────────────────────────────────────

const FETCH_MAX_LINES = 500;
const FETCH_TIMEOUT_MS = 20_000;
const SEARCH_TIMEOUT_MS = 15_000;
const MAX_RAW_BYTES = 5 * 1024 * 1024;

const USER_AGENT =
	"Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

// ─── Helpers ────────────────────────────────────────────────────────────────

function env(key: string): string | undefined {
	return process.env[key];
}

function truncStr(s: string, max: number): string {
	return s.length <= max ? s : s.slice(0, max - 1) + "…";
}

function getDomain(url: string): string {
	try {
		return new URL(url).hostname;
	} catch {
		return url.slice(0, 40);
	}
}

function normalizeUrl(url: string): string {
	if (!/^https?:\/\//i.test(url)) return `https://${url}`;
	return url;
}

function looksLikeHtml(content: string): boolean {
	const t = content.trim().toLowerCase();
	return t.startsWith("<!doctype") || t.startsWith("<html") || t.startsWith("<head") || t.startsWith("<body");
}

function timedSignal(ms: number, parent?: AbortSignal): AbortSignal {
	const ctrl = new AbortController();
	const timer = setTimeout(() => ctrl.abort(), ms);
	const cleanup = () => clearTimeout(timer);
	ctrl.signal.addEventListener("abort", cleanup, { once: true });
	if (parent) {
		if (parent.aborted) {
			ctrl.abort();
		} else {
			parent.addEventListener("abort", () => ctrl.abort(), { once: true });
		}
	}
	return ctrl.signal;
}

// ─── Raw Fetch ──────────────────────────────────────────────────────────────

async function fetchRaw(
	url: string,
	opts?: { timeout?: number; headers?: Record<string, string>; signal?: AbortSignal; method?: string; body?: string },
): Promise<{ ok: boolean; status?: number; content: string; contentType: string; finalUrl: string }> {
	const sig = timedSignal(opts?.timeout ?? FETCH_TIMEOUT_MS, opts?.signal);
	try {
		const res = await fetch(url, {
			method: opts?.method ?? "GET",
			headers: {
				"User-Agent": USER_AGENT,
				Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
				"Accept-Language": "en-US,en;q=0.5",
				...(opts?.headers ?? {}),
			},
			body: opts?.body,
			redirect: "follow",
			signal: sig,
		});
		const ct = res.headers.get("content-type") ?? "text/plain";
		const buf = await res.arrayBuffer();
		const content = buf.byteLength > MAX_RAW_BYTES
			? new TextDecoder().decode(buf.slice(0, MAX_RAW_BYTES))
			: new TextDecoder().decode(buf);
		return { ok: res.ok, status: res.status, content, contentType: ct.split(";")[0].trim().toLowerCase(), finalUrl: res.url || url };
	} catch (err: any) {
		return { ok: false, content: err?.message ?? "Fetch failed", contentType: "text/plain", finalUrl: url };
	}
}

// ─── HTML → Text ────────────────────────────────────────────────────────────

/** Use Jina Reader (r.jina.ai) – works WITHOUT API key (rate-limited) */
async function fetchViaJina(url: string, signal?: AbortSignal): Promise<{ ok: boolean; content: string }> {
	const headers: Record<string, string> = { Accept: "text/markdown" };
	const apiKey = env("JINA_API_KEY");
	if (apiKey) headers["Authorization"] = `Bearer ${apiKey}`;

	try {
		const sig = timedSignal(FETCH_TIMEOUT_MS, signal);
		const res = await fetch(`https://r.jina.ai/${url}`, { headers, signal: sig });
		if (!res.ok) return { ok: false, content: "" };
		const text = await res.text();
		if (text.trim().length < 50) return { ok: false, content: "" };
		return { ok: true, content: text };
	} catch {
		return { ok: false, content: "" };
	}
}

/** Basic HTML tag stripping fallback */
function stripHtml(html: string): string {
	return html
		.replace(/<script[^>]*>[\s\S]*?<\/script>/gi, "")
		.replace(/<style[^>]*>[\s\S]*?<\/style>/gi, "")
		.replace(/<[^>]+>/g, " ")
		.replace(/&nbsp;/gi, " ")
		.replace(/&amp;/gi, "&")
		.replace(/&lt;/gi, "<")
		.replace(/&gt;/gi, ">")
		.replace(/&quot;/gi, '"')
		.replace(/&#39;/gi, "'")
		.replace(/\s{2,}/g, " ")
		.replace(/\n{3,}/g, "\n\n")
		.trim();
}

// ─── Search Providers ───────────────────────────────────────────────────────

interface SearchSource {
	title: string;
	url: string;
	snippet?: string;
	age?: string;
}

interface SearchResult {
	provider: string;
	sources: SearchSource[];
	error?: string;
}

// --- DuckDuckGo HTML (NO API KEY) ---

async function searchDuckDuckGo(query: string, limit: number, signal?: AbortSignal): Promise<SearchResult> {
	const sig = timedSignal(SEARCH_TIMEOUT_MS, signal);

	// DuckDuckGo HTML endpoint – POST form
	const body = `q=${encodeURIComponent(query)}&b=&kl=`;
	const res = await fetch("https://html.duckduckgo.com/html/", {
		method: "POST",
		headers: {
			"User-Agent": USER_AGENT,
			"Content-Type": "application/x-www-form-urlencoded",
			Accept: "text/html",
			"Accept-Language": "en-US,en;q=0.5",
		},
		body,
		redirect: "follow",
		signal: sig,
	});

	if (!res.ok) {
		throw new Error(`DuckDuckGo returned HTTP ${res.status}`);
	}

	const html = await res.text();
	const sources: SearchSource[] = [];

	// Parse results from DuckDuckGo HTML
	// Each result is in a div with class "result" containing:
	//   <a class="result__a" href="...">title</a>
	//   <a class="result__snippet">snippet</a>
	const resultBlocks = html.split(/class="result\s/g).slice(1);

	for (const block of resultBlocks) {
		if (sources.length >= limit) break;

		// Extract URL from result__a or result__url href
		let url = "";
		let title = "";
		let snippet = "";

		// Get the link – DuckDuckGo wraps URLs in a redirect, extract the actual URL
		const hrefMatch = block.match(/class="result__a"[^>]*href="([^"]+)"/);
		if (hrefMatch) {
			url = hrefMatch[1];
			// DDG redirect URLs: //duckduckgo.com/l/?uddg=<encoded_url>&...
			const uddgMatch = url.match(/[?&]uddg=([^&]+)/);
			if (uddgMatch) {
				url = decodeURIComponent(uddgMatch[1]);
			} else if (url.startsWith("//")) {
				url = "https:" + url;
			}
		}

		// Get title text from result__a
		const titleMatch = block.match(/class="result__a"[^>]*>([^<]*(?:<[^/][^>]*>[^<]*)*)<\/a>/);
		if (titleMatch) {
			title = titleMatch[1].replace(/<[^>]+>/g, "").trim();
		}

		// Get snippet
		const snippetMatch = block.match(/class="result__snippet"[^>]*>([\s\S]*?)(?:<\/a>|<\/td>)/);
		if (snippetMatch) {
			snippet = snippetMatch[1].replace(/<[^>]+>/g, "").replace(/\s+/g, " ").trim();
		}

		if (url && title) {
			sources.push({ title, url, snippet: snippet || undefined });
		}
	}

	return { provider: "duckduckgo", sources };
}

// --- Brave Search (API key) ---

async function searchBrave(query: string, limit: number, recency?: string, signal?: AbortSignal): Promise<SearchResult> {
	const apiKey = env("BRAVE_API_KEY");
	if (!apiKey) throw new Error("BRAVE_API_KEY not set");

	const url = new URL("https://api.search.brave.com/res/v1/web/search");
	url.searchParams.set("q", query);
	url.searchParams.set("count", String(Math.min(limit, 20)));
	url.searchParams.set("extra_snippets", "true");
	const recencyMap: Record<string, string> = { day: "pd", week: "pw", month: "pm", year: "py" };
	if (recency && recencyMap[recency]) url.searchParams.set("freshness", recencyMap[recency]);

	const sig = timedSignal(SEARCH_TIMEOUT_MS, signal);
	const res = await fetch(url, {
		headers: { Accept: "application/json", "X-Subscription-Token": apiKey },
		signal: sig,
	});
	if (!res.ok) throw new Error(`Brave API ${res.status}: ${(await res.text()).slice(0, 200)}`);

	const data = (await res.json()) as any;
	const sources: SearchSource[] = [];
	for (const r of data?.web?.results ?? []) {
		if (!r.url) continue;
		const snippets: string[] = [];
		if (r.description?.trim()) snippets.push(r.description.trim());
		if (Array.isArray(r.extra_snippets)) for (const s of r.extra_snippets) if (s?.trim()) snippets.push(s.trim());
		sources.push({ title: r.title ?? r.url, url: r.url, snippet: snippets.join("\n") || undefined, age: r.age });
	}
	return { provider: "brave", sources };
}

// --- Jina Search (API key) ---

async function searchJina(query: string, limit: number, signal?: AbortSignal): Promise<SearchResult> {
	const apiKey = env("JINA_API_KEY");
	if (!apiKey) throw new Error("JINA_API_KEY not set");

	const sig = timedSignal(SEARCH_TIMEOUT_MS, signal);
	const res = await fetch(`https://s.jina.ai/${encodeURIComponent(query)}`, {
		headers: { Accept: "application/json", Authorization: `Bearer ${apiKey}` },
		signal: sig,
	});
	if (!res.ok) throw new Error(`Jina API ${res.status}: ${(await res.text()).slice(0, 200)}`);

	const data = (await res.json()) as any;
	const items: any[] = Array.isArray(data) ? data : data?.data ?? [];
	const sources: SearchSource[] = [];
	for (const r of items) {
		if (!r?.url) continue;
		sources.push({ title: r.title ?? r.url, url: r.url, snippet: r.content ?? r.description ?? undefined });
	}
	return { provider: "jina", sources: sources.slice(0, limit) };
}

// --- Provider selection ---

async function doSearch(
	query: string, limit: number, recency?: string, preferred?: string, signal?: AbortSignal,
): Promise<SearchResult> {
	type Fn = () => Promise<SearchResult>;
	const chain: Array<{ name: string; fn: Fn }> = [];

	// Build provider chain based on preference and available keys
	if (preferred === "brave") {
		chain.push({ name: "brave", fn: () => searchBrave(query, limit, recency, signal) });
	} else if (preferred === "jina") {
		chain.push({ name: "jina", fn: () => searchJina(query, limit, signal) });
	} else if (preferred === "duckduckgo") {
		chain.push({ name: "ddg", fn: () => searchDuckDuckGo(query, limit, signal) });
	} else {
		// Auto: try paid providers first, fall back to free DuckDuckGo
		if (env("BRAVE_API_KEY")) chain.push({ name: "brave", fn: () => searchBrave(query, limit, recency, signal) });
		if (env("JINA_API_KEY")) chain.push({ name: "jina", fn: () => searchJina(query, limit, signal) });
		chain.push({ name: "ddg", fn: () => searchDuckDuckGo(query, limit, signal) });
	}

	let lastError = "";
	for (const p of chain) {
		try {
			return await p.fn();
		} catch (err: any) {
			lastError = err?.message ?? String(err);
		}
	}
	return { provider: "none", sources: [], error: `All search providers failed. Last: ${lastError}` };
}

// ─── Tool Details types ─────────────────────────────────────────────────────

interface FetchDetails {
	url: string;
	finalUrl: string;
	contentType: string;
	method: string;
	truncated: boolean;
	notes: string[];
	fullOutputPath?: string;
}

interface SearchDetails {
	query: string;
	provider: string;
	sourceCount: number;
	error?: string;
}

// ─── Extension ──────────────────────────────────────────────────────────────

export default function (pi: ExtensionAPI) {
	// ═══════════════════════════════════════════════════════════════════════
	// web_fetch
	// ═══════════════════════════════════════════════════════════════════════
	pi.registerTool({
		name: "web_fetch",
		label: "Web Fetch",
		description: `Fetch a URL and return its content in clean, readable Markdown format.
Converts HTML pages to Markdown via Jina Reader (no API key needed).
Handles HTML, JSON, plain text, XML/RSS feeds.
Use raw=true to get untransformed HTML.
Output is truncated to ${FETCH_MAX_LINES} lines or ${formatSize(DEFAULT_MAX_BYTES)}.`,
		promptSnippet: `Fetch a URL and return its content in clean, readable Markdown format.
Converts HTML pages to Markdown via Jina Reader (no API key needed).
Handles HTML, JSON, plain text, XML/RSS feeds.
Use raw=true to get untransformed HTML.
Output is truncated to ${FETCH_MAX_LINES} lines or ${formatSize(DEFAULT_MAX_BYTES)}.`,
		parameters: Type.Object({
			url: Type.String({ description: "URL to fetch" }),
			raw: Type.Optional(Type.Boolean({ description: "Return raw content without HTML→Markdown (default: false)" })),
			timeout: Type.Optional(Type.Number({ description: "Timeout in seconds (default: 20, max: 45)" })),
		}),

		async execute(_toolCallId, params, signal) {
			const url = normalizeUrl((params.url ?? "").replace(/^@/, ""));
			const raw = params.raw ?? false;
			const timeoutMs = Math.min(Math.max(params.timeout ?? 20, 1), 45) * 1000;
			const notes: string[] = [];
			let content = "";
			let method = "raw";
			let contentType = "text/plain";
			let finalUrl = url;

			// 1) Fetch raw
			const resp = await fetchRaw(url, { timeout: timeoutMs, signal });
			if (!resp.ok) {
				const msg = resp.status ? `HTTP ${resp.status}` : resp.content.slice(0, 200);
				return {
					content: [{ type: "text" as const, text: `Failed to fetch: ${msg}` }],
					details: { url, finalUrl: resp.finalUrl, contentType: "unknown", method: "failed", truncated: false, notes: [msg] } as FetchDetails,
				};
			}

			finalUrl = resp.finalUrl;
			contentType = resp.contentType;

			// 2) Process by content type
			const isHtml = contentType.includes("html") || contentType.includes("xhtml");
			const isJson = contentType.includes("json");
			const isFeed = contentType.includes("rss") || contentType.includes("atom") || contentType.includes("feed")
				|| (contentType.includes("xml") && (resp.content.includes("<rss") || resp.content.includes("<feed")));

			if (isJson) {
				try { content = JSON.stringify(JSON.parse(resp.content), null, 2); } catch { content = resp.content; }
				method = "json";
			} else if (isFeed) {
				content = resp.content;
				method = "feed";
			} else if ((isHtml || looksLikeHtml(resp.content)) && !raw) {
				const jina = await fetchViaJina(url, signal);
				if (jina.ok) {
					content = jina.content;
					method = "jina-reader";
					notes.push("Converted via Jina Reader");
				} else {
					content = stripHtml(resp.content);
					method = "html-strip";
					notes.push("Jina unavailable, used basic HTML stripping");
				}
			} else {
				content = resp.content;
				method = "text";
			}

			// 3) Build output
			content = content.replace(/\n{3,}/g, "\n\n").trim();
			let output = `URL: ${finalUrl}\nContent-Type: ${contentType}\nMethod: ${method}\n`;
			if (notes.length) output += `Notes: ${notes.join("; ")}\n`;
			output += `\n---\n\n${content}`;

			// 4) Truncate
			const trunc = truncateHead(output, { maxLines: FETCH_MAX_LINES, maxBytes: DEFAULT_MAX_BYTES });
			let fullOutputPath: string | undefined;
			if (trunc.truncated) {
				const dir = mkdtempSync(join(tmpdir(), "pi-fetch-"));
				fullOutputPath = join(dir, "output.txt");
				writeFileSync(fullOutputPath, output);
				output = trunc.content
					+ `\n\n[Truncated: ${trunc.outputLines}/${trunc.totalLines} lines`
					+ ` (${formatSize(trunc.outputBytes)}/${formatSize(trunc.totalBytes)}).`
					+ ` Full output: ${fullOutputPath}]`;
			} else {
				output = trunc.content;
			}

			return {
				content: [{ type: "text" as const, text: output }],
				details: { url, finalUrl, contentType, method, truncated: trunc.truncated, notes, fullOutputPath } as FetchDetails,
			};
		},

		renderCall(args: any, theme: any) {
			const u = normalizeUrl(args.url ?? "");
			let t = theme.fg("toolTitle", theme.bold("web_fetch "));
			t += theme.fg("accent", getDomain(u));
			const p = u.replace(/^https?:\/\/[^/]+/, "");
			if (p) t += theme.fg("muted", ` ${truncStr(p, 50)}`);
			if (args.raw) t += theme.fg("dim", " (raw)");
			return new Text(t, 0, 0);
		},

		renderResult(result: any, { expanded }: any, theme: any) {
			const d = result.details as FetchDetails | undefined;
			if (!d) return new Text(theme.fg("error", result.content?.[0]?.text ?? "No response"), 0, 0);
			if (d.method === "failed") return new Text(theme.fg("error", `✗ ${d.notes[0] ?? "Fetch failed"}`), 0, 0);

			const icon = d.truncated ? theme.fg("warning", "⚠") : theme.fg("success", "✓");
			let t = `${icon} ${theme.fg("accent", getDomain(d.finalUrl))} ${theme.fg("dim", `[${d.method}]`)}`;
			if (d.truncated) t += theme.fg("warning", " (truncated)");

			if (expanded) {
				t += `\n  ${theme.fg("muted", "URL:")} ${d.finalUrl}`;
				t += `\n  ${theme.fg("muted", "Type:")} ${d.contentType}`;
				if (d.notes.length) t += `\n  ${theme.fg("muted", "Notes:")} ${d.notes.join("; ")}`;
				if (d.fullOutputPath) t += `\n  ${theme.fg("muted", "Full:")} ${d.fullOutputPath}`;
				const body = (result.content?.[0]?.text ?? "").split("---\n\n").slice(1).join("---\n\n");
				const lines = body.split("\n").filter((l: string) => l.trim()).slice(0, 8);
				for (const l of lines) t += `\n  ${theme.fg("dim", truncStr(l, 100))}`;
				if (body.split("\n").filter((l: string) => l.trim()).length > 8) t += `\n  ${theme.fg("muted", "...")}`;
			}
			return new Text(t, 0, 0);
		},
	});

	// ═══════════════════════════════════════════════════════════════════════
	// web_search
	// ═══════════════════════════════════════════════════════════════════════
	pi.registerTool({
		name: "web_search",
		label: "Web Search",
		description: `Search the web for up-to-date information. Works WITHOUT any API key using DuckDuckGo.
Optional: set BRAVE_API_KEY or JINA_API_KEY for higher quality results (auto-selected when available).
Always include source links when citing search results.`,
		promptSnippet: `Search the web for up-to-date information. Works WITHOUT any API key using DuckDuckGo.
Optional: set BRAVE_API_KEY or JINA_API_KEY for higher quality results (auto-selected when available).
Always include source links when citing search results.`,
		parameters: Type.Object({
			query: Type.String({ description: "Search query" }),
			provider: Type.Optional(Type.String({ description: '"duckduckgo" (free, default), "brave" (needs key), or "jina" (needs key)' })),
			recency: Type.Optional(Type.String({ description: '"day", "week", "month", "year" (Brave only)' })),
			limit: Type.Optional(Type.Number({ description: "Max results (default: 10)" })),
		}),

		async execute(_toolCallId, params, signal) {
			const query = params.query ?? "";
			const limit = Math.min(Math.max(params.limit ?? 10, 1), 20);

			const result = await doSearch(query, limit, params.recency, params.provider, signal);

			if (result.error) {
				return {
					content: [{ type: "text" as const, text: `Error: ${result.error}` }],
					details: { query, provider: result.provider, sourceCount: 0, error: result.error } as SearchDetails,
				};
			}

			const parts: string[] = [];
			parts.push(`## Search Results (${result.provider})`);
			parts.push(`Query: ${query}`);
			parts.push(`${result.sources.length} result(s)\n`);
			for (const [i, src] of result.sources.entries()) {
				parts.push(`[${i + 1}] ${src.title}`);
				parts.push(`    ${src.url}`);
				if (src.age) parts.push(`    Age: ${src.age}`);
				if (src.snippet) parts.push(`    ${truncStr(src.snippet, 300)}`);
				parts.push("");
			}

			const output = parts.join("\n");
			const trunc = truncateHead(output, { maxLines: DEFAULT_MAX_LINES, maxBytes: DEFAULT_MAX_BYTES });

			return {
				content: [{ type: "text" as const, text: trunc.content }],
				details: { query, provider: result.provider, sourceCount: result.sources.length } as SearchDetails,
			};
		},

		renderCall(args: any, theme: any) {
			let t = theme.fg("toolTitle", theme.bold("web_search "));
			t += theme.fg("accent", `"${truncStr(args.query ?? "", 60)}"`);
			if (args.provider) t += theme.fg("dim", ` [${args.provider}]`);
			if (args.recency) t += theme.fg("dim", ` ~${args.recency}`);
			return new Text(t, 0, 0);
		},

		renderResult(result: any, { expanded }: any, theme: any) {
			const d = result.details as SearchDetails | undefined;
			if (!d) return new Text(theme.fg("error", "No results"), 0, 0);
			if (d.error) return new Text(theme.fg("error", `✗ ${d.error}`), 0, 0);

			let t = `${theme.fg("success", "✓")} ${theme.fg("accent", `${d.sourceCount} results`)}`;
			t += theme.fg("dim", ` [${d.provider}]`);
			t += theme.fg("muted", ` "${truncStr(d.query, 40)}"`);

			if (expanded) {
				const lines = (result.content?.[0]?.text ?? "").split("\n").filter((l: string) => l.trim()).slice(0, 15);
				for (const l of lines) t += `\n  ${theme.fg("dim", truncStr(l.trimStart(), 100))}`;
				const total = (result.content?.[0]?.text ?? "").split("\n").filter((l: string) => l.trim()).length;
				if (total > 15) t += `\n  ${theme.fg("muted", `... ${total - 15} more`)}`;
			}
			return new Text(t, 0, 0);
		},
	});

}
