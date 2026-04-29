import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Text } from "@mariozechner/pi-tui";
import { lookup } from "node:dns/promises";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import net from "node:net";

const FETCH_TIMEOUT_MS = 20_000;
const SEARCH_TIMEOUT_MS = 15_000;
const MAX_TIMEOUT_MS = 45_000;
const MAX_REDIRECTS = 5;
const MAX_RAW_BYTES = 2 * 1024 * 1024;
const FETCH_MAX_BYTES = 120_000;
const FETCH_MAX_LINES = 700;
const SEARCH_MAX_BYTES = 80_000;
const SEARCH_MAX_LINES = 300;
const DEFAULT_SEARCH_LIMIT = 8;
const MAX_SEARCH_LIMIT = 20;

const USER_AGENT =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

interface WebFetchInput {
  url: string;
  raw?: boolean;
  timeout?: number;
}

interface WebSearchInput {
  query: string;
  limit?: number;
}

interface FetchDetails {
  url: string;
  finalUrl: string;
  status?: number;
  contentType: string;
  method: string;
  truncated: boolean;
  notes: string[];
  fullOutputPath?: string;
  error?: string;
}

interface SearchSource {
  title: string;
  url: string;
  snippet?: string;
}

interface SearchDetails {
  query: string;
  provider: string;
  sourceCount: number;
  error?: string;
}

const webFetchParameters = {
  type: "object",
  properties: {
    url: {
      type: "string",
      description: "HTTP(S) URL to fetch. Bare domains are treated as https:// domains.",
    },
    raw: {
      type: "boolean",
      description: "Return raw text/HTML instead of converting HTML to readable text/Markdown (default false).",
    },
    timeout: {
      type: "number",
      description: "Timeout in seconds (default 20, max 45).",
    },
  },
  required: ["url"],
  additionalProperties: false,
} as const;

const webSearchParameters = {
  type: "object",
  properties: {
    query: {
      type: "string",
      description: "Web search query.",
    },
    limit: {
      type: "number",
      description: `Maximum number of results (default ${DEFAULT_SEARCH_LIMIT}, max ${MAX_SEARCH_LIMIT}).`,
    },
  },
  required: ["query"],
  additionalProperties: false,
} as const;

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
}

function clampNumber(value: unknown, fallback: number, min: number, max: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
  return Math.max(min, Math.min(max, Math.floor(value)));
}

function truncateString(value: string, maxLength: number): string {
  if (value.length <= maxLength) return value;
  return `${value.slice(0, Math.max(0, maxLength - 1))}…`;
}

function normalizeUrl(input: string): string {
  const trimmed = input.trim().replace(/^@/, "");
  if (!trimmed) throw new Error("url must not be empty");
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed)) return `https://${trimmed}`;
  return trimmed;
}

function hostnameForDisplay(value: string): string {
  try {
    return new URL(value).hostname.replace(/^\[|\]$/g, "");
  } catch {
    return truncateString(value, 40);
  }
}

function parseHttpUrl(input: string): URL {
  const url = new URL(normalizeUrl(input));
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error(`Unsupported URL scheme: ${url.protocol.replace(":", "")}. Only http and https are allowed.`);
  }
  if (url.username || url.password) {
    throw new Error("Credentials in URLs are not supported.");
  }
  return url;
}

function isUnsafeIpv4(address: string): boolean {
  const parts = address.split(".").map((part) => Number(part));
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) return true;
  const [a, b] = parts;

  return (
    a === 0 ||
    a === 10 ||
    a === 127 ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 192 && b === 0) ||
    (a === 198 && (b === 18 || b === 19)) ||
    a >= 224
  );
}

function isUnsafeIpv6(address: string): boolean {
  const lower = address.toLowerCase().replace(/^\[|\]$/g, "").split("%")[0];
  if (lower === "::" || lower === "::1") return true;

  if (lower.startsWith("::ffff:")) {
    const mapped = lower.slice("::ffff:".length);
    if (net.isIP(mapped) === 4) return isUnsafeIpv4(mapped);
  }

  const firstChunk = lower.split(":").find(Boolean);
  const first = firstChunk ? Number.parseInt(firstChunk, 16) : 0;
  if (!Number.isFinite(first)) return true;

  return (
    (first & 0xfe00) === 0xfc00 ||
    (first & 0xffc0) === 0xfe80 ||
    (first & 0xff00) === 0xff00
  );
}

function isUnsafeIp(address: string): boolean {
  const family = net.isIP(address.replace(/^\[|\]$/g, ""));
  if (family === 4) return isUnsafeIpv4(address);
  if (family === 6) return isUnsafeIpv6(address);
  return true;
}

async function assertPublicHttpUrl(url: URL): Promise<void> {
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error(`Unsupported URL scheme: ${url.protocol.replace(":", "")}. Only http and https are allowed.`);
  }
  if (url.username || url.password) throw new Error("Credentials in URLs are not supported.");

  const hostname = url.hostname.replace(/^\[|\]$/g, "").toLowerCase();
  if (!hostname || hostname === "localhost" || hostname.endsWith(".localhost")) {
    throw new Error(`Refusing to fetch local hostname: ${url.hostname}`);
  }

  const literalFamily = net.isIP(hostname);
  if (literalFamily) {
    if (isUnsafeIp(hostname)) throw new Error(`Refusing to fetch private or local address: ${hostname}`);
    return;
  }

  const records = await lookup(hostname, { all: true, verbatim: true });
  if (records.length === 0) throw new Error(`Could not resolve hostname: ${hostname}`);

  const blocked = records.find((record) => isUnsafeIp(record.address));
  if (blocked) {
    throw new Error(`Refusing to fetch ${hostname}; it resolves to private or local address ${blocked.address}`);
  }
}

function timedSignal(ms: number, parent?: AbortSignal): AbortSignal {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ms);
  controller.signal.addEventListener("abort", () => clearTimeout(timer), { once: true });

  if (parent) {
    if (parent.aborted) controller.abort();
    else parent.addEventListener("abort", () => controller.abort(), { once: true });
  }

  return controller.signal;
}

async function readBodyLimited(response: Response, maxBytes: number): Promise<{ text: string; truncated: boolean }> {
  if (!response.body) return { text: await response.text(), truncated: false };

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  let truncated = false;

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    if (!value) continue;

    const remaining = maxBytes - total;
    if (remaining <= 0) {
      truncated = true;
      await reader.cancel();
      break;
    }

    if (value.byteLength > remaining) {
      chunks.push(value.slice(0, remaining));
      total += remaining;
      truncated = true;
      await reader.cancel();
      break;
    }

    chunks.push(value);
    total += value.byteLength;
  }

  const buffer = Buffer.concat(chunks.map((chunk) => Buffer.from(chunk)), total);
  return { text: new TextDecoder().decode(buffer), truncated };
}

async function fetchTextSafe(
  input: string,
  options: { timeoutMs: number; signal?: AbortSignal; headers?: Record<string, string> },
): Promise<{ ok: boolean; status: number; finalUrl: string; contentType: string; text: string; rawTruncated: boolean }> {
  let current = parseHttpUrl(input);
  const signal = timedSignal(options.timeoutMs, options.signal);

  for (let redirect = 0; redirect <= MAX_REDIRECTS; redirect++) {
    await assertPublicHttpUrl(current);

    const response = await fetch(current, {
      method: "GET",
      redirect: "manual",
      signal,
      headers: {
        "User-Agent": USER_AGENT,
        Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,application/json;q=0.8,text/plain;q=0.8,*/*;q=0.5",
        "Accept-Language": "en-US,en;q=0.7",
        ...(options.headers ?? {}),
      },
    });

    if (response.status >= 300 && response.status < 400 && response.headers.get("location")) {
      current = new URL(response.headers.get("location")!, current);
      continue;
    }

    const contentType = (response.headers.get("content-type") ?? "text/plain").split(";")[0].trim().toLowerCase();
    const body = await readBodyLimited(response, MAX_RAW_BYTES);
    return {
      ok: response.ok,
      status: response.status,
      finalUrl: response.url || current.toString(),
      contentType,
      text: body.text,
      rawTruncated: body.truncated,
    };
  }

  throw new Error(`Too many redirects (>${MAX_REDIRECTS})`);
}

function decodeHtmlEntities(value: string): string {
  const named: Record<string, string> = {
    amp: "&",
    apos: "'",
    gt: ">",
    lt: "<",
    nbsp: " ",
    quot: '"',
  };

  return value.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (match, entity: string) => {
    const lower = entity.toLowerCase();
    if (lower.startsWith("#x") || lower.startsWith("#")) {
      const codePoint = Number.parseInt(lower.startsWith("#x") ? lower.slice(2) : lower.slice(1), lower.startsWith("#x") ? 16 : 10);
      if (!Number.isFinite(codePoint)) return match;
      try {
        return String.fromCodePoint(codePoint);
      } catch {
        return match;
      }
    }
    return named[lower] ?? match;
  });
}

function looksLikeHtml(content: string): boolean {
  const head = content.trimStart().slice(0, 300).toLowerCase();
  return head.startsWith("<!doctype") || head.startsWith("<html") || head.includes("<body") || head.includes("<head");
}

function looksTextual(content: string): boolean {
  if (!content) return true;
  if (content.includes("\0")) return false;
  const sample = content.slice(0, 2000);
  const controlChars = sample.match(/[\x00-\x08\x0B\x0C\x0E-\x1F]/g)?.length ?? 0;
  return controlChars / sample.length < 0.02;
}

function isTextualContentType(contentType: string, content: string): boolean {
  if (!contentType || contentType === "application/octet-stream") return looksTextual(content);
  if (contentType.startsWith("text/")) return true;
  if (contentType.includes("json") || contentType.includes("xml") || contentType.includes("rss") || contentType.includes("atom")) return true;
  return [
    "application/javascript",
    "application/x-javascript",
    "application/xhtml+xml",
    "application/ld+json",
  ].includes(contentType);
}

function stripHtml(html: string): string {
  return decodeHtmlEntities(
    html
      .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, "")
      .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, "")
      .replace(/<noscript\b[^>]*>[\s\S]*?<\/noscript>/gi, "")
      .replace(/<\/(p|div|section|article|header|footer|main|li|h[1-6]|tr)>/gi, "\n")
      .replace(/<br\s*\/?\s*>/gi, "\n")
      .replace(/<[^>]+>/g, " ")
      .replace(/[ \t]{2,}/g, " ")
      .replace(/\n[ \t]+/g, "\n")
      .replace(/\n{3,}/g, "\n\n")
      .trim(),
  );
}

async function fetchViaJina(url: string, timeoutMs: number, signal?: AbortSignal): Promise<string | undefined> {
  const jinaUrl = `https://r.jina.ai/${url}`;
  try {
    const response = await fetchTextSafe(jinaUrl, {
      timeoutMs,
      signal,
      headers: { Accept: "text/markdown" },
    });
    const text = response.text.trim();
    if (response.ok && text.length >= 40) return text;
  } catch {
    // Fall back to local HTML stripping.
  }
  return undefined;
}

function truncateOutput(output: string, maxBytes: number, maxLines: number): {
  content: string;
  truncated: boolean;
  outputBytes: number;
  totalBytes: number;
  outputLines: number;
  totalLines: number;
} {
  const lines = output.split(/\r\n|\r|\n/);
  let content = lines.slice(0, maxLines).join("\n");
  let truncated = lines.length > maxLines;

  const totalBytes = Buffer.byteLength(output, "utf8");
  if (Buffer.byteLength(content, "utf8") > maxBytes) {
    content = new TextDecoder().decode(Buffer.from(content, "utf8").subarray(0, maxBytes));
    truncated = true;
  } else if (totalBytes > maxBytes && !truncated) {
    content = new TextDecoder().decode(Buffer.from(output, "utf8").subarray(0, maxBytes));
    truncated = true;
  }

  return {
    content,
    truncated,
    outputBytes: Buffer.byteLength(content, "utf8"),
    totalBytes,
    outputLines: content.split(/\r\n|\r|\n/).length,
    totalLines: lines.length,
  };
}

function maybeWriteFullOutput(output: string): string {
  const dir = mkdtempSync(join(tmpdir(), "pi-web-fetch-"));
  const file = join(dir, "output.txt");
  writeFileSync(file, output, "utf8");
  return file;
}

function formatFetchOutput(input: {
  finalUrl: string;
  contentType: string;
  method: string;
  notes: string[];
  content: string;
}): string {
  const header = [`URL: ${input.finalUrl}`, `Content-Type: ${input.contentType || "unknown"}`, `Method: ${input.method}`];
  if (input.notes.length) header.push(`Notes: ${input.notes.join("; ")}`);
  return `${header.join("\n")}\n\n---\n\n${input.content.trim()}`;
}

function parseJsonPretty(value: string): string {
  try {
    return JSON.stringify(JSON.parse(value), null, 2);
  } catch {
    return value;
  }
}

function unwrapDuckDuckGoUrl(rawHref: string): string {
  let href = decodeHtmlEntities(rawHref.trim());
  if (href.startsWith("//")) href = `https:${href}`;
  if (href.startsWith("/")) href = new URL(href, "https://duckduckgo.com").toString();

  try {
    const parsed = new URL(href);
    const uddg = parsed.searchParams.get("uddg");
    if (uddg) return decodeURIComponent(uddg);
    return parsed.toString();
  } catch {
    return href;
  }
}

function extractDuckDuckGoResults(html: string, limit: number): SearchSource[] {
  const sources: SearchSource[] = [];
  const blocks = html.split(/class="result\s/g).slice(1);

  for (const block of blocks) {
    if (sources.length >= limit) break;

    const hrefMatch = block.match(/class="result__a"[^>]*href="([^"]+)"/i);
    const titleMatch = block.match(/class="result__a"[^>]*>([\s\S]*?)<\/a>/i);
    if (!hrefMatch || !titleMatch) continue;

    const title = decodeHtmlEntities(titleMatch[1].replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim());
    const url = unwrapDuckDuckGoUrl(hrefMatch[1]);
    if (!title || !/^https?:\/\//i.test(url)) continue;

    const snippetMatch = block.match(/class="result__snippet"[^>]*>([\s\S]*?)(?:<\/a>|<\/td>|<\/div>)/i);
    const snippet = snippetMatch
      ? decodeHtmlEntities(snippetMatch[1].replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim())
      : undefined;

    sources.push({ title, url, snippet: snippet || undefined });
  }

  return sources;
}

async function searchDuckDuckGo(query: string, limit: number, signal?: AbortSignal): Promise<SearchSource[]> {
  const timeoutSignal = timedSignal(SEARCH_TIMEOUT_MS, signal);
  const body = new URLSearchParams({ q: query, b: "", kl: "" });

  const response = await fetch("https://html.duckduckgo.com/html/", {
    method: "POST",
    redirect: "follow",
    signal: timeoutSignal,
    headers: {
      "User-Agent": USER_AGENT,
      "Content-Type": "application/x-www-form-urlencoded",
      Accept: "text/html",
      "Accept-Language": "en-US,en;q=0.7",
    },
    body,
  });

  if (!response.ok) throw new Error(`DuckDuckGo returned HTTP ${response.status}`);
  const html = await response.text();
  return extractDuckDuckGoResults(html, limit);
}

function formatSearchResults(query: string, sources: SearchSource[]): string {
  const lines: string[] = [`## Search Results (duckduckgo)`, `Query: ${query}`, `${sources.length} result(s)`, ""];

  for (const [index, source] of sources.entries()) {
    lines.push(`[${index + 1}] ${source.title}`);
    lines.push(`    ${source.url}`);
    if (source.snippet) lines.push(`    ${truncateString(source.snippet, 350)}`);
    lines.push("");
  }

  return lines.join("\n").trimEnd();
}

export default function webFetchSearchExtension(pi: ExtensionAPI) {
  pi.registerTool({
    name: "web_fetch",
    label: "Web Fetch",
    description: `Fetch an HTTP(S) URL and return readable text/Markdown. HTML is converted via Jina Reader when possible, with a simple local fallback. Blocks local/private network targets.`,
    promptSnippet: `Fetch an HTTP(S) URL and return readable text/Markdown. Use for public web pages and documentation. Blocks local/private network targets and truncates large output.`,
    promptGuidelines: [
      "Use web_fetch for public HTTP(S) pages when current web content is needed.",
      "Do not use web_fetch for local/private network URLs, credentials, cookies, or logged-in pages.",
    ],
    parameters: webFetchParameters,
    async execute(_toolCallId, params: WebFetchInput, signal) {
      const notes: string[] = [];
      let requestUrl = "";

      try {
        requestUrl = parseHttpUrl(params.url ?? "").toString();
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return {
          content: [{ type: "text" as const, text: `web_fetch failed: ${message}` }],
          details: { url: params.url, finalUrl: params.url, contentType: "unknown", method: "failed", truncated: false, notes: [], error: message } satisfies FetchDetails,
        };
      }

      try {
        const timeoutMs = clampNumber(params.timeout, FETCH_TIMEOUT_MS / 1000, 1, MAX_TIMEOUT_MS / 1000) * 1000;
        const response = await fetchTextSafe(requestUrl, { timeoutMs, signal });
        if (!response.ok) {
          const message = `HTTP ${response.status}`;
          return {
            content: [{ type: "text" as const, text: `Failed to fetch ${requestUrl}: ${message}` }],
            details: { url: requestUrl, finalUrl: response.finalUrl, status: response.status, contentType: response.contentType, method: "failed", truncated: false, notes, error: message } satisfies FetchDetails,
          };
        }

        if (response.rawTruncated) notes.push(`Raw response limited to ${formatSize(MAX_RAW_BYTES)}`);

        if (!isTextualContentType(response.contentType, response.text)) {
          const message = `Unsupported non-text content type: ${response.contentType || "unknown"}`;
          return {
            content: [{ type: "text" as const, text: message }],
            details: { url: requestUrl, finalUrl: response.finalUrl, status: response.status, contentType: response.contentType, method: "unsupported", truncated: false, notes, error: message } satisfies FetchDetails,
          };
        }

        const isHtml = response.contentType.includes("html") || looksLikeHtml(response.text);
        const isJson = response.contentType.includes("json");
        let content = response.text;
        let method = "text";

        if (isJson) {
          content = parseJsonPretty(response.text);
          method = "json";
        } else if (isHtml && !params.raw) {
          const jina = await fetchViaJina(response.finalUrl, timeoutMs, signal);
          if (jina) {
            content = jina;
            method = "jina-reader";
            notes.push("Converted HTML via Jina Reader");
          } else {
            content = stripHtml(response.text);
            method = "html-strip";
            notes.push("Jina Reader unavailable; used simple HTML stripping");
          }
        } else if (isHtml && params.raw) {
          method = "raw-html";
        }

        const output = formatFetchOutput({
          finalUrl: response.finalUrl,
          contentType: response.contentType,
          method,
          notes,
          content,
        });
        const truncated = truncateOutput(output, FETCH_MAX_BYTES, FETCH_MAX_LINES);
        let contentOut = truncated.content;
        let fullOutputPath: string | undefined;

        if (truncated.truncated) {
          fullOutputPath = maybeWriteFullOutput(output);
          contentOut += `\n\n[Truncated: ${truncated.outputLines}/${truncated.totalLines} lines, ${formatSize(truncated.outputBytes)}/${formatSize(truncated.totalBytes)}. Full output: ${fullOutputPath}]`;
        }

        return {
          content: [{ type: "text" as const, text: contentOut }],
          details: { url: requestUrl, finalUrl: response.finalUrl, status: response.status, contentType: response.contentType, method, truncated: truncated.truncated, notes, fullOutputPath } satisfies FetchDetails,
        };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return {
          content: [{ type: "text" as const, text: `web_fetch failed: ${message}` }],
          details: { url: requestUrl || params.url, finalUrl: requestUrl || params.url, contentType: "unknown", method: "failed", truncated: false, notes, error: message } satisfies FetchDetails,
        };
      }
    },
    renderCall(args: WebFetchInput, theme: any) {
      const rawUrl = args.url ? normalizeUrl(args.url) : "";
      const domain = rawUrl ? hostnameForDisplay(rawUrl) : "url";
      const path = rawUrl.replace(/^https?:\/\/[^/]+/i, "");
      let text = theme.fg("toolTitle", theme.bold("web_fetch ")) + theme.fg("accent", domain);
      if (path) text += theme.fg("muted", ` ${truncateString(path, 55)}`);
      if (args.raw) text += theme.fg("dim", " (raw)");
      return new Text(text, 0, 0);
    },
    renderResult(result: any, { expanded }: any, theme: any) {
      const details = result.details as FetchDetails | undefined;
      if (!details) return new Text(theme.fg("error", result.content?.[0]?.text ?? "No web_fetch response"), 0, 0);
      if (details.error || details.method === "failed" || details.method === "unsupported") {
        return new Text(theme.fg("error", `✗ ${details.error ?? result.content?.[0]?.text ?? "web_fetch failed"}`), 0, 0);
      }

      const icon = details.truncated ? theme.fg("warning", "⚠") : theme.fg("success", "✓");
      let text = `${icon} ${theme.fg("accent", hostnameForDisplay(details.finalUrl))} ${theme.fg("dim", `[${details.method}]`)}`;
      if (details.truncated) text += theme.fg("warning", " truncated");
      if (expanded) {
        text += `\n  ${theme.fg("muted", "URL:")} ${details.finalUrl}`;
        text += `\n  ${theme.fg("muted", "Type:")} ${details.contentType}`;
        if (details.notes.length) text += `\n  ${theme.fg("muted", "Notes:")} ${details.notes.join("; ")}`;
        if (details.fullOutputPath) text += `\n  ${theme.fg("muted", "Full:")} ${details.fullOutputPath}`;
      }
      return new Text(text, 0, 0);
    },
  });

  pi.registerTool({
    name: "web_search",
    label: "Web Search",
    description: "Search the public web using DuckDuckGo HTML without API keys. Returns title, URL, and snippet for each result.",
    promptSnippet: "Search the public web using DuckDuckGo HTML when up-to-date information or source links are needed. Include cited URLs in answers.",
    promptGuidelines: [
      "Use web_search when current public web information is needed and repository context is insufficient.",
      "Use web_fetch on promising result URLs when exact page content matters.",
      "Always cite source URLs when relying on web_search results.",
    ],
    parameters: webSearchParameters,
    async execute(_toolCallId, params: WebSearchInput, signal) {
      const query = (params.query ?? "").trim();
      if (!query) {
        return {
          content: [{ type: "text" as const, text: "query must not be empty" }],
          details: { query, provider: "duckduckgo", sourceCount: 0, error: "query must not be empty" } satisfies SearchDetails,
        };
      }

      const limit = clampNumber(params.limit, DEFAULT_SEARCH_LIMIT, 1, MAX_SEARCH_LIMIT);
      try {
        const sources = await searchDuckDuckGo(query, limit, signal);
        const output = sources.length ? formatSearchResults(query, sources) : `No DuckDuckGo results for: ${query}`;
        const truncated = truncateOutput(output, SEARCH_MAX_BYTES, SEARCH_MAX_LINES);
        return {
          content: [{ type: "text" as const, text: truncated.content }],
          details: { query, provider: "duckduckgo", sourceCount: sources.length } satisfies SearchDetails,
        };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return {
          content: [{ type: "text" as const, text: `web_search failed: ${message}` }],
          details: { query, provider: "duckduckgo", sourceCount: 0, error: message } satisfies SearchDetails,
        };
      }
    },
    renderCall(args: WebSearchInput, theme: any) {
      return new Text(theme.fg("toolTitle", theme.bold("web_search ")) + theme.fg("accent", `"${truncateString(args.query ?? "", 70)}"`), 0, 0);
    },
    renderResult(result: any, { expanded }: any, theme: any) {
      const details = result.details as SearchDetails | undefined;
      if (!details) return new Text(theme.fg("error", "No web_search response"), 0, 0);
      if (details.error) return new Text(theme.fg("error", `✗ ${details.error}`), 0, 0);

      let text = `${theme.fg("success", "✓")} ${theme.fg("accent", `${details.sourceCount} result${details.sourceCount === 1 ? "" : "s"}`)} ${theme.fg("dim", `[${details.provider}]`)} ${theme.fg("muted", `"${truncateString(details.query, 45)}"`)}`;
      if (expanded) {
        const preview = String(result.content?.[0]?.text ?? "")
          .split("\n")
          .filter((line) => line.trim())
          .slice(0, 12);
        for (const line of preview) text += `\n  ${theme.fg("dim", truncateString(line.trimStart(), 110))}`;
      }
      return new Text(text, 0, 0);
    },
  });
}
