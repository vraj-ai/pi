import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { visibleWidth } from "@earendil-works/pi-tui";
import uiCustomization from "./index.ts";
import {
  layoutColumns,
  normalizeMaxLines,
  renderStatusWidget,
  type StatusWidgetAgent,
  type StatusWidgetState,
} from "./status-widget.ts";

function state(overrides: Partial<StatusWidgetState> = {}): StatusWidgetState {
  return {
    width: 80,
    maxLines: 40,
    ...overrides,
  };
}

function agent(overrides: Partial<StatusWidgetAgent> = {}): StatusWidgetAgent {
  return {
    label: "look around",
    status: "running",
    backend: "pi",
    model: "sol",
    startedAt: 100_000,
    at: 100_000,
    turns: 6,
    context: { kind: "measured", percent: 7 },
    ...overrides,
  };
}

test("empty widget is just the pi rule line", () => {
  const result = renderStatusWidget(state());
  assert.equal(result.length, 1);
  assert.match(result[0], /^─ pi ─/);
  assert.doesNotMatch(
    result.join("\n"),
    /issues|routines|mode workflow|route fleet|planner|coder|debugger|reviewer/,
  );
});

test("agent rows render glyph, label, elapsed, turns, and ctx", () => {
  const result = renderStatusWidget(
    state({ agents: [agent()], now: 106_000, width: 120 }),
  );
  const line = result.find((row) => row.includes("look around")) ?? "";
  assert.match(line, /◉/);
  assert.match(line, /look around/);
  assert.match(line, /pi\/sol/);
  assert.match(line, /6s/);
  assert.match(line, /6t/);
  assert.match(line, /7% ctx/);
});

test("backend/model column is dropped at width < 100", () => {
  const result = renderStatusWidget(
    state({ agents: [agent()], now: 100_000, width: 80 }),
  );
  assert.doesNotMatch(result.join("\n"), /pi\/sol/);
});

test("undefined context renders '? ctx' and never '0%'", () => {
  const result = renderStatusWidget(
    state({
      agents: [agent({ context: { kind: "unknown" } })],
      now: 100_000,
    }),
  );
  assert.match(result.join("\n"), /\? ctx/);
  assert.doesNotMatch(result.join("\n"), /0%/);
});

test("sub-1% context renders '<1% ctx'", () => {
  const result = renderStatusWidget(
    state({
      agents: [agent({ context: { kind: "measured", percent: 0.4 } })],
      now: 100_000,
    }),
  );
  assert.match(result.join("\n"), /<1% ctx/);
});

test("stale readings prefix elapsed with ~", () => {
  const result = renderStatusWidget(
    state({
      agents: [agent({ at: 1_000 })],
      now: 1_000 + 31_000,
    }),
  );
  assert.match(result.join("\n"), /~/);
});

test("overflow uses maxLines and reports suppressed count", () => {
  const agents = Array.from({ length: 50 }, (_, i) =>
    agent({ label: `agent-${i}` }),
  );
  const result = renderStatusWidget(
    state({ agents, maxLines: 10, now: 100_000 }),
  );
  assert.equal(result.length, 10);
  assert.match(result[9], /\+\d+ more/);
});

test("every line stays within the requested width", () => {
  const agents = [agent({ label: "a".repeat(80) }), agent({ status: "done" })];
  for (const width of [40, 80, 120, 200]) {
    for (const line of renderStatusWidget(
      state({ width, agents, now: 100_000 }),
    )) {
      assert.ok(visibleWidth(line) <= width, `${width}: ${line}`);
    }
  }
});

test("zero and negative widths emit nothing", () => {
  assert.deepEqual(renderStatusWidget(state({ width: 0 })), []);
  assert.deepEqual(renderStatusWidget(state({ width: -4 })), []);
});

test("throwing width getter degrades to bounded base lines", () => {
  const exploding = {
    get width(): number {
      throw new Error("nope");
    },
    maxLines: 40,
  } as StatusWidgetState;
  const result = renderStatusWidget(exploding);
  assert.ok(result.length >= 1);
  assert.match(result[0], /^─ pi ─/);
});

test("secret-shaped tokens in model/backend are redacted", () => {
  const result = renderStatusWidget(
    state({
      width: 120,
      now: 100_000,
      agents: [
        agent({
          backend: "sk-abcdefghijklmnop",
          model: "ghp_abcdefghijkl",
        }),
      ],
    }),
  );
  assert.doesNotMatch(
    result.join("\n"),
    /sk-abcdefghijklmnop|ghp_abcdefghijkl/,
  );
  assert.match(result.join("\n"), /\[REDACTED\]/);
});

test("layoutColumns right-aligns numeric cells", () => {
  const rows = layoutColumns(
    [
      ["a", "1", "10"],
      ["bb", "20", "2"],
    ],
    [1, 2],
    40,
  );
  assert.equal(rows.length, 2);
  assert.ok(visibleWidth(rows[0]) <= 40);
});

test("glyphs for running/done/idle/error are distinct without colour", () => {
  const result = renderStatusWidget(
    state({
      now: 100_000,
      agents: [
        agent({ label: "r", status: "running" }),
        agent({ label: "d", status: "done" }),
        agent({ label: "e", status: "error" }),
        agent({ label: "i", status: "idle" }),
      ],
    }),
  );
  const text = result.join("\n");
  assert.match(text, /◉/);
  assert.match(text, /✓/);
  assert.match(text, /×/);
  assert.match(text, /·/);
});

test("normalizeMaxLines maps 0 to unlimited and clamps the rest", () => {
  assert.equal(normalizeMaxLines(0), Number.POSITIVE_INFINITY);
  assert.equal(normalizeMaxLines(undefined), 40);
  assert.equal(normalizeMaxLines(-3), 8);
  assert.equal(normalizeMaxLines(999), 200);
  assert.equal(normalizeMaxLines(Number.NaN), 40);
});

test("terminal height caps unlimited output", () => {
  const agents = Array.from({ length: 40 }, (_, i) =>
    agent({ label: `a${i}` }),
  );
  const result = renderStatusWidget(
    state({
      agents,
      maxLines: 0,
      terminalRows: 20,
      reservedRows: 6,
      now: 100_000,
    }),
  );
  assert.ok(result.length <= 14);
  assert.match(result.at(-1) ?? "", /more/);
});

test("render module has no filesystem or network path", () => {
  const source = readFileSync(
    new URL("./status-widget.ts", import.meta.url),
    "utf8",
  );
  assert.doesNotMatch(
    source,
    /from\s+["']node:(fs|child_process|http|https|net)/,
  );
});

test("registers belowEditor widget and clears it on shutdown", () => {
  const listeners = new Map<string, Set<(value: unknown) => void>>();
  const hooks = new Map<string, (...args: unknown[]) => void>();
  const widgets: Array<{ key: string; content: unknown; options?: unknown }> =
    [];
  let headerFactory: unknown;
  let footerFactory: unknown;
  const theme = { fg: (_color: string, text: string) => text };
  const pi = {
    events: {
      on(channel: string, handler: (value: unknown) => void) {
        const channelListeners = listeners.get(channel) ?? new Set();
        channelListeners.add(handler);
        listeners.set(channel, channelListeners);
        return () => channelListeners.delete(handler);
      },
      emit(channel: string, value: unknown) {
        for (const handler of listeners.get(channel) ?? []) handler(value);
      },
    },
    on(event: string, handler: (...args: unknown[]) => void) {
      hooks.set(event, handler);
    },
  };
  const context = {
    cwd: "/repo",
    mode: "tui",
    ui: {
      theme,
      setHeader(factory: unknown) {
        headerFactory = factory;
      },
      setFooter(factory: unknown) {
        footerFactory = factory;
      },
      setWidget(key: string, content: unknown, options?: unknown) {
        widgets.push({ key, content, options });
      },
      setTitle() {},
    },
  };

  uiCustomization(pi as never);
  hooks.get("session_start")?.({}, context);
  assert.equal(widgets[0].key, "vraj-status");
  assert.deepEqual(widgets[0].options, { placement: "belowEditor" });
  assert.ok(headerFactory);
  assert.ok(footerFactory);

  hooks.get("session_shutdown")?.({}, context);
  assert.equal(widgets.at(-1)?.content, undefined);
});
