---
name: verify-pi
description: Prove the Pi coding-agent config (vraj-ai/pi) from the checkout. Use after a change to this repo, before claiming install, tests, skill linking, or the OpenCode Go catalog work. Drives npm gates and a temp-dir install, not a live provider call.
---

# Verify Pi

This repo is a Pi config checkout, not a server. Verification installs dependencies, runs the repo gates, and installs into a disposable agent directory. It does not call OpenCode, and it does not touch `~/.pi/agent`.

## Launch

From the repo root:

```sh
npm install --ignore-scripts
```

Ready means `node_modules/@earendil-works/pi-coding-agent/package.json` exists and `npm run gates` can start. There is no port and no seed database. Node's engine field for Pi 0.82.0 asks for `>=22.19.0`. Record `node -v`. A lower 22.x that still passes the gates is an environment note, not a skipped check.

## Doctor

Run this before a drive. Every line must exit 0.

```sh
node -v
test -f package.json && test -d extensions && test -d skills && test -f SYSTEM.md && test -f settings.example.json
test -f node_modules/@earendil-works/pi-coding-agent/package.json
node --input-type=module -e 'import { readFileSync } from "node:fs"; const p = JSON.parse(readFileSync("node_modules/@earendil-works/pi-coding-agent/package.json","utf8")); if (p.version !== "0.82.0") process.exit(1);'
```

Doctor fails closed when `node_modules` is missing, the checkout is incomplete, or the installed Pi package is not 0.82.0. Do not point `PI_CODING_AGENT_DIR` at the real home directory.

## Drive

Set `RUN_ID` and `OUT` first. See Evidence. Run one feature file under `features/` from a clean temp dir. The gates feature is the default when the change is code or docs in this repo.

Gates:

```sh
npm run gates
npm run format:check
```

Both must exit 0. `npm run gates` is `npm run check`, `npm run check:provenance`, and `npm test`.

Temp install (feature `install` and feature `loaded-skills`):

```sh
parent=$(mktemp -d)
agent="$parent/agent"
PI_CODING_AGENT_DIR="$agent" ./install.sh
test "$(readlink "$agent/skills")" = "$PWD/skills"
node --input-type=module -e 'import { readFileSync } from "node:fs"; const s = JSON.parse(readFileSync(process.argv[1],"utf8")); if (s.defaultProvider !== "openai-codex" || s.defaultModel !== "gpt-5.6-sol") process.exit(1);' "$agent/settings.json"
find -L "$agent/skills" -name SKILL.md | sort
```

`find` without `-L` does not walk the skills symlink. The installer refuses a target inside the checkout.

OpenCode Go, no network and no key (feature `opencode-go`):

```sh
unset OPENCODE_API_KEY
node node_modules/@earendil-works/pi-coding-agent/dist/cli.js --list-models opencode-go
node --input-type=module -e 'import data from "./node_modules/@earendil-works/pi-ai/dist/providers/data/opencode-go.json" with { type: "json" }; const ids = Object.values(data).flatMap((group) => Object.keys(group)); if (!ids.includes("kimi-k2.6")) process.exit(1); console.log(ids.length);'
```

The CLI without a key prints `No models available`. The second command reads the bundled catalog only. If `OPENCODE_API_KEY` or `~/.pi/agent/auth.json` is already set, do not unset a key you did not export in this shell, do not print it, and do not send a prompt. Stop the OpenCode Go feature at the catalog read.

## Evidence

```sh
RUN_ID=$(date +%Y%m%d%H%M%S)
OUT="${TMPDIR:-/tmp}/verify-pi/$RUN_ID"
mkdir -p "$OUT"
```

Save stdout, stderr, and the exit code for each command (`gates.log`, `format.log`, `install.log`, `opencode-go.log`). Record the feature id. Proof is the command and the resulting files (gate exit 0, the temp `settings.json` provider, the `SKILL.md` list, the catalog count). A green exit with no saved output is not proof. Do not commit `OUT`.

## Cleanup

```sh
rm -rf "$parent"
test ! -e "$parent"
test -d "$OUT"
```

Delete only the temp agent directory this run created. Leave `OUT` in place. Do not `kill` by process name. Do not delete `~/.pi/agent`.

## Helpers

No helper script. The commands above are the harness.
