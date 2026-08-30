/**
 * Skill discovery by reading the system prompt Pi already built.
 *
 * Pi's own discovery rules (global dirs, project dirs, packages, settings, CLI
 * `--skill`) are non-trivial and change between releases. Re-implementing them
 * would drift. The `<available_skills>` block in the system prompt is the
 * ground truth of what is actually loaded this session, so the manager parses
 * that instead.
 */

import { homedir } from "node:os";
import { resolve, sep } from "node:path";

export type SkillScope = "global" | "project" | "session";

export interface DiscoveredSkill {
  readonly name: string;
  readonly description: string;
  readonly location: string;
  readonly scope: SkillScope;
}

export const SKILLS_BLOCK =
  /<available_skills>\n([\s\S]*?)\n<\/available_skills>/;

function unescapeXml(value: string) {
  return value
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, "&");
}

function tag(block: string, name: string) {
  const match = block.match(new RegExp(`<${name}>([\\s\\S]*?)</${name}>`));
  return match ? unescapeXml(match[1]).trim() : "";
}

function within(path: string, root: string) {
  if (!root) return false;
  const normalized = resolve(root);
  return path === normalized || path.startsWith(`${normalized}${sep}`);
}

export interface ScopeRoots {
  readonly home?: string;
  readonly cwd?: string;
}

/**
 * Classify where a skill came from. Anything outside the well-known global and
 * project trees (settings entries, packages, `--skill`) is "session" - it is
 * present because of how this session was launched.
 */
export function classifyScope(
  location: string,
  roots: ScopeRoots = {},
): SkillScope {
  const home = roots.home ?? homedir();
  const cwd = roots.cwd ?? process.cwd();
  const path = resolve(location);

  for (const dir of [
    `${home}${sep}.pi${sep}agent${sep}skills`,
    `${home}${sep}.agents${sep}skills`,
  ]) {
    if (within(path, dir)) return "global";
  }
  if (cwd && within(path, cwd)) return "project";
  return "session";
}

/** Parse the `<available_skills>` block out of a system prompt. */
export function parseSkills(
  systemPrompt: string,
  roots: ScopeRoots = {},
): DiscoveredSkill[] {
  if (typeof systemPrompt !== "string") return [];
  const block = systemPrompt.match(SKILLS_BLOCK);
  if (!block) return [];

  const skills: DiscoveredSkill[] = [];
  for (const entry of block[1].split(/<\/skill>/)) {
    if (!entry.includes("<skill>")) continue;
    const name = tag(entry, "name");
    if (!name) continue;
    const location = tag(entry, "location");
    skills.push({
      name,
      description: tag(entry, "description"),
      location,
      scope: location ? classifyScope(location, roots) : "session",
    });
  }
  return skills;
}

export const SCOPE_ORDER: readonly SkillScope[] = [
  "global",
  "project",
  "session",
];

export function groupByScope(skills: readonly DiscoveredSkill[]) {
  const groups = new Map<SkillScope, DiscoveredSkill[]>(
    SCOPE_ORDER.map((scope) => [scope, [] as DiscoveredSkill[]]),
  );
  for (const skill of skills) groups.get(skill.scope)?.push(skill);
  for (const list of groups.values()) {
    list.sort((a, b) => a.name.localeCompare(b.name));
  }
  return groups;
}
