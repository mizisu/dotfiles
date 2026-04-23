import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { isToolCallEventType } from "@mariozechner/pi-coding-agent";
import * as path from "node:path";

const BLOCKED_BASENAMES = [".env", ".env.example"];
const BLOCKED_PATHS = ["agent/auth.json"];

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

function getBlockedReason(action: "read" | "write", filePath: string): string {
  const normalizedPath = normalizeFilePath(filePath);
  const verb = action === "read" ? "Reading" : "Modifying";

  if (BLOCKED_PATHS.some((pattern) => normalizedPath === pattern || normalizedPath.endsWith(`/${pattern}`))) {
    return `${verb} ${filePath} is blocked (agent/auth.json is sensitive)`;
  }

  return `${verb} ${filePath} is blocked (.env files are sensitive)`;
}

function commandTouchesBlockedFile(command: string): boolean {
  return (
    BLOCKED_BASENAMES.some((pattern) => command.includes(pattern)) ||
    BLOCKED_PATHS.some((pattern) => command.includes(pattern))
  );
}

export default function (pi: ExtensionAPI) {
  pi.on("tool_call", async (event, _ctx) => {
    if (isToolCallEventType("read", event) && isBlockedFile(event.input.path)) {
      return { block: true, reason: getBlockedReason("read", event.input.path) };
    }

    if (isToolCallEventType("write", event) && isBlockedFile(event.input.path)) {
      return { block: true, reason: getBlockedReason("write", event.input.path) };
    }

    if (isToolCallEventType("edit", event) && isBlockedFile(event.input.path)) {
      return { block: true, reason: getBlockedReason("write", event.input.path) };
    }

    if (isToolCallEventType("bash", event) && commandTouchesBlockedFile(event.input.command)) {
      return {
        block: true,
        reason: `Accessing sensitive files via bash is blocked (.env files and agent/auth.json are sensitive)`,
      };
    }
  });
}
