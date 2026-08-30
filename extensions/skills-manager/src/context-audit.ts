/**
 * `/context-audit`: what is actually eating the context window, and which
 * single contributor is large enough to be worth acting on.
 *
 * The locked threshold is 5,000 estimated tokens: anything at or above it is
 * flagged with a warning, because at that size it is cheaper to disable or
 * trim the contributor than to keep paying for it every turn.
 */

import { parseSkills, type ScopeRoots } from "./discovery.ts";

export const WARN_TOKENS = 5_000;
const CHARS_PER_TOKEN = 4;

export function estimateTokens(text: string) {
  return typeof text === "string"
    ? Math.ceil(text.length / CHARS_PER_TOKEN)
    : 0;
}

export interface ContextEntry {
  readonly label: string;
  readonly tokens: number;
  readonly detail?: string;
}

export interface AuditInput {
  readonly systemPrompt: string;
  /** Estimated tokens of the conversation so far, from `getContextUsage()`. */
  readonly conversationTokens?: number | null;
  readonly contextWindow?: number | null;
  readonly disabled?: ReadonlySet<string>;
  readonly roots?: ScopeRoots;
}

export interface AuditReport {
  readonly entries: readonly ContextEntry[];
  readonly warnings: readonly ContextEntry[];
  readonly totalTokens: number;
  readonly contextWindow: number | null;
  readonly percent: number | null;
  /** Aggregate only - the per-skill rows already appear in `entries`. */
  readonly skills: {
    readonly total: number;
    readonly enabled: number;
    readonly tokens: number;
  };
}

/**
 * Split the system prompt into the pieces a user can actually do something
 * about: each individual skill description, the skills preamble, and the
 * remaining prompt body.
 */
export function auditContext(input: AuditInput): AuditReport {
  const prompt =
    typeof input.systemPrompt === "string" ? input.systemPrompt : "";
  const skills = parseSkills(prompt, input.roots ?? {});
  const disabled = input.disabled ?? new Set<string>();

  const entries: ContextEntry[] = [];

  let skillsTokens = 0;
  for (const skill of skills) {
    if (disabled.has(skill.name)) continue;
    const tokens = estimateTokens(
      `${skill.name}${skill.description}${skill.location}`,
    );
    skillsTokens += tokens;
    entries.push({
      label: `skill: ${skill.name}`,
      tokens,
      detail: `${skill.scope} · ${skill.location}`,
    });
  }

  const promptTokens = estimateTokens(prompt);
  const bodyTokens = Math.max(0, promptTokens - skillsTokens);
  entries.push({
    label: "system prompt (excluding skills)",
    tokens: bodyTokens,
    detail: "instructions, tool guidelines, AGENTS.md",
  });

  const conversation =
    typeof input.conversationTokens === "number" &&
    Number.isFinite(input.conversationTokens)
      ? Math.max(0, Math.round(input.conversationTokens))
      : 0;
  if (conversation > 0) {
    entries.push({
      label: "conversation so far",
      tokens: conversation,
      detail: "shrink with /compact",
    });
  }

  entries.sort((a, b) => b.tokens - a.tokens);

  const contextWindow =
    typeof input.contextWindow === "number" &&
    Number.isFinite(input.contextWindow) &&
    input.contextWindow > 0
      ? input.contextWindow
      : null;
  const totalTokens = promptTokens + conversation;

  return {
    entries,
    warnings: entries.filter((entry) => entry.tokens > WARN_TOKENS),
    totalTokens,
    contextWindow,
    percent: contextWindow ? (totalTokens / contextWindow) * 100 : null,
    skills: {
      total: skills.length,
      enabled: skills.filter((skill) => !disabled.has(skill.name)).length,
      tokens: skillsTokens,
    },
  };
}

function formatTokens(tokens: number) {
  return tokens >= 1_000 ? `${(tokens / 1_000).toFixed(1)}k` : `${tokens}`;
}

/** Render the report for `ctx.ui.notify` / the transcript. */
export function formatAudit(report: AuditReport) {
  const lines = ["Context audit"];
  const window = report.contextWindow
    ? ` of ${formatTokens(report.contextWindow)} (${Math.round(report.percent ?? 0)}%)`
    : "";
  lines.push(`  total ~${formatTokens(report.totalTokens)} tokens${window}`);
  if (report.skills.total > 0) {
    lines.push(
      `  ${report.skills.enabled}/${report.skills.total} skills enabled, ~${formatTokens(report.skills.tokens)} tokens (toggle with /skills)`,
    );
  }
  lines.push("");

  for (const entry of report.entries) {
    const flag = entry.tokens > WARN_TOKENS ? "  <-- over 5k" : "";
    lines.push(
      `  ${formatTokens(entry.tokens).padStart(6)}  ${entry.label}${flag}`,
    );
    if (entry.detail) lines.push(`          ${entry.detail}`);
  }

  if (report.warnings.length > 0) {
    lines.push("");
    lines.push(
      `Warning: ${report.warnings.length} contributor${report.warnings.length === 1 ? "" : "s"} over ${WARN_TOKENS} tokens:`,
    );
    for (const warning of report.warnings) {
      lines.push(`  - ${warning.label} (~${formatTokens(warning.tokens)})`);
    }
  }

  return lines.join("\n");
}
