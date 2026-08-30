/**
 * Remove disabled skills from the system prompt for the coming turn.
 *
 * Pi has no API to un-discover a skill, but `before_agent_start` can replace
 * the system prompt. Dropping a `<skill>` entry from `<available_skills>` is
 * what "disabled" actually means to the model: it stops being offered, and its
 * description stops costing context. The `/skill:name` command still works,
 * which is the right escape hatch.
 */

import { SKILLS_BLOCK } from "./discovery.ts";

const NAME = /<name>([\s\S]*?)<\/name>/;

function unescapeXml(value: string) {
  return value
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, "&");
}

export interface FilterResult {
  readonly prompt: string;
  /** Names actually removed - useful for the notification and for tests. */
  readonly removed: readonly string[];
}

/**
 * Returns the prompt unchanged when nothing is disabled or no skills block
 * exists. When every skill is disabled the whole block (and its preamble) is
 * dropped, matching what Pi emits for a session with no skills at all.
 */
export function filterSkills(
  systemPrompt: string,
  disabled: ReadonlySet<string>,
): FilterResult {
  if (typeof systemPrompt !== "string") return { prompt: "", removed: [] };
  if (disabled.size === 0) return { prompt: systemPrompt, removed: [] };
  const block = systemPrompt.match(SKILLS_BLOCK);
  if (!block) return { prompt: systemPrompt, removed: [] };

  const removed: string[] = [];
  const kept: string[] = [];
  for (const chunk of block[1].split(/(?<=<\/skill>)/)) {
    if (!chunk.includes("<skill>")) {
      if (chunk.trim()) kept.push(chunk.replace(/^\n+|\n+$/g, ""));
      continue;
    }
    const name = chunk.match(NAME);
    const skillName = name ? unescapeXml(name[1]).trim() : "";
    if (skillName && disabled.has(skillName)) {
      removed.push(skillName);
      continue;
    }
    kept.push(chunk.replace(/^\n+|\n+$/g, ""));
  }

  if (removed.length === 0) return { prompt: systemPrompt, removed: [] };

  if (kept.length === 0) {
    // No skills survive: drop the preamble Pi writes above the block too, so
    // the model is not told to consult a list that is not there.
    const preamble =
      /\n\nThe following skills provide specialized instructions[\s\S]*?<\/available_skills>/;
    const stripped = systemPrompt.replace(preamble, "");
    return {
      prompt:
        stripped === systemPrompt
          ? systemPrompt.replace(SKILLS_BLOCK, "")
          : stripped,
      removed,
    };
  }

  const rebuilt = `<available_skills>\n${kept.join("\n")}\n</available_skills>`;
  return { prompt: systemPrompt.replace(SKILLS_BLOCK, rebuilt), removed };
}
