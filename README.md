# pi-bifrost-provider

A [pi](https://pi.dev) provider extension for the [Bifrost AI gateway](https://docs.getbifrost.ai/).

Bifrost exposes an OpenAI-compatible API. This package registers a `bifrost` provider in pi using `openai-completions`.

## Quick start

Run Bifrost locally, then test this extension without installing it:

```bash
cd ~/dev/pi-dev/pi-bifrost-provider
pi -e . --list-models bifrost
pi -e . --model bifrost/openai/gpt-4o-mini -p "Say hello from Bifrost"
```

Install locally into pi:

```bash
pi install ~/dev/pi-dev/pi-bifrost-provider
```

Then use `/model` and search for `bifrost`, or run:

```bash
pi --model bifrost/openai/gpt-4o-mini
```

## Configuration

This extension follows the same pattern as our LiteLLM provider: it reads provider configuration directly from pi's credential store:

```text
~/.pi/agent/auth.json
```

Example:

```json
{
  "bifrost": {
    "key": "dummy-key",
    "base_url": "http://localhost:8080/openai/v1",
    "virtual_key": "",
    "models": "",
    "discover_models": "1",
    "reasoning_models": ""
  }
}
```

Environment variables are still supported as overrides, matching the LiteLLM extension style.

Caching defaults also mirror LiteLLM behavior: when `PI_CACHE_RETENTION` is unset, the extension sets it to `long` so pi emits long-lived cache markers for compatible models.

| auth.json key | env override | Default | Description |
| --- | --- | --- | --- |
| `key` | `BIFROST_API_KEY` | `dummy-key` | Bearer token sent to Bifrost. Use `dummy-key` when Bifrost handles upstream provider credentials internally. |
| `base_url` / `baseUrl` | `BIFROST_BASE_URL` | `http://localhost:8080/openai/v1` | Bifrost OpenAI-compatible base URL. If set to `.../openai`, the extension normalizes it to `.../openai/v1`. |
| `virtual_key` / `virtualKey` | `BIFROST_VIRTUAL_KEY` | unset | Sends Bifrost virtual key as `x-bf-vk`. |
| `models` | `BIFROST_MODELS` | unset | Comma-separated model IDs. When unset, the extension tries `/models`, then falls back to a small default catalog. |
| `discover_models` / `discoverModels` | `BIFROST_DISCOVER_MODELS` | `1` | Set to `0` to skip `/models` discovery. |
| `reasoning_models` / `reasoningModels` | `BIFROST_REASONING_MODELS` | unset | Comma-separated model IDs that should expose pi thinking levels. Defaults to none for gateway compatibility. |
| `context_window` / `contextWindow` | `BIFROST_CONTEXT_WINDOW` | `128000` | Fallback only. Used when discovery does not return per-model context metadata. |
| `max_tokens` / `maxTokens` | `BIFROST_MAX_TOKENS` | `16384` | Fallback only. Used when discovery does not return per-model output-token metadata. |

For compatibility with pi's newer API-key credential shape, the extension also accepts these values under `bifrost.env` using the `BIFROST_*` names.

## Model metadata

When `discover_models` is enabled and Bifrost's `/models` endpoint returns catalog metadata, the extension maps it per model:

- `context_length`, `contextWindow`, `max_context_length`, or `max_input_tokens` → pi `contextWindow`
- `max_output_tokens`, `max_completion_tokens`, or `max_tokens` → pi `maxTokens`
- `architecture.input_modalities` / `architecture.modality` → pi text/image support
- `pricing.prompt` / `pricing.completion` and cache pricing fields → pi cost metadata

The global `context_window` and `max_tokens` settings are therefore fallbacks, not the preferred source of truth.

If you set `models` explicitly, Bifrost is not queried for metadata for those entries, so the fallback values apply.

## Bifrost endpoint note

Bifrost docs often show OpenAI SDK configuration with:

```text
base_url = "http://localhost:8080/openai"
```

Pi's OpenAI-compatible transport expects a base URL before `/chat/completions`, so this extension uses:

```text
http://localhost:8080/openai/v1
```

If you provide `BIFROST_BASE_URL=http://localhost:8080/openai` or `base_url: "http://localhost:8080/openai"`, the extension automatically appends `/v1`.

## Prompt caching behavior

For OpenAI-family models (`gpt*`, `codex`, `o1/o3/o4`, `openai/*`), this extension applies the same guardrails we use in our LiteLLM extension:

- Forces `prompt_cache_retention: "24h"` when missing.
- Adds a stable fallback `prompt_cache_key` (`pi-bifrost-<model>`) when pi doesn't provide one.
- Enables provider/model compat hints for long retention and session-affinity headers.

## Commands

The extension adds:

```text
/bifrost
```

This shows the active Bifrost base URL and loaded model count.
