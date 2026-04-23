import type {
  ExtensionAPI,
  LsToolDetails,
  LsToolInput,
  TruncationResult,
} from "@mariozechner/pi-coding-agent";
import {
  createBashTool,
  createLocalBashOperations,
  createLsTool,
  DEFAULT_MAX_BYTES,
  DEFAULT_MAX_LINES,
  formatSize,
  truncateHead,
} from "@mariozechner/pi-coding-agent";
import { spawnSync } from "node:child_process";

const REWRITE_TIMEOUT_MS = 2000;

let rtkAvailable: boolean | undefined;

function checkRtkAvailable(): boolean {
  if (rtkAvailable !== undefined) return rtkAvailable;

  const result = spawnSync("rtk", ["--version"], {
    encoding: "utf-8",
    timeout: REWRITE_TIMEOUT_MS,
  });

  rtkAvailable = !result.error && result.status === 0;
  return rtkAvailable;
}

function rewriteCommand(command: string): string | undefined {
  if (!checkRtkAvailable()) return undefined;

  const result = spawnSync("rtk", ["rewrite", command], {
    encoding: "utf-8",
    timeout: REWRITE_TIMEOUT_MS,
  });

  if (result.error) {
    rtkAvailable = false;
    return undefined;
  }

  const rewritten = (result.stdout ?? "").trim();
  if ((result.status === 0 || result.status === 3) && rewritten.length > 0) {
    return rewritten;
  }

  return undefined;
}

function renderTruncatedText(truncation: TruncationResult): string {
  if (!truncation.truncated) return truncation.content || "(no output)";

  return `${truncation.content}\n\n[Output truncated: ${truncation.outputLines} of ${truncation.totalLines} lines (${formatSize(truncation.outputBytes)} of ${formatSize(truncation.totalBytes)})]`;
}

async function runRtkTextCommand(
  pi: ExtensionAPI,
  args: string[],
  signal: AbortSignal,
): Promise<{ text: string; truncation?: TruncationResult } | undefined> {
  if (!checkRtkAvailable()) return undefined;

  try {
    const result = await pi.exec("rtk", args, { signal });
    if (result.code !== 0) return undefined;

    const rawOutput = [result.stdout, result.stderr].filter(Boolean).join("\n") || "(no output)";
    const truncation = truncateHead(rawOutput, {
      maxLines: DEFAULT_MAX_LINES,
      maxBytes: DEFAULT_MAX_BYTES,
    });

    return {
      text: renderTruncatedText(truncation),
      truncation: truncation.truncated ? truncation : undefined,
    };
  } catch {
    return undefined;
  }
}

function buildRtkLsArgs(input: LsToolInput): string[] {
  const args = ["ls"];
  if (input.path) args.push(input.path);
  return args;
}

export default function (pi: ExtensionAPI) {
  const cwd = process.cwd();
  const bashTool = createBashTool(cwd, {
    spawnHook: ({ command, cwd, env }) => ({
      command: rewriteCommand(command) ?? command,
      cwd,
      env,
    }),
  });
  const lsTool = createLsTool(cwd);
  const localBashOperations = createLocalBashOperations();

  pi.on("session_start", async (_event, ctx) => {
    if (!checkRtkAvailable()) {
      ctx.ui.notify(
        "rtk not found in PATH — RTK extension will fall back to built-in tools.",
        "warning",
      );
    }
  });

  pi.registerTool({
    ...bashTool,
  });

  pi.registerTool({
    ...lsTool,
    async execute(toolCallId, params: LsToolInput, signal, onUpdate) {
      if (params.limit !== undefined) {
        return lsTool.execute(toolCallId, params, signal, onUpdate);
      }

      const result = await runRtkTextCommand(pi, buildRtkLsArgs(params), signal);
      if (!result) {
        return lsTool.execute(toolCallId, params, signal, onUpdate);
      }

      const details: LsToolDetails = {
        truncation: result.truncation,
      };

      return {
        content: [{ type: "text", text: result.text }],
        details,
      };
    },
  });

  pi.on("user_bash", (event) => {
    if (event.excludeFromContext) return;

    return {
      operations: {
        exec(command, cwd, options) {
          return localBashOperations.exec(rewriteCommand(command) ?? command, cwd, options);
        },
      },
    };
  });
}
