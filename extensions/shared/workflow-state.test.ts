import assert from "node:assert/strict";
import test from "node:test";
import { isSubagentSummary } from "./workflow-state.ts";

const base = {
  id: "sa-1",
  title: "look around",
  status: "running" as const,
  backend: "pi" as const,
  startedAt: 1,
  turns: 1,
};

test("a complete summary is accepted", () => {
  assert.equal(isSubagentSummary(base), true);
  assert.equal(
    isSubagentSummary({ ...base, modelLabel: "sol", turns: 3 }),
    true,
  );
});

test("missing or non-finite startedAt is rejected", () => {
  const { startedAt: _, ...missing } = base;
  assert.equal(isSubagentSummary(missing), false);
  assert.equal(isSubagentSummary({ ...base, startedAt: "just now" }), false);
  assert.equal(isSubagentSummary({ ...base, startedAt: null }), false);
  assert.equal(isSubagentSummary({ ...base, startedAt: Number.NaN }), false);
  assert.equal(
    isSubagentSummary({ ...base, startedAt: Number.POSITIVE_INFINITY }),
    false,
  );
});

test("unknown backends and statuses are rejected", () => {
  assert.equal(isSubagentSummary({ ...base, backend: "workflow" }), false);
  assert.equal(isSubagentSummary({ ...base, status: "routing" }), false);
  assert.equal(isSubagentSummary(null), false);
});
