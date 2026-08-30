/**
 * Gain: tokens this harness saved that would otherwise have been paid for.
 *
 * Ported in shape from `packages/stats/src/gain-aggregator.ts` in oh-my-pi
 * (https://github.com/can1357/oh-my-pi), MIT, (c) Can Boluk and Stencil Labs, Inc. Upstream's
 * only source is its own `snapcompact`; this port measures pi's two real
 * savings sources instead:
 *
 * - `compression`: the output-compress extension, which appends one record per
 *   compressed tool output
 * - `compaction`: pi's own context compaction, which appends one record per
 *   compaction event
 *
 * The log is append-only JSONL so a crash costs at most the record being
 * written, and a corrupt line is skipped rather than discarding the file.
 */

import { appendFileSync, mkdirSync, readFileSync } from "node:fs";
import { dirname } from "node:path";
import {
  emptyGainTotals,
  GAIN_SOURCES,
  type GainDashboardStats,
  type GainSource,
  type GainSourceTotals,
  type GainTimeSeriesPoint,
} from "./shared-types.ts";

const CHARS_PER_TOKEN = 4;

export interface GainRecord {
  readonly source: GainSource;
  readonly at: number;
  /** Project folder the saving happened in. */
  readonly folder: string;
  readonly originalBytes: number;
  readonly outputBytes: number;
}

export function isGainSource(value: unknown): value is GainSource {
  return GAIN_SOURCES.includes(value as GainSource);
}

/** Append one record. Best effort: a failed write must never break a turn. */
export function recordGain(logFile: string, record: GainRecord) {
  try {
    mkdirSync(dirname(logFile), { recursive: true });
    appendFileSync(logFile, `${JSON.stringify(record)}\n`, "utf8");
    return true;
  } catch {
    return false;
  }
}

export function readGainLog(logFile: string): GainRecord[] {
  let text: string;
  try {
    text = readFileSync(logFile, "utf8");
  } catch {
    return [];
  }

  const records: GainRecord[] = [];
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    try {
      const parsed: unknown = JSON.parse(line);
      if (!parsed || typeof parsed !== "object") continue;
      const record = parsed as Record<string, unknown>;
      if (!isGainSource(record.source)) continue;
      const at = Number(record.at);
      const originalBytes = Number(record.originalBytes);
      const outputBytes = Number(record.outputBytes);
      if (
        !Number.isFinite(at) ||
        !Number.isFinite(originalBytes) ||
        !Number.isFinite(outputBytes) ||
        originalBytes < 0 ||
        outputBytes < 0
      ) {
        continue;
      }
      records.push({
        source: record.source,
        at,
        folder: typeof record.folder === "string" ? record.folder : "",
        originalBytes,
        outputBytes,
      });
    } catch {
      // One bad line does not invalidate the rest of the log.
    }
  }
  return records;
}

function accumulate(totals: GainSourceTotals, record: GainRecord) {
  // A record where output grew saved nothing; clamping keeps the aggregate
  // honest instead of reporting negative savings.
  const savedBytes = Math.max(0, record.originalBytes - record.outputBytes);
  totals.hits += 1;
  totals.savedBytes += savedBytes;
  totals.savedTokens += Math.round(savedBytes / CHARS_PER_TOKEN);
  totals.outputBytes += record.outputBytes;
  totals.originalBytes += record.originalBytes;
}

function finalize(totals: GainSourceTotals) {
  return {
    ...totals,
    reductionPercent:
      totals.originalBytes > 0
        ? totals.savedBytes / totals.originalBytes
        : null,
  };
}

function dayKey(at: number) {
  return new Date(at).toISOString().slice(0, 10);
}

export interface GainOptions {
  readonly cutoff?: number | null;
  /** Restrict to records whose folder starts with this prefix. */
  readonly project?: string | null;
}

export function aggregateGain(
  records: readonly GainRecord[],
  options: GainOptions = {},
): GainDashboardStats {
  const cutoff = options.cutoff ?? null;
  const project = options.project ?? null;

  const projects = [...new Set(records.map((record) => record.folder))]
    .filter(Boolean)
    .sort();

  const bySource: Record<GainSource, GainSourceTotals> = {
    compression: emptyGainTotals(),
    compaction: emptyGainTotals(),
  };
  const overall = emptyGainTotals();
  const byDay = new Map<string, { compression: number; compaction: number }>();

  for (const record of records) {
    if (cutoff !== null && record.at < cutoff) continue;
    if (project !== null && !record.folder.startsWith(project)) continue;

    accumulate(bySource[record.source], record);
    accumulate(overall, record);

    const key = dayKey(record.at);
    const day = byDay.get(key) ?? { compression: 0, compaction: 0 };
    const savedTokens = Math.round(
      Math.max(0, record.originalBytes - record.outputBytes) / CHARS_PER_TOKEN,
    );
    day[record.source] += savedTokens;
    byDay.set(key, day);
  }

  const timeSeries: GainTimeSeriesPoint[] = [...byDay.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([date, day]) => ({
      date,
      compression: day.compression,
      compaction: day.compaction,
      total: day.compression + day.compaction,
    }));

  return {
    overall: finalize(overall),
    bySource: {
      compression: finalize(bySource.compression),
      compaction: finalize(bySource.compaction),
    },
    timeSeries,
    project,
    projects,
  };
}
