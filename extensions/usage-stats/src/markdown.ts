/**
 * Markdown rendering of every dashboard page, for the `usage_stats` tool and
 * `/usage summary`.
 *
 * Tables are the point: a model reading this needs to compare rows, and a
 * Markdown table is the densest honest format for that. Every number that is
 * derived or estimated says so inline, because the reader cannot see the
 * footnote a dashboard would have.
 */

import type {
  AggregatedStats,
  BehaviorDashboardStats,
  DashboardStats,
  GainDashboardStats,
  MessageRow,
  ProviderDashboardStats,
  TimeRange,
  ToolDashboardStats,
} from "./shared-types.ts";
import { RANGE_META } from "./shared-types.ts";
import { projectLabel } from "./paths.ts";

export function formatTokens(tokens: number) {
  if (!Number.isFinite(tokens)) return "0";
  const rounded = Math.round(tokens);
  if (Math.abs(rounded) < 1_000) return `${rounded}`;
  if (Math.abs(rounded) < 1_000_000) return `${(rounded / 1_000).toFixed(1)}k`;
  return `${(rounded / 1_000_000).toFixed(2)}M`;
}

export function formatCost(cost: number) {
  if (!Number.isFinite(cost)) return "$0.00";
  return cost > 0 && cost < 0.01 ? "<$0.01" : `$${cost.toFixed(2)}`;
}

export function formatPercent(fraction: number | null) {
  if (fraction === null || !Number.isFinite(fraction)) return "n/a";
  return `${(fraction * 100).toFixed(1)}%`;
}

function formatMs(ms: number | null) {
  if (ms === null || !Number.isFinite(ms)) return "n/a";
  return ms >= 1_000 ? `${(ms / 1_000).toFixed(1)}s` : `${Math.round(ms)}ms`;
}

function formatRate(rate: number | null) {
  return rate === null || !Number.isFinite(rate)
    ? "n/a"
    : `${rate.toFixed(1)} tok/s`;
}

function table(
  headers: readonly string[],
  rows: readonly (readonly string[])[],
) {
  if (rows.length === 0) return "_no data in range_";
  return [
    `| ${headers.join(" | ")} |`,
    `| ${headers.map(() => "---").join(" | ")} |`,
    ...rows.map((row) => `| ${row.join(" | ")} |`),
  ].join("\n");
}

function heading(range: TimeRange) {
  return `PI Usage Statistics - ${RANGE_META[range].windowLabel}`;
}

export function renderOverall(stats: AggregatedStats) {
  return [
    `- requests: ${stats.totalRequests} (${stats.failedRequests} failed, ${formatPercent(stats.errorRate)} error rate)`,
    `- tokens: ${formatTokens(stats.totalInputTokens)} in, ${formatTokens(stats.totalOutputTokens)} out, ` +
      `${formatTokens(stats.totalCacheReadTokens)} cache read, ${formatTokens(stats.totalCacheWriteTokens)} cache write, ` +
      `${formatTokens(stats.totalReasoningTokens)} reasoning`,
    `- cache: ${formatPercent(stats.cacheRate)} of prompt input served from cache, ${formatPercent(stats.cacheSavings)} prompt cost saved`,
    `- cost: ${formatCost(stats.totalCost)}` +
      (stats.unpricedRequests > 0
        ? ` (${stats.unpricedRequests} requests carried tokens but no price - subscription or free tier)`
        : ""),
    `- latency: ${formatMs(stats.avgDuration)} average, ${formatRate(stats.avgTokensPerSecond)} (derived from entry timestamps, includes local tool time)`,
  ].join("\n");
}

export function renderOverview(stats: DashboardStats, range: TimeRange) {
  const sections = [
    `# ${heading(range)}`,
    "",
    "## Overall",
    renderOverall(stats.overall),
    "",
  ];

  sections.push("## By model", "");
  sections.push(
    table(
      ["model", "provider", "requests", "errors", "tokens", "cost", "tok/s"],
      stats.byModel
        .slice(0, 20)
        .map((model) => [
          model.model,
          model.provider,
          `${model.totalRequests}`,
          `${model.failedRequests}`,
          formatTokens(
            model.totalInputTokens +
              model.totalOutputTokens +
              model.totalCacheReadTokens +
              model.totalCacheWriteTokens,
          ),
          formatCost(model.totalCost),
          formatRate(model.avgTokensPerSecond),
        ]),
    ),
    "",
  );

  sections.push("## By project", "");
  sections.push(
    table(
      ["project", "requests", "tokens", "cost"],
      stats.byFolder
        .slice(0, 20)
        .map((folder) => [
          projectLabel(folder.folder),
          `${folder.totalRequests}`,
          formatTokens(folder.totalOutputTokens + folder.totalInputTokens),
          formatCost(folder.totalCost),
        ]),
    ),
    "",
  );

  sections.push("## By agent", "");
  sections.push(
    table(
      ["agent", "requests", "tokens", "cost"],
      stats.byAgentType.map((agent) => [
        agent.agentType,
        `${agent.totalRequests}`,
        formatTokens(agent.totalInputTokens + agent.totalOutputTokens),
        formatCost(agent.totalCost),
      ]),
    ),
  );

  return sections.join("\n");
}

export function renderTools(stats: ToolDashboardStats, range: TimeRange) {
  return [
    `# ${heading(range)}: tools`,
    "",
    "Token and cost columns are the invoking turn's real usage split evenly",
    "across that turn's tool calls, so the shares sum back to the turn total.",
    "",
    table(
      [
        "tool",
        "calls",
        "errors",
        "args chars",
        "result chars",
        "token share",
        "cost share",
      ],
      stats.byTool
        .slice(0, 30)
        .map((tool) => [
          tool.tool,
          `${tool.calls}`,
          `${tool.errors}`,
          formatTokens(tool.argsChars),
          formatTokens(tool.resultChars),
          formatTokens(tool.totalTokensShare),
          formatCost(tool.costShare),
        ]),
    ),
  ].join("\n");
}

export function renderProviders(
  stats: ProviderDashboardStats,
  range: TimeRange,
) {
  const sections = [
    `# ${heading(range)}: providers`,
    "",
    table(
      ["provider", "requests", "failed", "models", "tokens", "cost", "tok/s"],
      stats.providers.map((provider) => [
        provider.provider,
        `${provider.totalRequests}`,
        `${provider.failedRequests}`,
        `${provider.models}`,
        formatTokens(provider.totalTokens),
        formatCost(provider.totalCost),
        formatRate(provider.avgTokensPerSecond),
      ]),
    ),
    "",
    "## Subscription limits",
    "",
  ];

  if (stats.windowInsights.length === 0) {
    sections.push(
      "_No limit data. Providers that send rate-limit headers are recorded automatically;_",
      "_for the rest, configure `vraj.usage.budgets` to get an estimated series._",
    );
  } else {
    sections.push(
      table(
        [
          "provider",
          "window",
          "source",
          "accounts",
          "windows burned",
          "est tokens/window",
          "peak concurrent",
          "ideal accounts",
          "exhausted",
        ],
        stats.windowInsights.map((insight) => [
          insight.provider,
          insight.windowLabel,
          insight.source,
          `${insight.accounts}`,
          insight.fractionConsumed.toFixed(2),
          insight.estTokensPerWindow === null
            ? "n/a"
            : formatTokens(insight.estTokensPerWindow),
          formatPercent(insight.peakConcurrentFraction),
          `${insight.idealAccounts}`,
          `${insight.exhaustedEvents}`,
        ]),
      ),
      "",
      "`reported` rows come from the provider's own rate-limit headers.",
      "`estimated` rows are inferred from observed burn against a configured budget.",
    );
  }

  return sections.join("\n");
}

export function renderBehavior(
  stats: BehaviorDashboardStats,
  range: TimeRange,
) {
  const overall = stats.overall;
  return [
    `# ${heading(range)}: behaviour`,
    "",
    `- user messages: ${overall.messages} (${formatTokens(overall.words)} words, ${formatTokens(overall.chars)} chars)`,
    `- frustration signals per 100 messages: ${overall.frustrationRate.toFixed(1)}`,
    `- breakdown: ${overall.yelling} yelling, ${overall.profanity} profanity, ${overall.anguish} anguish, ` +
      `${overall.negation} negation, ${overall.repetition} repetition, ${overall.blame} blame`,
    "",
    "## By model",
    "",
    table(
      ["model", "messages", "signals/100", "negation", "repetition", "blame"],
      stats.byModel
        .slice(0, 20)
        .map((model) => [
          model.model,
          `${model.messages}`,
          model.frustrationRate.toFixed(1),
          `${model.negation}`,
          `${model.repetition}`,
          `${model.blame}`,
        ]),
    ),
  ].join("\n");
}

export function renderGain(stats: GainDashboardStats, range: TimeRange) {
  const overall = stats.overall;
  return [
    `# ${heading(range)}: gain`,
    "",
    `Tokens saved that would otherwise have been sent: **${formatTokens(overall.savedTokens)}**`,
    `across ${overall.hits} events, ${formatPercent(overall.reductionPercent)} smaller than the originals.`,
    "",
    table(
      [
        "source",
        "events",
        "saved tokens",
        "original bytes",
        "kept bytes",
        "reduction",
      ],
      (["compression", "compaction"] as const).map((source) => {
        const totals = stats.bySource[source];
        return [
          source,
          `${totals.hits}`,
          formatTokens(totals.savedTokens),
          formatTokens(totals.originalBytes),
          formatTokens(totals.outputBytes),
          formatPercent(totals.reductionPercent),
        ];
      }),
    ),
  ].join("\n");
}

export function renderRequests(
  rows: readonly MessageRow[],
  range: TimeRange,
  title = "requests",
) {
  return [
    `# ${heading(range)}: ${title}`,
    "",
    table(
      ["when", "model", "stop", "tokens", "cost", "latency", "error"],
      rows
        .slice(0, 50)
        .map((row) => [
          new Date(row.timestamp).toISOString().replace("T", " ").slice(0, 19),
          row.model,
          row.stopReason,
          formatTokens(row.totalTokens),
          formatCost(row.costTotal),
          formatMs(row.duration),
          (row.errorMessage ?? "").replace(/\|/g, "/").slice(0, 80),
        ]),
    ),
  ].join("\n");
}

export function renderCosts(
  stats: { byModel: DashboardStats["byModel"] },
  range: TimeRange,
) {
  const total = stats.byModel.reduce((sum, model) => sum + model.totalCost, 0);
  return [
    `# ${heading(range)}: costs`,
    "",
    `Total: **${formatCost(total)}**`,
    "",
    table(
      ["model", "provider", "cost", "share", "requests", "unpriced"],
      stats.byModel
        .slice(0, 25)
        .map((model) => [
          model.model,
          model.provider,
          formatCost(model.totalCost),
          total > 0 ? formatPercent(model.totalCost / total) : "n/a",
          `${model.totalRequests}`,
          `${model.unpricedRequests}`,
        ]),
    ),
  ].join("\n");
}

export function renderProjects(
  stats: { byFolder: DashboardStats["byFolder"] },
  range: TimeRange,
) {
  return [
    `# ${heading(range)}: projects`,
    "",
    table(
      ["project", "requests", "errors", "tokens", "cost"],
      stats.byFolder
        .slice(0, 30)
        .map((folder) => [
          folder.folder,
          `${folder.totalRequests}`,
          `${folder.failedRequests}`,
          formatTokens(folder.totalInputTokens + folder.totalOutputTokens),
          formatCost(folder.totalCost),
        ]),
    ),
  ].join("\n");
}
