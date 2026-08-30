import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import type {
  ExtensionCommandContext,
  KeybindingsManager,
  Theme,
} from "@earendil-works/pi-coding-agent";
import { visibleWidth } from "@earendil-works/pi-tui";
import type { Component, TUI } from "@earendil-works/pi-tui";
import type { SubagentSnapshot } from "./src/domain.ts";
import type { SubagentReadModel } from "./src/manager.ts";
import {
  openSubagentPicker,
  openSubagentTranscript,
  reconcileDashboardSelection,
  sortSubagents,
  type DashboardSelection,
} from "./src/ui/takeover.ts";

type TakeoverComponent = Component & { dispose?(): void };

type TakeoverFactory = (
  tui: TUI,
  theme: Theme,
  keybindings: KeybindingsManager,
  done: (result: null) => void,
) => TakeoverComponent;

type TakeoverInternals = {
  input: { onSubmit?: (value: string) => void };
};

type DashboardFactory = (
  tui: TUI,
  theme: Theme,
  keybindings: KeybindingsManager,
  done: (result: string | null) => void,
) => TakeoverComponent;

const snapshot = (): SubagentSnapshot => ({
  id: "sa-1",
  origin: "model",
  backend: "codex",
  title: "agent",
  prompt: "prompt",
  cwd: "/tmp",
  status: "running",
  createdAt: 1_000,
  meta: { backend: "codex" },
  usage: {},
  transcript: [],
  liveTools: [],
  queued: [],
  finalText: "",
  turns: 0,
});

const mkSnap = (
  id: string,
  status: SubagentSnapshot["status"],
  createdAt: number,
): SubagentSnapshot => ({ ...snapshot(), id, status, createdAt });

async function openPickerForTest(snaps: ReadonlyArray<SubagentSnapshot>) {
  const components: TakeoverComponent[] = [];
  const pending: Array<(value: string | null) => void> = [];
  const sends: string[] = [];
  const bindings = new Set<string>();
  const tui = {
    requestRender: () => {},
    terminal: { rows: 30 },
  } as unknown as TUI;
  const theme = {
    fg: (_color: string, text: string) => text,
    bold: (text: string) => text,
  } as unknown as Theme;
  const keybindings = {
    getKeys: (binding: string) =>
      binding === "tui.select.confirm"
        ? ["enter"]
        : binding === "tui.select.cancel"
          ? ["esc"]
          : ["up", "down"],
    matches: (data: string, key: string) => bindings.has(`${data}:${key}`),
  } as unknown as KeybindingsManager;
  const view = {
    size: () => snaps.length,
    list: () => snaps,
    get: (id: string) => snaps.find((s) => s.id === id),
    subscribe: () => () => {},
    subscribeTo: () => () => {},
    requestAbort: () => {},
    requestSend: (_id: string, text: string) => {
      sends.push(text);
    },
  } as unknown as SubagentReadModel;
  const context = {
    ui: {
      custom: async (factory: unknown) => {
        if (typeof factory !== "function") throw new Error("missing factory");
        components.push(
          (factory as DashboardFactory)(tui, theme, keybindings, (result) => {
            pending.shift()?.(result);
          }),
        );
        return new Promise<string | null>((resolve) => pending.push(resolve));
      },
    },
  } as unknown as ExtensionCommandContext;
  const flush = () => new Promise<void>((resolve) => setTimeout(resolve, 0));
  const picker = openSubagentPicker(context, view);
  await flush();
  return { bindings, components, flush, pending, picker, sends };
}

async function openForTest(snap: SubagentSnapshot) {
  let component: TakeoverComponent | undefined;
  let closed = false;
  let aborts = 0;
  let sends: string[] = [];
  let renders = 0;
  const tui = {
    requestRender: () => {
      renders++;
    },
    terminal: { rows: 30 },
  } as unknown as TUI;
  const theme = {
    fg: (_color: string, text: string) => text,
    bold: (text: string) => text,
  } as unknown as Theme;
  const bindings = new Set<string>();
  const keybindings = {
    getKeys: () => ["enter"],
    matches: (data: string, key: string) => bindings.has(`${data}:${key}`),
  } as unknown as KeybindingsManager;
  const view = {
    get: (id: string) => (id === snap.id ? snap : undefined),
    subscribeTo: () => () => {},
    requestAbort: () => {
      aborts++;
    },
    requestSend: (_id: string, text: string) => {
      sends.push(text);
    },
  } as unknown as SubagentReadModel;
  const factoryContext = {
    ui: {
      custom: async (factory: unknown) => {
        if (typeof factory !== "function") throw new Error("missing factory");
        component = (factory as TakeoverFactory)(
          tui,
          theme,
          keybindings,
          () => {
            closed = true;
          },
        );
        return null;
      },
    },
  } as unknown as ExtensionCommandContext;
  await openSubagentTranscript(factoryContext, view, snap.id);
  if (!component) throw new Error("takeover component was not created");
  return {
    component,
    bindings,
    get aborts() {
      return aborts;
    },
    get sends() {
      return sends;
    },
    get renders() {
      return renders;
    },
    get closed() {
      return closed;
    },
  };
}

test("the stage transcript view has no send path and bounds its errors", async () => {
  const harness = await openForTest({
    ...snapshot(),
    errorText: "Authorization: Bearer STAGE_RUNTIME_SECRET\u001b[31m",
    liveAssistant: {
      thinking: "",
      text: "Authorization: Bearer STAGE_LIVE_SECRET\u001b[32m",
    },
  });
  try {
    harness.bindings.add("clear:app.clear");
    harness.component.handleInput?.("clear");
    assert.equal(harness.aborts, 1);

    harness.bindings.add("up:tui.editor.cursorUp");
    harness.component.handleInput?.("up");
    assert.equal(harness.renders, 1);

    // Herdr: no takeover. Typing goes nowhere and no send is ever requested.
    const internals = harness.component as unknown as TakeoverInternals;
    assert.equal(
      internals.input,
      undefined,
      "the read-only view must not hold an input component",
    );
    harness.component.handleInput?.("direct answer");
    assert.deepEqual(harness.sends, []);

    const lines = harness.component.render(40);
    const output = lines.join("\n");
    assert.match(output, /read-only/);
    assert.doesNotMatch(output, /Send to /);
    assert.doesNotMatch(
      output,
      /STAGE_SEND|STAGE_RUNTIME|STAGE_LIVE|\u001b\[31m|\u001b\[32m/,
    );
    assert.ok(lines.every((line) => visibleWidth(line) <= 40));
    for (const width of [1, 20, 40, 80]) {
      assert.doesNotThrow(() => harness.component.render(width));
      assert.ok(
        harness.component
          .render(width)
          .every((line) => visibleWidth(line) <= Math.max(1, width)),
      );
    }

    harness.bindings.add("escape:app.interrupt");
    harness.component.handleInput?.("escape");
    assert.equal(harness.closed, true);
  } finally {
    harness.component.dispose?.();
  }
});

test("dashboard can abort a running subagent with x", async () => {
  const stage = snapshot();
  let component: TakeoverComponent | undefined;
  let aborts = 0;
  const tui = {
    requestRender: () => {},
    terminal: { rows: 30 },
  } as unknown as TUI;
  const theme = {
    fg: (_color: string, text: string) => text,
    bold: (text: string) => text,
  } as unknown as Theme;
  const keybindings = {
    getKeys: () => [],
    matches: () => false,
  } as unknown as KeybindingsManager;
  const view = {
    size: () => 1,
    list: () => [stage],
    subscribe: () => () => {},
    requestAbort: () => {
      aborts++;
    },
  } as unknown as SubagentReadModel;
  const context = {
    ui: {
      custom: async (factory: unknown) => {
        if (typeof factory !== "function") throw new Error("missing factory");
        component = (factory as DashboardFactory)(
          tui,
          theme,
          keybindings,
          () => {},
        );
        return null;
      },
    },
  } as unknown as ExtensionCommandContext;

  await openSubagentPicker(context, view);
  try {
    component?.handleInput?.("x");
    assert.equal(aborts, 1);
    assert.match(component?.render(80).join("\n") ?? "", /x abort/);
  } finally {
    component?.dispose?.();
  }
});

test("the helper transcript view keeps abort but has no send", async () => {
  const harness = await openForTest(snapshot());
  try {
    harness.bindings.add("clear:app.clear");
    harness.component.handleInput?.("clear");
    assert.equal(harness.aborts, 1);

    const internals = harness.component as unknown as TakeoverInternals;
    assert.equal(internals.input, undefined);
    harness.component.handleInput?.("follow up");
    assert.deepEqual(harness.sends, [], "no takeover: nothing is ever sent");
  } finally {
    harness.component.dispose?.();
  }
});

test("settled helper takeover does not advertise abort", async () => {
  const harness = await openForTest({
    ...snapshot(),
    status: "done",
    settledAt: 1_000,
  });
  try {
    assert.doesNotMatch(harness.component.render(120).join("\\n"), /abort run/);
  } finally {
    harness.component.dispose?.();
  }
});

test("dashboard preserves tiny measured context and terminal width with Unicode titles", async () => {
  const snap = {
    ...snapshot(),
    title: "日本語🙂 dashboard title that needs truncation",
    usage: { tokens: 1, contextWindow: 200_000 },
  };
  let component: TakeoverComponent | undefined;
  const tui = {
    requestRender: () => {},
    terminal: { rows: 30 },
  } as unknown as TUI;
  const theme = {
    fg: (_color: string, text: string) => text,
    bold: (text: string) => text,
  } as unknown as Theme;
  const keybindings = {
    getKeys: () => [],
    matches: () => false,
  } as unknown as KeybindingsManager;
  const view = {
    size: () => 1,
    list: () => [snap],
    get: (id: string) => (id === snap.id ? snap : undefined),
    subscribe: () => () => {},
  } as unknown as SubagentReadModel;
  const context = {
    ui: {
      custom: async (factory: unknown) => {
        if (typeof factory !== "function") throw new Error("missing factory");
        component = (factory as DashboardFactory)(
          tui,
          theme,
          keybindings,
          () => {},
        );
        return null;
      },
    },
  } as unknown as ExtensionCommandContext;

  await openSubagentPicker(context, view);
  try {
    if (!component) throw new Error("dashboard was not created");
    const lines = component.render(80);
    const output = lines.join("\n");
    assert.match(output, /<1%\/200k/);
    assert.doesNotMatch(output, /0%/);
    assert.ok(lines.every((line) => visibleWidth(line) <= 80));
  } finally {
    component?.dispose?.();
  }
});

test("stage takeover preserves tiny measured context in its width-bounded header", async () => {
  const harness = await openForTest({
    ...snapshot(),
    title: "日本語🙂 takeover title",
    usage: { tokens: 1, contextWindow: 200_000 },
  });
  try {
    const lines = harness.component.render(80);
    const output = lines.join("\n");
    assert.match(output, /<1%\/200k/);
    assert.doesNotMatch(output, /0%/);
    assert.ok(lines.every((line) => visibleWidth(line) <= 80));
  } finally {
    harness.component.dispose?.();
  }
});

test("no send path survives in the transcript view; the tool relay stays blocked", () => {
  const source = readFileSync(
    new URL("./src/ui/takeover.ts", import.meta.url),
    "utf8",
  );
  assert.doesNotMatch(source, /requestStageSend\(/);
  assert.doesNotMatch(source, /requestSend\(/);
  assert.doesNotMatch(source, /new Input\(/);
});

test("dashboard selection follows its subagent id and falls back by row", () => {
  const selection: DashboardSelection = { id: "sa-7", index: 6 };

  reconcileDashboardSelection(selection, [
    { id: "sa-new" },
    ...Array.from({ length: 8 }, (_, index) => ({ id: `sa-${index + 1}` })),
  ]);
  assert.deepEqual(selection, { id: "sa-7", index: 7 });

  reconcileDashboardSelection(selection, [
    ...Array.from({ length: 6 }, (_, index) => ({ id: `sa-${index + 1}` })),
    { id: "sa-8" },
    { id: "sa-9" },
  ]);
  assert.deepEqual(selection, { id: "sa-9", index: 7 });

  reconcileDashboardSelection(selection, [{ id: "sa-1" }, { id: "sa-2" }]);
  assert.deepEqual(selection, { id: "sa-2", index: 1 });

  reconcileDashboardSelection(selection, []);
  assert.deepEqual(selection, { id: undefined, index: 0 });
});

test("sortSubagents lists running first, then done, then error, with stable tiebreaks", () => {
  const input = [
    mkSnap("sa-done", "done", 3_000),
    mkSnap("sa-run-c", "running", 2_000),
    mkSnap("sa-err", "error", 4_000),
    mkSnap("sa-run-b", "running", 1_000),
    mkSnap("sa-run-a", "running", 2_000),
  ];
  const sorted = sortSubagents(input);
  assert.deepEqual(
    sorted.map((snap) => snap.id),
    ["sa-run-b", "sa-run-a", "sa-run-c", "sa-done", "sa-err"],
  );
  // The input array is not mutated.
  assert.deepEqual(
    input.map((snap) => snap.id),
    ["sa-done", "sa-run-c", "sa-err", "sa-run-b", "sa-run-a"],
  );
});

test("rendered dashboard orders running first, then done, then error, filtering nothing", async () => {
  const snaps = [
    mkSnap("sa-done", "done", 3_000),
    mkSnap("sa-run-a", "running", 2_000),
    mkSnap("sa-err", "error", 4_000),
    mkSnap("sa-run-b", "running", 1_000),
  ];
  const harness = await openPickerForTest(snaps);
  try {
    const lines = harness.components[0].render(120);
    const position = (id: string) =>
      lines.findIndex((line) => line.includes(id));
    assert.ok(position("sa-run-a") >= 0);
    assert.ok(position("sa-run-b") >= 0);
    assert.ok(position("sa-run-b") < position("sa-run-a"));
    assert.ok(position("sa-run-a") < position("sa-done"));
    assert.ok(position("sa-done") < position("sa-err"));
    assert.deepEqual(
      snaps.map((snap) => snap.id),
      ["sa-done", "sa-run-a", "sa-err", "sa-run-b"],
    );
  } finally {
    harness.components.forEach((component) => component.dispose?.());
  }
});

test("selection id survives a reorder after the dashboard sorts", () => {
  const sorted = sortSubagents([
    mkSnap("sa-done", "done", 3_000),
    mkSnap("sa-run-a", "running", 2_000),
    mkSnap("sa-err", "error", 4_000),
    mkSnap("sa-run-b", "running", 1_000),
  ]);
  const selection: DashboardSelection = { id: "sa-run-b", index: 0 };
  reconcileDashboardSelection(selection, sorted);
  assert.equal(selection.id, "sa-run-b");
  assert.equal(
    selection.index,
    sorted.findIndex((snap) => snap.id === "sa-run-b"),
  );
});

test("picker returns to the dashboard after a transcript view resolves", async () => {
  const snaps = [
    mkSnap("sa-run-1", "running", 1_000),
    mkSnap("sa-done", "done", 2_000),
  ];
  const harness = await openPickerForTest(snaps);
  try {
    assert.equal(harness.components.length, 1);

    // Confirm the selected running agent: the dashboard resolves, the picker
    // loop opens a takeover instead of returning to the caller.
    harness.bindings.add("enter:tui.select.confirm");
    harness.components[0].handleInput?.("enter");
    await harness.flush();
    assert.equal(harness.components.length, 2);
    assert.match(harness.components[1].render(80).join("\n"), /read-only/);
    assert.deepEqual(harness.sends, []);

    // Closing the takeover resolves it; the loop re-renders the dashboard.
    harness.bindings.add("escape:app.interrupt");
    harness.components[1].handleInput?.("escape");
    await harness.flush();
    assert.equal(harness.components.length, 3);
    assert.match(harness.components[2].render(80).join("\n"), /Subagents/);

    // Cancelling the re-rendered dashboard returns to the main session.
    harness.bindings.add("escape:tui.select.cancel");
    harness.components[2].handleInput?.("escape");
    await harness.picker;
    assert.equal(harness.components.length, 3);
  } finally {
    harness.components.forEach((component) => component.dispose?.());
  }
});

test("cancelling the dashboard returns to the session without opening a takeover", async () => {
  const snaps = [mkSnap("sa-run-1", "running", 1_000)];
  const harness = await openPickerForTest(snaps);
  try {
    assert.equal(harness.components.length, 1);
    harness.bindings.add("escape:tui.select.cancel");
    harness.components[0].handleInput?.("escape");
    await harness.picker;
    assert.equal(harness.components.length, 1);
    assert.deepEqual(harness.sends, []);
  } finally {
    harness.components.forEach((component) => component.dispose?.());
  }
});

test("dashboard only advertises abort for a running helper", async () => {
  const harness = await openPickerForTest([mkSnap("sa-done", "done", 1_000)]);
  try {
    assert.doesNotMatch(
      harness.components[0].render(120).join("\\n"),
      /x abort/,
    );
  } finally {
    harness.components.forEach((component) => component.dispose?.());
  }
});

test("dashboard hint names confirm, cancel, and both escape behaviours; rows are redacted and width-bounded", async () => {
  const snaps = [
    {
      ...mkSnap("sa-run", "running", 1_000),
      title: "Authorization: Bearer DASH_SECRET_TOKEN",
    },
    {
      ...mkSnap("sa-done", "done", 2_000),
      title: "日本語🙂 very long dashboard title that must truncate safely",
    },
  ];
  const harness = await openPickerForTest(snaps);
  try {
    for (const width of [40, 80, 120]) {
      const lines = harness.components[0].render(width);
      const output = lines.join("\n");
      assert.ok(
        lines.every((line) => visibleWidth(line) <= width),
        `width ${width} exceeded`,
      );
      assert.doesNotMatch(output, /DASH_SECRET_TOKEN/);
    }
    const full = harness.components[0].render(120).join("\n");
    assert.match(full, /enter take over/);
    assert.match(full, /esc back to session/);
    assert.match(full, /esc in takeover back to picker/);

    // INV-20 no-send regression: dashboard keystrokes never deliver text.
    harness.components[0].handleInput?.("hello world");
    harness.components[0].handleInput?.("a");
    assert.deepEqual(harness.sends, []);
  } finally {
    harness.components.forEach((component) => component.dispose?.());
  }
});
