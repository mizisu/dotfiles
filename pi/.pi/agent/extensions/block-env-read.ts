import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { isToolCallEventType } from "@mariozechner/pi-coding-agent";
import * as path from "node:path";

const BLOCKED_BASENAMES = [".env", ".env.example"];
const BLOCKED_PATHS = ["agent/auth.json"];
const READ_COMMAND_RE = /\b(cat|less|more|head|tail|bat|sed|awk)\b/;

function normalizeFilePath(filePath: string): string {
  return path.normalize(filePath).replace(/\\/g, "/").replace(/^\.\//, "");
}

function isBlockedFile(filePath: string): boolean {
  const normalizedPath = normalizeFilePath(filePath);
  const basename = path.basename(normalizedPath);

  return (
    BLOCKED_BASENAMES.some((pattern) => basename === pattern) ||
    BLOCKED_PATHS.some((pattern) => normalizedPath === pattern || normalizedPath.endsWith(`/${pattern}`))
  );
}

function getBlockedReason(filePath: string): string {
  const normalizedPath = normalizeFilePath(filePath);

  if (BLOCKED_PATHS.some((pattern) => normalizedPath === pattern || normalizedPath.endsWith(`/${pattern}`))) {
    return `Reading ${filePath} is blocked (agent/auth.json is sensitive)`;
  }

  return `Reading ${filePath} is blocked (.env files are sensitive)`;
}

export default function (pi: ExtensionAPI) {
  pi.on("tool_call", async (event, _ctx) => {
    if (isToolCallEventType("read", event)) {
      if (isBlockedFile(event.input.path)) {
        return { block: true, reason: getBlockedReason(event.input.path) };
      }
    }

    if (isToolCallEventType("bash", event)) {
      const cmd = event.input.command;
      if (
        READ_COMMAND_RE.test(cmd) &&
        (BLOCKED_BASENAMES.some((pattern) => cmd.includes(pattern)) ||
          BLOCKED_PATHS.some((pattern) => cmd.includes(pattern)))
      ) {
        return {
          block: true,
          reason: `Reading sensitive files via bash is blocked (.env files and agent/auth.json are sensitive)`,
        };
      }
    }
  });
}
