/**
 * One place that assembles every dashboard payload from the database and the
 * side logs. Both the HTTP server and the `usage_stats` tool call through here,
 * so a page and its Markdown equivalent can never disagree.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { StatsDatabase } from "./db.ts";
import { aggregateGain, readGainLog } from "./gain.ts";
import { resolvePaths, type StatsPaths } from "./paths.ts";
import { listSessionFiles, sync, type SyncResult } from "./sync.ts";
import {
  buildUsageSeries,
  buildWindowInsights,
  estimateSnapshots,
  readSnapshots,
  type PlanBudget,
} from "./usage-windows.ts";
import {
  cutoffFor,
  isTimeRange,
  RANGE_META,
  type BehaviorDashboardStats,
  type DashboardStats,
  type GainDashboardStats,
  type MessageRow,
  type ModelPerformancePoint,
  type ModelTimeSeriesPoint,
  type CostTimeSeriesPoint,
  type ProviderDashboardStats,
  type TimeRange,
  type ToolDashboardStats,
} from "./shared-types.ts";

export interface StatsContext {
  readonly db: StatsDatabase;
  readonly paths: StatsPaths;
  readonly now: () => number;
  /** Plan budgets used only to estimate limits a provider does not report. */
  readonly budgets: readonly PlanBudget[];
}

export interface OpenOptions {
  readonly home?: string;
  readonly paths?: StatsPaths;
  readonly now?: () => number;
  readonly budgets?: readonly PlanBudget[];
  /** Drop the index and rebuild from the session logs. */
  readonly rebuild?: boolean;
}

export function openStats(options: OpenOptions = {}): StatsContext {
  const paths = options.paths ?? resolvePaths(options.home);
  const db = options.rebuild
    ? StatsDatabase.rebuild(paths.databaseFile)
    : StatsDatabase.open(paths.databaseFile);
  return {
    db,
    paths,
    now: options.now ?? Date.now,
    budgets: options.budgets ?? readBudgets(paths),
  };
}

/**
 * Plan budgets come from `vraj.usage.budgets` in the agent settings. There is
 * no shipped default: guessing someone's plan would produce a confident wrong
 * number, and the estimated series is simply absent until it is configured.
 */
export function readBudgets(paths: StatsPaths): PlanBudget[] {
  let settings: Record<string, unknown>;
  try {
    const parsed: unknown = JSON.parse(
      readFileSync(join(paths.agentDir, "settings.json"), "utf8"),
    );
    settings =
      parsed && typeof parsed === "object" && !Array.isArray(parsed)
        ? (parsed as Record<string, unknown>)
        : {};
  } catch {
    return [];
  }

  const raw = settings["vraj.usage.budgets"];
  if (!Array.isArray(raw)) return [];
  const budgets: PlanBudget[] = [];
  for (const entry of raw) {
    if (!entry || typeof entry !== "object") continue;
    const budget = entry as Record<string, unknown>;
    const provider = budget.provider;
    const windowMs = Number(budget.windowMs);
    const tokensPerWindow = Number(budget.tokensPerWindow);
    if (
      typeof provider !== "string" ||
      !provider ||
      !Number.isFinite(windowMs) ||
      windowMs <= 0 ||
      !Number.isFinite(tokensPerWindow) ||
      tokensPerWindow <= 0
    ) {
      continue;
    }
    budgets.push({
      provider,
      windowMs,
      tokensPerWindow,
      windowLabel:
        typeof budget.windowLabel === "string" && budget.windowLabel
          ? budget.windowLabel
          : `${Math.round(windowMs / 3_600_000)}h window`,
    });
  }
  return budgets;
}

export function parseRange(
  value: unknown,
  fallback: TimeRange = "7d",
): TimeRange {
  return isTimeRange(value) ? value : fallback;
}

function cutoff(context: StatsContext, range: TimeRange) {
  return cutoffFor(range, context.now());
}

export function runSync(
  context: StatsContext,
  options: { full?: boolean } = {},
): SyncResult {
  return sync(context.db, context.paths.sessionsDir, {
    ...(options.full === undefined ? {} : { full: options.full }),
    now: context.now,
  });
}

export function overview(
  context: StatsContext,
  range: TimeRange,
): DashboardStats {
  const at = cutoff(context, range);
  const meta = RANGE_META[range];
  return {
    overall: context.db.overall(at),
    byModel: context.db.byModel(at),
    byFolder: context.db.byFolder(at),
    byAgentType: context.db.byAgentType(at),
    timeSeries: context.db.timeSeries(at, meta.bucketMs),
  };
}

export function modelDashboard(
  context: StatsContext,
  range: TimeRange,
): {
  byModel: DashboardStats["byModel"];
  usage: ModelTimeSeriesPoint[];
  performance: ModelPerformancePoint[];
} {
  const at = cutoff(context, range);
  const meta = RANGE_META[range];
  return {
    byModel: context.db.byModel(at),
    usage: context.db.modelTimeSeries(at, meta.bucketMs),
    performance: context.db.modelPerformanceSeries(at, meta.bucketMs),
  };
}

export function costs(
  context: StatsContext,
  range: TimeRange,
): { series: CostTimeSeriesPoint[]; byModel: DashboardStats["byModel"] } {
  const at = cutoff(context, range);
  return {
    series: context.db.costTimeSeries(at, RANGE_META[range].bucketMs),
    byModel: context.db.byModel(at),
  };
}

export function behavior(
  context: StatsContext,
  range: TimeRange,
): BehaviorDashboardStats {
  const at = cutoff(context, range);
  return {
    overall: context.db.behaviorOverall(at),
    byModel: context.db.behaviorByModel(at),
    behaviorSeries: context.db.behaviorTimeSeries(
      at,
      RANGE_META[range].bucketMs,
    ),
  };
}

export function tools(
  context: StatsContext,
  range: TimeRange,
): ToolDashboardStats {
  const at = cutoff(context, range);
  return {
    byTool: context.db.toolStats(at),
    byToolModel: context.db.toolStatsByModel(at),
    series: context.db.toolTimeSeries(at, RANGE_META[range].bucketMs),
  };
}

export function providers(
  context: StatsContext,
  range: TimeRange,
): ProviderDashboardStats {
  const at = cutoff(context, range);
  const aggregates = context.db.byProvider(at);
  const tokensByProvider = new Map(
    aggregates.map((entry) => [entry.provider, entry.totalTokens]),
  );

  const reported = readSnapshots(limitsLog(context));
  // Estimation is a fallback, never an override: a provider that reports its
  // own limits is never second-guessed with a guess.
  const reportedProviders = new Set(
    reported.map((snapshot) => snapshot.provider),
  );
  const budgets = context.budgets.filter(
    (budget) => !reportedProviders.has(budget.provider),
  );
  const estimated =
    budgets.length > 0
      ? estimateSnapshots(
          context.db
            .providerTimeSeries(at, RANGE_META[range].bucketMs)
            .map((point) => ({
              provider: point.provider,
              timestamp: point.timestamp,
              totalTokens: point.totalTokens,
            })),
          budgets,
        )
      : [];

  const usageSeries = buildUsageSeries([...reported, ...estimated], at);
  return {
    providers: aggregates,
    hourly: context.db.providerHourlyBurn(at),
    series: context.db.providerTimeSeries(at, RANGE_META[range].bucketMs),
    usageSeries,
    windowInsights: buildWindowInsights(usageSeries, tokensByProvider),
  };
}

export function limitsLog(context: { readonly paths: StatsPaths }) {
  return join(context.paths.agentDir, "usage-limits.jsonl");
}

export function projectsDashboard(context: StatsContext, range: TimeRange) {
  const at = cutoff(context, range);
  return {
    byFolder: context.db.byFolder(at),
    projects: context.db.projects(at),
  };
}

export function requests(
  context: StatsContext,
  range: TimeRange,
  limit = 100,
): MessageRow[] {
  return context.db.recentRequests(limit, cutoff(context, range));
}

export function errors(
  context: StatsContext,
  range: TimeRange,
  limit = 100,
): MessageRow[] {
  return context.db.recentErrors(limit, cutoff(context, range));
}

export function gain(
  context: StatsContext,
  range: TimeRange,
  project: string | null = null,
): GainDashboardStats {
  return aggregateGain(readGainLog(context.paths.gainLog), {
    cutoff: cutoff(context, range),
    project,
  });
}

export interface IndexStatus {
  sessionFiles: number;
  indexedMessages: number;
  databaseFile: string;
  sessionsDir: string;
}

export function status(context: StatsContext): IndexStatus {
  return {
    sessionFiles: listSessionFiles(context.paths.sessionsDir).length,
    indexedMessages: context.db.messageCount(),
    databaseFile: context.paths.databaseFile,
    sessionsDir: context.paths.sessionsDir,
  };
}
