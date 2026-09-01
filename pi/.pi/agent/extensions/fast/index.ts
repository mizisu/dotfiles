import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import {
  CONFIG_DIR_NAME,
  getAgentDir,
  SettingsManager,
  withFileMutationQueue,
  type ExtensionAPI,
  type ExtensionContext,
} from "@earendil-works/pi-coding-agent";

const FAST_MODELS = new Set(["gpt-5.6-sol", "gpt-5.6-terra", "gpt-5.6-luna"]);
const FAST_MODE_ENV = "PI_GPT_FAST_MODE";
const FAST_MODE_STATUS_KEY = "fast";

type FastModeSettings = {
  fast?: unknown;
};

function getEnvironmentOverride(): boolean | undefined {
  const value = process.env[FAST_MODE_ENV];
  if (value === undefined) return undefined;
  return value === "1";
}

function resolveFastModeSetting(ctx: ExtensionContext): {
  value: boolean | undefined;
  path: string;
} {
  const agentDir = getAgentDir();
  const settingsManager = SettingsManager.create(ctx.cwd, agentDir, {
    projectTrusted: ctx.isProjectTrusted(),
  });
  const globalFast = (settingsManager.getGlobalSettings() as FastModeSettings).fast;
  const projectFast = (settingsManager.getProjectSettings() as FastModeSettings).fast;

  if (typeof projectFast === "boolean") {
    return {
      value: projectFast,
      path: join(ctx.cwd, CONFIG_DIR_NAME, "settings.json"),
    };
  }

  return {
    value: typeof globalFast === "boolean" ? globalFast : undefined,
    path: join(agentDir, "settings.json"),
  };
}

async function persistFastMode(ctx: ExtensionContext, enabled: boolean): Promise<void> {
  const settingsPath = resolveFastModeSetting(ctx).path;

  await withFileMutationQueue(settingsPath, async () => {
    let settings: Record<string, unknown> = {};

    try {
      const content = await readFile(settingsPath, "utf8");
      const parsed: unknown = JSON.parse(content.replace(/^\uFEFF/, ""));
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
        throw new Error(`${settingsPath} must contain a JSON object`);
      }
      settings = parsed as Record<string, unknown>;
    } catch (error) {
      if (!(error && typeof error === "object" && "code" in error && error.code === "ENOENT")) {
        throw error;
      }
    }

    settings.fast = enabled;
    await mkdir(dirname(settingsPath), { recursive: true });
    await writeFile(settingsPath, `${JSON.stringify(settings, null, 2)}\n`, "utf8");
  });
}

export default function fastMode(pi: ExtensionAPI): void {
  let enabled = getEnvironmentOverride() ?? false;

  pi.registerCommand("fast", {
    description: "Toggle and persist GPT Fast mode",
    handler: async (_args, ctx) => {
      const nextEnabled = !enabled;

      try {
        await persistFastMode(ctx, nextEnabled);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        ctx.ui.notify(`Failed to save GPT Fast mode: ${message}`, "error");
        return;
      }

      enabled = nextEnabled;
      // Environment inheritance reaches new children; use IPC only if running children must update.
      process.env[FAST_MODE_ENV] = enabled ? "1" : "0";
      ctx.ui.setStatus(FAST_MODE_STATUS_KEY, enabled ? "fast" : undefined);
      ctx.ui.notify(`GPT Fast mode ${enabled ? "enabled" : "disabled"} and saved.`);
    },
  });

  pi.on("session_start", (_event, ctx) => {
    enabled = resolveFastModeSetting(ctx).value ?? getEnvironmentOverride() ?? false;
    process.env[FAST_MODE_ENV] = enabled ? "1" : "0";
    ctx.ui.setStatus(FAST_MODE_STATUS_KEY, enabled ? "fast" : undefined);
  });

  pi.on("before_provider_request", (event, ctx) => {
    const model = ctx.model;
    const payload = event.payload;

    if (
      !enabled ||
      model?.provider !== "openai-codex" ||
      !FAST_MODELS.has(model.id) ||
      !payload ||
      typeof payload !== "object" ||
      (payload as Record<string, unknown>).model !== model.id
    ) return;

    return { ...payload, service_tier: "priority" };
  });
}
