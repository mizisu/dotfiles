import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { isToolCallEventType } from "@mariozechner/pi-coding-agent";
import path from "node:path";

type SensitivePathRule = {
  patterns: string[];
  reason: string;
};

type ToolCallContentBlock = {
  type: "toolCall";
  name: string;
  arguments: Record<string, unknown>;
};

const REDACTED_SENSITIVE_WRITE_CONTENT = "[REDACTED: sensitive file write content omitted]";
const REDACTED_SENSITIVE_EDIT_TEXT = "[REDACTED: sensitive file edit text omitted]";

const SENSITIVE_PATH_RULES: SensitivePathRule[] = [
  {
    patterns: [".env", ".env.*"],
    reason: ".env files may contain secrets",
  },
  {
    patterns: ["agent/auth.json"],
    reason: "agent/auth.json contains Pi credentials",
  },
];

function normalizePath(filePath: string): string {
  return path.normalize(filePath.replace(/^@/, "")).replace(/\\/g, "/").replace(/^\.\//, "");
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function matchesPattern(value: string, pattern: string): boolean {
  const regex = new RegExp(`^${escapeRegExp(pattern).replace(/\\\*/g, ".*")}$`);

  return regex.test(value);
}

function pathMatchesPattern(normalizedPath: string, pattern: string): boolean {
  const normalizedPattern = normalizePath(pattern);

  if (normalizedPattern.includes("/")) {
    return matchesPattern(normalizedPath, normalizedPattern) || matchesPattern(normalizedPath, `*/${normalizedPattern}`);
  }

  return matchesPattern(path.posix.basename(normalizedPath), normalizedPattern);
}

function findSensitivePathRule(filePath: string): SensitivePathRule | undefined {
  const normalizedPath = normalizePath(filePath);

  return SENSITIVE_PATH_RULES.find((rule) =>
    rule.patterns.some((pattern) => pathMatchesPattern(normalizedPath, pattern)),
  );
}

function commandPathCandidates(command: string): string[] {
  return command
    .replace(/[=;&|<>(){}[\]"'`$]/g, " ")
    .split(/\s+/)
    .filter(Boolean);
}

function findSensitiveCommandRule(command: string): SensitivePathRule | undefined {
  return commandPathCandidates(command)
    .map((candidate) => findSensitivePathRule(candidate))
    .find((rule) => rule !== undefined);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isToolCallContentBlock(block: unknown): block is ToolCallContentBlock {
  return (
    isRecord(block) &&
    block.type === "toolCall" &&
    typeof block.name === "string" &&
    isRecord(block.arguments)
  );
}

function redactSensitiveWriteEditCall(block: unknown): unknown {
  if (!isToolCallContentBlock(block)) return block;
  if (block.name !== "write" && block.name !== "edit") return block;

  const filePath = block.arguments.path;
  if (typeof filePath !== "string") return block;
  if (!findSensitivePathRule(filePath)) return block;

  if (block.name === "write") {
    return {
      ...block,
      arguments: {
        ...block.arguments,
        content: REDACTED_SENSITIVE_WRITE_CONTENT,
      },
    };
  }

  return {
    ...block,
    arguments: {
      ...block.arguments,
      edits: [{ oldText: REDACTED_SENSITIVE_EDIT_TEXT, newText: REDACTED_SENSITIVE_EDIT_TEXT }],
    },
  };
}

function redactSensitiveAssistantMessage<T extends { role: string; content?: unknown }>(message: T): T | undefined {
  if (message.role !== "assistant" || !Array.isArray(message.content)) return undefined;

  let modified = false;
  const content = message.content.map((block) => {
    const redactedBlock = redactSensitiveWriteEditCall(block);
    if (redactedBlock !== block) modified = true;
    return redactedBlock;
  });

  return modified ? ({ ...message, content } as T) : undefined;
}

function redactSensitiveMessages<T extends { role: string; content?: unknown }>(messages: T[]): { messages: T[]; modified: boolean } {
  let modified = false;
  const redactedMessages = messages.map((message) => {
    const redactedMessage = redactSensitiveAssistantMessage(message);
    if (!redactedMessage) return message;

    modified = true;
    return redactedMessage;
  });

  return { messages: redactedMessages, modified };
}

function sensitivePathReason(action: "Reading" | "Modifying", filePath: string, rule: SensitivePathRule): string {
  return `${action} ${filePath} is blocked because ${rule.reason}.`;
}

export default function (pi: ExtensionAPI) {
  pi.on("message_end", async (event) => {
    const redactedMessage = redactSensitiveAssistantMessage(event.message);
    if (redactedMessage) return { message: redactedMessage };

    return undefined;
  });

  pi.on("context", async (event) => {
    const result = redactSensitiveMessages(event.messages);
    if (result.modified) return { messages: result.messages };

    return undefined;
  });

  pi.on("tool_call", async (event) => {
    if (isToolCallEventType("read", event)) {
      const rule = findSensitivePathRule(event.input.path);
      if (rule) return { block: true, reason: sensitivePathReason("Reading", event.input.path, rule) };
    }

    if (isToolCallEventType("write", event)) {
      const rule = findSensitivePathRule(event.input.path);
      if (rule) return { block: true, reason: sensitivePathReason("Modifying", event.input.path, rule) };
    }

    if (isToolCallEventType("edit", event)) {
      const rule = findSensitivePathRule(event.input.path);
      if (rule) return { block: true, reason: sensitivePathReason("Modifying", event.input.path, rule) };
    }

    if (isToolCallEventType("bash", event)) {
      const rule = findSensitiveCommandRule(event.input.command);
      if (rule) {
        return {
          block: true,
          reason: `Accessing sensitive files via bash is blocked because ${rule.reason}.`,
        };
      }
    }

    return undefined;
  });
}
