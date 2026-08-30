import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { visibleWidth } from "@earendil-works/pi-tui";
import {
  SUBAGENT_STATE_CHANNEL,
  type SubagentSummary,
} from "../shared/workflow-state.ts";
import { renderFooter, type FooterState } from "./footer.ts";
import uiCustomization from "./index.ts";

const plainTheme = { fg: (_color: string, text: string) => text };

function agent(overrides: Partial<SubagentSummary> = {}) {
  return {
    id: "a1",
    title: "agent",
    status: "running" as const,
    backend: "pi" as const,
    startedAt: 1_000,
    turns: 3,
    ...overrides,
  };
}

function state(overrides: Partial<FooterState> = {}): FooterState {
  return {
    width: 80,
    theme: plainTheme,
    cwdLabel: "~/repo",
    runtime: "pi/model · high",
    usage: "42%/200k · $0.12 · 13 tok/s",
    pr: "main · 2 changed",
    statuses: [],
    ...overrides,
  };
}

test("no extension statuses renders exactly the 2 base lines", () => {
  assert.equal(renderFooter(state()).length, 2);
});

test("every line fits the requested width at 40, 80, 120, and 200", () => {
  for (const width of [40, 80, 120, 200]) {
    const lines = renderFooter(
      state({
        width,
        statuses: [
          "some extension status line that is far too long to fit",
          "a second\nsplit status line",
        ],
      }),
    );
    assert.ok(lines.length <= 7);
    for (const line of lines) {
      assert.ok(
        visibleWidth(line) <= width,
        `width ${width}: ${JSON.stringify(line)} is ${visibleWidth(line)}`,
      );
    }
  }
});

test("extension status lines append after the base, split and truncated, capped at 7 total", () => {
  const lines = renderFooter(
    state({
      width: 30,
      statuses: [
        "one\ntwo three four five six seven",
        "three",
        "four",
        "five",
        "six",
      ],
    }),
  );
  assert.equal(lines.length, 7);
  assert.equal(lines[2], "one");
  assert.ok(visibleWidth(lines[3]) <= 30);
  assert.ok(lines[4].includes("three"));
  assert.ok(lines[5].includes("four"));
});

test("the footer never exceeds 7 lines for any tested state", () => {
  for (const width of [20, 40, 80, 120, 200]) {
    const lines = renderFooter(
      state({
        width,
        statuses: Array.from({ length: 12 }, (_, i) => `status ${i + 1}`),
      }),
    );
    assert.ok(lines.length <= 7, `width ${width}: ${lines.length} lines`);
  }
});

test("PI-39: INV-4 footer clause unchanged — exactly 3 lines bare, at most 7 with 10 statuses", () => {
  assert.equal(renderFooter(state()).length, 2);
  const withTen = renderFooter(
    state({
      statuses: Array.from({ length: 10 }, (_, i) => `status ${i + 1}`),
    }),
  );
  assert.ok(withTen.length <= 7, `${withTen.length} lines with 10 statuses`);
});

test("1 000 renders at width 200 complete in under 2 000 ms", () => {
  const input = state({
    width: 200,
    statuses: ["status one", "status two"],
  });
  const start = performance.now();
  for (let i = 0; i < 1_000; i++) renderFooter(input);
  const elapsed = performance.now() - start;
  assert.ok(elapsed < 2_000, `1000 renders took ${elapsed}ms`);
});

test("the module imports no fs, subprocess, or network APIs", () => {
  const source = readFileSync(new URL("./footer.ts", import.meta.url), "utf8");
  assert.doesNotMatch(
    source,
    /from\s+["']node:(fs|child_process|http|https|net|os|path)/,
  );
  assert.doesNotMatch(source, /\b(fetch|XMLHttpRequest|WebSocket)\s*\(/);
});

test("the shipped index.ts footer wrapper performs no render-path I/O", () => {
  const source = readFileSync(new URL("./index.ts", import.meta.url), "utf8");
  // The wrapper may import node:os/node:path for identity, but render-path
  // purity (INV-3) is unprovable if any I/O-capable module can be imported at
  // all: an imported binding could be called inside render while a region
  // scan only searches for the module-specifier text. Forbid the modules
  // module-wide so the invariant is mutation-proof.
  assert.doesNotMatch(
    source,
    /from\s+["']node:(fs|child_process|http|https|net)/,
  );
  assert.doesNotMatch(source, /\b(fetch|XMLHttpRequest|WebSocket)\s*\(/);
  // And no I/O binding call may appear in the footer render region.
  const renderRegion = source.slice(source.indexOf("setFooter"), source.length);
  assert.doesNotMatch(
    renderRegion,
    /\b(readFileSync|writeFileSync|readdirSync|execSync|spawn|exec|fetch|XMLHttpRequest|WebSocket)\s*\(/,
  );
});

test("very narrow and non-finite widths never throw or overflow", () => {
  const input = state({
    width: 0,
    cwdLabel: "~/repo",
    statuses: ["模型😀"],
  });
  for (const width of [0, 1, 2, 3, 4, 19, Number.NaN, Infinity]) {
    assert.doesNotThrow(() => renderFooter({ ...input, width }));
    const lines = renderFooter({ ...input, width });
    for (const line of lines) {
      assert.ok(
        visibleWidth(line) <=
          Math.max(0, Math.floor(Number.isFinite(width) ? width : 0)),
        `${width}: ${JSON.stringify(line)}`,
      );
    }
  }
});

test("ANSI width is measured visibly in the base lines", () => {
  const ansiTheme = {
    fg: (_color: string, text: string) => `\u001b[38;5;33m${text}\u001b[0m`,
  };
  const lines = renderFooter(
    state({
      width: 80,
      theme: ansiTheme,
      cwdLabel: "模型😀模型😀模型😀",
    }),
  );
  assert.equal(lines.length, 2);
  for (const line of lines) assert.ok(visibleWidth(line) <= 80);
});

test("theme and status rendering failures fall back to bounded base lines", () => {
  const lines = renderFooter(
    state({
      statuses: ["a status that should not escape the width"],
      theme: {
        fg() {
          throw new Error("theme unavailable");
        },
      },
    }),
  );

  assert.equal(lines.length, 3);
  for (const line of lines) assert.ok(visibleWidth(line) <= 80);
});

test("PI-26 dedup: footer renders no mode/route/stage-row/issue tokens", () => {
  // The footer state no longer carries agents, routeStatus, readingFor, or
  // reasonFor. Pass the old-style data as a raw object to prove the render
  // path ignores it: no belowEditor status token leaks into the footer for
  // the same underlying state.
  const legacy = {
    width: 200,
    theme: plainTheme,
    cwdLabel: "~/repo",
    runtime: "pi/model · high",
    usage: "42%/200k · $0.12 · 13 tok/s",
    pr: "main · 2 changed",
    statuses: [] as readonly string[],
    routeStatus: "fleet/coder · running · 1 running · 4 tracked",
    agents: [agent({ modelLabel: "deepseek-v4-flash", turns: 6 })],
  } as const;
  const lines = renderFooter(legacy as unknown as FooterState);

  assert.equal(lines.length, 2);
  assert.ok(lines[0].includes("~/repo"));
  const all = lines.join("\n");
  assert.doesNotMatch(all, /mode (workflow|free)/);
  assert.doesNotMatch(all, /route (fleet|direct)/);
  assert.doesNotMatch(all, /% ctx/);
  assert.doesNotMatch(all, /running|tracked/);
  assert.doesNotMatch(all, /deepseek-v4-flash|PI-\d+/);
  // PI-39: the stage rail is removed, so no stage token may appear at all.
  assert.doesNotMatch(all, /planner|coder|debugger|reviewer|flow/);
});

test("live state reaches the footer as base lines plus extension statuses only", () => {
  type EventHandler = (value: unknown) => void;
  const listeners = new Map<string, Set<EventHandler>>();
  const hooks = new Map<string, (...args: unknown[]) => void>();
  let headerFactory:
    | ((
        tui: { requestRender(): void },
        theme: typeof plainTheme,
      ) => { render(width: number): string[] })
    | undefined;
  let footerFactory:
    | ((
        tui: { requestRender(): void },
        theme: typeof plainTheme,
        footerData: { getExtensionStatuses(): Map<string, string> },
      ) => { render(width: number): string[] })
    | undefined;
  const theme = plainTheme;
  const pi = {
    events: {
      on(channel: string, handler: EventHandler) {
        const channelListeners =
          listeners.get(channel) ?? new Set<EventHandler>();
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
    getThinkingLevel() {
      return "high";
    },
  };
  const context = {
    mode: "tui",
    cwd: "/repo",
    ui: {
      theme,
      setHeader(factory: typeof headerFactory) {
        headerFactory = factory;
      },
      setFooter(factory: typeof footerFactory) {
        footerFactory = factory;
      },
      setTitle() {},
    },
  };

  uiCustomization(pi as never);
  hooks.get("session_start")?.({}, context);
  assert.ok(headerFactory);
  assert.ok(footerFactory);
  const header = headerFactory({ requestRender() {} }, theme);
  const footer = footerFactory({ requestRender() {} }, theme, {
    getExtensionStatuses: () => new Map(),
  });
  pi.events.emit(SUBAGENT_STATE_CHANNEL, [
    agent({
      id: "sa-1",
      contextTokens: 25,
      contextWindow: 100,
    }),
    agent({ id: "helper-agent" }),
  ]);

  // PI-26 dedup: subagent stage rows do not reach the footer anymore; they
  // live in the belowEditor widget. The footer stays at the 2 base lines.
  const lines = footer.render(80);
  assert.equal(lines.length, 2);
  assert.ok(!lines.some((line) => line.includes("sa-1")));
  assert.ok(!lines.some((line) => line.includes("%")));
  assert.ok(!lines.some((line) => line.includes("helper-agent")));
  assert.ok(lines[0].includes("/repo"));
  assert.doesNotMatch([...header.render(80), ...lines].join("\n"), /steer/i);

  // Extension statuses still append within the 7-line budget.
  const statusFooter = footerFactory({ requestRender() {} }, theme, {
    getExtensionStatuses: () => new Map([["ext", "status one"]]),
  });
  const statusLines = statusFooter.render(80);
  assert.equal(statusLines.length, 3);
  assert.ok(statusLines[2].includes("status one"));

  // INV-6: a throwing extension-status getter degrades to the 2 base lines.
  const statusFailureFooter = footerFactory({ requestRender() {} }, theme, {
    getExtensionStatuses() {
      throw new Error("status provider unavailable");
    },
  });
  assert.doesNotThrow(() => statusFailureFooter.render(80));
  assert.equal(statusFailureFooter.render(80).length, 2);

  // INV-3: the shipped wrapper (index.ts) renders within budget too — the
  // pure-footer benchmark above must not be the only perf proof.
  const liveFooter = footerFactory({ requestRender() {} }, theme, {
    getExtensionStatuses: () => new Map([["ext", "status"]]),
  });
  const start = performance.now();
  for (let i = 0; i < 1_000; i++) liveFooter.render(200);
  const elapsed = performance.now() - start;
  assert.ok(elapsed < 2_000, `wrapper: 1000 renders took ${elapsed}ms`);
});
