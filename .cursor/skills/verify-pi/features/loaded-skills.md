# Loaded skills

After install, Pi's global skill directory is this repo's `skills/`. Five packages are on that path.

## Sub-features

- `skills-linked` shows a symlink from the agent `skills` directory to the checkout.
- `skills-five` lists one `SKILL.md` for each shipped package.

## How to get to it (user POV)

- Run `./install.sh`, restart Pi or `/reload`, then `/skills`. This drive checks the filesystem the installer created, because `/skills` needs an interactive session.

## Driving it with the shell

Preconditions:

- The install feature has just succeeded for this `agent`, or you run its install command again into a new temp dir.
- `$OUT` exists.

- **Link.** Run `readlink "$agent/skills"`. Output is `$PWD/skills`.
- **Packages.** Run `find -L "$agent/skills" -name SKILL.md | sort | tee "$OUT/skills.log"`. Exit code 0. `find -L` prints paths under `$agent/skills`, not the canonical checkout path. The log lists exactly these five files:

  - `background-terminals/SKILL.md`
  - `pi-setup-maintenance/SKILL.md`
  - `pi-usage-maintenance/SKILL.md`
  - `subagents/SKILL.md`
  - `terse-output/SKILL.md`

## Gotchas

- `find` without `-L` prints nothing, because `skills` is a symlink. That empty result is not a missing install.
- `pi-setup-maintenance` and `pi-usage-maintenance` set `disable-model-invocation: true`. They are on disk and still hidden from `<available_skills>` until `/skill:name`.
- This feature does not prove Pi's prompt block. It proves the files the installer published.
