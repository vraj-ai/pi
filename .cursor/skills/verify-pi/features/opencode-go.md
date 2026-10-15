# OpenCode Go

OpenCode Go is the built-in `opencode-go` provider in Pi 0.82.0. This check proves the catalog file and the CLI's behavior when no key is available. It does not send a completion request.

## Sub-features

- `opencode-no-key` runs `--list-models opencode-go` with no key in the shell and gets the unauthenticated message.
- `opencode-catalog` reads the bundled catalog and finds `kimi-k2.6` among 16 ids.

## How to get to it (user POV)

- With a key, the user runs `/model` or `pi --list-models opencode-go` and picks a model. See `docs/opencode-go.md`.
- Without a key, `pi --list-models` tells them to log in. That is the path this drive can prove.

## Driving it with the shell

Preconditions:

- Doctor passed, including Pi package version `0.82.0`.
- `$OUT` exists.
- Do not read or print `OPENCODE_API_KEY` or `~/.pi/agent/auth.json`. Do not unset `OPENCODE_API_KEY`.

- **Unauthenticated list.** Run this only when `OPENCODE_API_KEY` is unset and `${HOME}/.pi/agent/auth.json` does not exist: `node node_modules/@earendil-works/pi-coding-agent/dist/cli.js --list-models opencode-go >"$OUT/opencode-go-list.log" 2>&1`. Exit code 0. The log contains `No models available`. If either credential is present, write `skipped: credential present` to that log and do not run the list command.
- **Bundled catalog.** Run `node --input-type=module -e 'import data from "./node_modules/@earendil-works/pi-ai/dist/providers/data/opencode-go.json" with { type: "json" }; const ids = Object.values(data).flatMap((group) => Object.keys(group)).sort(); if (!ids.includes("kimi-k2.6") || ids.length !== 16) process.exit(1); console.log(ids.join("\n"));' | tee "$OUT/opencode-go-catalog.log"`. Exit code 0. The log has 16 lines and includes `kimi-k2.6`.

## Gotchas

- A key already in the environment or in `auth.json` can make `--list-models` print models instead of `No models available`. Skipping the list command is the result. Do not clear the variable to force the no-key line.
- The catalog command does not prove the network endpoint. `minimax-m3`, `qwen3.7-max`, and `qwen3.7-plus` use `https://opencode.ai/zen/go`. The other ids use `https://opencode.ai/zen/go/v1`.
- `opencode/claude-fable-5` in `skills/subagents/SKILL.md` is OpenCode Zen, not this provider.
