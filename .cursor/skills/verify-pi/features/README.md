# Pi verification map

Prove the checkout from the repo root. Read this index, then one feature file. Do not install into `~/.pi/agent`.

## Baseline preconditions

- Repo root is the current directory. `package.json`, `extensions/`, `skills/`, and `SYSTEM.md` exist.
- `npm install --ignore-scripts` has been run for this checkout.
- `RUN_ID` and `OUT` from the skill's Evidence section exist.
- A temp agent dir, when used, is outside the checkout (`mktemp -d`).

## Driving conventions

- Start from the baseline. Do not reuse another run's agent directory.
- Treat the commands in the feature file as literal.
- Save stdout, stderr, and the exit code under `$OUT`.
- Do not print `OPENCODE_API_KEY`, `auth.json`, or any other secret.
- Cleanup removes the temp agent dir and leaves `$OUT`.

## Proof and skip reporting

- CLI proof is the command, the output log, and the exit code.
- Install proof includes the linked skills path and `defaultProvider` / `defaultModel` from the temp `settings.json`.
- An unreachable path records the command and the unmet precondition. A different command does not cover it.

## Feature entry contract

Each feature file has an H1, one opening paragraph, then `Sub-features`, `How to get to it (user POV)`, `Driving it with the shell`, and `Gotchas`.

## Features

- [Gates](./gates.md) — typecheck, provenance, tests, and format.
- [Install](./install.md) — `./install.sh` into a disposable agent directory.
- [Loaded skills](./loaded-skills.md) — the five `SKILL.md` packages the install links.
- [OpenCode Go](./opencode-go.md) — unauthenticated CLI behavior and the bundled catalog.
