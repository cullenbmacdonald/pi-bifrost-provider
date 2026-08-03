import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
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
		cacheRead: pricePerMillion(pricing.cache_read ?? pricing.cache_read_input_token) ?? 0,
		cacheWrite: pricePerMillion(pricing.cache_write ?? pricing.cache_creation_input_token) ?? 0,
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
	return {
		id: model.id,
		name: model.name || model.id,
		reasoning: reasoningModels.has(model.id),
		input: model.input ?? (modelSupportsImage(model.id) ? ["text", "image"] : ["text"]),
		cost: model.cost ?? { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow,
		maxTokens,
	};
}

async function discoverModels(config: BifrostConfig): Promise<DiscoveredModel[]> {
	const headers: Record<string, string> = { Authorization: `Bearer ${config.apiKey}` };
	if (config.virtualKey) headers["x-bf-vk"] = config.virtualKey;

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

export default async function bifrostProvider(pi: ExtensionAPI) {
	const config = await loadConfig();
	const discoveredModels = await loadModels(config);
	const reasoningModels = configuredReasoningModels(config);
	const models = discoveredModels.map((model) => toModelConfig(model, reasoningModels, config));

	pi.registerProvider(PROVIDER_ID, {
		name: "Bifrost",
		baseUrl: config.baseUrl,
		apiKey: config.apiKey,
		api: "openai-completions",
		headers: configuredHeaders(config),
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
			ctx.ui.notify(
				`Bifrost provider: ${config.baseUrl} (${models.length} model${models.length === 1 ? "" : "s"})`,
				"info",
			);
		},
	});
}
