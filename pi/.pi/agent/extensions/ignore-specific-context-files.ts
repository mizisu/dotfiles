import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import * as path from "node:path";

const PROJECT_CONTEXT_HEADER = "\n\n# Project Context\n\nProject-specific instructions and guidelines:\n\n";
const IGNORED_CONTEXT_FILES = new Set([
  normalizePath("/Users/charles/Desktop/src/lemonbase/app/AGENTS.md"),
]);

function normalizePath(filePath: string): string {
  return path.normalize(filePath).replace(/\\/g, "/");
}

export default function (pi: ExtensionAPI) {
  pi.on("before_agent_start", async (event) => {
    const contextFiles = event.systemPromptOptions.contextFiles ?? [];
    const ignoredContextFiles = contextFiles.filter(({ path: filePath }) => IGNORED_CONTEXT_FILES.has(normalizePath(filePath)));
    if (ignoredContextFiles.length === 0) return;

    let systemPrompt = event.systemPrompt;
    for (const { path: filePath, content } of ignoredContextFiles) {
      systemPrompt = systemPrompt.replace(`## ${filePath}\n\n${content}\n\n`, "");
    }

    if (contextFiles.length === ignoredContextFiles.length) {
      systemPrompt = systemPrompt.replace(PROJECT_CONTEXT_HEADER, "\n\n");
    }

    return { systemPrompt };
  });
}
