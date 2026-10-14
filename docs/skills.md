# Skill loading

Pi 0.82.0 loads a skill by scanning for `SKILL.md`, putting the name and description in `<available_skills>`, and reading the file when the task matches. `/skill:name` loads a skill even when it was left out of the prompt. The locations below are from `docs/skills.md` in `@earendil-works/pi-coding-agent@0.82.0`.

## Where Pi looks

- Global: `~/.pi/agent/skills/` and `~/.agents/skills/`
- Project, only after the folder is trusted: `.pi/skills/` and `.agents/skills/` from the working directory up to the git root
- Installed Pi packages: a `skills/` directory, or `pi.skills` in that package's `package.json`
- `skills` paths in settings
- `--skill <path>` (still loads with `--no-skills`)

In `~/.pi/agent/skills/` and `.pi/skills/`, a root `.md` file is a skill. In `~/.agents/skills/` and project `.agents/skills/`, root `.md` files are ignored. Directories containing `SKILL.md` are found recursively in every location. A skill with no description is not loaded. The same name from two locations warns, and Pi keeps the first one.

`disable-model-invocation: true` hides a skill from the system prompt. `/skill:name` still runs it.

## What this installer does

`./install.sh` links this repo's `skills/` to `~/.pi/agent/skills` (it copies when a symlink is refused). Those skills are then global. They are not project skills of this checkout: the repo has no `.pi/skills/` directory, and `package.json` has no `pi` manifest, so opening this repo does not publish `skills/` until you install.

| Skill | When it loads |
| --- | --- |
| `terse-output` | Routine replies. Security warnings, irreversible action confirmations, and multi-step sequences stay uncompressed. |
| `subagents` | The user asks for a subagent, or you spawn one with `subagent_spawn`. |
| `background-terminals` | A command must keep running (`bg_start`). |
| `pi-setup-maintenance` | Manual only (`disable-model-invocation`). An explicit setup pass. |
| `pi-usage-maintenance` | Manual only (`disable-model-invocation`). An explicit usage-data pass. |

The installer does not declare `git:github.com/DietrichGebert/ponytail` in `settings.packages`. That family lives in the skills repository. Declaring it here as well installs it twice under colliding local names. An entry already in the user's settings is left in place, with a note.

pstack and [github.com/vraj-ai/skills](https://github.com/vraj-ai/skills) (`grill`, `issues`, `ship`, `snapshot`) are not copied by this installer. Pi loads them when their directories are already on a path above, usually `~/.agents/skills`.

## `/skills` in this repo

`extensions/skills-manager` does not re-scan disk. It parses the `<available_skills>` block Pi already built.

- A path under `~/.pi/agent/skills` or `~/.agents/skills` is global.
- A path under the session cwd is project.
- Anything else (settings paths, packages, `--skill`) is session.

Disabling a skill writes `vraj.skills.disabled` (a sorted list of names) to `~/.pi/agent/settings.json` for global, `.pi/settings.json` for project, or memory for the session. On the next turn the extension removes those `<skill>` entries from the system prompt. `/skill:name` still loads a disabled skill. A settings file that fails to parse counts as nothing disabled.

`/context-audit` ranks what is filling the window and warns above 5,000 estimated tokens.

If the prompt has no skills, `/skills` says so and names `~/.pi/agent/skills`, `~/.agents/skills`, and the trusted project dirs. The repo doc is this file; it is not installed into the agent directory.
