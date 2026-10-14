# Gates

Gates are the check a user runs in the repo before trusting a change: TypeScript, provenance headers, the test suite, and Prettier.

## Sub-features

- `gates-all` runs `npm run gates` (check, provenance, test) and exits 0.
- `gates-format` runs `npm run format:check` and exits 0.

## How to get to it (user POV)

- From the repo root, run the Checks commands in `README.md`.

## Driving it with the shell

Preconditions:

- Doctor in `.cursor/skills/verify-pi/SKILL.md` passed.
- `$OUT` exists.

- **Typecheck, provenance, tests.** Run `npm run gates >"$OUT/gates.log" 2>&1`. Exit code 0. The log contains the test summary and no failing assertion.
- **Format.** Run `npm run format:check >"$OUT/format.log" 2>&1`. Exit code 0. The log says the checked files are formatted.

## Gotchas

- `npm run gates` does not include `format:check`. Both are required.
- Live Codex or other provider tests are not part of this feature. A failure that needs a real API key stays a failure of the suite, recorded in the log, and is not reclassified as success.
- Pi's `engines` field asks for Node `>=22.19.0`. Record `node -v` next to the log. A pass on an older 22.x is still a pass of this feature.
