/**
 * The rebuildable SQLite index behind PI Usage Statistics.
 *
 * Ported from `packages/stats/src/db.ts` in oh-my-pi
 * (https://github.com/can1357/oh-my-pi), MIT, (c) Can Boluk and Stencil Labs, Inc. The schema
 * and the aggregate queries follow upstream; the storage engine is node's
 * built-in `node:sqlite` rather than `bun:sqlite`, and the columns match pi's
 * usage shape (reasoning tokens in, premium requests and service tiers out).
 *
 * The database is a derived cache of the JSONL session logs. Nothing in it is
 * authoritative, `rebuild()` drops and re-indexes from scratch, and a schema
 * bump simply forces one.
 */

import { mkdirSync, rmSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type {
  AgentType,
  AgentTypeStats,
  AggregatedStats,
  BehaviorModelStats,
  BehaviorOverallStats,
  BehaviorTimeSeriesPoint,
  CostTimeSeriesPoint,
  FolderStats,
  MessageRow,
  ModelPerformancePoint,
  ModelStats,
  ModelTimeSeriesPoint,
  ProviderAggregate,
  ProviderHourlyPoint,
  ProviderTimeSeriesPoint,
  TimeSeriesPoint,
  ToolModelStats,
  ToolTimeSeriesPoint,
  ToolUsageStats,
} from "./shared-types.ts";
import type {
  ParsedMessage,
  ParsedToolCall,
  ParsedToolResult,
  ParsedUserMessage,
} from "./parser.ts";

/** Bumping this forces a full rebuild on next open. */
export const SCHEMA_VERSION = 1;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_file TEXT NOT NULL,
  entry_id TEXT NOT NULL,
  folder TEXT NOT NULL,
  model TEXT NOT NULL,
  provider TEXT NOT NULL,
  api TEXT NOT NULL,
  timestamp INTEGER NOT NULL,
  duration INTEGER,
  stop_reason TEXT NOT NULL,
  error_message TEXT,
  input_tokens INTEGER NOT NULL,
  output_tokens INTEGER NOT NULL,
  cache_read_tokens INTEGER NOT NULL,
  cache_write_tokens INTEGER NOT NULL,
  reasoning_tokens INTEGER NOT NULL,
  total_tokens INTEGER NOT NULL,
  cost_input REAL NOT NULL,
  cost_output REAL NOT NULL,
  cost_cache_read REAL NOT NULL,
  cost_cache_write REAL NOT NULL,
  cost_total REAL NOT NULL,
  agent_type TEXT NOT NULL DEFAULT 'main',
  UNIQUE(session_file, entry_id)
);
CREATE INDEX IF NOT EXISTS idx_messages_timestamp ON messages(timestamp);
CREATE INDEX IF NOT EXISTS idx_messages_model ON messages(model);
CREATE INDEX IF NOT EXISTS idx_messages_folder ON messages(folder);
CREATE INDEX IF NOT EXISTS idx_messages_session ON messages(session_file);
CREATE INDEX IF NOT EXISTS idx_messages_ts_model_provider ON messages(timestamp, model, provider);
CREATE INDEX IF NOT EXISTS idx_messages_stop_reason_ts ON messages(stop_reason, timestamp);

CREATE TABLE IF NOT EXISTS file_offsets (
  session_file TEXT PRIMARY KEY,
  offset INTEGER NOT NULL,
  last_modified INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS user_messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_file TEXT NOT NULL,
  entry_id TEXT NOT NULL,
  folder TEXT NOT NULL,
  timestamp INTEGER NOT NULL,
  model TEXT,
  provider TEXT,
  chars INTEGER NOT NULL,
  words INTEGER NOT NULL,
  yelling INTEGER NOT NULL,
  profanity INTEGER NOT NULL,
  anguish INTEGER NOT NULL,
  negation INTEGER NOT NULL DEFAULT 0,
  repetition INTEGER NOT NULL DEFAULT 0,
  blame INTEGER NOT NULL DEFAULT 0,
  UNIQUE(session_file, entry_id)
);
CREATE INDEX IF NOT EXISTS idx_user_messages_timestamp ON user_messages(timestamp);

CREATE TABLE IF NOT EXISTS tool_calls (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_file TEXT NOT NULL,
  entry_id TEXT NOT NULL,
  tool_call_id TEXT NOT NULL,
  folder TEXT NOT NULL,
  tool_name TEXT NOT NULL,
  model TEXT NOT NULL,
  provider TEXT NOT NULL,
  timestamp INTEGER NOT NULL,
  agent_type TEXT NOT NULL DEFAULT 'main',
  calls_in_turn INTEGER NOT NULL DEFAULT 1,
  args_chars INTEGER NOT NULL DEFAULT 0,
  result_chars INTEGER,
  is_error INTEGER,
  UNIQUE(session_file, tool_call_id)
);
CREATE INDEX IF NOT EXISTS idx_tool_calls_timestamp ON tool_calls(timestamp);
CREATE INDEX IF NOT EXISTS idx_tool_calls_tool_timestamp ON tool_calls(tool_name, timestamp);

CREATE TABLE IF NOT EXISTS meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
`;

/** Cost of the prompt input if none of it had been cached. */
const UNCACHED_PROMPT_COST = `
  (CASE WHEN input_tokens > 0
        THEN (cost_input / input_tokens) * (input_tokens + cache_read_tokens + cache_write_tokens)
        ELSE cost_input + cost_cache_read + cost_cache_write END)
`;

function whereRange(cutoff: number | null, alias = "") {
  const column = alias ? `${alias}.timestamp` : "timestamp";
  return cutoff === null ? "" : ` WHERE ${column} >= ${Math.floor(cutoff)}`;
}

function andRange(cutoff: number | null, alias = "") {
  const column = alias ? `${alias}.timestamp` : "timestamp";
  return cutoff === null ? "" : ` AND ${column} >= ${Math.floor(cutoff)}`;
}

type Row = Record<string, unknown>;

function num(value: unknown) {
  return typeof value === "number" && Number.isFinite(value)
    ? value
    : typeof value === "bigint"
      ? Number(value)
      : 0;
}

function str(value: unknown, fallback = "") {
  return typeof value === "string" ? value : fallback;
}

/** Shared SELECT list for anything shaped like {@link AggregatedStats}. */
const AGGREGATE_COLUMNS = `
  COUNT(*) AS total_requests,
  SUM(CASE WHEN stop_reason = 'error' THEN 0 ELSE 1 END) AS successful_requests,
  SUM(CASE WHEN stop_reason = 'error' THEN 1 ELSE 0 END) AS failed_requests,
  SUM(input_tokens) AS input_tokens,
  SUM(output_tokens) AS output_tokens,
  SUM(cache_read_tokens) AS cache_read_tokens,
  SUM(cache_write_tokens) AS cache_write_tokens,
  SUM(reasoning_tokens) AS reasoning_tokens,
  SUM(cost_total) AS cost_total,
  SUM(cost_input + cost_cache_read + cost_cache_write) AS prompt_cost,
  SUM(${UNCACHED_PROMPT_COST}) AS uncached_prompt_cost,
  SUM(CASE WHEN total_tokens > 0 AND cost_total = 0 AND stop_reason != 'error' THEN 1 ELSE 0 END) AS unpriced_requests,
  AVG(duration) AS avg_duration,
  SUM(CASE WHEN duration > 0 THEN output_tokens ELSE 0 END) AS timed_output_tokens,
  SUM(CASE WHEN duration > 0 THEN duration ELSE 0 END) AS timed_duration,
  MIN(timestamp) AS first_timestamp,
  MAX(timestamp) AS last_timestamp
`;

function toAggregate(row: Row | undefined): AggregatedStats {
  const total = num(row?.total_requests);
  const input = num(row?.input_tokens);
  const cacheRead = num(row?.cache_read_tokens);
  const promptCost = num(row?.prompt_cost);
  const uncached = num(row?.uncached_prompt_cost);
  const timedDuration = num(row?.timed_duration);
  const timedOutput = num(row?.timed_output_tokens);
  const promptInput = input + cacheRead;

  return {
    totalRequests: total,
    successfulRequests: num(row?.successful_requests),
    failedRequests: num(row?.failed_requests),
    errorRate: total > 0 ? num(row?.failed_requests) / total : 0,
    totalInputTokens: input,
    totalOutputTokens: num(row?.output_tokens),
    totalCacheReadTokens: cacheRead,
    totalCacheWriteTokens: num(row?.cache_write_tokens),
    totalReasoningTokens: num(row?.reasoning_tokens),
    cacheRate: promptInput > 0 ? cacheRead / promptInput : 0,
    cacheSavings: uncached > 0 ? (uncached - promptCost) / uncached : 0,
    totalCost: num(row?.cost_total),
    unpricedRequests: num(row?.unpriced_requests),
    avgDuration: row?.avg_duration === null ? null : num(row?.avg_duration),
    avgTokensPerSecond:
      timedDuration > 0 ? timedOutput / (timedDuration / 1_000) : null,
    firstTimestamp: num(row?.first_timestamp),
    lastTimestamp: num(row?.last_timestamp),
  };
}

export interface SyncCounts {
  messages: number;
  userMessages: number;
  toolCalls: number;
  toolResults: number;
}

export class StatsDatabase {
  readonly #db: DatabaseSync;
  readonly #file: string;

  private constructor(db: DatabaseSync, file: string) {
    this.#db = db;
    this.#file = file;
  }

  /**
   * Open (creating if needed). A schema-version mismatch rebuilds rather than
   * migrating: the whole index is derived from files still on disk, so a
   * rebuild is cheaper and safer than a migration path per version.
   */
  static open(file: string): StatsDatabase {
    if (file !== ":memory:") mkdirSync(dirname(file), { recursive: true });
    let db = new DatabaseSync(file);
    db.exec("PRAGMA journal_mode = WAL");
    db.exec(SCHEMA);

    const version = db
      .prepare("SELECT value FROM meta WHERE key = 'schema_version'")
      .get() as Row | undefined;
    const current = version ? Number(str(version.value, "0")) : 0;
    if (current !== SCHEMA_VERSION) {
      db.close();
      if (file !== ":memory:") {
        for (const suffix of ["", "-wal", "-shm"]) {
          rmSync(`${file}${suffix}`, { force: true });
        }
      }
      db = new DatabaseSync(file);
      db.exec("PRAGMA journal_mode = WAL");
      db.exec(SCHEMA);
    }
    db.prepare(
      "INSERT OR REPLACE INTO meta (key, value) VALUES ('schema_version', ?)",
    ).run(String(SCHEMA_VERSION));
    return new StatsDatabase(db, file);
  }

  close() {
    try {
      this.#db.close();
    } catch {
      // Already closed.
    }
  }

  /** Drop everything and start over. Session logs are untouched. */
  static rebuild(file: string): StatsDatabase {
    if (file !== ":memory:") {
      for (const suffix of ["", "-wal", "-shm"]) {
        rmSync(`${file}${suffix}`, { force: true });
      }
    }
    return StatsDatabase.open(file);
  }

  get file() {
    return this.#file;
  }

  // --- incremental indexing ------------------------------------------------

  getOffset(sessionFile: string) {
    const row = this.#db
      .prepare(
        "SELECT offset, last_modified FROM file_offsets WHERE session_file = ?",
      )
      .get(sessionFile) as Row | undefined;
    return row
      ? { offset: num(row.offset), lastModified: num(row.last_modified) }
      : null;
  }

  setOffset(sessionFile: string, offset: number, lastModified: number) {
    this.#db
      .prepare(
        "INSERT OR REPLACE INTO file_offsets (session_file, offset, last_modified) VALUES (?, ?, ?)",
      )
      .run(sessionFile, Math.floor(offset), Math.floor(lastModified));
  }

  /**
   * Insert one file's parsed rows in a single transaction, so a crash mid-file
   * never leaves the offset ahead of the rows it claims to cover.
   */
  insert(parsed: {
    messages: readonly ParsedMessage[];
    userMessages: readonly ParsedUserMessage[];
    toolCalls: readonly ParsedToolCall[];
    toolResults: readonly ParsedToolResult[];
  }): SyncCounts {
    const counts: SyncCounts = {
      messages: 0,
      userMessages: 0,
      toolCalls: 0,
      toolResults: 0,
    };

    const insertMessage = this.#db.prepare(`
      INSERT OR IGNORE INTO messages (
        session_file, entry_id, folder, model, provider, api, timestamp,
        duration, stop_reason, error_message,
        input_tokens, output_tokens, cache_read_tokens, cache_write_tokens,
        reasoning_tokens, total_tokens,
        cost_input, cost_output, cost_cache_read, cost_cache_write, cost_total,
        agent_type
      ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
    `);
    const insertUser = this.#db.prepare(`
      INSERT OR IGNORE INTO user_messages (
        session_file, entry_id, folder, timestamp, model, provider,
        chars, words, yelling, profanity, anguish, negation, repetition, blame
      ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)
    `);
    // A later pass may learn which model answered a user message parsed
    // earlier, so an existing NULL link is filled in rather than left unknown.
    const linkUser = this.#db.prepare(`
      UPDATE user_messages SET model = ?, provider = ?
      WHERE session_file = ? AND entry_id = ? AND model IS NULL
    `);
    const insertTool = this.#db.prepare(`
      INSERT OR IGNORE INTO tool_calls (
        session_file, entry_id, tool_call_id, folder, tool_name, model,
        provider, timestamp, agent_type, calls_in_turn, args_chars
      ) VALUES (?,?,?,?,?,?,?,?,?,?,?)
    `);
    const linkResult = this.#db.prepare(`
      UPDATE tool_calls SET result_chars = ?, is_error = ?
      WHERE session_file = ? AND tool_call_id = ?
    `);

    this.#db.exec("BEGIN");
    try {
      for (const message of parsed.messages) {
        const result = insertMessage.run(
          message.sessionFile,
          message.entryId,
          message.folder,
          message.model,
          message.provider,
          message.api,
          Math.floor(message.timestamp),
          message.durationMs === null ? null : Math.floor(message.durationMs),
          message.stopReason,
          message.errorMessage,
          message.inputTokens,
          message.outputTokens,
          message.cacheReadTokens,
          message.cacheWriteTokens,
          message.reasoningTokens,
          message.totalTokens,
          message.costInput,
          message.costOutput,
          message.costCacheRead,
          message.costCacheWrite,
          message.costTotal,
          message.agentType,
        );
        counts.messages += Number(result.changes);
      }

      for (const user of parsed.userMessages) {
        const result = insertUser.run(
          user.sessionFile,
          user.entryId,
          user.folder,
          Math.floor(user.timestamp),
          user.model,
          user.provider,
          user.chars,
          user.words,
          user.yelling,
          user.profanity,
          user.anguish,
          user.negation,
          user.repetition,
          user.blame,
        );
        counts.userMessages += Number(result.changes);
        if (user.model) {
          linkUser.run(
            user.model,
            user.provider,
            user.sessionFile,
            user.entryId,
          );
        }
      }

      for (const call of parsed.toolCalls) {
        const result = insertTool.run(
          call.sessionFile,
          call.entryId,
          call.toolCallId,
          call.folder,
          call.toolName,
          call.model,
          call.provider,
          Math.floor(call.timestamp),
          call.agentType,
          call.callsInTurn,
          call.argsChars,
        );
        counts.toolCalls += Number(result.changes);
      }

      for (const link of parsed.toolResults) {
        const result = linkResult.run(
          link.resultChars,
          link.isError ? 1 : 0,
          link.sessionFile,
          link.toolCallId,
        );
        counts.toolResults += Number(result.changes);
      }
      this.#db.exec("COMMIT");
    } catch (error) {
      this.#db.exec("ROLLBACK");
      throw error;
    }
    return counts;
  }

  messageCount() {
    const row = this.#db
      .prepare("SELECT COUNT(*) AS n FROM messages")
      .get() as Row;
    return num(row.n);
  }

  // --- overview ------------------------------------------------------------

  overall(cutoff: number | null): AggregatedStats {
    const row = this.#db
      .prepare(`SELECT ${AGGREGATE_COLUMNS} FROM messages${whereRange(cutoff)}`)
      .get() as Row | undefined;
    return toAggregate(row);
  }

  byModel(cutoff: number | null): ModelStats[] {
    const rows = this.#db
      .prepare(
        `SELECT model, provider, ${AGGREGATE_COLUMNS} FROM messages${whereRange(cutoff)}
         GROUP BY model, provider ORDER BY cost_total DESC, total_requests DESC`,
      )
      .all() as Row[];
    return rows.map((row) => ({
      model: str(row.model, "unknown"),
      provider: str(row.provider, "unknown"),
      ...toAggregate(row),
    }));
  }

  byFolder(cutoff: number | null): FolderStats[] {
    const rows = this.#db
      .prepare(
        `SELECT folder, ${AGGREGATE_COLUMNS} FROM messages${whereRange(cutoff)}
         GROUP BY folder ORDER BY cost_total DESC, total_requests DESC`,
      )
      .all() as Row[];
    return rows.map((row) => ({
      folder: str(row.folder, "unknown"),
      ...toAggregate(row),
    }));
  }

  byAgentType(cutoff: number | null): AgentTypeStats[] {
    const rows = this.#db
      .prepare(
        `SELECT agent_type, ${AGGREGATE_COLUMNS} FROM messages${whereRange(cutoff)}
         GROUP BY agent_type ORDER BY total_requests DESC`,
      )
      .all() as Row[];
    return rows.map((row) => ({
      agentType: (str(row.agent_type, "main") as AgentType) ?? "main",
      ...toAggregate(row),
    }));
  }

  timeSeries(cutoff: number | null, bucketMs: number): TimeSeriesPoint[] {
    const bucket = Math.max(1, Math.floor(bucketMs));
    const rows = this.#db
      .prepare(
        `SELECT (timestamp / ${bucket}) * ${bucket} AS bucket,
                COUNT(*) AS requests,
                SUM(CASE WHEN stop_reason = 'error' THEN 1 ELSE 0 END) AS errors,
                SUM(total_tokens) AS tokens,
                SUM(cost_total) AS cost
         FROM messages${whereRange(cutoff)}
         GROUP BY bucket ORDER BY bucket`,
      )
      .all() as Row[];
    return rows.map((row) => ({
      timestamp: num(row.bucket),
      requests: num(row.requests),
      errors: num(row.errors),
      tokens: num(row.tokens),
      cost: num(row.cost),
    }));
  }

  modelTimeSeries(
    cutoff: number | null,
    bucketMs: number,
  ): ModelTimeSeriesPoint[] {
    const bucket = Math.max(1, Math.floor(bucketMs));
    const rows = this.#db
      .prepare(
        `SELECT (timestamp / ${bucket}) * ${bucket} AS bucket, model, provider,
                COUNT(*) AS requests
         FROM messages${whereRange(cutoff)}
         GROUP BY bucket, model, provider ORDER BY bucket`,
      )
      .all() as Row[];
    return rows.map((row) => ({
      timestamp: num(row.bucket),
      model: str(row.model, "unknown"),
      provider: str(row.provider, "unknown"),
      requests: num(row.requests),
    }));
  }

  modelPerformanceSeries(
    cutoff: number | null,
    bucketMs: number,
  ): ModelPerformancePoint[] {
    const bucket = Math.max(1, Math.floor(bucketMs));
    const rows = this.#db
      .prepare(
        `SELECT (timestamp / ${bucket}) * ${bucket} AS bucket, model, provider,
                COUNT(*) AS requests,
                SUM(CASE WHEN duration > 0 THEN output_tokens ELSE 0 END) AS timed_output,
                SUM(CASE WHEN duration > 0 THEN duration ELSE 0 END) AS timed_duration
         FROM messages${whereRange(cutoff)}
         GROUP BY bucket, model, provider ORDER BY bucket`,
      )
      .all() as Row[];
    return rows.map((row) => {
      const duration = num(row.timed_duration);
      return {
        timestamp: num(row.bucket),
        model: str(row.model, "unknown"),
        provider: str(row.provider, "unknown"),
        requests: num(row.requests),
        avgTokensPerSecond:
          duration > 0 ? num(row.timed_output) / (duration / 1_000) : null,
      };
    });
  }

  costTimeSeries(
    cutoff: number | null,
    bucketMs: number,
  ): CostTimeSeriesPoint[] {
    const bucket = Math.max(1, Math.floor(bucketMs));
    const rows = this.#db
      .prepare(
        `SELECT (timestamp / ${bucket}) * ${bucket} AS bucket, model, provider,
                SUM(cost_total) AS cost,
                SUM(cost_input) AS cost_input,
                SUM(cost_output) AS cost_output,
                SUM(cost_cache_read) AS cost_cache_read,
                SUM(cost_cache_write) AS cost_cache_write,
                SUM(CASE WHEN total_tokens > 0 AND cost_total = 0 AND stop_reason != 'error' THEN 1 ELSE 0 END) AS unpriced,
                COUNT(*) AS requests
         FROM messages${whereRange(cutoff)}
         GROUP BY bucket, model, provider ORDER BY bucket`,
      )
      .all() as Row[];
    return rows.map((row) => ({
      timestamp: num(row.bucket),
      model: str(row.model, "unknown"),
      provider: str(row.provider, "unknown"),
      cost: num(row.cost),
      unpricedRequests: num(row.unpriced),
      costInput: num(row.cost_input),
      costOutput: num(row.cost_output),
      costCacheRead: num(row.cost_cache_read),
      costCacheWrite: num(row.cost_cache_write),
      requests: num(row.requests),
    }));
  }

  // --- providers -----------------------------------------------------------

  byProvider(cutoff: number | null): ProviderAggregate[] {
    const rows = this.#db
      .prepare(
        `SELECT provider,
                COUNT(*) AS total_requests,
                SUM(CASE WHEN stop_reason = 'error' THEN 1 ELSE 0 END) AS failed_requests,
                COUNT(DISTINCT model) AS models,
                SUM(input_tokens) AS input_tokens,
                SUM(output_tokens) AS output_tokens,
                SUM(cache_read_tokens) AS cache_read_tokens,
                SUM(cache_write_tokens) AS cache_write_tokens,
                SUM(total_tokens) AS total_tokens,
                SUM(cost_total) AS cost_total,
                SUM(CASE WHEN total_tokens > 0 AND cost_total = 0 AND stop_reason != 'error' THEN 1 ELSE 0 END) AS unpriced,
                SUM(CASE WHEN duration > 0 THEN output_tokens ELSE 0 END) AS timed_output,
                SUM(CASE WHEN duration > 0 THEN duration ELSE 0 END) AS timed_duration
         FROM messages${whereRange(cutoff)}
         GROUP BY provider ORDER BY total_tokens DESC`,
      )
      .all() as Row[];
    return rows.map((row) => {
      const duration = num(row.timed_duration);
      return {
        provider: str(row.provider, "unknown"),
        totalRequests: num(row.total_requests),
        failedRequests: num(row.failed_requests),
        models: num(row.models),
        totalInputTokens: num(row.input_tokens),
        totalOutputTokens: num(row.output_tokens),
        totalCacheReadTokens: num(row.cache_read_tokens),
        totalCacheWriteTokens: num(row.cache_write_tokens),
        totalTokens: num(row.total_tokens),
        totalCost: num(row.cost_total),
        unpricedRequests: num(row.unpriced),
        avgTokensPerSecond:
          duration > 0 ? num(row.timed_output) / (duration / 1_000) : null,
      };
    });
  }

  /** Token burn by local hour of day, for the peak-burn histogram. */
  providerHourlyBurn(cutoff: number | null): ProviderHourlyPoint[] {
    const rows = this.#db
      .prepare(
        `SELECT provider,
                CAST(strftime('%H', timestamp / 1000, 'unixepoch', 'localtime') AS INTEGER) AS hour,
                SUM(total_tokens) AS total_tokens,
                SUM(output_tokens) AS output_tokens,
                COUNT(*) AS requests
         FROM messages${whereRange(cutoff)}
         GROUP BY provider, hour ORDER BY provider, hour`,
      )
      .all() as Row[];
    return rows.map((row) => ({
      provider: str(row.provider, "unknown"),
      hour: num(row.hour),
      totalTokens: num(row.total_tokens),
      outputTokens: num(row.output_tokens),
      requests: num(row.requests),
    }));
  }

  providerTimeSeries(
    cutoff: number | null,
    bucketMs: number,
  ): ProviderTimeSeriesPoint[] {
    const bucket = Math.max(1, Math.floor(bucketMs));
    const rows = this.#db
      .prepare(
        `SELECT (timestamp / ${bucket}) * ${bucket} AS bucket, provider,
                SUM(total_tokens) AS total_tokens,
                SUM(cost_total) AS cost,
                SUM(CASE WHEN total_tokens > 0 AND cost_total = 0 AND stop_reason != 'error' THEN 1 ELSE 0 END) AS unpriced,
                COUNT(*) AS requests
         FROM messages${whereRange(cutoff)}
         GROUP BY bucket, provider ORDER BY bucket`,
      )
      .all() as Row[];
    return rows.map((row) => ({
      timestamp: num(row.bucket),
      provider: str(row.provider, "unknown"),
      totalTokens: num(row.total_tokens),
      cost: num(row.cost),
      unpricedRequests: num(row.unpriced),
      requests: num(row.requests),
    }));
  }

  // --- requests and errors -------------------------------------------------

  recentRequests(limit: number, cutoff: number | null): MessageRow[] {
    return this.#selectMessages(
      `SELECT * FROM messages${whereRange(cutoff)} ORDER BY timestamp DESC LIMIT ?`,
      limit,
    );
  }

  recentErrors(limit: number, cutoff: number | null): MessageRow[] {
    return this.#selectMessages(
      `SELECT * FROM messages WHERE stop_reason = 'error'${andRange(cutoff)}
       ORDER BY timestamp DESC LIMIT ?`,
      limit,
    );
  }

  messageById(id: number): MessageRow | null {
    const rows = this.#selectMessages(
      "SELECT * FROM messages WHERE id = ?",
      id,
    );
    return rows[0] ?? null;
  }

  #selectMessages(sql: string, parameter: number): MessageRow[] {
    const rows = this.#db.prepare(sql).all(Math.floor(parameter)) as Row[];
    return rows.map((row) => ({
      id: num(row.id),
      sessionFile: str(row.session_file),
      entryId: str(row.entry_id),
      folder: str(row.folder),
      model: str(row.model, "unknown"),
      provider: str(row.provider, "unknown"),
      api: str(row.api, "unknown"),
      timestamp: num(row.timestamp),
      duration: row.duration === null ? null : num(row.duration),
      stopReason: str(row.stop_reason, "unknown"),
      errorMessage: row.error_message === null ? null : str(row.error_message),
      inputTokens: num(row.input_tokens),
      outputTokens: num(row.output_tokens),
      cacheReadTokens: num(row.cache_read_tokens),
      cacheWriteTokens: num(row.cache_write_tokens),
      reasoningTokens: num(row.reasoning_tokens),
      totalTokens: num(row.total_tokens),
      costTotal: num(row.cost_total),
      agentType: (str(row.agent_type, "main") as AgentType) ?? "main",
    }));
  }

  // --- behaviour -----------------------------------------------------------

  behaviorOverall(cutoff: number | null): BehaviorOverallStats {
    const row = this.#db
      .prepare(
        `SELECT COUNT(*) AS messages, SUM(chars) AS chars, SUM(words) AS words,
                SUM(yelling) AS yelling, SUM(profanity) AS profanity,
                SUM(anguish) AS anguish, SUM(negation) AS negation,
                SUM(repetition) AS repetition, SUM(blame) AS blame
         FROM user_messages${whereRange(cutoff)}`,
      )
      .get() as Row | undefined;
    return toBehavior(row);
  }

  behaviorByModel(cutoff: number | null): BehaviorModelStats[] {
    const rows = this.#db
      .prepare(
        `SELECT model, provider, COUNT(*) AS messages, SUM(chars) AS chars,
                SUM(words) AS words, SUM(yelling) AS yelling,
                SUM(profanity) AS profanity, SUM(anguish) AS anguish,
                SUM(negation) AS negation, SUM(repetition) AS repetition,
                SUM(blame) AS blame
         FROM user_messages WHERE model IS NOT NULL${andRange(cutoff)}
         GROUP BY model, provider ORDER BY messages DESC`,
      )
      .all() as Row[];
    return rows.map((row) => ({
      model: str(row.model, "unknown"),
      provider: str(row.provider, "unknown"),
      ...toBehavior(row),
    }));
  }

  behaviorTimeSeries(
    cutoff: number | null,
    bucketMs: number,
  ): BehaviorTimeSeriesPoint[] {
    const bucket = Math.max(1, Math.floor(bucketMs));
    const rows = this.#db
      .prepare(
        `SELECT (timestamp / ${bucket}) * ${bucket} AS bucket,
                COUNT(*) AS messages, SUM(yelling) AS yelling,
                SUM(profanity) AS profanity, SUM(anguish) AS anguish,
                SUM(negation) AS negation, SUM(repetition) AS repetition,
                SUM(blame) AS blame
         FROM user_messages${whereRange(cutoff)}
         GROUP BY bucket ORDER BY bucket`,
      )
      .all() as Row[];
    return rows.map((row) => ({
      timestamp: num(row.bucket),
      messages: num(row.messages),
      yelling: num(row.yelling),
      profanity: num(row.profanity),
      anguish: num(row.anguish),
      negation: num(row.negation),
      repetition: num(row.repetition),
      blame: num(row.blame),
    }));
  }

  // --- tools ---------------------------------------------------------------

  /**
   * Per-call share of the invoking turn's real usage. Joining tool calls to
   * their assistant message and dividing by `calls_in_turn` keeps the shares
   * additive: summing every tool's share reproduces the turn's total.
   */
  toolStats(cutoff: number | null): ToolUsageStats[] {
    const rows = this.#db
      .prepare(
        `SELECT t.tool_name AS tool, ${TOOL_SHARE_COLUMNS}
         FROM tool_calls t
         LEFT JOIN messages m
           ON m.session_file = t.session_file AND m.entry_id = t.entry_id
         ${cutoff === null ? "" : `WHERE t.timestamp >= ${Math.floor(cutoff)}`}
         GROUP BY t.tool_name ORDER BY calls DESC`,
      )
      .all() as Row[];
    return rows.map(toToolUsage);
  }

  toolStatsByModel(cutoff: number | null): ToolModelStats[] {
    const rows = this.#db
      .prepare(
        `SELECT t.tool_name AS tool, t.model AS model, t.provider AS provider,
                ${TOOL_SHARE_COLUMNS}
         FROM tool_calls t
         LEFT JOIN messages m
           ON m.session_file = t.session_file AND m.entry_id = t.entry_id
         ${cutoff === null ? "" : `WHERE t.timestamp >= ${Math.floor(cutoff)}`}
         GROUP BY t.tool_name, t.model, t.provider ORDER BY calls DESC`,
      )
      .all() as Row[];
    return rows.map((row) => ({
      model: str(row.model, "unknown"),
      provider: str(row.provider, "unknown"),
      ...toToolUsage(row),
    }));
  }

  toolTimeSeries(
    cutoff: number | null,
    bucketMs: number,
  ): ToolTimeSeriesPoint[] {
    const bucket = Math.max(1, Math.floor(bucketMs));
    const rows = this.#db
      .prepare(
        `SELECT (timestamp / ${bucket}) * ${bucket} AS bucket, tool_name AS tool,
                COUNT(*) AS calls,
                SUM(CASE WHEN is_error = 1 THEN 1 ELSE 0 END) AS errors
         FROM tool_calls${whereRange(cutoff)}
         GROUP BY bucket, tool ORDER BY bucket`,
      )
      .all() as Row[];
    return rows.map((row) => ({
      timestamp: num(row.bucket),
      tool: str(row.tool, "unknown"),
      calls: num(row.calls),
      errors: num(row.errors),
    }));
  }

  /** Distinct project folders seen, newest activity first. */
  projects(cutoff: number | null): string[] {
    const rows = this.#db
      .prepare(
        `SELECT folder, MAX(timestamp) AS last FROM messages${whereRange(cutoff)}
         GROUP BY folder ORDER BY last DESC`,
      )
      .all() as Row[];
    return rows.map((row) => str(row.folder)).filter(Boolean);
  }
}

const TOOL_SHARE_COLUMNS = `
  COUNT(*) AS calls,
  SUM(CASE WHEN t.is_error = 1 THEN 1 ELSE 0 END) AS errors,
  SUM(t.args_chars) AS args_chars,
  SUM(COALESCE(t.result_chars, 0)) AS result_chars,
  SUM(COALESCE(m.total_tokens, 0) * 1.0 / MAX(t.calls_in_turn, 1)) AS total_tokens_share,
  SUM(COALESCE(m.output_tokens, 0) * 1.0 / MAX(t.calls_in_turn, 1)) AS output_tokens_share,
  SUM(COALESCE(m.cost_total, 0) * 1.0 / MAX(t.calls_in_turn, 1)) AS cost_share,
  MAX(t.timestamp) AS last_used
`;

function toToolUsage(row: Row): ToolUsageStats {
  return {
    tool: str(row.tool, "unknown"),
    calls: num(row.calls),
    errors: num(row.errors),
    argsChars: num(row.args_chars),
    resultChars: num(row.result_chars),
    totalTokensShare: num(row.total_tokens_share),
    outputTokensShare: num(row.output_tokens_share),
    costShare: num(row.cost_share),
    lastUsed: num(row.last_used),
  };
}

function toBehavior(row: Row | undefined): BehaviorOverallStats {
  const messages = num(row?.messages);
  const signals =
    num(row?.yelling) +
    num(row?.profanity) +
    num(row?.anguish) +
    num(row?.negation) +
    num(row?.repetition) +
    num(row?.blame);
  return {
    messages,
    chars: num(row?.chars),
    words: num(row?.words),
    yelling: num(row?.yelling),
    profanity: num(row?.profanity),
    anguish: num(row?.anguish),
    negation: num(row?.negation),
    repetition: num(row?.repetition),
    blame: num(row?.blame),
    frustrationRate: messages > 0 ? (signals / messages) * 100 : 0,
  };
}
