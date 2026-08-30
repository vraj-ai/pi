import assert from "node:assert/strict";
import {
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import type {
  ExtensionAPI,
  ExtensionContext,
  KeybindingsManager,
} from "@earendil-works/pi-coding-agent";
import {
  KeybindingsManager as TuiKeybindingsManager,
  TUI_KEYBINDINGS,
  type EditorComponent,
  type EditorTheme,
  type TUI,
} from "@earendil-works/pi-tui";
import setupSubagentsExtension, {
  createSubagentPickerEditorFactory,
  openSubagentPickerFromContext,
  readPickerSettings,
  SubagentPickerEditor,
  type SubagentPickerEditorOptions,
} from "./index.ts";
import type { SubagentReadModel } from "./src/manager.ts";
import { resolvePickerEnabled } from "./src/picker-trigger.ts";

const DOWN = "\x1b[B";

const noopTui = {} as TUI;
const noopTheme = {} as EditorTheme;

const keybindings = () =>
  new TuiKeybindingsManager(TUI_KEYBINDINGS) as unknown as KeybindingsManager;

/** Records the wrapped-editor calls (the stock/previous editor path). */
class RecordingEditor extends SubagentPickerEditor {
  readonly passThroughCalls: string[] = [];
  onDownCalls = 0;
  protected passThrough(data: string): void {
    this.passThroughCalls.push(data);
  }
}

function makeEditor(
  options: Partial<
    Pick<
      SubagentPickerEditorOptions,
      "getRunningCount" | "getEnabled" | "onDown"
    >
  > = {},
): RecordingEditor {
  const editor = new RecordingEditor(noopTui, noopTheme, keybindings(), {
    getRunningCount: options.getRunningCount ?? (() => 0),
    getEnabled: options.getEnabled ?? (() => true),
    onDown:
      options.onDown ??
      (() => {
        editor.onDownCalls += 1;
      }),
  });
  return editor;
}

function fakeUi(customResults: Array<string | null>) {
  const calls: string[] = [];
  const results = [...customResults];
  return {
    calls,
    ctx: {
      hasUI: true,
      ui: {
        custom: async () => {
          calls.push("custom");
          return results.shift() ?? null;
        },
        notify: () => {
          calls.push("notify");
        },
      },
    } as unknown as ExtensionContext,
  };
}

function fakeView(size: number, sends: string[] = []): SubagentReadModel {
  return {
    list: () => [],
    get: () => undefined,
    size: () => size,
    subscribe: () => () => {},
    subscribeTo: () => () => {},
    requestSend: (id, text) => {
      sends.push(`requestSend:${id}:${text}`);
    },
    requestAbort: () => {},
    setOnSettled: () => {},
  };
}

function createFakePi() {
  const shortcuts: Array<{
    key: string;
    handler: (ctx: ExtensionContext) => void | Promise<void>;
  }> = [];
  const pi = {
    events: { on: () => () => {}, emit: () => {} },
    on: () => {},
    registerTool: () => {},
    registerCommand: () => {},
    registerShortcut: (
      key: string,
      options: { handler: (ctx: ExtensionContext) => void | Promise<void> },
    ) => {
      shortcuts.push({ key, handler: options.handler });
    },
    registerMessageRenderer: () => {},
    registerEntryRenderer: () => {},
  } as unknown as ExtensionAPI;
  return { pi, shortcuts };
}

const SEND_PATTERN =
  /requestSend|requestStageSend|subagent_send|SUBAGENT_BRIDGE_CHANNEL|sendMessage|relay/i;

test("DOWN with no running subagent reaches the wrapped editor once, identical input, no picker", () => {
  const editor = makeEditor({ getRunningCount: () => 0 });
  editor.handleInput(DOWN);
  assert.deepEqual(editor.passThroughCalls, [DOWN]);
  assert.equal(editor.onDownCalls, 0);
});

test("DOWN with a running subagent and empty buffer opens the picker, wrapped editor not called", () => {
  const editor = makeEditor({ getRunningCount: () => 1 });
  editor.handleInput(DOWN);
  assert.equal(editor.onDownCalls, 1);
  assert.deepEqual(editor.passThroughCalls, []);
});

test("DOWN with a running subagent and non-empty buffer reaches the wrapped editor, no picker", () => {
  const editor = makeEditor({ getRunningCount: () => 1 });
  editor.setText("hello");
  editor.handleInput(DOWN);
  assert.deepEqual(editor.passThroughCalls, [DOWN]);
  assert.equal(editor.onDownCalls, 0);
});

test("downArrow=false kill switch: DOWN never opens the picker, every DOWN reaches the wrapped editor", () => {
  const editor = makeEditor({
    getRunningCount: () => 1,
    getEnabled: () => false,
  });
  editor.handleInput(DOWN);
  assert.deepEqual(editor.passThroughCalls, [DOWN]);
  assert.equal(editor.onDownCalls, 0);
  editor.setText("typed");
  editor.handleInput(DOWN);
  assert.deepEqual(editor.passThroughCalls, [DOWN, DOWN]);
  assert.equal(editor.onDownCalls, 0);
});

test("non-DOWN keys always pass through byte-identical", () => {
  const editor = makeEditor({ getRunningCount: () => 1 });
  const keys = ["a", "hello world", "\r", "\t", "\x1b[A", "\x1b[1;3B"];
  for (const data of keys) editor.handleInput(data);
  assert.deepEqual(editor.passThroughCalls, keys);
  assert.equal(editor.onDownCalls, 0);
});

test("the editor factory chains a previously installed factory", () => {
  const baseCalls: string[] = [];
  let baseText = "";
  const base: EditorComponent = {
    getText: () => baseText,
    setText: (text: string) => {
      baseText = text;
    },
    handleInput: (data: string) => {
      baseCalls.push(data);
    },
    render: () => [],
    invalidate: () => {},
  };
  let onDownCalls = 0;
  const factory = createSubagentPickerEditorFactory({
    previous: () => base,
    getRunningCount: () => 1,
    getEnabled: () => true,
    onDown: () => {
      onDownCalls += 1;
    },
  });
  const editor = factory(noopTui, noopTheme, keybindings());
  assert.ok(editor instanceof SubagentPickerEditor);

  // Non-DOWN input flows to the editor the previous factory produced.
  editor.handleInput("x");
  assert.deepEqual(baseCalls, ["x"]);
  assert.equal(onDownCalls, 0);

  // Empty live buffer + running subagent: DOWN opens the picker, base untouched.
  editor.handleInput(DOWN);
  assert.deepEqual(baseCalls, ["x"]);
  assert.equal(onDownCalls, 1);

  // Non-empty live buffer: DOWN flows to the wrapped editor, no picker.
  baseText = "hi";
  editor.handleInput(DOWN);
  assert.deepEqual(baseCalls, ["x", DOWN]);
  assert.equal(onDownCalls, 1);
});

test("openSubagentPickerFromContext opens the picker when at least one subagent exists, and never sends", async () => {
  const sends: string[] = [];
  const { ctx, calls } = fakeUi([null]);
  await openSubagentPickerFromContext(ctx, fakeView(1, sends));
  assert.deepEqual(calls, ["custom"]);
  assert.deepEqual(sends, []);
});

test("openSubagentPickerFromContext no-ops with no subagents", async () => {
  const { ctx, calls } = fakeUi([null]);
  await openSubagentPickerFromContext(ctx, fakeView(0));
  assert.deepEqual(calls, []);
});

test("the picker trigger path performs no send (INV-20 / PI-11)", async () => {
  const sends: string[] = [];
  const { ctx, calls } = fakeUi([null]);
  await openSubagentPickerFromContext(ctx, fakeView(1, sends));
  assert.deepEqual(calls, ["custom"]);
  assert.deepEqual(sends, []);
  assert.doesNotMatch(openSubagentPickerFromContext.toString(), SEND_PATTERN);
  assert.doesNotMatch(SubagentPickerEditor.toString(), SEND_PATTERN);
});

test("registers exactly one shortcut keyed alt+down, never down/up/enter/escape/tab", () => {
  const { pi, shortcuts } = createFakePi();
  setupSubagentsExtension(pi);
  assert.equal(shortcuts.length, 1);
  assert.equal(shortcuts[0].key, "alt+down");
  for (const forbidden of ["down", "up", "enter", "escape", "tab"]) {
    assert.notEqual(shortcuts[0].key, forbidden);
  }
});

test("PI-39: no extension registers a shortcut bound to bare down", () => {
  const extensionsRoot = fileURLToPath(new URL("../", import.meta.url));
  const entryPoints: string[] = [];
  for (const entry of readdirSync(extensionsRoot, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const index = join(extensionsRoot, entry.name, "index.ts");
    if (existsSync(index)) entryPoints.push(index);
  }
  assert.ok(
    entryPoints.length >= 2,
    "expected multiple extension entry points",
  );
  const registered = entryPoints.flatMap((file) => {
    const source = readFileSync(file, "utf8");
    const calls = source.matchAll(/registerShortcut\s*\(\s*["']([^"']+)["']/g);
    return [...calls].map((match) => match[1]);
  });
  assert.ok(registered.length >= 1, "expected at least the alt+down alias");
  assert.ok(
    registered.every((key) => key !== "down"),
    `bare down registered: ${registered.join(", ")}`,
  );
  assert.ok(registered.includes("alt+down"));
});

test("alt+down opens the picker when at least one subagent exists, regardless of buffer state", async () => {
  const { pi, shortcuts } = createFakePi();
  setupSubagentsExtension(pi);
  const handler = shortcuts[0].handler;
  // The handler delegates to the shared no-send trigger and never reads the
  // editor buffer (buffer state irrelevant for the shortcut).
  const handlerSource = handler.toString();
  assert.match(handlerSource, /openPicker|openSubagentPickerFromContext/);
  assert.doesNotMatch(
    handlerSource,
    /getText|getEditorText|editorText|shouldOpenPicker/,
  );
  assert.doesNotMatch(handlerSource, SEND_PATTERN);
  // Leaf behavior: with ≥1 subagent the picker opens via ui.custom.
  const { ctx, calls } = fakeUi([null]);
  await openSubagentPickerFromContext(ctx, fakeView(1));
  assert.deepEqual(calls, ["custom"]);
});

test("readPickerSettings resolves the kill switch from settings.json", () => {
  const dir = mkdtempSync(join(tmpdir(), "pi34-picker-"));
  try {
    const settingsPath = join(dir, "settings.json");
    writeFileSync(
      settingsPath,
      JSON.stringify({
        "vraj.subagents.picker": { downArrow: false },
      }),
    );
    assert.equal(resolvePickerEnabled(readPickerSettings(settingsPath)), false);

    writeFileSync(settingsPath, JSON.stringify({}));
    assert.equal(resolvePickerEnabled(readPickerSettings(settingsPath)), true);

    writeFileSync(settingsPath, "not json{");
    assert.equal(resolvePickerEnabled(readPickerSettings(settingsPath)), true);

    assert.equal(
      resolvePickerEnabled(readPickerSettings(join(dir, "missing.json"))),
      true,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
