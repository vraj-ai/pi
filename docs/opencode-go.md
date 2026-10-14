# OpenCode Go

Pi **0.82.0** (`@earendil-works/pi-ai`, the version this repo installs) already registers OpenCode Go. Provider id: `opencode-go`. Display name: `OpenCode Zen Go`. This checkout does not install a second provider extension.

`./install.sh` still seeds `defaultProvider: "openai-codex"` and `defaultModel: "gpt-5.6-sol"` when those keys are absent. It does not switch an existing install to OpenCode Go, and a later install will not overwrite a provider or model you already set.

## Auth

OpenCode Go and OpenCode Zen (`opencode`) both read `OPENCODE_API_KEY`. They are different providers and different `auth.json` keys. Pi resolves credentials in this order (from the providers doc shipped with `@earendil-works/pi-coding-agent@0.82.0`):

1. CLI `--api-key`
2. `~/.pi/agent/auth.json`
3. the environment variable
4. custom provider keys from `models.json`

`auth.json` wins over the environment variable. A shared `OPENCODE_API_KEY` signs in both providers unless `auth.json` sets them separately.

Store the key with `/login`, or in `~/.pi/agent/auth.json` (Pi creates this file with mode `0600`):

```json
{
  "opencode-go": { "type": "api_key", "key": "$OPENCODE_API_KEY" }
}
```

The `key` field also accepts a literal, `${ENV_VAR}` interpolation, or a `!command` that prints the secret. Keep the real key out of git, docs, and settings. `auth.json` is runtime state; the installer does not restore it on rollback.

## Select a model

In a session that already has a key:

```text
/model
```

Choose provider `opencode-go`, then a model. From the shell:

```sh
pi --provider opencode-go --model kimi-k2.6
```

`kimi-k2.6` is one id in the bundled catalog, not a special default. To make it the default for this agent directory, set both keys in `~/.pi/agent/settings.json`:

```json
{
  "defaultProvider": "opencode-go",
  "defaultModel": "kimi-k2.6"
}
```

Subagent model hints use `provider/model-id`. An OpenCode Go hint looks like `opencode-go/kimi-k2.6`. Rows in `skills/subagents/SKILL.md` that start with `opencode/` are OpenCode Zen, not Go.

Without a key, `pi --list-models` prints `No models available` and points at Pi's providers doc. That is the unauthenticated state, not an empty catalog.

## Bundled catalog (pi-ai 0.82.0)

The file is `node_modules/@earendil-works/pi-ai/dist/providers/data/opencode-go.json`. `pi update --models` can refresh Pi's cached catalog, so `/model` is the live list. These are the 16 ids shipped in 0.82.0:

| id | API | input | context | max tokens | base URL |
| --- | --- | --- | --- | --- | --- |
| `deepseek-v4-flash` | openai-completions | text | 1000000 | 384000 | `https://opencode.ai/zen/go/v1` |
| `deepseek-v4-pro` | openai-completions | text | 1000000 | 384000 | `https://opencode.ai/zen/go/v1` |
| `glm-5.1` | openai-completions | text | 202752 | 32768 | `https://opencode.ai/zen/go/v1` |
| `glm-5.2` | openai-completions | text | 1000000 | 131072 | `https://opencode.ai/zen/go/v1` |
| `grok-4.5` | openai-responses | text, image | 500000 | 500000 | `https://opencode.ai/zen/go/v1` |
| `hy3` | openai-completions | text | 256000 | 64000 | `https://opencode.ai/zen/go/v1` |
| `kimi-k2.6` | openai-completions | text, image | 262144 | 65536 | `https://opencode.ai/zen/go/v1` |
| `kimi-k2.7-code` | openai-completions | text, image | 262144 | 262144 | `https://opencode.ai/zen/go/v1` |
| `kimi-k3` | openai-completions | text, image | 1048576 | 131072 | `https://opencode.ai/zen/go/v1` |
| `mimo-v2.5` | openai-completions | text, image | 1000000 | 128000 | `https://opencode.ai/zen/go/v1` |
| `mimo-v2.5-pro` | openai-completions | text | 1048576 | 128000 | `https://opencode.ai/zen/go/v1` |
| `minimax-m2.7` | openai-completions | text | 204800 | 131072 | `https://opencode.ai/zen/go/v1` |
| `minimax-m3` | anthropic-messages | text, image | 1000000 | 131072 | `https://opencode.ai/zen/go` |
| `qwen3.6-plus` | openai-completions | text, image | 1000000 | 65536 | `https://opencode.ai/zen/go/v1` |
| `qwen3.7-max` | anthropic-messages | text | 1000000 | 65536 | `https://opencode.ai/zen/go` |
| `qwen3.7-plus` | anthropic-messages | text, image | 1000000 | 65536 | `https://opencode.ai/zen/go` |

Anthropic-messages models use `https://opencode.ai/zen/go`. The others use `https://opencode.ai/zen/go/v1`.

## Not this checkout

`monotykamary/pi-opencode-go-provider` is a separate extension. This repo does not install it. `./install.sh` replaces `~/.pi/agent/extensions` with a link to this repo's `extensions/`, so an extension dropped into that directory is removed on the next install. The built-in provider is the one this config uses.
