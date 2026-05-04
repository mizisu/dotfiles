import { SettingsManager } from "@mariozechner/pi-coding-agent";

export interface ResolvedModelSlot {
  model: any;
  auth: { apiKey?: string; headers?: Record<string, string> };
  reference: string;
}

function getString(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed || undefined;
}

async function resolveModelSlot(ctx: any, providerKey: string, modelKey: string, label: string): Promise<ResolvedModelSlot> {
  const settings = SettingsManager.create(ctx.cwd).getGlobalSettings() as Record<string, unknown>;
  const provider = getString(settings[providerKey]);
  const modelId = getString(settings[modelKey]);

  if (!provider || !modelId) {
    throw new Error(`${providerKey}/${modelKey} are not configured in agent/settings.json`);
  }

  const reference = `${provider}/${modelId}`;
  const model = ctx.modelRegistry.find(provider, modelId);
  if (!model) throw new Error(`Configured ${label} model not found: ${reference}`);

  const auth = await ctx.modelRegistry.getApiKeyAndHeaders(model);
  if (!auth.ok) throw new Error(`Auth error for ${label} model ${reference}: ${auth.error}`);

  return { model, auth, reference };
}

export function resolveSmallModel(ctx: any): Promise<ResolvedModelSlot> {
  return resolveModelSlot(ctx, "smallProvider", "smallModel", "small");
}

export function resolveMediumModel(ctx: any): Promise<ResolvedModelSlot> {
  return resolveModelSlot(ctx, "mediumProvider", "mediumModel", "medium");
}
