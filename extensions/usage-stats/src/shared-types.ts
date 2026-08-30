/**
 * Shared types for PI Usage Statistics.
 *
 * Ported from `packages/stats/src/shared-types.ts` in oh-my-pi
 * (https://github.com/can1357/oh-my-pi), MIT, (c) Can Boluk and Stencil Labs, Inc.
 * Adapted for pi's session format: `premiumRequests` and `serviceTier` have no
 * pi equivalent and are dropped; `duration`/`ttft` are *derived* from entry
 * timestamps rather than provider-reported, and every field that carries a
 * derived value says so.
 *
 * Kept free of node-only imports so the browser bundle can share it.
 */

export const TIME_RANGES = ["1h", "24h", "7d", "30d", "90d", "all"] as const;
export type TimeRange = (typeof TIME_RANGES)[number];

export function isTimeRange(value: unknown): value is TimeRange {
  return (TIME_RANGES as readonly string[]).includes(value as string);
}

export const HOUR_MS = 60 * 60 * 1_000;
export const DAY_MS = 24 * HOUR_MS;
const FIVE_MIN_MS = 5 * 60 * 1_000;

export interface RangeMeta {
  /** Human label used in chart subtitles. */
  readonly windowLabel: string;
  /** Short prefix for compact column headers. */
  readonly trendLabel: string;
  /** Bucket size matching the server query for this range. */
  readonly bucketMs: number;
  /** Buckets the server returns; 0 means "as many as the data spans". */
  readonly bucketCount: number;
}

export const RANGE_META: Readonly<Record<TimeRange, RangeMeta>> = {
  "1h": {
    windowLabel: "the last hour",
    trendLabel: "1h",
    bucketMs: FIVE_MIN_MS,
    bucketCount: 12,
  },
  "24h": {
    windowLabel: "the last 24 hours",
    trendLabel: "24h",
    bucketMs: HOUR_MS,
    bucketCount: 24,
  },
  "7d": {
    windowLabel: "the last 7 days",
    trendLabel: "7d",
    bucketMs: DAY_MS,
    bucketCount: 7,
  },
  "30d": {
    windowLabel: "the last 30 days",
    trendLabel: "30d",
    bucketMs: DAY_MS,
    bucketCount: 30,
  },
  "90d": {
    windowLabel: "the last 90 days",
    trendLabel: "90d",
    bucketMs: DAY_MS,
    bucketCount: 90,
  },
  all: {
    windowLabel: "all time",
    trendLabel: "all",
    bucketMs: DAY_MS,
    bucketCount: 0,
  },
};

/** Epoch ms cutoff for a range, or `null` for "all". */
export function cutoffFor(range: TimeRange, now: number): number | null {
  switch (range) {
    case "1h":
      return now - HOUR_MS;
    case "24h":
      return now - DAY_MS;
    case "7d":
      return now - 7 * DAY_MS;
    case "30d":
      return now - 30 * DAY_MS;
    case "90d":
      return now - 90 * DAY_MS;
    case "all":
      return null;
  }
}

/** Which agent produced a message, inferred from the session's own metadata. */
export type AgentType = "main" | "subagent";

export interface AggregatedStats {
  totalRequests: number;
  successfulRequests: number;
  failedRequests: number;
  /** 0-1. */
  errorRate: number;
  totalInputTokens: number;
  totalOutputTokens: number;
  totalCacheReadTokens: number;
  totalCacheWriteTokens: number;
  totalReasoningTokens: number;
  /** Share of prompt input served from cache, 0-1. */
  cacheRate: number;
  /**
   * Prompt-input cost saved relative to billing the same tokens uncached
   * (0-1; negative when cache writes cost more than reads save).
   */
  cacheSavings: number;
  totalCost: number;
  /** Requests carrying token usage but no cost - a subscription or free tier. */
  unpricedRequests: number;
  /** Derived from entry timestamps, not provider-reported. */
  avgDuration: number | null;
  avgTokensPerSecond: number | null;
  firstTimestamp: number;
  lastTimestamp: number;
}

export interface ModelStats extends AggregatedStats {
  model: string;
  provider: string;
}

export interface FolderStats extends AggregatedStats {
  folder: string;
}

export interface AgentTypeStats extends AggregatedStats {
  agentType: AgentType;
}

export interface TimeSeriesPoint {
  timestamp: number;
  requests: number;
  errors: number;
  tokens: number;
  cost: number;
}

export interface ModelTimeSeriesPoint {
  timestamp: number;
  model: string;
  provider: string;
  requests: number;
}

export interface ModelPerformancePoint {
  timestamp: number;
  model: string;
  provider: string;
  requests: number;
  avgTokensPerSecond: number | null;
}

export interface CostTimeSeriesPoint {
  timestamp: number;
  model: string;
  provider: string;
  cost: number;
  unpricedRequests: number;
  costInput: number;
  costOutput: number;
  costCacheRead: number;
  costCacheWrite: number;
  requests: number;
}

export interface DashboardStats {
  overall: AggregatedStats;
  byModel: ModelStats[];
  byFolder: FolderStats[];
  byAgentType: AgentTypeStats[];
  timeSeries: TimeSeriesPoint[];
}

// --- behaviour -------------------------------------------------------------

export interface BehaviorOverallStats {
  messages: number;
  chars: number;
  words: number;
  yelling: number;
  profanity: number;
  anguish: number;
  negation: number;
  repetition: number;
  blame: number;
  /** Signals per 100 user messages. */
  frustrationRate: number;
}

export interface BehaviorModelStats extends BehaviorOverallStats {
  model: string;
  provider: string;
}

export interface BehaviorTimeSeriesPoint {
  timestamp: number;
  messages: number;
  yelling: number;
  profanity: number;
  anguish: number;
  negation: number;
  repetition: number;
  blame: number;
}

export interface BehaviorDashboardStats {
  overall: BehaviorOverallStats;
  byModel: BehaviorModelStats[];
  behaviorSeries: BehaviorTimeSeriesPoint[];
}

// --- tools -----------------------------------------------------------------

export interface ToolUsageStats {
  tool: string;
  calls: number;
  errors: number;
  argsChars: number;
  resultChars: number;
  /**
   * Provider usage of the invoking turns, split evenly across that turn's tool
   * calls so the shares stay additive across tools.
   */
  totalTokensShare: number;
  outputTokensShare: number;
  costShare: number;
  lastUsed: number;
}

export interface ToolModelStats extends ToolUsageStats {
  model: string;
  provider: string;
}

export interface ToolTimeSeriesPoint {
  timestamp: number;
  tool: string;
  calls: number;
  errors: number;
}

export interface ToolDashboardStats {
  byTool: ToolUsageStats[];
  byToolModel: ToolModelStats[];
  series: ToolTimeSeriesPoint[];
}

// --- providers -------------------------------------------------------------

export interface ProviderAggregate {
  provider: string;
  totalRequests: number;
  failedRequests: number;
  models: number;
  totalInputTokens: number;
  totalOutputTokens: number;
  totalCacheReadTokens: number;
  totalCacheWriteTokens: number;
  totalTokens: number;
  totalCost: number;
  unpricedRequests: number;
  avgTokensPerSecond: number | null;
}

export interface ProviderHourlyPoint {
  provider: string;
  /** Local hour of day, 0-23. */
  hour: number;
  totalTokens: number;
  outputTokens: number;
  requests: number;
}

export interface ProviderTimeSeriesPoint {
  timestamp: number;
  provider: string;
  totalTokens: number;
  cost: number;
  unpricedRequests: number;
  requests: number;
}

/**
 * A subscription limit window. `reported` limits come from the provider's own
 * usage headers recorded in pi's auth store; `estimated` limits are inferred
 * from observed burn when the provider reports nothing. The distinction is
 * carried all the way to the UI so an estimate is never read as a fact.
 */
export type LimitSource = "reported" | "estimated";

export interface UsageWindowPoint {
  timestamp: number;
  /** Used fraction 0..1 (>1 = overage) when known. */
  usedFraction: number | null;
  exhausted: boolean;
}

export interface UsageWindowSeries {
  provider: string;
  accountKey: string;
  accountLabel: string;
  windowKey: string;
  windowLabel: string;
  source: LimitSource;
  points: UsageWindowPoint[];
}

export interface ProviderWindowInsight {
  provider: string;
  windowKey: string;
  windowLabel: string;
  source: LimitSource;
  accounts: number;
  /** Window resets observed (drops in used fraction). */
  cycles: number;
  /** Window-equivalents consumed in range; 1.0 = one full window burned. */
  fractionConsumed: number;
  /** Tokens one full window buys. Null when too little was consumed to say. */
  estTokensPerWindow: number | null;
  peakConcurrentFraction: number;
  /** max(1, ceil(peakConcurrentFraction / 0.9)). */
  idealAccounts: number;
  exhaustedEvents: number;
}

export interface ProviderDashboardStats {
  providers: ProviderAggregate[];
  hourly: ProviderHourlyPoint[];
  series: ProviderTimeSeriesPoint[];
  usageSeries: UsageWindowSeries[];
  windowInsights: ProviderWindowInsight[];
}

// --- gain ------------------------------------------------------------------

/**
 * Where saved tokens came from. `compression` is the output-compress
 * extension; `compaction` is pi's own context compaction.
 */
export type GainSource = "compression" | "compaction";

export const GAIN_SOURCES: readonly GainSource[] = [
  "compression",
  "compaction",
];

export interface GainSourceTotals {
  savedTokens: number;
  savedBytes: number;
  hits: number;
  outputBytes: number;
  originalBytes: number;
  /** savedBytes / originalBytes, or null when originalBytes is 0. */
  reductionPercent: number | null;
}

export interface GainTimeSeriesPoint {
  date: string;
  compression: number;
  compaction: number;
  total: number;
}

export interface GainDashboardStats {
  overall: GainSourceTotals;
  bySource: Record<GainSource, GainSourceTotals>;
  timeSeries: GainTimeSeriesPoint[];
  /** Active project filter (cwd prefix), or null for all projects. */
  project: string | null;
  projects: string[];
}

// --- requests --------------------------------------------------------------

export interface MessageRow {
  id: number;
  sessionFile: string;
  entryId: string;
  folder: string;
  model: string;
  provider: string;
  api: string;
  timestamp: number;
  /** Derived from the gap to the preceding entry. */
  duration: number | null;
  stopReason: string;
  errorMessage: string | null;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  reasoningTokens: number;
  totalTokens: number;
  costTotal: number;
  agentType: AgentType;
}

export function emptyAggregate(): AggregatedStats {
  return {
    totalRequests: 0,
    successfulRequests: 0,
    failedRequests: 0,
    errorRate: 0,
    totalInputTokens: 0,
    totalOutputTokens: 0,
    totalCacheReadTokens: 0,
    totalCacheWriteTokens: 0,
    totalReasoningTokens: 0,
    cacheRate: 0,
    cacheSavings: 0,
    totalCost: 0,
    unpricedRequests: 0,
    avgDuration: null,
    avgTokensPerSecond: null,
    firstTimestamp: 0,
    lastTimestamp: 0,
  };
}

export function emptyGainTotals(): GainSourceTotals {
  return {
    savedTokens: 0,
    savedBytes: 0,
    hits: 0,
    outputBytes: 0,
    originalBytes: 0,
    reductionPercent: null,
  };
}
