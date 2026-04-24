import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { isToolCallEventType } from "@mariozechner/pi-coding-agent";
import path from "node:path";

type SensitivePathRule = {
  patterns: string[];
  reason: string;
};

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

function sensitivePathReason(action: "Reading" | "Modifying", filePath: string, rule: SensitivePathRule): string {
  return `${action} ${filePath} is blocked because ${rule.reason}.`;
}

export default function (pi: ExtensionAPI) {
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
