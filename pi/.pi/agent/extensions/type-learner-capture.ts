/**
 * Type Learner Pi capture extension.
 *
 * Global install target:
 *   ~/.pi/agent/extensions/type-learner-capture.ts
 *
 * Captures only user-submitted Pi input into a local JSONL inbox and returns
 * `continue` so normal Pi behavior is unchanged. It does not call any AI
 * provider and does not write to Obsidian directly.
 */
import { randomUUID } from "node:crypto";
import { appendFile, mkdir } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export const CAPTURE_SCHEMA_VERSION = 1;
export const PI_CAPTURE_METHOD = "pi_extension_input";

export interface PiInputEventLike {
  text: string;
  source?: "interactive" | "rpc" | "extension" | string;
  streamingBehavior?: string | null;
  images?: unknown[];
}

export interface PiCaptureContextLike {
  hasUI?: boolean;
  ui?: {
    notify(message: string, level?: "info" | "warning" | "error" | string): void;
  };
}

export interface TypeLearnerPiCaptureOptions {
  inboxPath?: string;
  runtimeHome?: string;
  now?: () => Date;
  makeEventId?: () => string;
}

export interface PiCaptureEnvelope {
  schema_version: typeof CAPTURE_SCHEMA_VERSION;
  event_id: string;
  source: "pi";
  capture_method: typeof PI_CAPTURE_METHOD;
  captured_at: string;
  body_text: string;
  metadata: {
    input_source: "interactive" | "rpc";
    streaming_behavior: string | null;
    image_count: number;
    high_risk_secret?: boolean;
    original_char_count?: number;
  };
}

export function defaultRuntimeHome(): string {
  return process.env.TYPE_LEARNER_HOME ?? join(homedir(), "Library", "Application Support", "type-learner");
}

export function defaultPiInboxPath(runtimeHome = defaultRuntimeHome()): string {
  return process.env.TYPE_LEARNER_PI_INBOX ?? join(runtimeHome, "inbox", "pi-capture.jsonl");
}

export function shouldSkipInput(text: string, source: string | undefined, attachmentCount = 0): boolean {
  const trimmed = text.trim();
  if (!trimmed) return true;
  if (source === "extension") return true;
  if (attachmentCount > 0) return true;
  if (trimmed.includes(":lock:") || trimmed.includes("🔒")) return true;
  return trimmed.startsWith("/") || trimmed.startsWith("!");
}

function inputSource(source: string | undefined): "interactive" | "rpc" {
  return source === "rpc" ? "rpc" : "interactive";
}

const HIGH_RISK_SECRET_PATTERNS = [
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
  /-----BEGIN PGP PRIVATE KEY BLOCK-----[\s\S]*?-----END PGP PRIVATE KEY BLOCK-----/g,
  /\bAuthorization:\s*(?:Bearer|Basic|token)\s+[^\s,;]+/gi,
  /\bBearer\s+[A-Za-z0-9._~+/=-]{20,}\b/gi,
  /\bxox[baprs]-[A-Za-z0-9-]+\b/g,
  /https:\/\/hooks\.slack\.com\/services\/[A-Za-z0-9/_-]+/g,
  /\bsk-[A-Za-z0-9_-]{20,}\b/g,
  /\bsk-ant-[A-Za-z0-9_-]{20,}\b/g,
  /\bAIza[0-9A-Za-z_-]{35}\b/g,
  /\bgh[pousr]_[A-Za-z0-9_]{20,}\b/g,
  /\bgl(?:pat|oas|rt)-[A-Za-z0-9_-]{20,}\b/g,
  /\bhf_[A-Za-z0-9]{20,}\b/g,
  /\bnpm_[A-Za-z0-9]{20,}\b/g,
  /\b(?:sk|rk)_(?:live|test)_[A-Za-z0-9]{16,}\b/g,
  /\bwhsec_[A-Za-z0-9]{16,}\b/g,
  /\bSG\.[A-Za-z0-9_-]{16,}\.[A-Za-z0-9_-]{16,}\b/g,
  /\b\d{8,10}:[A-Za-z0-9_-]{35}\b/g,
  /\b(?:mfa\.[A-Za-z0-9_-]{20,}|[MN][A-Za-z0-9]{23}\.[A-Za-z0-9_-]{6}\.[A-Za-z0-9_-]{27,})\b/g,
  /\bya29\.[A-Za-z0-9_-]{20,}\b/g,
  /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g,
  /\b(password|passwd|pwd)\s*[:=]\s*[^\s,;]+/gi,
  /\b(?:postgres(?:ql)?|mysql|mongodb(?:\+srv)?|redis):\/\/[^\s:@]+:[^\s@]+@[^\s]+/gi,
  /^\s*[A-Z0-9_]*(SECRET|TOKEN|PASSWORD|API_KEY|PRIVATE_KEY|DATABASE_URL|DB_URL)[A-Z0-9_]*\s*=\s*.+$/gim,
];

function redactHighRiskSecrets(text: string): { text: string; highRisk: boolean } {
  let redacted = text;
  for (const pattern of HIGH_RISK_SECRET_PATTERNS) {
    redacted = redacted.replace(pattern, "[토큰]");
  }
  return { text: redacted, highRisk: redacted !== text };
}

export function createPiCaptureEnvelope(event: PiInputEventLike, options: TypeLearnerPiCaptureOptions = {}): PiCaptureEnvelope {
  const now = options.now?.() ?? new Date();
  const sanitized = redactHighRiskSecrets(event.text);
  return {
    schema_version: CAPTURE_SCHEMA_VERSION,
    event_id: options.makeEventId?.() ?? `pi_${now.getTime()}_${randomUUID()}`,
    source: "pi",
    capture_method: PI_CAPTURE_METHOD,
    captured_at: now.toISOString(),
    body_text: sanitized.text,
    metadata: {
      input_source: inputSource(String(event.source ?? "interactive")),
      streaming_behavior: event.streamingBehavior ?? null,
      image_count: event.images?.length ?? 0,
      high_risk_secret: sanitized.highRisk,
      original_char_count: event.text.length,
    },
  };
}

export async function appendPiCaptureEnvelope(envelope: PiCaptureEnvelope, inboxPath = defaultPiInboxPath()): Promise<void> {
  await mkdir(dirname(inboxPath), { recursive: true });
  await appendFile(inboxPath, `${JSON.stringify(envelope)}\n`, "utf8");
}

export function registerTypeLearnerPiCapture(
  pi: Pick<ExtensionAPI, "on">,
  options: TypeLearnerPiCaptureOptions = {},
): void {
  pi.on("input", async (event: PiInputEventLike, ctx: PiCaptureContextLike) => {
    const source = String(event.source ?? "interactive");
    if (shouldSkipInput(event.text, source, event.images?.length ?? 0)) {
      return { action: "continue" };
    }

    const envelope = createPiCaptureEnvelope(event, options);
    const inboxPath = options.inboxPath ?? defaultPiInboxPath(options.runtimeHome);

    try {
      await appendPiCaptureEnvelope(envelope, inboxPath);
    } catch (error) {
      if (ctx.hasUI && ctx.ui) {
        const message = error instanceof Error ? error.message : String(error);
        ctx.ui.notify(`Type Learner capture failed: ${message}`, "warning");
      }
      // Fail open: never block the user's Pi prompt because capture failed.
    }

    return { action: "continue" };
  });
}

export default function typeLearnerCapture(pi: ExtensionAPI) {
  registerTypeLearnerPiCapture(pi);
}
