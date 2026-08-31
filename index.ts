import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

type PiCompat = {
	supportsDeveloperRole?: boolean;
	supportsLongCacheRetention?: boolean;
	sendSessionAffinityHeaders?: boolean;
	sendSessionIdHeader?: boolean;
};

type ThinkingLevelMap = {
	xhigh?: "xhigh" | null;
};

type ProviderModelConfig = {
	id: string;
	name: string;
	reasoning: boolean;
	input: ("text" | "image")[];
	cost: { input: number; output: number; cacheRead: number; cacheWrite: number };
	contextWindow: number;
	maxTokens: number;
	compat?: PiCompat;
	thinkingLevelMap?: ThinkingLevelMap;
	_api?: "openai-responses" | "openai-completions";
};

type RawBifrostModel = {
	id?: unknown;
	name?: unknown;
	normalized_name?: unknown;
	context_length?: unknown;
	contextWindow?: unknown;
	max_context_length?: unknown;
	max_input_tokens?: unknown;
	max_tokens?: unknown;
	max_output_tokens?: unknown;
	max_completion_tokens?: unknown;
	architecture?: {
		modality?: unknown;
		input_modalities?: unknown;
	};
	pricing?: {
		prompt?: unknown;
		completion?: unknown;
		input?: unknown;
		output?: unknown;
		cache_read?: unknown;
		cache_write?: unknown;
		cache_read_input_token?: unknown;
		cache_creation_input_token?: unknown;
		input_cache_read?: unknown;
		input_cache_write?: unknown;
	};
};

type OpenAIModelsResponse = {
	data?: RawBifrostModel[];
};

type StoredBifrostAuth = {
	key?: unknown;
	base_url?: unknown;
	baseUrl?: unknown;
	virtual_key?: unknown;
	virtualKey?: unknown;
	models?: unknown;
	discover_models?: unknown;
	discoverModels?: unknown;
	reasoning_models?: unknown;
	reasoningModels?: unknown;
	context_window?: unknown;
	contextWindow?: unknown;
	max_tokens?: unknown;
	maxTokens?: unknown;
	env?: Record<string, unknown>;
};

type BifrostConfig = {
	baseUrl: string;
	apiKey: string;
	virtualKey?: string;
	models?: string;
	discoverModels: string;
	reasoningModels?: string;
	contextWindow: string;
	maxTokens: string;
};

type DiscoveredModel = {
	id: string;
	name?: string;
	contextWindow?: number;
	maxTokens?: number;
	input?: ("text" | "image")[];
	cost?: ProviderModelConfig["cost"];
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

/** Models that should use the OpenAI Responses API (tools + reasoning compatible). */
function prefersResponsesApi(id: string): boolean {
	return /(\bgpt-5(?:[.-]|$)|codex)/i.test(id);
}

/** Infer whether a model supports reasoning/thinking from its ID. */
function inferReasoning(id: string): boolean {
	return /(opus|sonnet|reason|r1|o[134]|gpt-5|qwen3|deepseek)/i.test(id);
}

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

function numberValue(value: unknown): number | undefined {
	const parsed = typeof value === "number" ? value : typeof value === "string" ? Number(value) : Number.NaN;
	return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
}

function integerValue(...values: unknown[]): number | undefined {
	for (const value of values) {
		const parsed = numberValue(value);
		if (parsed) return Math.floor(parsed);
	}
	return undefined;
}

function pricePerMillion(value: unknown): number | undefined {
	const parsed = numberValue(value);
	if (parsed === undefined) return undefined;
	// Bifrost's catalog is OpenRouter-like in many deployments, where pricing is
	// usually dollars/token. Pi stores dollars/million tokens. If a gateway ever
	// returns already-per-million rates, values >= 1 are left alone.
	return parsed < 1 ? parsed * 1_000_000 : parsed;
}

function stringValue(value: unknown): string | undefined {
	return typeof value === "string" && value.length > 0 ? value : undefined;
}

function resolveStoredValue(value: string | undefined): string | undefined {
	if (!value) return undefined;
	const match = value.match(/^\$\{?([A-Z0-9_]+)\}?$/u);
	return match ? process.env[match[1]] : value;
}

function normalizeBaseUrl(value: string | undefined): string {
	let baseUrl = (value || DEFAULT_BASE_URL).trim().replace(/\/+$/u, "");
	// Bifrost docs often show http://localhost:8080/openai for OpenAI SDKs.
	// Pi's OpenAI-compatible transport expects the base URL before /chat/completions,
	// so normalize that documentation form to /openai/v1.
	if (baseUrl.endsWith("/openai")) baseUrl = `${baseUrl}/v1`;
	return baseUrl;
}

async function readAuthFromFile(): Promise<StoredBifrostAuth> {
	const agentDir = process.env.PI_CODING_AGENT_DIR || join(homedir(), ".pi", "agent");
	try {
		const auth = JSON.parse(await readFile(join(agentDir, "auth.json"), "utf8")) as Record<string, StoredBifrostAuth>;
		return auth[PROVIDER_ID] ?? {};
	} catch {
		return {};
	}
}

function authValue(auth: StoredBifrostAuth, envName: string, ...authKeys: Array<keyof StoredBifrostAuth>): string | undefined {
	// Match the LiteLLM extension style: real environment variables win, then
	// values from ~/.pi/agent/auth.json. Also accept ApiKeyCredential-style env.
	const fromProcess = process.env[envName];
	if (fromProcess?.trim()) return fromProcess.trim();

	const env = auth.env ?? {};
	const fromCredentialEnv = stringValue(env[envName]);
	if (fromCredentialEnv?.trim()) return fromCredentialEnv.trim();

	for (const key of authKeys) {
		const value = stringValue(auth[key]);
		if (value?.trim()) return value.trim();
	}
	return undefined;
}

async function loadConfig(): Promise<BifrostConfig> {
	const auth = await readAuthFromFile();
	const apiKey = resolveStoredValue(authValue(auth, "BIFROST_API_KEY", "key")) ?? "dummy-key";

	return {
		baseUrl: normalizeBaseUrl(authValue(auth, "BIFROST_BASE_URL", "base_url", "baseUrl")),
		apiKey,
		virtualKey: authValue(auth, "BIFROST_VIRTUAL_KEY", "virtual_key", "virtualKey"),
		models: authValue(auth, "BIFROST_MODELS", "models"),
		discoverModels: authValue(auth, "BIFROST_DISCOVER_MODELS", "discover_models", "discoverModels") ?? "1",
		reasoningModels: authValue(auth, "BIFROST_REASONING_MODELS", "reasoning_models", "reasoningModels"),
		contextWindow:
			authValue(auth, "BIFROST_CONTEXT_WINDOW", "context_window", "contextWindow") ?? String(DEFAULT_CONTEXT_WINDOW),
		maxTokens: authValue(auth, "BIFROST_MAX_TOKENS", "max_tokens", "maxTokens") ?? String(DEFAULT_MAX_TOKENS),
	};
}

function configuredHeaders(config: BifrostConfig): Record<string, string> | undefined {
	const headers: Record<string, string> = {};
	if (config.virtualKey) headers["x-bf-vk"] = config.virtualKey;
	return Object.keys(headers).length > 0 ? headers : undefined;
}

function modelSupportsImage(id: string): boolean {
	return /(?:claude|gemini|gpt-4o|gpt-5|vision|llava)/iu.test(id);
}

function discoveredInput(raw: RawBifrostModel, id: string): ("text" | "image")[] {
	const modalities = Array.isArray(raw.architecture?.input_modalities)
		? raw.architecture.input_modalities.map(String)
		: [];
	const modality = stringValue(raw.architecture?.modality) ?? "";
	return modalities.some((entry) => entry.toLowerCase() === "image") || /image/i.test(modality) || modelSupportsImage(id)
		? ["text", "image"]
		: ["text"];
}

function discoveredCost(raw: RawBifrostModel): ProviderModelConfig["cost"] | undefined {
	const pricing = raw.pricing;
	if (!pricing) return undefined;
	return {
		input: pricePerMillion(pricing.prompt ?? pricing.input) ?? 0,
		output: pricePerMillion(pricing.completion ?? pricing.output) ?? 0,
		cacheRead: pricePerMillion(pricing.cache_read ?? pricing.cache_read_input_token ?? pricing.input_cache_read) ?? 0,
		cacheWrite: pricePerMillion(pricing.cache_write ?? pricing.cache_creation_input_token ?? pricing.input_cache_write) ?? 0,
	};
}

function fromBifrostModel(raw: RawBifrostModel): DiscoveredModel | undefined {
	const id = stringValue(raw.id)?.trim();
	if (!id) return undefined;
	return {
		id,
		name: stringValue(raw.name) ?? stringValue(raw.normalized_name) ?? id,
		contextWindow: integerValue(raw.context_length, raw.contextWindow, raw.max_context_length, raw.max_input_tokens),
		maxTokens: integerValue(raw.max_output_tokens, raw.max_completion_tokens, raw.max_tokens),
		input: discoveredInput(raw, id),
		cost: discoveredCost(raw),
	};
}

function configuredReasoningModels(config: BifrostConfig): Set<string> {
	return new Set(parseList(config.reasoningModels));
}

function toModelConfig(model: DiscoveredModel, reasoningModels: Set<string>, config: BifrostConfig): ProviderModelConfig {
	const contextWindow = model.contextWindow ?? parsePositiveInteger(config.contextWindow, DEFAULT_CONTEXT_WINDOW);
	const maxTokens = model.maxTokens ?? parsePositiveInteger(config.maxTokens, DEFAULT_MAX_TOKENS);
	const reasoning = reasoningModels.has(model.id) || inferReasoning(model.id);
	return {
		id: model.id,
		name: model.name || model.id,
		reasoning,
		input: model.input ?? (modelSupportsImage(model.id) ? ["text", "image"] : ["text"]),
		cost: model.cost ?? { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow,
		maxTokens,
		compat: {
			supportsLongCacheRetention: true,
			sendSessionAffinityHeaders: true,
			sendSessionIdHeader: true,
		},
		// Pi only exposes extended levels such as xhigh when the model opts in
		// with a non-null thinkingLevelMap entry. Bifrost forwards this value to
		// the upstream OpenAI-compatible provider.
		thinkingLevelMap: reasoning ? { xhigh: "xhigh" } : undefined,
		_api: prefersResponsesApi(model.id) ? "openai-responses" : "openai-completions",
	};
}

async function discoverModelsForProvider(
	config: BifrostConfig,
	provider: string,
): Promise<DiscoveredModel[]> {
	const baseUrl = config.baseUrl.replace(/\/openai\/v1$/, "").replace(/\/v1$/, "");
	const headers: Record<string, string> = { Authorization: `Bearer ${config.apiKey}` };
	if (config.virtualKey) headers["x-bf-vk"] = config.virtualKey;

	const signal = AbortSignal.timeout(5_000);
	const response = await fetch(`${baseUrl}/v1/models?provider=${provider}`, { headers, signal });
	if (!response.ok) return [];

	const payload = (await response.json()) as OpenAIModelsResponse;
	return (payload.data ?? []).flatMap((model) => {
		const parsed = fromBifrostModel(model);
		return parsed ? [parsed] : [];
	});
}

async function discoverModels(config: BifrostConfig): Promise<DiscoveredModel[]> {
	const headers: Record<string, string> = { Authorization: `Bearer ${config.apiKey}` };
	if (config.virtualKey) headers["x-bf-vk"] = config.virtualKey;

	// First try per-provider discovery which returns richer metadata (pricing, context, etc.)
	const baseUrl = config.baseUrl.replace(/\/openai\/v1$/, "").replace(/\/v1$/, "");
	const providers = ["openai", "bedrock", "anthropic", "google", "azure-openai"];
	const perProviderResults = await Promise.all(
		providers.map((p) => discoverModelsForProvider(config, p).catch(() => [] as DiscoveredModel[])),
	);
	const richModels = perProviderResults.flat();
	if (richModels.length > 0) return richModels;

	// Fallback: try the basic /models endpoint
	const signal = AbortSignal.timeout(2_000);
	const response = await fetch(`${config.baseUrl}/models`, { headers, signal });
	if (!response.ok) throw new Error(`Bifrost model discovery failed: HTTP ${response.status}`);

	const payload = (await response.json()) as OpenAIModelsResponse;
	return (payload.data ?? []).flatMap((model) => {
		const parsed = fromBifrostModel(model);
		return parsed ? [parsed] : [];
	});
}

async function loadModels(config: BifrostConfig): Promise<DiscoveredModel[]> {
	const configured = parseList(config.models);
	if (configured.length > 0) return configured.map((id) => ({ id }));

	if (config.discoverModels !== "0") {
		try {
			const discovered = await discoverModels(config);
			if (discovered.length > 0) return discovered;
		} catch {
			// Fall back to a small useful catalog. Startup should not fail just because
			// the local gateway is not running yet.
		}
	}

	return DEFAULT_MODEL_IDS.map((id) => ({ id }));
}

function stripInternalFields(models: ProviderModelConfig[]): Array<Omit<ProviderModelConfig, "_api">> {
	return models.map(({ _api: _, ...rest }) => rest);
}

function isOpenAiCacheCandidate(modelId: unknown): modelId is string {
	if (typeof modelId !== "string") return false;
	return /(gpt|codex|o[134]|openai)/i.test(modelId);
}

function installOpenAiPromptCacheHook(pi: ExtensionAPI) {
	pi.on("before_provider_request", async (event) => {
		const payload = (event.payload ?? {}) as Record<string, unknown>;
		if (!isOpenAiCacheCandidate(payload.model)) return payload;

		// Keep retention explicit for OpenAI prompt caching through gateways.
		if (payload.prompt_cache_retention !== "24h") {
			payload.prompt_cache_retention = "24h";
		}

		// Stable fallback key when pi doesn't provide one.
		if (typeof payload.prompt_cache_key !== "string" || payload.prompt_cache_key.length === 0) {
			payload.prompt_cache_key = `pi-bifrost-${payload.model}`;
		}

		return payload;
	});
}

export default async function bifrostProvider(pi: ExtensionAPI) {
	if (!process.env.PI_CACHE_RETENTION) {
		process.env.PI_CACHE_RETENTION = "long";
	}

	const config = await loadConfig();
	const discoveredModels = await loadModels(config);
	const reasoningModels = configuredReasoningModels(config);
	const allModels = discoveredModels.map((model) => toModelConfig(model, reasoningModels, config));

	// Split models by API type: GPT-5.x uses Responses API (supports tools + reasoning),
	// everything else uses Chat Completions.
	const responsesModels = allModels.filter((m) => m._api === "openai-responses");
	const completionsModels = allModels.filter((m) => m._api !== "openai-responses");

	// Bifrost's base URL for OpenAI-compat is .../openai/v1. The Responses API
	// lives at .../v1/responses, so we need the base without /openai/v1.
	const responsesBaseUrl = config.baseUrl.replace(/\/openai\/v1$/, "/v1");

	if (completionsModels.length > 0) {
		pi.registerProvider(PROVIDER_ID, {
			name: "Bifrost",
			baseUrl: config.baseUrl,
			apiKey: config.apiKey,
			api: "openai-completions",
			headers: configuredHeaders(config),
			compat: {
				supportsDeveloperRole: false,
				supportsLongCacheRetention: true,
				sendSessionAffinityHeaders: true,
				sendSessionIdHeader: true,
			},
			models: stripInternalFields(completionsModels),
		});
	}

	if (responsesModels.length > 0) {
		pi.registerProvider(`${PROVIDER_ID}-responses`, {
			name: "Bifrost (Responses)",
			baseUrl: responsesBaseUrl,
			apiKey: config.apiKey,
			api: "openai-responses",
			headers: configuredHeaders(config),
			compat: {
				supportsLongCacheRetention: true,
				sendSessionAffinityHeaders: true,
				sendSessionIdHeader: true,
			},
			models: stripInternalFields(responsesModels),
		});
	}

	installOpenAiPromptCacheHook(pi);

	pi.registerCommand("bifrost", {
		description: "Show Bifrost provider configuration",
		handler: async (_args, ctx) => {
			const total = allModels.length;
			ctx.ui.notify(
				`Bifrost provider: ${config.baseUrl} (${total} model${total === 1 ? "" : "s"}: ${completionsModels.length} completions, ${responsesModels.length} responses)`,
				"info",
			);
		},
	});
}
