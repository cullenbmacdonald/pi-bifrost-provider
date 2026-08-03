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

Environment variables:

| Variable | Default | Description |
| --- | --- | --- |
| `BIFROST_BASE_URL` | `http://localhost:8080/openai/v1` | Bifrost OpenAI-compatible base URL. If set to `.../openai`, the extension normalizes it to `.../openai/v1`. |
| `BIFROST_API_KEY` | `dummy-key` | Bearer token sent to Bifrost. Use a real key if your Bifrost deployment requires one. |
| `BIFROST_VIRTUAL_KEY` | unset | Sends Bifrost virtual key as `x-bf-vk`. |
| `BIFROST_MODELS` | unset | Comma-separated model IDs. When unset, the extension tries `/models`, then falls back to a small default catalog. |
| `BIFROST_DISCOVER_MODELS` | `1` | Set to `0` to skip `/models` discovery. |
| `BIFROST_REASONING_MODELS` | unset | Comma-separated model IDs that should expose pi thinking levels. Defaults to none for gateway compatibility. |
| `BIFROST_CONTEXT_WINDOW` | `128000` | Context window assigned to discovered/configured models. |
| `BIFROST_MAX_TOKENS` | `16384` | Max output tokens assigned to discovered/configured models. |

Example with explicit models and a virtual key:

```bash
export BIFROST_BASE_URL=http://localhost:8080/openai/v1
export BIFROST_API_KEY=dummy-key
export BIFROST_VIRTUAL_KEY=vk_12345
export BIFROST_MODELS=openai/gpt-4o-mini,anthropic/claude-sonnet-4-20250514

pi -e ~/dev/pi-dev/pi-bifrost-provider --model bifrost/openai/gpt-4o-mini
```

## Bifrost endpoint note

Bifrost docs often show OpenAI SDK configuration with:

```text
base_url = "http://localhost:8080/openai"
```

Pi's OpenAI-compatible transport expects a base URL before `/chat/completions`, so this extension uses:

```text
http://localhost:8080/openai/v1
```

If you provide `BIFROST_BASE_URL=http://localhost:8080/openai`, the extension automatically appends `/v1`.

## Commands

The extension adds:

```text
/bifrost
```

This shows the active Bifrost base URL and loaded model count.
