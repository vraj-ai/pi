# Vraj Pi

Personal configuration for **Pi**, the terminal agent host this repo installs into
(`~/.pi/agent`). Every request is handled on the normal agent path. Subagents are
manual. The UI is a compact `π` header, a technical footer, and a below-editor
list of active subagents.

## What this repo is

Everything here gets linked (or copied) into `~/.pi/agent` by `./install.sh`:

- `SYSTEM.md` — coordinator policy: direct handling, terse output, subagent rules.
- `AGENTS.md` — agent rules for this repo: check/format/lint, type safety, test economy.
- `extensions/ui-customization` — compact `π + project` header, technical footer, active-subagent status.
- `extensions/subagents` — **Herdr**: the read-only multi-harness subagent fleet.
- `extensions/skills-manager` — `/skills` per-scope skill toggles and `/context-audit`.
- `extensions/usage-stats` — **PI Usage Statistics**: local cost/token/tool/limit index.
- `extensions/output-compress` — compresses noisy tool output, with `read_raw_output` recovery.
- `extensions/session-tools` — `/safety`, `/no-sleep`, `/features`, `/continue`.
- `extensions/files` — `/files` working-tree browser.
- `extensions/copy-all` — `/copy-all`, `/copy-last`, `/copy-code`, `/export`, all redacted.
- `extensions/firecrawl-search` — `search`, `scrape`, `crawl`, `extract`.
- `extensions/background-terminals` — `/ps` and background terminal tools.
- `extensions/ask-user` — mid-turn multiple-choice questions.
- `extensions/summaries` — session summarisation.
- `extensions/file-search` — `fd` / `rg` tools.
- `extensions/git-info`, `extensions/model-info` — git context and footer telemetry.
- `skills/` — local skill packages (background-terminals, subagents, terse-output, pi-setup-maintenance, pi-usage-maintenance).
- `themes/cobalt-ink.json` — the default deep-cobalt dark theme; `themes/vraj-ink.json` is still shipped.
- `keybindings.json` — personal keybinding overrides.
- `SETUP.md` — install, backup, and rollback details.
- `PROVENANCE.md` — vendored third-party code, what was changed, and how to re-check it.

Runtime state stays outside git: auth, sessions, trust, live settings, downloaded packages, and environment files.

## Token savings

| Lever                                                                      | What it actually does                                                                                                                                             |
| -------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Caveman-style terse output** — `skills/terse-output/SKILL.md` + Ponytail | Routine replies drop filler while keeping technical accuracy; security warnings, irreversible action confirmations, and multi-step sequences are never compressed |
| **Measured-only telemetry**                                                | Context use is a real occupancy fraction; everything else is elapsed time, turn count, or unknown                                                                 |

Credentials, API keys, tokens, and provider URLs never reach the footer, the status surface, or third parties.

## Install

```sh
./install.sh
```

The installer backs up current runtime resources before linking this repo into `~/.pi/agent`. Restart Pi or run `/reload` afterward.

## Direct-only operation

Every request is handled by the normal Pi agent path. Nothing is classified or routed automatically. There is no `/flow`, no `/mode`, no `workflow` tool, and no planner/coder/debugger/reviewer rail.

Subagents are **manual**: you spawn them explicitly with the subagent tools when you want one.

### Herdr: the subagent fleet

Three properties are enforced, not conventions:

- **Read-only.** Every subagent runs without the ability to write files or run
  shell commands. `pi` excludes the write tools, `claude` gets a read-only
  allowlist plus an explicit deny list, `codex` runs in its read-only sandbox,
  and the CLI harnesses append their read-only argv. A harness that cannot
  express read-only refuses to spawn rather than quietly running writable.
- **No takeover.** `/subagents` is a transcript viewer: scroll and abort, no
  input line and no send path. The model can still continue a child with
  `subagent_send`; a human cannot seize its turn.
- **Max 4 concurrent** across all harnesses.

| Slug     | Backend               | Notes                                        |
| -------- | --------------------- | -------------------------------------------- |
| `pi`     | in-process pi session | inherits this environment's tools and config |
| `claude` | Claude Agent SDK      |                                              |
| `codex`  | `codex app-server`    |                                              |
| `agy`    | generic one-shot CLI  | needs `agy`/`antigravity` on PATH            |
| `omp`    | generic one-shot CLI  | needs `omp` on PATH                          |
| `grok`   | generic one-shot CLI  | needs `grok` on PATH                         |

`agy`, `omp`, and `grok` are driven through a shared one-shot CLI backend whose
argv is _data_: each ships a default and each is overridable at
`vraj.subagents.cli.<slug>` in settings. A missing binary reports the harness as
unavailable with a clear message; it never breaks startup.

Agent rows show elapsed time, completed assistant turns (`1t` = one turn), and
measured context-window use (`<1% ctx`, for example). Unavailable usage shows no
percentage.

## Status surface

The primary status surface is the **belowEditor** widget — running subagents
below the prompt. The footer is telemetry only (cwd, runtime/model, usage, git/PR).

**Subagent picker.** DOWN opens the subagent picker only when a subagent is running;
`alt+down` opens it anytime. DOWN opens a view only — sending to a subagent remains
the explicit in-view send action (PI-11, INV-20).

## PI Usage Statistics

A local, rebuildable index of the pi session logs under `~/.pi/agent/sessions`.
Nothing leaves the machine: the dashboard binds to loopback and the page has no
remote assets.

- `/usage` — open the dashboard (ten sections, six ranges)
- `/usage summary [range]` — the overview in the transcript
- `/usage sync` — index new sessions now
- `/usage rebuild` — drop the index and re-read every session log
- `usage_stats` tool — any page as Markdown, for the model

Two honesty rules are built in, because a confident wrong number is worse than
no number:

- **Latency and tokens/second are derived** from entry timestamps (pi records no
  request duration), so they include local tool time, and gaps below 250 ms or
  above 10 minutes are reported as unknown rather than as a measurement.
- **Subscription limits are labelled `reported` or `estimated`.** `reported`
  rows come from the provider's own rate-limit response headers, recorded as
  they arrive. `estimated` rows are inferred from observed burn against a plan
  budget you configure at `vraj.usage.budgets`; there is no shipped default,
  because guessing someone's plan would manufacture a number. A provider that
  reports its own limits is never overridden by an estimate.

Ported from oh-my-pi's `packages/stats` (MIT) — see `PROVENANCE.md` for what was
taken, what was adapted, and why.

## Other surfaces

| Surface                                            | What it does                                                                                                                                                            |
| -------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `/skills`                                          | Per-skill checkbox manager grouped by scope. Disabling removes the skill from `<available_skills>` in the system prompt on the next turn. `/skill:name` still loads it. |
| `/context-audit`                                   | Ranks what is filling the window and warns about every contributor over 5,000 estimated tokens.                                                                         |
| `/copy-all`, `/copy-last`, `/copy-code`, `/export` | Copy or export the thread. Secrets are redacted before anything reaches a clipboard or a file.                                                                          |
| `/files [filter]`                                  | Browse the working tree and insert a repo-relative file reference. Cannot navigate outside the working directory.                                                       |
| `/raw [handle]`, `read_raw_output`                 | Recover the original behind a compressed tool output.                                                                                                                   |
| `/safety [on\|off\|strict\|rules]`                 | Blocks a small set of catastrophic shell commands.                                                                                                                      |
| `/no-sleep [on\|off\|agent\|session]`              | Holds the machine awake while a turn runs.                                                                                                                              |
| `/features`                                        | What this harness provides and which optional dependencies are actually installed.                                                                                      |
| `/continue`, `shift+alt+enter`                     | Send "continue" when the agent is stopped. Never steers a live run.                                                                                                     |
| Git context                                        | A compact branch/working-tree/recent-commits block is injected before the turn, only when the repository state changed.                                                 |

## Provenance and mirroring

```sh
npm run check:provenance     # vendored code still carries its attribution
npm run update-upstream      # report upstream changes since the pin (applies nothing)
npm run update-upstream -- --pr   # also write UPSTREAM-UPDATE.md for a draft PR

../scripts/mirror-check.sh   # drift between pi/ and the vraj-ai/pi mirror
../scripts/mirror-sync.sh    # copy pi/ into a mirror clone; never commits or pushes
```

`update-upstream` deliberately applies nothing: these ports are adaptations, not
copies, so a mechanical merge would either clobber the adaptation or produce a
conflict nobody can resolve without reading both sides anyway.

## Checks

```sh
npm install
npm run gates          # check + check:provenance + test
```

or individually:

```sh
npm run check
npm run check:provenance
npm run format:check
npm test
```

The live provider/auth routes are intentionally not tested in CI. Run them only when the exact credentials and models are available.

Tests are proportional: prefer one focused production-seam check that proves related behavior. Add separate cases only for distinct high-risk boundaries; do not create a test per criterion by default.

## Concise output

Terse output is a local skill (`skills/terse-output`), not a Pi package. The installer does not declare Ponytail in `settings.packages`; that family lives in the skills repository, and declaring it here too installs it twice under colliding local names. Routine replies use concise, Caveman-style evidence; security warnings, irreversible action confirmations, and multi-step sequences are never compressed.
