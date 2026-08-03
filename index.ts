import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

type ProviderModelConfig = {
	id: string;
	name: string;
	reasoning: boolean;
	input: ("text" | "image")[];
	cost: { input: number; output: number; cacheRead: number; cacheWrite: number };
	contextWindow: number;
	maxTokens: number;
};

type OpenAIModelsResponse = {
	data?: Array<{ id?: unknown; name?: unknown }>;
};

const PROVIDER_ID = "bifrost";
const DEFAULT_BASE_URL = "http://localhost:8080/openai/v1";
const DEFAULT_CONTEXT_WINDOW = 128_000;
const DEFAULT_MAX_TOKENS = 16_384;
const DEFAULT_MODEL_IDS = [
	"openai/gpt-4o-mini",
	"openai/gpt-4o",
	"anthropic/claude-sonnet-4-20250514",
];

function parseList(value: string | undefined): string[] {
	return (value ?? "")
		.split(",")
		.map((entry) => entry.trim())
		.filter(Boolean);
}

function parsePositiveInteger(value: string | undefined, fallback: number): number {
	if (!value) return fallback;
	const parsed = Number(value);
	return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : fallback;
}

function normalizeBaseUrl(value: string | undefined): string {
	let baseUrl = (value || DEFAULT_BASE_URL).trim().replace(/\/+$/u, "");
	// Bifrost docs often show http://localhost:8080/openai for OpenAI SDKs.
	// Pi's OpenAI-compatible transport expects the base URL before /chat/completions,
	// so normalize that documentation form to /openai/v1.
	if (baseUrl.endsWith("/openai")) baseUrl = `${baseUrl}/v1`;
	return baseUrl;
}

function configuredHeaders(): Record<string, string> | undefined {
	const headers: Record<string, string> = {};
	if (process.env.BIFROST_VIRTUAL_KEY) headers["x-bf-vk"] = "$BIFROST_VIRTUAL_KEY";
	return Object.keys(headers).length > 0 ? headers : undefined;
}

function modelSupportsImage(id: string): boolean {
	return /(?:claude|gemini|gpt-4o|gpt-5|vision|llava)/iu.test(id);
}

function configuredReasoningModels(): Set<string> {
	return new Set(parseList(process.env.BIFROST_REASONING_MODELS));
}

function toModelConfig(id: string, name: string | undefined, reasoningModels: Set<string>): ProviderModelConfig {
	const contextWindow = parsePositiveInteger(process.env.BIFROST_CONTEXT_WINDOW, DEFAULT_CONTEXT_WINDOW);
	const maxTokens = parsePositiveInteger(process.env.BIFROST_MAX_TOKENS, DEFAULT_MAX_TOKENS);
	return {
		id,
		name: name || id,
		reasoning: reasoningModels.has(id),
		input: modelSupportsImage(id) ? ["text", "image"] : ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow,
		maxTokens,
	};
}

async function discoverModels(baseUrl: string): Promise<Array<{ id: string; name?: string }>> {
	const apiKey = process.env.BIFROST_API_KEY || "dummy-key";
	const headers: Record<string, string> = { Authorization: `Bearer ${apiKey}` };
	if (process.env.BIFROST_VIRTUAL_KEY) headers["x-bf-vk"] = process.env.BIFROST_VIRTUAL_KEY;

	const signal = AbortSignal.timeout(2_000);
	const response = await fetch(`${baseUrl}/models`, { headers, signal });
	if (!response.ok) throw new Error(`Bifrost model discovery failed: HTTP ${response.status}`);

	const payload = (await response.json()) as OpenAIModelsResponse;
	return (payload.data ?? []).flatMap((model) => {
		if (typeof model.id !== "string" || model.id.length === 0) return [];
		return [{ id: model.id, name: typeof model.name === "string" ? model.name : undefined }];
	});
}

async function loadModelIds(baseUrl: string): Promise<Array<{ id: string; name?: string }>> {
	const configured = parseList(process.env.BIFROST_MODELS);
	if (configured.length > 0) return configured.map((id) => ({ id }));

	if (process.env.BIFROST_DISCOVER_MODELS !== "0") {
		try {
			const discovered = await discoverModels(baseUrl);
			if (discovered.length > 0) return discovered;
		} catch {
			// Fall back to a small useful catalog. Startup should not fail just because
			// the local gateway is not running yet.
		}
	}

	return DEFAULT_MODEL_IDS.map((id) => ({ id }));
}

export default async function bifrostProvider(pi: ExtensionAPI) {
	const baseUrl = normalizeBaseUrl(process.env.BIFROST_BASE_URL);
	const modelIds = await loadModelIds(baseUrl);
	const reasoningModels = configuredReasoningModels();
	const models = modelIds.map((model) => toModelConfig(model.id, model.name, reasoningModels));

	pi.registerProvider(PROVIDER_ID, {
		name: "Bifrost",
		baseUrl,
		apiKey: process.env.BIFROST_API_KEY ? "$BIFROST_API_KEY" : "dummy-key",
		api: "openai-completions",
		headers: configuredHeaders(),
		compat: {
			// Bifrost is an OpenAI-compatible gateway. Using system instead of developer
			// is the safest default across routed upstream providers.
			supportsDeveloperRole: false,
		},
		models,
	});

	pi.registerCommand("bifrost", {
		description: "Show Bifrost provider configuration",
		handler: async (_args, ctx) => {
			ctx.ui.notify(`Bifrost provider: ${baseUrl} (${models.length} model${models.length === 1 ? "" : "s"})`, "info");
		},
	});
}
