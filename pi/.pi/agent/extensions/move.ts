import { mkdir, stat, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, resolve } from "node:path";
import { homedir } from "node:os";
import { SessionManager, type ExtensionAPI, type ExtensionCommandContext } from "@mariozechner/pi-coding-agent";

const COMMAND_NAME = "move";

type NotifyLevel = "info" | "warning" | "error";

function notify(ctx: ExtensionCommandContext, message: string, level: NotifyLevel = "info"): void {
  if (ctx.hasUI) ctx.ui.notify(message, level);
  else console.log(message);
}

function stripOuterQuotes(value: string): string {
  const trimmed = value.trim();
  if (trimmed.length >= 2) {
    const first = trimmed[0];
    const last = trimmed[trimmed.length - 1];
    if ((first === '"' && last === '"') || (first === "'" && last === "'")) {
      return trimmed.slice(1, -1).trim();
    }
  }
  return trimmed;
}

function expandHome(value: string): string {
  if (value === "~") return homedir();
  if (value.startsWith("~/")) return resolve(homedir(), value.slice(2));
  return value;
}

function resolveTargetPath(input: string, cwd: string): string {
  const expanded = expandHome(stripOuterQuotes(input));
  return isAbsolute(expanded) ? resolve(expanded) : resolve(cwd, expanded);
}

async function directoryExists(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isDirectory();
  } catch {
    return false;
  }
}

async function ensureDirectory(ctx: ExtensionCommandContext, targetPath: string): Promise<boolean> {
  try {
    const info = await stat(targetPath);
    if (info.isDirectory()) return true;
    notify(ctx, `/move: not a directory: ${targetPath}`, "error");
    return false;
  } catch {
    // Continue below and optionally create it.
  }

  const parent = dirname(targetPath);
  if (!(await directoryExists(parent))) {
    notify(ctx, `/move: parent directory does not exist: ${parent}`, "error");
    return false;
  }

  if (!ctx.hasUI) {
    notify(ctx, `/move: directory does not exist: ${targetPath}`, "error");
    return false;
  }

  const confirmed = await ctx.ui.confirm("Create directory?", `${targetPath}\n\nThis directory does not exist. Create it?`);
  if (!confirmed) return false;

  try {
    await mkdir(targetPath, { recursive: true });
    return true;
  } catch (error) {
    notify(ctx, `/move: failed to create directory: ${error instanceof Error ? error.message : String(error)}`, "error");
    return false;
  }
}

function serializeJsonl(entries: unknown[]): string {
  return `${entries.map((entry) => JSON.stringify(entry)).join("\n")}\n`;
}

async function createMovedSessionFile(ctx: ExtensionCommandContext, targetCwd: string): Promise<string> {
  const currentSessionFile = ctx.sessionManager.getSessionFile();
  const targetManager = SessionManager.create(targetCwd, undefined, currentSessionFile ? { parentSession: currentSessionFile } : undefined);
  const targetSessionFile = targetManager.getSessionFile();
  const targetHeader = targetManager.getHeader();

  if (!targetSessionFile || !targetHeader) {
    throw new Error("failed to create target session metadata");
  }

  const entries = ctx.sessionManager.getEntries();
  await mkdir(dirname(targetSessionFile), { recursive: true });
  await writeFile(targetSessionFile, serializeJsonl([targetHeader, ...entries]), { flag: "wx" });

  return targetSessionFile;
}

export default function moveExtension(pi: ExtensionAPI) {
  pi.registerCommand(COMMAND_NAME, {
    description: "Move the current session to another directory",
    async handler(args, ctx) {
      await ctx.waitForIdle();

      let input = stripOuterQuotes(args ?? "");
      if (!input) {
        if (!ctx.hasUI) {
          notify(ctx, "Usage: /move <path>", "error");
          return;
        }
        ctx.ui.setEditorText("/move ");
        return;
      }

      const oldCwd = ctx.sessionManager.getCwd();
      const targetCwd = resolveTargetPath(input, oldCwd);

      if (targetCwd === oldCwd) {
        notify(ctx, `/move: already in ${targetCwd}`);
        return;
      }

      if (!(await ensureDirectory(ctx, targetCwd))) return;

      const currentLeafId = ctx.sessionManager.getLeafId();
      let targetSessionFile: string;
      try {
        targetSessionFile = await createMovedSessionFile(ctx, targetCwd);
      } catch (error) {
        notify(ctx, `/move: failed to prepare moved session: ${error instanceof Error ? error.message : String(error)}`, "error");
        return;
      }

      const result = await ctx.switchSession(targetSessionFile, {
        withSession: async (nextCtx) => {
          if (currentLeafId && nextCtx.sessionManager.getEntry(currentLeafId)) {
            await nextCtx.navigateTree(currentLeafId, { summarize: false });
          }
          nextCtx.ui.notify(`Moved to ${nextCtx.sessionManager.getCwd()}`, "info");
        },
      });

      if (result.cancelled) {
        notify(ctx, "/move: cancelled.", "warning");
        return;
      }
    },
  });
}
