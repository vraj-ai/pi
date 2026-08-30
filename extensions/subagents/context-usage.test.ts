import assert from "node:assert/strict";
import test from "node:test";
import { renderFooter } from "../ui-customization/footer.ts";
import { contextOccupancyTokens } from "./src/backends/claude.ts";
import { parseThreadTokenUsage } from "./src/backends/codex.ts";
import { contextPercent, formatContextUtilization } from "./src/format.ts";

// --- Claude: per-request occupancy, never the run aggregate ------------------

test("Claude occupancy sums one request's input, cache, and output tokens", () => {
  assert.equal(
    contextOccupancyTokens({
      input_tokens: 12,
      cache_read_input_tokens: 45_000,
      cache_creation_input_tokens: 3_000,
      output_tokens: 700,
    }),
    48_712,
  );
});

test("Claude occupancy treats null cache/output counts as zero", () => {
  assert.equal(
    contextOccupancyTokens({
      input_tokens: 9_000,
      cache_read_input_tokens: null,
      cache_creation_input_tokens: null,
      output_tokens: 250,
    }),
    9_250,
  );
});

test("Claude occupancy is unknown without usable nonzero per-request usage", () => {
  assert.equal(contextOccupancyTokens(undefined), undefined);
  assert.equal(contextOccupancyTokens(null), undefined);
  assert.equal(
    contextOccupancyTokens({ input_tokens: null, output_tokens: 5 }),
    undefined,
  );
  assert.equal(
    contextOccupancyTokens({ input_tokens: 0, output_tokens: 0 }),
    undefined,
  );
  assert.equal(
    contextOccupancyTokens({
      input_tokens: 0,
      cache_read_input_tokens: 0,
      cache_creation_input_tokens: 0,
      output_tokens: 0,
    }),
    undefined,
  );
});

test("Claude occupancy rejects negative and non-finite token readings", () => {
  assert.equal(
    contextOccupancyTokens({ input_tokens: -1, output_tokens: 5 }),
    undefined,
  );
  assert.equal(
    contextOccupancyTokens({ input_tokens: Number.POSITIVE_INFINITY }),
    undefined,
  );
  assert.equal(
    contextOccupancyTokens({ input_tokens: 10, cache_read_input_tokens: -4 }),
    undefined,
  );
});

test("unknown context utilization omits the percent sign", () => {
  for (const tokens of [
    undefined,
    null,
    0,
    -1,
    Number.NaN,
    Number.POSITIVE_INFINITY,
    Number.NEGATIVE_INFINITY,
  ]) {
    assert.equal(
      formatContextUtilization({ tokens, contextWindow: 200_000 }),
      "?/200k",
    );
  }
  assert.equal(formatContextUtilization({ tokens: 0, contextWindow: 0 }), "");
});

test("tiny positive context utilization is measured without rendering zero", () => {
  const percent = contextPercent({ tokens: 1, contextWindow: 200_000 });
  assert.ok(percent !== undefined && percent > 0 && percent < 1);
  assert.equal(
    formatContextUtilization({ tokens: 1, contextWindow: 200_000 }),
    "<1%/200k",
  );
  assert.equal(
    formatContextUtilization({ tokens: 2_000, contextWindow: 200_000 }),
    "1%/200k",
  );
});

test("Claude occupancy from the last request stays below the window where the run aggregate would not", () => {
  // A 10-request tool loop over a mostly-cached 150k prompt: the aggregate
  // usage (what SDKResultMessage.usage reports) re-counts the cache per
  // request and blows past the 200k window; the final request's usage is the
  // true occupancy.
  const perRequest = {
    input_tokens: 500,
    cache_read_input_tokens: 150_000,
    cache_creation_input_tokens: 0,
    output_tokens: 400,
  };
  const aggregate = {
    input_tokens: 500 * 10,
    cache_read_input_tokens: 150_000 * 10,
    cache_creation_input_tokens: 0,
    output_tokens: 400 * 10,
  };
  const occupancy = contextOccupancyTokens(perRequest);
  assert.ok(occupancy !== undefined && occupancy < 200_000);
  const misleading = contextOccupancyTokens(aggregate);
  assert.ok(misleading !== undefined && misleading > 200_000);
});

// --- Codex: last request's total, never the thread-cumulative total ----------

const codexParams = (tokenUsage: unknown) => ({
  threadId: "t",
  turnId: "u",
  tokenUsage,
});

test("Codex occupancy uses tokenUsage.last.totalTokens, not the cumulative total", () => {
  const { tokens, contextWindow } = parseThreadTokenUsage(
    codexParams({
      total: {
        totalTokens: 1_450_000,
        inputTokens: 1_400_000,
        cachedInputTokens: 1_300_000,
        outputTokens: 50_000,
        reasoningOutputTokens: 20_000,
      },
      last: {
        totalTokens: 61_000,
        inputTokens: 60_000,
        cachedInputTokens: 55_000,
        outputTokens: 1_000,
        reasoningOutputTokens: 400,
      },
      modelContextWindow: 272_000,
    }),
  );
  assert.equal(tokens, 61_000);
  assert.equal(contextWindow, 272_000);
});

test("Codex occupancy is unknown when last usage or window is absent", () => {
  assert.deepEqual(
    parseThreadTokenUsage(
      codexParams({ total: { totalTokens: 10 }, modelContextWindow: null }),
    ),
    { tokens: undefined, contextWindow: undefined },
  );
  assert.deepEqual(parseThreadTokenUsage({ threadId: "t" }), {
    tokens: undefined,
    contextWindow: undefined,
  });
});

test("Codex non-positive or non-finite occupancy stays unknown through stage rows", () => {
  const theme = { fg: (_color: string, text: string) => text };
  for (const totalTokens of [
    0,
    -1,
    Number.NaN,
    Number.POSITIVE_INFINITY,
    Number.NEGATIVE_INFINITY,
    null,
    "0",
    {},
    undefined,
  ]) {
    const usage = parseThreadTokenUsage(
      codexParams({
        last: { totalTokens },
        modelContextWindow: 200_000,
      }),
    );
    assert.equal(usage.tokens, undefined);
    const lines = renderFooter({
      width: 120,
      theme,
      cwdLabel: "~/repo",
      runtime: "pi/model",
      usage: "",
      pr: "",
      statuses: [],
    });
    assert.equal(lines.length, 2);
    assert.doesNotMatch(lines.join(" "), /%/);
  }
});
