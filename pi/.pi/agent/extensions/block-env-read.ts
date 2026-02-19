import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { isToolCallEventType } from "@mariozechner/pi-coding-agent";
import * as path from "node:path";

const BLOCKED_PATTERNS = [".env", ".env.example"];

function isBlockedFile(filePath: string): boolean {
  const basename = path.basename(filePath);
  return BLOCKED_PATTERNS.some((pattern) => basename === pattern);
}

export default function (pi: ExtensionAPI) {
  pi.on("tool_call", async (event, _ctx) => {
    if (isToolCallEventType("read", event)) {
      if (isBlockedFile(event.input.path)) {
        return { block: true, reason: `Reading ${event.input.path} is blocked (.env files are sensitive)` };
      }
    }

    if (isToolCallEventType("bash", event)) {
      const cmd = event.input.command;
      if (BLOCKED_PATTERNS.some((p) => cmd.includes(p) && /\b(cat|less|more|head|tail|bat|sed|awk)\b/.test(cmd))) {
        return { block: true, reason: `Reading .env files via bash is blocked (.env files are sensitive)` };
      }
    }
  });
}
