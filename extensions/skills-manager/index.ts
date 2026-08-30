/**
 * skills-manager: `/skills` and `/context-audit`.
 *
 * `/skills` is a checkbox manager over every skill Pi loaded, grouped by where
 * it came from (global / project / session). Toggling a skill persists at that
 * skill's own scope: global skills in `~/.pi/agent/settings.json`, project
 * skills in `.pi/settings.json`, session skills for this session only.
 *
 * A disabled skill is removed from `<available_skills>` in the system prompt on
 * the next turn, so it stops being offered and stops costing context.
 * `/skill:name` still loads it explicitly.
 *
 * `/context-audit` reports what is filling the window and warns about every
 * contributor over 5,000 estimated tokens.
 */

import type {
  ExtensionAPI,
  ExtensionCommandContext,
} from "@earendil-works/pi-coding-agent";
import { auditContext, formatAudit } from "./src/context-audit.ts";
import { parseSkills, type DiscoveredSkill } from "./src/discovery.ts";
import { buildRows, DONE_LABEL, summarize } from "./src/picker.ts";
import { filterSkills } from "./src/prompt-filter.ts";
import { SkillToggleState } from "./src/state.ts";

function readSystemPrompt(ctx: { getSystemPrompt(): string }) {
  try {
    return ctx.getSystemPrompt();
  } catch {
    return "";
  }
}

const CONTEXT_AUDIT_ENTRY = "vraj-context-audit";

interface ContextAuditEntry {
  readonly text: string;
}

export default function skillsManager(pi: ExtensionAPI) {
  pi.registerEntryRenderer<ContextAuditEntry>(CONTEXT_AUDIT_ENTRY, (entry) => {
    const lines =
      typeof entry.data?.text === "string" ? entry.data.text.split("\n") : [];
    return { render: () => lines, invalidate() {} };
  });

  let state = new SkillToggleState();
  let cwd = process.cwd();

  const skillsFor = (ctx: ExtensionCommandContext): DiscoveredSkill[] =>
    parseSkills(readSystemPrompt(ctx), { cwd: ctx.cwd });

  pi.on("session_start", (_event, ctx) => {
    cwd = ctx.cwd;
    // A new session starts with a clean session scope; global and project
    // toggles are re-read from disk on demand.
    state = new SkillToggleState({ cwd });
  });

  // The single seam that makes "disabled" real: rewrite the system prompt for
  // the coming turn. Never throws - a filter failure leaves the prompt intact.
  pi.on("before_agent_start", (event) => {
    try {
      const disabled = state.allDisabled();
      if (disabled.size === 0) return;
      const { prompt, removed } = filterSkills(event.systemPrompt, disabled);
      if (removed.length === 0) return;
      return { systemPrompt: prompt };
    } catch {
      return;
    }
  });

  pi.registerCommand("skills", {
    description:
      "Enable or disable individual skills per scope (global / project / session)",
    handler: async (_args, ctx) => {
      const skills = skillsFor(ctx);
      if (skills.length === 0) {
        ctx.ui.notify(
          "No skills are loaded in this session. See docs/skills.md for skill locations.",
          "info",
        );
        return;
      }

      // Select loop: each pick flips one checkbox, then the list redraws.
      for (;;) {
        const disabled = state.allDisabled();
        const { labels, byLabel } = buildRows(skills, disabled);
        const choice = await ctx.ui.select(
          `Skills - ${summarize(skills, disabled)}`,
          labels,
        );
        if (choice === undefined || choice === DONE_LABEL) break;
        const row = byLabel.get(choice);
        if (!row) continue; // a scope header - not selectable
        const nowEnabled = state.toggle(row.name, row.scope);
        ctx.ui.notify(
          `${row.name} ${nowEnabled ? "enabled" : "disabled"} (${row.scope})`,
          "info",
        );
      }

      const disabled = state.allDisabled();
      ctx.ui.notify(summarize(skills, disabled), "info");
    },
  });

  pi.registerCommand("context-audit", {
    description:
      "Show what is filling the context window and warn about contributors over 5k tokens",
    handler: async (_args, ctx) => {
      const usage = (() => {
        try {
          return ctx.getContextUsage();
        } catch {
          return undefined;
        }
      })();

      const report = auditContext({
        systemPrompt: readSystemPrompt(ctx),
        conversationTokens: usage?.tokens ?? null,
        contextWindow: usage?.contextWindow ?? null,
        disabled: state.allDisabled(),
        roots: { cwd: ctx.cwd },
      });

      // Rendered as a custom entry, not a message: an audit of what is
      // filling the context must not itself fill the context.
      pi.appendEntry(CONTEXT_AUDIT_ENTRY, { text: formatAudit(report) });
      if (report.warnings.length > 0) {
        ctx.ui.notify(
          `${report.warnings.length} context contributor(s) over 5k tokens`,
          "warning",
        );
      }
    },
  });
}
