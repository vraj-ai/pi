/**
 * Rows for the `/skills` checkbox manager.
 *
 * Pi's UI offers a single-select dialog, not a multi-select, so the manager is
 * a select loop: pick a row to flip its checkbox, the list redraws, "Done"
 * exits. Building the row list is pure so the toggling behaviour is testable
 * without a terminal.
 */

import {
  groupByScope,
  SCOPE_ORDER,
  type DiscoveredSkill,
  type SkillScope,
} from "./discovery.ts";

export const DONE_LABEL = "Done";

export interface SkillRow {
  readonly label: string;
  readonly name: string;
  readonly scope: SkillScope;
  readonly enabled: boolean;
}

const SCOPE_TITLE: Record<SkillScope, string> = {
  global: "Global",
  project: "Project",
  session: "Session",
};

function truncate(text: string, width: number) {
  if (text.length <= width) return text;
  return width <= 1 ? text.slice(0, width) : `${text.slice(0, width - 1)}…`;
}

/**
 * One row per skill, grouped by scope with a header row per non-empty group.
 * Header rows are returned as labels only; the caller ignores selections whose
 * label is not in the returned `byLabel` map.
 */
export function buildRows(
  skills: readonly DiscoveredSkill[],
  disabled: ReadonlySet<string>,
) {
  const labels: string[] = [];
  const byLabel = new Map<string, SkillRow>();
  const groups = groupByScope(skills);

  for (const scope of SCOPE_ORDER) {
    const group = groups.get(scope) ?? [];
    if (group.length === 0) continue;
    const enabledCount = group.filter((s) => !disabled.has(s.name)).length;
    labels.push(
      `-- ${SCOPE_TITLE[scope]} (${enabledCount}/${group.length}) --`,
    );
    for (const skill of group) {
      const enabled = !disabled.has(skill.name);
      const label = `  [${enabled ? "x" : " "}] ${skill.name}${
        skill.description ? ` - ${truncate(skill.description, 60)}` : ""
      }`;
      labels.push(label);
      byLabel.set(label, { label, name: skill.name, scope, enabled });
    }
  }

  labels.push(DONE_LABEL);
  return { labels, byLabel };
}

export function summarize(
  skills: readonly DiscoveredSkill[],
  disabled: ReadonlySet<string>,
) {
  const off = skills.filter((skill) => disabled.has(skill.name));
  if (off.length === 0) return `${skills.length} skills enabled`;
  return `${skills.length - off.length}/${skills.length} skills enabled (${off
    .map((skill) => skill.name)
    .sort()
    .join(", ")} off)`;
}
