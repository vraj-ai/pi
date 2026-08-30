/**
 * Persisted enable/disable state for skills, one store per scope.
 *
 * - global  -> `~/.pi/agent/settings.json`
 * - project -> `<cwd>/.pi/settings.json`
 * - session -> in memory, gone when the session ends
 *
 * The key is `vraj.skills.disabled`: a sorted array of skill names. A settings
 * file that fails to parse is treated as "nothing disabled" rather than as an
 * error, so a hand-edited file can never lock the user out of their skills.
 */

import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { SkillScope } from "./discovery.ts";

export const DISABLED_KEY = "vraj.skills.disabled";

export interface StatePaths {
  readonly home?: string;
  readonly cwd?: string;
}

/** Settings file backing a scope. `session` has none - it never touches disk. */
export function settingsPathFor(
  scope: SkillScope,
  paths: StatePaths = {},
): string | undefined {
  if (scope === "global") {
    return join(paths.home ?? homedir(), ".pi", "agent", "settings.json");
  }
  if (scope === "project") {
    return join(paths.cwd ?? process.cwd(), ".pi", "settings.json");
  }
  return undefined;
}

function readSettings(path: string): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

function namesFrom(value: unknown) {
  return Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === "string")
    : [];
}

export function readDisabled(scope: SkillScope, paths: StatePaths = {}) {
  const path = settingsPathFor(scope, paths);
  if (!path) return new Set<string>();
  return new Set(namesFrom(readSettings(path)[DISABLED_KEY]));
}

/**
 * Rewrite only our key, preserving every other setting. Written to a sibling
 * temp file and renamed so an interrupted write cannot truncate the user's
 * settings.
 */
export function writeDisabled(
  scope: SkillScope,
  names: Iterable<string>,
  paths: StatePaths = {},
) {
  const path = settingsPathFor(scope, paths);
  if (!path) return false;
  const settings = readSettings(path);
  const sorted = [...new Set(names)].sort();
  if (sorted.length === 0) delete settings[DISABLED_KEY];
  else settings[DISABLED_KEY] = sorted;

  const temp = `${path}.vraj-tmp`;
  try {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(temp, `${JSON.stringify(settings, null, 2)}\n`, "utf8");
    renameSync(temp, path);
    return true;
  } catch {
    return false;
  }
}

/**
 * Live view of what is disabled across all three scopes. Session toggles are
 * held here; global and project toggles round-trip through settings files.
 */
export class SkillToggleState {
  readonly #session = new Set<string>();
  readonly #paths: StatePaths;

  constructor(paths: StatePaths = {}) {
    this.#paths = paths;
  }

  disabledIn(scope: SkillScope) {
    return scope === "session"
      ? new Set(this.#session)
      : readDisabled(scope, this.#paths);
  }

  /** Union across scopes: a skill disabled anywhere stays out of the prompt. */
  allDisabled() {
    const all = new Set<string>(this.#session);
    for (const scope of ["global", "project"] as const) {
      for (const name of readDisabled(scope, this.#paths)) all.add(name);
    }
    return all;
  }

  isDisabled(name: string) {
    return this.allDisabled().has(name);
  }

  /** Toggle `name` within `scope`. Returns the new enabled state. */
  toggle(name: string, scope: SkillScope) {
    if (scope === "session") {
      const wasDisabled = this.#session.delete(name);
      if (!wasDisabled) this.#session.add(name);
      return wasDisabled;
    }
    const disabled = readDisabled(scope, this.#paths);
    const wasDisabled = disabled.delete(name);
    if (!wasDisabled) disabled.add(name);
    writeDisabled(scope, disabled, this.#paths);
    return wasDisabled;
  }

  clearSession() {
    this.#session.clear();
  }
}
