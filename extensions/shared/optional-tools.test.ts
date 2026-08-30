import assert from "node:assert/strict";
import { test } from "node:test";
import {
  OptionalToolRegistry,
  readLeanSetting,
  type ToolRegistryHost,
} from "./optional-tools.ts";

/** A host that records what the registry asked pi to activate. */
function fakeHost(allTools: string[]): ToolRegistryHost & {
  active: string[];
  calls: number;
} {
  const state = {
    active: [...allTools],
    calls: 0,
    getActiveTools: () => state.active,
    getAllTools: () => allTools.map((name) => ({ name })),
    setActiveTools: (names: string[]) => {
      state.calls += 1;
      state.active = names;
    },
  };
  return state;
}

const optional = (name: string, leanDefault: "on" | "off" = "off") => ({
  name,
  summary: `${name} summary`,
  leanDefault,
  rationale: `${name} is safe to leave off until it is needed`,
});

test("lean mode withholds opt-in tools from the model", () => {
  const host = fakeHost(["read", "bash", "usage_stats", "extract"]);
  const registry = new OptionalToolRegistry();
  registry.register(optional("usage_stats"));
  registry.register(optional("extract"));
  registry.bind(host);

  assert.deepEqual(host.active, ["read", "bash"]);
  assert.deepEqual(registry.disabledNames().sort(), ["extract", "usage_stats"]);
});

test("non-optional tools are never removed", () => {
  const host = fakeHost(["read", "bash", "search", "scrape", "extract"]);
  const registry = new OptionalToolRegistry();
  // `search`/`scrape` are the always-available simple Firecrawl surface and are
  // deliberately not registered as optional.
  registry.register(optional("extract"));
  registry.bind(host);

  assert.ok(host.active.includes("search"));
  assert.ok(host.active.includes("scrape"));
  assert.ok(!host.active.includes("extract"));
});

test("a tool can be switched on and off mid-session", () => {
  const host = fakeHost(["read", "usage_stats"]);
  const registry = new OptionalToolRegistry();
  registry.register(optional("usage_stats"));
  registry.bind(host);
  assert.deepEqual(host.active, ["read"]);

  assert.equal(registry.set("usage_stats", "on"), true);
  assert.deepEqual(host.active, ["read", "usage_stats"]);
  assert.equal(registry.stateOf("usage_stats"), "on");

  assert.equal(registry.set("usage_stats", "off"), true);
  assert.deepEqual(host.active, ["read"]);

  assert.equal(registry.set("not_a_tool", "on"), false);
});

test("full mode offers everything, lean mode restores the defaults", () => {
  const host = fakeHost(["read", "usage_stats", "extract"]);
  const registry = new OptionalToolRegistry();
  registry.register(optional("usage_stats"));
  registry.register(optional("extract"));
  registry.bind(host);

  registry.setLean(false);
  assert.deepEqual(host.active.sort(), ["extract", "read", "usage_stats"]);
  assert.equal(registry.lean, false);

  registry.setLean(true);
  assert.deepEqual(host.active, ["read"]);
});

test("switching mode does not undo an explicit choice", () => {
  const host = fakeHost(["read", "usage_stats", "extract"]);
  const registry = new OptionalToolRegistry();
  registry.register(optional("usage_stats"));
  registry.register(optional("extract"));
  registry.bind(host);

  registry.set("usage_stats", "on");
  registry.setLean(true);
  assert.ok(
    host.active.includes("usage_stats"),
    "an explicit on must survive re-applying lean defaults",
  );
  assert.ok(
    !host.active.includes("extract"),
    "untouched tools follow the mode",
  );
});

test("on-demand enable respects an explicit off", () => {
  const host = fakeHost(["read", "read_raw_output"]);
  const registry = new OptionalToolRegistry();
  registry.register(optional("read_raw_output"));
  registry.bind(host);

  // Nothing has been compressed yet, so the tool is not offered.
  assert.deepEqual(host.active, ["read"]);

  // The first compression makes it useful.
  assert.equal(registry.enableOnDemand("read_raw_output"), true);
  assert.deepEqual(host.active, ["read", "read_raw_output"]);
  // Already on: no further work.
  assert.equal(registry.enableOnDemand("read_raw_output"), false);

  // A deliberate off is not silently undone by the next compression.
  registry.set("read_raw_output", "off");
  assert.equal(registry.enableOnDemand("read_raw_output"), false);
  assert.deepEqual(host.active, ["read"]);

  assert.equal(registry.enableOnDemand("unknown"), false);
});

test("a tool registered while lean starts at its lean default", () => {
  const host = fakeHost(["read", "always", "sometimes"]);
  const registry = new OptionalToolRegistry();
  registry.bind(host);
  registry.register(optional("always", "on"));
  registry.register(optional("sometimes", "off"));

  assert.deepEqual(host.active.sort(), ["always", "read"]);
});

test("registering the same tool twice keeps its current state", () => {
  const host = fakeHost(["read", "usage_stats"]);
  const registry = new OptionalToolRegistry();
  registry.register(optional("usage_stats"));
  registry.bind(host);
  registry.set("usage_stats", "on");

  registry.register(optional("usage_stats"));
  assert.equal(registry.stateOf("usage_stats"), "on");
});

test("an unbound or broken host degrades to leaving every tool active", () => {
  const registry = new OptionalToolRegistry();
  registry.register(optional("usage_stats"));
  // No host bound: recording state must not throw.
  assert.doesNotThrow(() => registry.set("usage_stats", "on"));

  const broken: ToolRegistryHost = {
    getActiveTools: () => {
      throw new Error("no");
    },
    getAllTools: () => {
      throw new Error("no");
    },
    setActiveTools: () => {
      throw new Error("no");
    },
  };
  registry.bind(broken);
  assert.doesNotThrow(() => registry.set("usage_stats", "off"));
});

test("apply does nothing when the active set already matches", () => {
  const host = fakeHost(["read", "usage_stats"]);
  const registry = new OptionalToolRegistry();
  registry.register(optional("usage_stats"));
  registry.bind(host);
  const after = host.calls;
  registry.apply();
  registry.apply();
  assert.equal(host.calls, after, "a no-op apply must not churn the tool set");
});

test("the listing is stable and reports every tool's state", () => {
  const registry = new OptionalToolRegistry();
  registry.register(optional("zebra"));
  registry.register(optional("alpha", "on"));
  assert.deepEqual(
    registry.list().map((entry) => [entry.tool.name, entry.state]),
    [
      ["alpha", "on"],
      ["zebra", "off"],
    ],
  );
});

test("the lean setting defaults on and only a real boolean turns it off", () => {
  assert.equal(readLeanSetting({}), true);
  assert.equal(readLeanSetting({ "vraj.tools.lean": false }), false);
  assert.equal(readLeanSetting({ "vraj.tools.lean": true }), true);
  assert.equal(readLeanSetting({ "vraj.tools.lean": "no" }), true);
});
