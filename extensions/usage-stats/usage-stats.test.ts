import assert from "node:assert/strict";
import {
  appendFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  behavior,
  costs,
  errors,
  gain,
  limitsLog,
  modelDashboard,
  openStats,
  overview,
  parseRange,
  projectsDashboard,
  providers,
  requests,
  runSync,
  status,
  tools,
  type StatsContext,
} from "./src/api.ts";
import { DASHBOARD_SECTIONS, dashboardHtml } from "./src/client.ts";
import { StatsDatabase } from "./src/db.ts";
import { aggregateGain, readGainLog, recordGain } from "./src/gain.ts";
import {
  renderBehavior,
  renderCosts,
  renderGain,
  renderOverview,
  renderProviders,
  renderTools,
} from "./src/markdown.ts";
import {
  analyzeUserText,
  MIN_DERIVED_DURATION_MS,
  parseSession,
} from "./src/parser.ts";
import {
  folderFromSessionDir,
  projectLabel,
  resolvePaths,
} from "./src/paths.ts";
import { cutoffFor, TIME_RANGES } from "./src/shared-types.ts";
import { handle, startServer } from "./src/server.ts";
import { listSessionFiles } from "./src/sync.ts";
import {
  buildUsageSeries,
  buildWindowInsights,
  estimateSnapshots,
  parseLimitHeaders,
  readSnapshots,
  recordSnapshots,
  snapshotsFromHeaders,
} from "./src/usage-windows.ts";

const T0 = Date.UTC(2026, 7, 30, 12, 0, 0);

// --- fixtures --------------------------------------------------------------

function assistant(options: {
  id: string;
  parentId?: string | null;
  at: number;
  model?: string;
  provider?: string;
  stopReason?: string;
  errorMessage?: string;
  input?: number;
  output?: number;
  cacheRead?: number;
  cacheWrite?: number;
  reasoning?: number;
  cost?: number;
  toolCalls?: Array<{ id: string; name: string }>;
}) {
  const input = options.input ?? 1_000;
  const output = options.output ?? 100;
  const cacheRead = options.cacheRead ?? 0;
  const cacheWrite = options.cacheWrite ?? 0;
  const cost = options.cost ?? 0.01;
  return JSON.stringify({
    type: "message",
    id: options.id,
    parentId: options.parentId ?? null,
    timestamp: new Date(options.at).toISOString(),
    message: {
      role: "assistant",
      api: "openai-completions",
      provider: options.provider ?? "anthropic",
      model: options.model ?? "claude-opus-5",
      usage: {
        input,
        output,
        cacheRead,
        cacheWrite,
        reasoning: options.reasoning ?? 0,
        totalTokens: input + output + cacheRead + cacheWrite,
        cost: {
          input: cost * 0.6,
          output: cost * 0.3,
          cacheRead: cost * 0.1,
          cacheWrite: 0,
          total: cost,
        },
      },
      stopReason: options.stopReason ?? "stop",
      ...(options.errorMessage ? { errorMessage: options.errorMessage } : {}),
      timestamp: options.at,
      content: (options.toolCalls ?? []).map((call) => ({
        type: "toolCall",
        id: call.id,
        name: call.name,
        arguments: { path: "/some/file.ts" },
      })),
    },
  });
}

function userMessage(id: string, at: number, text: string) {
  return JSON.stringify({
    type: "message",
    id,
    parentId: null,
    timestamp: new Date(at).toISOString(),
    message: { role: "user", content: [{ type: "text", text }] },
  });
}

function toolResult(
  at: number,
  toolCallId: string,
  text: string,
  isError = false,
) {
  return JSON.stringify({
    type: "message",
    id: `tr-${toolCallId}`,
    parentId: null,
    timestamp: new Date(at).toISOString(),
    message: {
      role: "toolResult",
      toolCallId,
      toolName: "read",
      isError,
      timestamp: at,
      content: [{ type: "text", text }],
    },
  });
}

/** A temp agent home with two projects and a subagent session. */
function makeAgentHome() {
  const home = mkdtempSync(join(tmpdir(), "pi-usage-home-"));
  const agentDir = join(home, ".pi", "agent");
  const sessions = join(agentDir, "sessions");

  const alpha = join(sessions, "--Users-vraj-work-alpha--");
  const beta = join(sessions, "--Users-vraj-work-beta--");
  mkdirSync(alpha, { recursive: true });
  mkdirSync(beta, { recursive: true });

  writeFileSync(
    join(alpha, "s1.jsonl"),
    [
      JSON.stringify({
        type: "session",
        version: 3,
        id: "s1",
        timestamp: new Date(T0).toISOString(),
        cwd: "/Users/vraj/work/alpha",
      }),
      userMessage("u1", T0, "please fix the build"),
      assistant({
        id: "a1",
        parentId: "u1",
        at: T0 + 2_000,
        input: 1_000,
        output: 200,
        cacheRead: 500,
        cost: 0.02,
        toolCalls: [
          { id: "tc1", name: "bash" },
          { id: "tc2", name: "read" },
        ],
      }),
      toolResult(T0 + 3_000, "tc1", "build output here"),
      toolResult(T0 + 3_500, "tc2", "file contents", true),
      userMessage(
        "u2",
        T0 + 4_000,
        "NO that is STILL not what i meant, you didn't read it",
      ),
      assistant({
        id: "a2",
        parentId: "u2",
        at: T0 + 6_000,
        stopReason: "error",
        errorMessage: "provider timeout",
        cost: 0,
        input: 900,
        output: 0,
      }),
      "",
    ].join("\n"),
    "utf8",
  );

  writeFileSync(
    join(beta, "s2.jsonl"),
    [
      JSON.stringify({
        type: "session",
        version: 3,
        id: "s2",
        timestamp: new Date(T0).toISOString(),
        cwd: "/Users/vraj/work/beta",
      }),
      JSON.stringify({
        type: "session_info",
        id: "si",
        parentId: null,
        timestamp: new Date(T0).toISOString(),
        name: "subagent: review the diff",
      }),
      assistant({
        id: "b1",
        at: T0 + 10_000,
        model: "gpt-5-codex",
        provider: "openai",
        input: 5_000,
        output: 500,
        reasoning: 300,
        cost: 0,
      }),
      "",
    ].join("\n"),
    "utf8",
  );

  return { home, agentDir, sessions, alpha, beta };
}

function openTestContext(home: string, now = () => T0 + 60_000): StatsContext {
  return openStats({ home, now, budgets: [] });
}

// --- paths -----------------------------------------------------------------

test("session directory names decode back to project paths", () => {
  assert.equal(
    folderFromSessionDir("--Users-vraj-work-alpha--"),
    "/Users/vraj/work/alpha",
  );
  assert.equal(folderFromSessionDir("not-a-session-dir"), "not-a-session-dir");
  assert.equal(projectLabel("/Users/vraj/work/alpha"), "work/alpha");
  assert.equal(projectLabel("/"), "/");
});

test("paths live under the agent directory", () => {
  const paths = resolvePaths("/home/x");
  assert.ok(paths.databaseFile.endsWith("usage-stats.sqlite"));
  assert.ok(paths.sessionsDir.endsWith(join(".pi", "agent", "sessions")));
});

// --- parser ----------------------------------------------------------------

test("a session parses into messages, tool calls, results, and user turns", () => {
  const { home, alpha } = makeAgentHome();
  try {
    const file = join(alpha, "s1.jsonl");
    const content = readFileSync(file, "utf8");
    const parsed = parseSession(file, content);

    assert.equal(parsed.messages.length, 2);
    assert.equal(parsed.userMessages.length, 2);
    assert.equal(parsed.toolCalls.length, 2);
    assert.equal(parsed.toolResults.length, 2);
    assert.equal(parsed.skipped, 0);
    assert.ok(parsed.offset > 0);

    const [first] = parsed.messages;
    assert.equal(first.folder, "/Users/vraj/work/alpha");
    assert.equal(first.model, "claude-opus-5");
    assert.equal(first.inputTokens, 1_000);
    assert.equal(first.cacheReadTokens, 500);
    assert.equal(first.totalTokens, 1_700);
    assert.equal(first.costTotal, 0.02);
    assert.equal(first.agentType, "main");
    // Derived latency: 2s after the user message that preceded it.
    assert.equal(first.durationMs, 2_000);

    // Both tool calls report the turn they came from, for share attribution.
    assert.deepEqual(
      parsed.toolCalls.map((call) => [call.toolName, call.callsInTurn]),
      [
        ["bash", 2],
        ["read", 2],
      ],
    );
    assert.equal(parsed.toolResults[1].isError, true);

    // The user message is linked to the model that answered it.
    assert.equal(parsed.userMessages[0].model, "claude-opus-5");
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("a subagent session is labelled from its own session_info", () => {
  const { home, beta } = makeAgentHome();
  try {
    const file = join(beta, "s2.jsonl");
    const content = readFileSync(file, "utf8");
    const parsed = parseSession(file, content);
    assert.equal(parsed.messages[0].agentType, "subagent");
    assert.equal(parsed.messages[0].reasoningTokens, 300);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("a truncated final line is left for the next pass", () => {
  const complete = `${assistant({ id: "a1", at: T0 })}\n`;
  const partial = `${complete}{"type":"message","id":"a2`;
  const parsed = parseSession("/x/--repo--/s.jsonl", partial);
  assert.equal(parsed.messages.length, 1);
  assert.equal(parsed.offset, Buffer.byteLength(complete, "utf8"));
});

test("corrupt lines are skipped, not fatal", () => {
  const content = `not json\n${assistant({ id: "a1", at: T0 })}\n[]\n`;
  const parsed = parseSession("/x/--repo--/s.jsonl", content);
  assert.equal(parsed.messages.length, 1);
  assert.equal(parsed.skipped, 2);
});

test("a sub-millisecond gap yields no latency, so throughput stays believable", () => {
  const content = [
    userMessage("u1", T0, "hi"),
    // Same-millisecond stamps: a 5,000-token reply would read as millions of
    // tokens per second if this gap were treated as a generation window.
    assistant({ id: "a1", parentId: "u1", at: T0, output: 5_000 }),
    "",
  ].join("\n");
  const parsed = parseSession("/x/--repo--/s.jsonl", content);
  assert.equal(parsed.messages[0].durationMs, null);
});

test("a gap at the minimum is kept", () => {
  const content = [
    userMessage("u1", T0, "hi"),
    assistant({ id: "a1", parentId: "u1", at: T0 + MIN_DERIVED_DURATION_MS }),
    "",
  ].join("\n");
  assert.equal(
    parseSession("/x/--repo--/s.jsonl", content).messages[0].durationMs,
    MIN_DERIVED_DURATION_MS,
  );
});

test("an implausible gap is reported as unknown latency, not a 12-hour request", () => {
  const content = [
    userMessage("u1", T0, "hi"),
    assistant({ id: "a1", parentId: "u1", at: T0 + 12 * 60 * 60 * 1_000 }),
    "",
  ].join("\n");
  const parsed = parseSession("/x/--repo--/s.jsonl", content);
  assert.equal(parsed.messages[0].durationMs, null);
});

test("behavioural signals fire on the phrases people actually type", () => {
  const upset = analyzeUserText(
    "NO THAT IS WRONG. you didn't read it. like i said, ugh",
  );
  assert.ok(upset.yelling >= 1);
  assert.ok(upset.negation >= 1);
  assert.ok(upset.blame >= 1);
  assert.ok(upset.repetition >= 1);
  assert.ok(upset.anguish >= 1);

  const calm = analyzeUserText(
    "Please add a test for the parser when you get a chance.",
  );
  assert.equal(calm.yelling, 0);
  assert.equal(calm.profanity, 0);
  assert.equal(calm.blame, 0);
  assert.ok(calm.words > 5);
});

// --- database and sync -----------------------------------------------------

test("sync indexes every session, and a second pass adds nothing", () => {
  const { home, sessions } = makeAgentHome();
  try {
    assert.equal(listSessionFiles(sessions).length, 2);
    const context = openTestContext(home);
    const first = runSync(context);
    assert.equal(first.files, 2);
    assert.equal(first.changed, 2);
    assert.equal(first.counts.messages, 3);
    assert.equal(first.counts.toolCalls, 2);
    assert.equal(first.counts.toolResults, 2);
    assert.equal(first.failed, 0);

    const second = runSync(context);
    assert.equal(second.counts.messages, 0, "re-syncing must be a no-op");
    assert.equal(second.changed, 0);
    assert.equal(context.db.messageCount(), 3);
    context.db.close();
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("appended lines are picked up incrementally", () => {
  const { home, alpha } = makeAgentHome();
  try {
    const context = openTestContext(home);
    runSync(context);
    assert.equal(context.db.messageCount(), 3);

    appendFileSync(
      join(alpha, "s1.jsonl"),
      `${assistant({ id: "a3", at: T0 + 20_000, cost: 0.05 })}\n`,
      "utf8",
    );
    const result = runSync(context);
    assert.equal(result.counts.messages, 1);
    assert.equal(context.db.messageCount(), 4);
    context.db.close();
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("a truncated session file is re-read from the start", () => {
  const { home, alpha } = makeAgentHome();
  try {
    const context = openTestContext(home);
    runSync(context);
    const before = context.db.messageCount();

    // Rewrite the file smaller: the recorded offset is now past its end.
    writeFileSync(
      join(alpha, "s1.jsonl"),
      `${assistant({ id: "fresh", at: T0 + 30_000 })}\n`,
      "utf8",
    );
    const result = runSync(context);
    assert.equal(result.counts.messages, 1);
    assert.equal(context.db.messageCount(), before + 1);
    context.db.close();
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("rebuild drops the index and re-reads everything", () => {
  const { home } = makeAgentHome();
  try {
    let context = openTestContext(home);
    runSync(context);
    assert.equal(context.db.messageCount(), 3);
    context.db.close();

    context = openStats({
      home,
      now: () => T0 + 60_000,
      rebuild: true,
      budgets: [],
    });
    assert.equal(context.db.messageCount(), 0, "rebuild must start empty");
    runSync(context, { full: true });
    assert.equal(context.db.messageCount(), 3);
    context.db.close();
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("a schema version bump forces a rebuild rather than a broken read", () => {
  const file = join(mkdtempSync(join(tmpdir(), "pi-usage-db-")), "db.sqlite");
  try {
    const first = StatsDatabase.open(file);
    first.insert({
      messages: [
        {
          sessionFile: "/x/s.jsonl",
          entryId: "e1",
          folder: "/x",
          model: "m",
          provider: "p",
          api: "a",
          timestamp: T0,
          durationMs: 10,
          stopReason: "stop",
          errorMessage: null,
          inputTokens: 1,
          outputTokens: 1,
          cacheReadTokens: 0,
          cacheWriteTokens: 0,
          reasoningTokens: 0,
          totalTokens: 2,
          costInput: 0,
          costOutput: 0,
          costCacheRead: 0,
          costCacheWrite: 0,
          costTotal: 0,
          agentType: "main",
        },
      ],
      userMessages: [],
      toolCalls: [],
      toolResults: [],
    });
    assert.equal(first.messageCount(), 1);
    first.close();

    const reopened = StatsDatabase.open(file);
    assert.equal(reopened.messageCount(), 1, "same version keeps the data");
    reopened.close();
  } finally {
    rmSync(file, { force: true });
  }
});

// --- aggregates ------------------------------------------------------------

test("the overview aggregates cost, cache, errors, and agent split", () => {
  const { home } = makeAgentHome();
  try {
    const context = openTestContext(home);
    runSync(context);
    const stats = overview(context, "24h");

    assert.equal(stats.overall.totalRequests, 3);
    assert.equal(stats.overall.failedRequests, 1);
    assert.ok(Math.abs(stats.overall.errorRate - 1 / 3) < 1e-9);
    assert.ok(Math.abs(stats.overall.totalCost - 0.02) < 1e-9);
    // The subagent turn carried 5,500 tokens but no price.
    assert.equal(stats.overall.unpricedRequests, 1);
    assert.equal(stats.overall.totalCacheReadTokens, 500);
    assert.ok(stats.overall.cacheRate > 0 && stats.overall.cacheRate < 1);
    assert.ok(stats.overall.avgTokensPerSecond !== null);

    assert.deepEqual(stats.byAgentType.map((a) => a.agentType).sort(), [
      "main",
      "subagent",
    ]);
    assert.deepEqual(stats.byModel.map((m) => m.model).sort(), [
      "claude-opus-5",
      "gpt-5-codex",
    ]);
    assert.deepEqual(stats.byFolder.map((f) => f.folder).sort(), [
      "/Users/vraj/work/alpha",
      "/Users/vraj/work/beta",
    ]);
    assert.ok(stats.timeSeries.length > 0);
    context.db.close();
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("ranges actually narrow the data", () => {
  const { home } = makeAgentHome();
  try {
    // "now" is far past the fixtures, so a 1h window must exclude them.
    const context = openStats({
      home,
      now: () => T0 + 10 * 24 * 3_600_000,
      budgets: [],
    });
    runSync(context);
    assert.equal(overview(context, "1h").overall.totalRequests, 0);
    assert.equal(overview(context, "24h").overall.totalRequests, 0);
    assert.equal(overview(context, "30d").overall.totalRequests, 3);
    assert.equal(overview(context, "all").overall.totalRequests, 3);
    context.db.close();
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("every documented range maps to a cutoff", () => {
  for (const range of TIME_RANGES) {
    const cutoff = cutoffFor(range, T0);
    if (range === "all") assert.equal(cutoff, null);
    else assert.ok(typeof cutoff === "number" && cutoff < T0);
  }
});

test("tool shares split the invoking turn's usage and stay additive", () => {
  const { home } = makeAgentHome();
  try {
    const context = openTestContext(home);
    runSync(context);
    const stats = tools(context, "all");

    const bash = stats.byTool.find((t) => t.tool === "bash");
    const read = stats.byTool.find((t) => t.tool === "read");
    assert.ok(bash && read);
    // The turn carried 1,700 tokens across two calls: 850 each.
    assert.ok(Math.abs(bash.totalTokensShare - 850) < 1e-6);
    assert.ok(Math.abs(read.totalTokensShare - 850) < 1e-6);
    assert.ok(Math.abs(bash.costShare + read.costShare - 0.02) < 1e-9);
    assert.equal(read.errors, 1, "the failed tool result is attributed");
    assert.ok(read.resultChars > 0);
    assert.ok(stats.byToolModel.length > 0);
    context.db.close();
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("behaviour, costs, projects, requests, and errors all report", () => {
  const { home } = makeAgentHome();
  try {
    const context = openTestContext(home);
    runSync(context);

    const b = behavior(context, "all");
    assert.equal(b.overall.messages, 2);
    assert.ok(b.overall.frustrationRate > 0);
    assert.ok(b.byModel.length > 0, "user turns link to the answering model");

    const c = costs(context, "all");
    assert.ok(c.byModel.length > 0);

    const p = projectsDashboard(context, "all");
    assert.equal(p.byFolder.length, 2);
    assert.equal(p.projects.length, 2);

    const r = requests(context, "all", 10);
    assert.equal(r.length, 3);
    assert.ok(r[0].timestamp >= r[1].timestamp, "newest first");

    const e = errors(context, "all", 10);
    assert.equal(e.length, 1);
    assert.equal(e[0].errorMessage, "provider timeout");

    const m = modelDashboard(context, "all");
    assert.ok(m.usage.length > 0);
    assert.ok(m.performance.length > 0);
    context.db.close();
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

// --- subscription limits ---------------------------------------------------

test("provider rate-limit headers parse into reported windows", () => {
  const readings = parseLimitHeaders({
    "anthropic-ratelimit-requests-limit": "1000",
    "anthropic-ratelimit-requests-remaining": "250",
    "Anthropic-RateLimit-Unified-Limit": "100",
    "anthropic-ratelimit-unified-remaining": "0",
    "anthropic-ratelimit-unified-status": "exhausted",
    "x-ratelimit-limit-tokens": "40000",
    "x-ratelimit-remaining-tokens": "10000",
  });
  const byKey = new Map(readings.map((r) => [r.windowKey, r]));

  assert.ok(
    Math.abs((byKey.get("anthropic:requests")?.usedFraction ?? 0) - 0.75) <
      1e-9,
  );
  assert.equal(byKey.get("anthropic:unified")?.usedFraction, 1);
  assert.equal(byKey.get("anthropic:unified")?.exhausted, true);
  assert.ok(
    Math.abs((byKey.get("openai:tokens")?.usedFraction ?? 0) - 0.75) < 1e-9,
  );

  assert.deepEqual(parseLimitHeaders({}), []);
  assert.deepEqual(parseLimitHeaders({ "x-ratelimit-limit-tokens": "0" }), []);
  assert.deepEqual(parseLimitHeaders(undefined as never), []);
});

test("reported snapshots round-trip through the log", () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-usage-limits-"));
  const file = join(dir, "usage-limits.jsonl");
  try {
    const snapshots = snapshotsFromHeaders({
      provider: "anthropic",
      headers: {
        "anthropic-ratelimit-requests-limit": "100",
        "anthropic-ratelimit-requests-remaining": "40",
      },
      at: T0,
    });
    assert.equal(snapshots[0].source, "reported");
    assert.equal(recordSnapshots(file, snapshots), true);

    appendFileSync(file, "not json\n", "utf8");
    const read = readSnapshots(file);
    assert.equal(read.length, 1, "a corrupt line is skipped");
    assert.ok(Math.abs(read[0].usedFraction - 0.6) < 1e-9);
    assert.equal(readSnapshots(join(dir, "missing.jsonl")).length, 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("estimated snapshots are labelled and reset each window", () => {
  const windowMs = 3_600_000;
  const snapshots = estimateSnapshots(
    [
      { provider: "openai", timestamp: T0, totalTokens: 30_000 },
      { provider: "openai", timestamp: T0 + 60_000, totalTokens: 30_000 },
      {
        provider: "openai",
        timestamp: T0 + windowMs + 60_000,
        totalTokens: 10_000,
      },
      { provider: "other", timestamp: T0, totalTokens: 99_000 },
    ],
    [
      {
        provider: "openai",
        windowLabel: "hourly",
        windowMs,
        tokensPerWindow: 100_000,
      },
    ],
  );
  assert.equal(snapshots.length, 3, "only the budgeted provider is estimated");
  assert.ok(snapshots.every((s) => s.source === "estimated"));
  assert.ok(Math.abs(snapshots[0].usedFraction - 0.3) < 1e-9);
  assert.ok(Math.abs(snapshots[1].usedFraction - 0.6) < 1e-9);
  assert.ok(
    Math.abs(snapshots[2].usedFraction - 0.1) < 1e-9,
    "a new window starts from zero",
  );
  assert.deepEqual(estimateSnapshots([], []), []);
});

test("window insights count resets and size the account fleet", () => {
  const series = buildUsageSeries(
    [
      {
        provider: "p",
        accountKey: "a",
        accountLabel: "a",
        windowKey: "w",
        windowLabel: "W",
        at: T0,
        usedFraction: 0.2,
        exhausted: false,
        source: "reported",
      },
      {
        provider: "p",
        accountKey: "a",
        accountLabel: "a",
        windowKey: "w",
        windowLabel: "W",
        at: T0 + 1,
        usedFraction: 0.9,
        exhausted: false,
        source: "reported",
      },
      {
        provider: "p",
        accountKey: "a",
        accountLabel: "a",
        windowKey: "w",
        windowLabel: "W",
        at: T0 + 2,
        usedFraction: 0.1,
        exhausted: false,
        source: "reported",
      },
      {
        provider: "p",
        accountKey: "b",
        accountLabel: "b",
        windowKey: "w",
        windowLabel: "W",
        at: T0 + 1,
        usedFraction: 0.8,
        exhausted: true,
        source: "reported",
      },
    ],
    null,
  );
  assert.equal(series.length, 2, "one series per account");

  const [insight] = buildWindowInsights(series, new Map([["p", 1_000_000]]));
  assert.equal(insight.accounts, 2);
  assert.equal(insight.cycles, 1, "the drop from 0.9 to 0.1 is a reset");
  assert.equal(insight.exhaustedEvents, 1);
  assert.ok(insight.fractionConsumed > 1);
  assert.ok(insight.estTokensPerWindow !== null);
  // Peak concurrency is 0.9 + 0.8 = 1.7 -> ceil(1.7 / 0.9) = 2 accounts.
  assert.ok(Math.abs(insight.peakConcurrentFraction - 1.7) < 1e-9);
  assert.equal(insight.idealAccounts, 2);
  assert.equal(insight.source, "reported");
});

test("too little burn yields no tokens-per-window estimate", () => {
  const series = buildUsageSeries(
    [
      {
        provider: "p",
        accountKey: "a",
        accountLabel: "a",
        windowKey: "w",
        windowLabel: "W",
        at: T0,
        usedFraction: 0.01,
        exhausted: false,
        source: "reported",
      },
    ],
    null,
  );
  const [insight] = buildWindowInsights(series, new Map([["p", 1_000]]));
  assert.equal(insight.estTokensPerWindow, null);
});

test("a provider that reports its own limits is never overridden by an estimate", () => {
  const { home } = makeAgentHome();
  try {
    const context = openStats({
      home,
      now: () => T0 + 60_000,
      budgets: [
        {
          provider: "anthropic",
          windowLabel: "hourly",
          windowMs: 3_600_000,
          tokensPerWindow: 1_000,
        },
      ],
    });
    runSync(context);
    recordSnapshots(
      limitsLog(context),
      snapshotsFromHeaders({
        provider: "anthropic",
        headers: {
          "anthropic-ratelimit-requests-limit": "100",
          "anthropic-ratelimit-requests-remaining": "50",
        },
        at: T0 + 1_000,
      }),
    );

    const sources = new Set(
      providers(context, "all").usageSeries.map((s) => s.source),
    );
    assert.deepEqual([...sources], ["reported"]);
    context.db.close();
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

// --- gain ------------------------------------------------------------------

test("gain records aggregate per source and per day", () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-usage-gain-"));
  const file = join(dir, "gain.jsonl");
  try {
    recordGain(file, {
      source: "compression",
      at: T0,
      folder: "/a",
      originalBytes: 4_000,
      outputBytes: 1_000,
    });
    recordGain(file, {
      source: "compaction",
      at: T0,
      folder: "/a",
      originalBytes: 8_000,
      outputBytes: 4_000,
    });
    recordGain(file, {
      source: "compression",
      at: T0 + 86_400_000,
      folder: "/b",
      originalBytes: 400,
      outputBytes: 400,
    });
    appendFileSync(file, '{"source":"nonsense","at":1}\nnot json\n', "utf8");

    const records = readGainLog(file);
    assert.equal(records.length, 3, "junk lines are dropped");

    const stats = aggregateGain(records);
    assert.equal(stats.overall.hits, 3);
    // 3000 + 4000 saved bytes at 4 chars/token.
    assert.equal(stats.overall.savedTokens, 750 + 1_000);
    assert.equal(stats.bySource.compression.savedBytes, 3_000);
    assert.equal(stats.bySource.compaction.savedBytes, 4_000);
    assert.ok((stats.overall.reductionPercent ?? 0) > 0);
    assert.equal(stats.timeSeries.length, 2, "one point per day");
    assert.deepEqual(stats.projects, ["/a", "/b"]);

    const filtered = aggregateGain(records, { project: "/b" });
    assert.equal(filtered.overall.hits, 1);
    assert.equal(filtered.overall.savedTokens, 0, "no shrink means no saving");

    const ranged = aggregateGain(records, { cutoff: T0 + 1 });
    assert.equal(ranged.overall.hits, 1);

    assert.equal(readGainLog(join(dir, "missing.jsonl")).length, 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// --- markdown --------------------------------------------------------------

test("every markdown view renders with real data and says what is derived", () => {
  const { home } = makeAgentHome();
  try {
    const context = openTestContext(home);
    runSync(context);

    const summary = renderOverview(overview(context, "all"), "all");
    assert.match(summary, /# PI Usage Statistics/);
    assert.match(summary, /claude-opus-5/);
    assert.match(summary, /derived from entry timestamps/);
    assert.match(summary, /subscription or free tier/);

    assert.match(renderTools(tools(context, "all"), "all"), /\| bash \|/);
    assert.match(renderCosts(costs(context, "all"), "all"), /Total:/);
    assert.match(
      renderBehavior(behavior(context, "all"), "all"),
      /frustration signals/,
    );
    assert.match(renderGain(gain(context, "all"), "all"), /Tokens saved/);

    const limits = renderProviders(providers(context, "all"), "all");
    assert.match(limits, /Subscription limits/);
    assert.match(
      limits,
      /No limit data/,
      "absent limits are stated, not faked",
    );
    context.db.close();
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("empty data renders without throwing", () => {
  const home = mkdtempSync(join(tmpdir(), "pi-usage-empty-"));
  try {
    const context = openTestContext(home);
    runSync(context);
    assert.match(
      renderOverview(overview(context, "all"), "all"),
      /no data in range/,
    );
    assert.match(renderTools(tools(context, "all"), "all"), /no data in range/);
    assert.equal(status(context).indexedMessages, 0);
    context.db.close();
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

// --- server ----------------------------------------------------------------

test("every dashboard route answers, and unknown routes 404", () => {
  const { home } = makeAgentHome();
  try {
    const context = openTestContext(home);
    runSync(context);

    const page = handle(context, "GET", "/");
    assert.equal(page.status, 200);
    assert.match(page.type, /text\/html/);
    for (const section of DASHBOARD_SECTIONS) {
      assert.ok(
        page.body.includes(`"${section}"`),
        `page is missing ${section}`,
      );
    }

    const routes = [
      "/api/status",
      "/api/stats",
      "/api/stats/overview",
      "/api/stats/model-dashboard",
      "/api/stats/models",
      "/api/stats/costs",
      "/api/stats/behavior",
      "/api/stats/tools",
      "/api/stats/providers",
      "/api/stats/recent",
      "/api/stats/errors",
      "/api/stats/folders",
      "/api/stats/projects",
      "/api/stats/timeseries",
      "/api/stats/gain",
    ];
    for (const route of routes) {
      const response = handle(context, "GET", `${route}?range=all`);
      assert.equal(response.status, 200, `${route} -> ${response.status}`);
      assert.doesNotThrow(
        () => JSON.parse(response.body),
        `${route} is not JSON`,
      );
    }

    // Every range is accepted on every route.
    for (const range of TIME_RANGES) {
      assert.equal(
        handle(context, "GET", `/api/stats/overview?range=${range}`).status,
        200,
      );
    }
    // A nonsense range falls back rather than erroring.
    assert.equal(
      handle(context, "GET", "/api/stats/overview?range=nope").status,
      200,
    );

    const row = requests(context, "all", 1)[0];
    assert.equal(handle(context, "GET", `/api/request/${row.id}`).status, 200);
    assert.equal(handle(context, "GET", "/api/request/999999").status, 404);
    assert.equal(handle(context, "GET", "/api/nope").status, 404);
    assert.equal(handle(context, "PUT", "/api/stats").status, 405);

    const synced = handle(context, "POST", "/api/sync");
    assert.equal(synced.status, 200);
    assert.ok("counts" in JSON.parse(synced.body));
    context.db.close();
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("the served dashboard is self-contained and loopback-only", async () => {
  const { home } = makeAgentHome();
  const context = openTestContext(home);
  runSync(context);
  const server = await startServer(context, 0);
  try {
    assert.match(server.url, /^http:\/\/127\.0\.0\.1:\d+$/);

    const html = await fetch(server.url).then((response) => response.text());
    assert.match(html, /PI Usage Statistics/);
    // No external origin may be fetched: this data never leaves the machine.
    // The SVG namespace URI is a identifier, not a request, so it is allowed.
    const remote = html.match(/https?:\/\/[^\s"'`)]+/gi) ?? [];
    assert.deepEqual(
      remote.filter((url) => !url.startsWith("http://www.w3.org/2000/svg")),
      [],
      "the page must not reference any remote resource",
    );
    assert.doesNotMatch(html, /<script[^>]+src=/i);
    assert.doesNotMatch(html, /<link[^>]+href=/i);

    const stats = await fetch(
      `${server.url}/api/stats/overview?range=all`,
    ).then((r) => r.json());
    assert.equal(stats.overall.totalRequests, 3);
  } finally {
    await server.close();
    context.db.close();
    rmSync(home, { recursive: true, force: true });
  }
});

test("range parsing rejects junk", () => {
  assert.equal(parseRange("30d"), "30d");
  assert.equal(parseRange("nope"), "7d");
  assert.equal(parseRange(undefined), "7d");
  assert.equal(parseRange(null, "all"), "all");
});

test("the dashboard html declares no remote assets", () => {
  const html = dashboardHtml();
  assert.match(html, /<!doctype html>/);
  assert.ok(html.includes("PI Usage Statistics"));
  assert.doesNotMatch(html, /cdn|unpkg|jsdelivr|googleapis/i);
});
