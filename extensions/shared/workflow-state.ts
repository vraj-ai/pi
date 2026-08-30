/**
 * Shared subagent dashboard types.
 *
 * The below-editor widget and the subagent extension publish/consume the same
 * summaries on `SUBAGENT_STATE_CHANNEL`. This is not a workflow/stage bus.
 */

export const SUBAGENT_STATE_CHANNEL = "vraj:subagent-state";

const HERDR_BACKENDS: readonly string[] = [
  "pi",
  "claude",
  "codex",
  "agy",
  "omp",
  "grok",
];

export interface SubagentSummary {
  id: string;
  title: string;
  status: "running" | "done" | "error";
  backend: "pi" | "claude" | "codex" | "agy" | "omp" | "grok";
  startedAt: number;
  modelLabel?: string;
  contextTokens?: number;
  contextWindow?: number;
  turns: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

export function isSubagentSummary(value: unknown): value is SubagentSummary {
  if (!isRecord(value)) return false;
  return (
    typeof value.id === "string" &&
    typeof value.title === "string" &&
    (value.status === "running" ||
      value.status === "done" ||
      value.status === "error") &&
    HERDR_BACKENDS.includes(value.backend as string) &&
    typeof value.startedAt === "number" &&
    Number.isFinite(value.startedAt) &&
    typeof value.turns === "number"
  );
}
