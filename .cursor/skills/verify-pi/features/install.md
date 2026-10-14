# Install

Install links this checkout into an agent directory and seeds settings only where the user has not already chosen a value.

## Sub-features

- `install-link` links `skills`, `extensions`, and `SYSTEM.md` at the temp agent dir.
- `install-seed` writes `defaultProvider` `openai-codex` and `defaultModel` `gpt-5.6-sol` into a new `settings.json`.

## How to get to it (user POV)

- Run `./install.sh` (or `./install.ps1` on Windows). The default target is `~/.pi/agent`. This drive uses a temp directory instead so the real agent dir stays untouched.

## Driving it with the shell

Preconditions:

- Doctor passed.
- `$OUT` exists.
- `parent` and `agent` are unset, or they point at a directory this run created.

- **Install.** Run `parent=$(mktemp -d); agent="$parent/agent"; PI_CODING_AGENT_DIR="$agent" ./install.sh >"$OUT/install.log" 2>&1`. Exit code 0. The log contains `Installed Vraj Pi` and `Linked skills`.
- **Links.** Run `readlink "$agent/skills"; readlink "$agent/extensions"; readlink "$agent/SYSTEM.md"`. The three outputs are `$PWD/skills`, `$PWD/extensions`, and `$PWD/SYSTEM.md`.
- **Seeded provider.** Run `node --input-type=module -e 'import { readFileSync } from "node:fs"; const s = JSON.parse(readFileSync(process.argv[1],"utf8")); console.log(s.defaultProvider, s.defaultModel);' "$agent/settings.json"`. Output is `openai-codex gpt-5.6-sol`.

## Gotchas

- The installer refuses a target inside the checkout.
- A second install into the same temp dir keeps an existing `defaultProvider`. Assert the seed on a fresh temp dir.
- `settings.example.json` also shows Pi's default `compaction` and `retry` objects. A fresh install does not write those keys; they match the runtime defaults in Pi 0.82.0.
- Rollback and the real `~/.pi/agent` are not this feature. Do not pass the home directory.
