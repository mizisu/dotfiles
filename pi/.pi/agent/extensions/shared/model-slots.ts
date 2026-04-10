import type { Model } from "@mariozechner/pi-ai";
import { SettingsManager } from "@mariozechner/pi-coding-agent";

interface ModelRegistryLike {
	find(provider: string, modelId: string): Model<any> | undefined;
	getApiKeyAndHeaders(model: Model<any>): Promise<
		| { ok: true; apiKey?: string; headers?: Record<string, string> }
		| { ok: false; error: string }
	>;
}

interface ModelContextLike {
	cwd: string;
	modelRegistry: ModelRegistryLike;
	model: Model<any> | undefined;
}

interface ModelReference {
	provider: string;
	modelId: string;
}

type ConfiguredModelSource = "small" | "medium";

export interface ResolvedSmallModel {
	model?: Model<any>;
	auth?: {
		apiKey?: string;
		headers?: Record<string, string>;
	};
	source: ConfiguredModelSource | "current" | "none";
	configuredReference?: string;
	fallbackReason?: string;
	error?: string;
}

export type ResolvedMediumModel = ResolvedSmallModel;

function getString(value: unknown): string | undefined {
	if (typeof value !== "string") return undefined;
	const trimmed = value.trim();
	return trimmed || undefined;
}

function getModelReference(
	cwd: string,
	providerKey: "smallProvider" | "mediumProvider",
	modelKey: "smallModel" | "mediumModel",
): ModelReference | undefined {
	const settingsManager = SettingsManager.create(cwd);
	const globalSettings = settingsManager.getGlobalSettings() as Record<string, unknown>;
	const projectSettings = settingsManager.getProjectSettings() as Record<string, unknown>;

	const provider = getString(projectSettings[providerKey]) ?? getString(globalSettings[providerKey]);
	const modelId = getString(projectSettings[modelKey]) ?? getString(globalSettings[modelKey]);

	if (!provider || !modelId) return undefined;
	return { provider, modelId };
}

function getSmallModelReference(cwd: string): ModelReference | undefined {
	return getModelReference(cwd, "smallProvider", "smallModel");
}

function getMediumModelReference(cwd: string): ModelReference | undefined {
	return getModelReference(cwd, "mediumProvider", "mediumModel");
}

function sameModel(a: Model<any> | undefined, b: Model<any> | undefined): boolean {
	return !!a && !!b && a.provider === b.provider && a.id === b.id;
}

async function resolveAuth(modelRegistry: ModelRegistryLike, model: Model<any>) {
	const auth = await modelRegistry.getApiKeyAndHeaders(model);
	if (!auth.ok) return { error: auth.error };
	return {
		apiKey: auth.apiKey,
		headers: auth.headers,
	};
}

async function resolveConfiguredModel(
	ctx: ModelContextLike,
	configured: ModelReference | undefined,
	source: ConfiguredModelSource,
	label: string,
): Promise<ResolvedSmallModel> {
	const currentModel = ctx.model;

	if (!configured) {
		if (!currentModel) return { source: "none", error: "No model selected" };

		const auth = await resolveAuth(ctx.modelRegistry, currentModel);
		if ("error" in auth) {
			return {
				source: "current",
				error: `Auth error for ${currentModel.provider}/${currentModel.id}: ${auth.error}`,
			};
		}

		return { source: "current", model: currentModel, auth };
	}

	const configuredReference = `${configured.provider}/${configured.modelId}`;
	const configuredModel = ctx.modelRegistry.find(configured.provider, configured.modelId);

	if (!configuredModel) {
		if (!currentModel) {
			return {
				source: "none",
				configuredReference,
				error: `Configured ${label} model not found: ${configuredReference}`,
			};
		}

		const auth = await resolveAuth(ctx.modelRegistry, currentModel);
		if ("error" in auth) {
			return {
				source: "current",
				configuredReference,
				fallbackReason: `Configured ${label} model not found: ${configuredReference}`,
				error: `Auth error for ${currentModel.provider}/${currentModel.id}: ${auth.error}`,
			};
		}

		return {
			source: "current",
			model: currentModel,
			auth,
			configuredReference,
			fallbackReason: `Configured ${label} model not found: ${configuredReference}. Using current model instead.`,
		};
	}

	const configuredAuth = await resolveAuth(ctx.modelRegistry, configuredModel);
	if (!("error" in configuredAuth)) {
		return {
			source,
			model: configuredModel,
			auth: configuredAuth,
			configuredReference,
		};
	}

	if (currentModel && !sameModel(currentModel, configuredModel)) {
		const currentAuth = await resolveAuth(ctx.modelRegistry, currentModel);
		if (!("error" in currentAuth)) {
			return {
				source: "current",
				model: currentModel,
				auth: currentAuth,
				configuredReference,
				fallbackReason: `Auth error for configured ${label} model ${configuredReference}: ${configuredAuth.error}. Using current model instead.`,
			};
		}
	}

	return {
		source,
		configuredReference,
		error: `Auth error for configured ${label} model ${configuredReference}: ${configuredAuth.error}`,
	};
}

export async function resolveSmallModel(ctx: ModelContextLike): Promise<ResolvedSmallModel> {
	return resolveConfiguredModel(ctx, getSmallModelReference(ctx.cwd), "small", "small");
}

export async function resolveMediumModel(ctx: ModelContextLike): Promise<ResolvedMediumModel> {
	return resolveConfiguredModel(ctx, getMediumModelReference(ctx.cwd), "medium", "medium");
}
