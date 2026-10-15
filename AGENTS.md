# Pi

Personal config for the Pi coding agent. `./install.sh` links it into `~/.pi/agent`.

## Skills

Load the skill that matches the work. Do not wait for the user to invoke it.

pstack poteto-mode, in order: understand (`how` / `why`) → design (`architect`) → build → verify (`.cursor/skills/verify-pi`) → interrogate → ship.

From [github.com/vraj-ai/skills](https://github.com/vraj-ai/skills):

- `grill` — product intent is still ambiguous. Do not build.
- `issues` — an agreed outcome needs a tracker issue. Name the `verify-pi` feature in Verification.
- `ship` — implement and open the PR. A one-file or obvious change can ship directly. Cross-module work, a design fork, or a bug with an unknown cause runs poteto-mode inside ship. Use `interrogate` as the independent review when no PR bot is configured.
- `snapshot` — unfinished work needs a resume note. Do not write `CONTEXT/progress.md`.

OpenCode Go setup and Pi's skill paths: `docs/opencode-go.md`, `docs/skills.md`.

## Commands

```sh
npm install
npm run gates          # tsc --noEmit, provenance, tests
npm run format:check
```

## Verify

Run `.cursor/skills/verify-pi` before claiming this repo works. `npm run gates` and `npm run format:check` are mandatory. Keep the skill's evidence. Live provider calls are out of that check.

## Authority

Self-merge is off (fleet ADR 0003). Open one PR. Do not merge it.

## Tracker

GitHub issues on `vraj-ai/pi`. `tickets.md` is a historical log, not the live queue.

## Constraints

- Avoid explicit return types unless needed.
- `as any` is a last resort. Prefer inference and existing types.
- Use the smallest meaningful production-seam test. Keep separate cases for distinct safety and failure modes.
