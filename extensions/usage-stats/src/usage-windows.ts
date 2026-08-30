/**
 * Subscription limit windows: how much of a plan a window has burned, what one
 * window is worth in tokens, and how many accounts peak demand would need.
 *
 * Ported from `packages/stats/src/usage-windows.ts` in oh-my-pi
 * (https://github.com/can1357/oh-my-pi), MIT, (c) Can Boluk and Stencil Labs, Inc. Upstream
 * reads limit snapshots out of its own auth store; pi's auth store records no
 * usage headers, so this port has two sources and always says which one a
 * number came from:
 *
 * - `reported`  - parsed from the provider's own rate-limit response headers,
 *                 recorded by this extension as they arrive
 * - `estimated` - inferred from observed token burn against a configured plan
 *                 budget, used only when the provider reports nothing
 *
 * An estimate is never presented as a reported fact. That distinction is the
 * whole point: acting on a fabricated "you have 12% left" is worse than having
 * no number at all.
 */

import { appendFileSync, mkdirSync, readFileSync } from "node:fs";
import { dirname } from "node:path";
import type {
  LimitSource,
  ProviderWindowInsight,
  UsageWindowPoint,
  UsageWindowSeries,
} from "./shared-types.ts";

/** One recorded limit observation. */
export interface LimitSnapshot {
  readonly provider: string;
  readonly accountKey: string;
  readonly accountLabel: string;
  readonly windowKey: string;
  readonly windowLabel: string;
  readonly at: number;
  /** 0..1 used (>1 = overage). */
  readonly usedFraction: number;
  readonly exhausted: boolean;
  readonly source: LimitSource;
}

// --- header parsing --------------------------------------------------------

function header(headers: Record<string, string>, name: string) {
  // Header names arrive with inconsistent casing across providers.
  const wanted = name.toLowerCase();
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() === wanted) return value;
  }
  return undefined;
}

function positiveNumber(value: string | undefined) {
  if (value === undefined) return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : undefined;
}

interface WindowReading {
  windowKey: string;
  windowLabel: string;
  usedFraction: number;
  exhausted: boolean;
}

/**
 * Extract every limit window a response reports. Handles the two shapes in
 * common use:
 *
 * - Anthropic: `anthropic-ratelimit-<unit>-limit` / `-remaining`, plus the
 *   subscription form `anthropic-ratelimit-unified-*` with a `-status`.
 * - OpenAI-style: `x-ratelimit-limit-<unit>` / `x-ratelimit-remaining-<unit>`.
 *
 * Returns an empty array when nothing usable is present, which is the normal
 * case for providers that report no limits at all.
 */
export function parseLimitHeaders(
  headers: Record<string, string>,
): WindowReading[] {
  const readings: WindowReading[] = [];
  if (!headers || typeof headers !== "object") return readings;

  const add = (
    windowKey: string,
    windowLabel: string,
    limit: number | undefined,
    remaining: number | undefined,
    status?: string,
  ) => {
    if (limit === undefined || remaining === undefined || limit <= 0) return;
    const used = Math.max(0, limit - remaining) / limit;
    readings.push({
      windowKey,
      windowLabel,
      usedFraction: used,
      exhausted:
        remaining <= 0 ||
        (status !== undefined && /exhaust|exceed/i.test(status)),
    });
  };

  for (const unit of ["requests", "tokens", "input-tokens", "output-tokens"]) {
    add(
      `anthropic:${unit}`,
      `Anthropic ${unit}`,
      positiveNumber(header(headers, `anthropic-ratelimit-${unit}-limit`)),
      positiveNumber(header(headers, `anthropic-ratelimit-${unit}-remaining`)),
    );
    add(
      `openai:${unit}`,
      `OpenAI ${unit}`,
      positiveNumber(header(headers, `x-ratelimit-limit-${unit}`)),
      positiveNumber(header(headers, `x-ratelimit-remaining-${unit}`)),
    );
  }

  add(
    "anthropic:unified",
    "Anthropic subscription window",
    positiveNumber(header(headers, "anthropic-ratelimit-unified-limit")),
    positiveNumber(header(headers, "anthropic-ratelimit-unified-remaining")),
    header(headers, "anthropic-ratelimit-unified-status"),
  );

  return readings;
}

/** Build snapshots from one response's headers. */
export function snapshotsFromHeaders(options: {
  provider: string;
  accountKey?: string;
  accountLabel?: string;
  headers: Record<string, string>;
  at: number;
}): LimitSnapshot[] {
  const accountKey = options.accountKey ?? options.provider;
  return parseLimitHeaders(options.headers).map((reading) => ({
    provider: options.provider,
    accountKey,
    accountLabel: options.accountLabel ?? accountKey,
    windowKey: reading.windowKey,
    windowLabel: reading.windowLabel,
    at: options.at,
    usedFraction: reading.usedFraction,
    exhausted: reading.exhausted,
    source: "reported" as const,
  }));
}

// --- persistence -----------------------------------------------------------

export function recordSnapshots(
  logFile: string,
  snapshots: readonly LimitSnapshot[],
) {
  if (snapshots.length === 0) return true;
  try {
    mkdirSync(dirname(logFile), { recursive: true });
    appendFileSync(
      logFile,
      `${snapshots.map((snapshot) => JSON.stringify(snapshot)).join("\n")}\n`,
      "utf8",
    );
    return true;
  } catch {
    return false;
  }
}

export function readSnapshots(logFile: string): LimitSnapshot[] {
  let text: string;
  try {
    text = readFileSync(logFile, "utf8");
  } catch {
    return [];
  }
  const snapshots: LimitSnapshot[] = [];
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    try {
      const parsed = JSON.parse(line) as Partial<LimitSnapshot>;
      if (
        typeof parsed.provider !== "string" ||
        typeof parsed.windowKey !== "string" ||
        typeof parsed.at !== "number" ||
        typeof parsed.usedFraction !== "number" ||
        !Number.isFinite(parsed.at) ||
        !Number.isFinite(parsed.usedFraction)
      ) {
        continue;
      }
      snapshots.push({
        provider: parsed.provider,
        accountKey: parsed.accountKey ?? parsed.provider,
        accountLabel:
          parsed.accountLabel ?? parsed.accountKey ?? parsed.provider,
        windowKey: parsed.windowKey,
        windowLabel: parsed.windowLabel ?? parsed.windowKey,
        at: parsed.at,
        usedFraction: parsed.usedFraction,
        exhausted: parsed.exhausted === true,
        source: parsed.source === "estimated" ? "estimated" : "reported",
      });
    } catch {
      // Skip the bad line.
    }
  }
  return snapshots;
}

// --- estimation ------------------------------------------------------------

/** A configured plan budget, used only when a provider reports nothing. */
export interface PlanBudget {
  readonly provider: string;
  readonly windowLabel: string;
  readonly windowMs: number;
  /** Tokens the plan allows per window. */
  readonly tokensPerWindow: number;
}

export interface BurnPoint {
  readonly provider: string;
  readonly timestamp: number;
  readonly totalTokens: number;
}

/**
 * Synthesise snapshots from observed burn: bucket tokens into the plan's window
 * and express each bucket's cumulative burn as a fraction of the budget. Marked
 * `estimated` so no caller can mistake it for the provider's own accounting.
 */
export function estimateSnapshots(
  burn: readonly BurnPoint[],
  budgets: readonly PlanBudget[],
): LimitSnapshot[] {
  const snapshots: LimitSnapshot[] = [];
  for (const budget of budgets) {
    if (budget.tokensPerWindow <= 0 || budget.windowMs <= 0) continue;
    const points = burn
      .filter((point) => point.provider === budget.provider)
      .sort((a, b) => a.timestamp - b.timestamp);
    if (points.length === 0) continue;

    let windowStart =
      Math.floor(points[0].timestamp / budget.windowMs) * budget.windowMs;
    let consumed = 0;
    for (const point of points) {
      const bucket =
        Math.floor(point.timestamp / budget.windowMs) * budget.windowMs;
      if (bucket !== windowStart) {
        windowStart = bucket;
        consumed = 0;
      }
      consumed += point.totalTokens;
      const usedFraction = consumed / budget.tokensPerWindow;
      snapshots.push({
        provider: budget.provider,
        accountKey: `${budget.provider}:estimated`,
        accountLabel: `${budget.provider} (estimated)`,
        windowKey: `estimated:${budget.provider}:${budget.windowMs}`,
        windowLabel: `${budget.windowLabel} (estimated)`,
        at: point.timestamp,
        usedFraction,
        exhausted: usedFraction >= 1,
        source: "estimated",
      });
    }
  }
  return snapshots;
}

// --- aggregation -----------------------------------------------------------

function seriesKey(snapshot: LimitSnapshot) {
  return `${snapshot.provider} ${snapshot.accountKey} ${snapshot.windowKey}`;
}

export function buildUsageSeries(
  snapshots: readonly LimitSnapshot[],
  cutoff: number | null,
): UsageWindowSeries[] {
  const grouped = new Map<
    string,
    UsageWindowSeries & { points: UsageWindowPoint[] }
  >();
  for (const snapshot of snapshots) {
    if (cutoff !== null && snapshot.at < cutoff) continue;
    const key = seriesKey(snapshot);
    let series = grouped.get(key);
    if (!series) {
      series = {
        provider: snapshot.provider,
        accountKey: snapshot.accountKey,
        accountLabel: snapshot.accountLabel,
        windowKey: snapshot.windowKey,
        windowLabel: snapshot.windowLabel,
        source: snapshot.source,
        points: [],
      };
      grouped.set(key, series);
    }
    series.points.push({
      timestamp: snapshot.at,
      usedFraction: snapshot.usedFraction,
      exhausted: snapshot.exhausted,
    });
  }

  for (const series of grouped.values()) {
    series.points.sort((a, b) => a.timestamp - b.timestamp);
  }
  return [...grouped.values()].sort(
    (a, b) =>
      a.provider.localeCompare(b.provider) ||
      a.windowKey.localeCompare(b.windowKey) ||
      a.accountKey.localeCompare(b.accountKey),
  );
}

/**
 * Derive per-window insight. `fractionConsumed` sums positive deltas across
 * accounts, so a window that reset twice counts as two windows burned rather
 * than as a single confusing sawtooth.
 */
export function buildWindowInsights(
  series: readonly UsageWindowSeries[],
  tokensByProvider: ReadonlyMap<string, number>,
): ProviderWindowInsight[] {
  const grouped = new Map<string, UsageWindowSeries[]>();
  for (const one of series) {
    const key = `${one.provider} ${one.windowKey}`;
    grouped.set(key, [...(grouped.get(key) ?? []), one]);
  }

  const insights: ProviderWindowInsight[] = [];
  for (const group of grouped.values()) {
    const first = group[0];
    let fractionConsumed = 0;
    let cycles = 0;
    let exhaustedEvents = 0;

    // Peak concurrency: for each sampled instant, sum the most recent reading
    // from every account, and keep the largest such sum.
    const instants = new Set<number>();
    for (const one of group) {
      for (const point of one.points) instants.add(point.timestamp);
    }

    for (const one of group) {
      let previousFraction: number | undefined;
      let previousExhausted = false;
      for (const point of one.points) {
        const fraction = point.usedFraction ?? 0;
        if (previousFraction !== undefined) {
          const delta = fraction - previousFraction;
          if (delta > 0) fractionConsumed += delta;
          // A drop means the window reset; the pre-reset remainder counts too.
          else if (delta < 0) {
            cycles += 1;
            fractionConsumed += Math.max(0, 1 - previousFraction) + fraction;
          }
        } else {
          fractionConsumed += fraction;
        }
        if (point.exhausted && !previousExhausted) exhaustedEvents += 1;
        previousExhausted = point.exhausted;
        previousFraction = fraction;
      }
    }

    let peakConcurrentFraction = 0;
    for (const instant of [...instants].sort((a, b) => a - b)) {
      let sum = 0;
      for (const one of group) {
        let latest: number | undefined;
        for (const point of one.points) {
          if (point.timestamp > instant) break;
          if (point.usedFraction !== null) latest = point.usedFraction;
        }
        sum += latest ?? 0;
      }
      peakConcurrentFraction = Math.max(peakConcurrentFraction, sum);
    }

    const providerTokens = tokensByProvider.get(first.provider) ?? 0;
    insights.push({
      provider: first.provider,
      windowKey: first.windowKey,
      windowLabel: first.windowLabel,
      source: first.source,
      accounts: new Set(group.map((one) => one.accountKey)).size,
      cycles,
      fractionConsumed,
      // Below a tenth of a window the extrapolation is noise, not an estimate.
      estTokensPerWindow:
        fractionConsumed >= 0.1 && providerTokens > 0
          ? providerTokens / fractionConsumed
          : null,
      peakConcurrentFraction,
      idealAccounts: Math.max(1, Math.ceil(peakConcurrentFraction / 0.9)),
      exhaustedEvents,
    });
  }

  return insights.sort(
    (a, b) =>
      a.provider.localeCompare(b.provider) ||
      a.windowKey.localeCompare(b.windowKey),
  );
}
