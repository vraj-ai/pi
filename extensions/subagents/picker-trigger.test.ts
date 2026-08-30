import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import {
  resolvePickerEnabled,
  shouldOpenPicker,
  type PickerTriggerInput,
} from "./src/picker-trigger.ts";

const positive = {
  editorText: "",
  autocompleteOpen: false,
  historyActive: false,
  runningCount: 1,
  enabled: true,
} satisfies PickerTriggerInput;

test("opens when buffer empty, autocomplete closed, no history nav, running, enabled", () => {
  assert.equal(shouldOpenPicker(positive), true);
  assert.equal(shouldOpenPicker({ ...positive, runningCount: 2 }), true);
});

test("never opens on any non-empty editor text, including a single space", () => {
  for (const editorText of [" ", "x", "\n", "  x  "]) {
    assert.equal(shouldOpenPicker({ ...positive, editorText }), false);
  }
});

test("never opens while autocomplete is open or mid-history-navigation", () => {
  assert.equal(
    shouldOpenPicker({ ...positive, autocompleteOpen: true }),
    false,
  );
  assert.equal(shouldOpenPicker({ ...positive, historyActive: true }), false);
});

test("never opens with no running subagents", () => {
  assert.equal(shouldOpenPicker({ ...positive, runningCount: 0 }), false);
  assert.equal(shouldOpenPicker({ ...positive, runningCount: -1 }), false);
});

test("kill-switch false disables the trigger", () => {
  assert.equal(shouldOpenPicker({ ...positive, enabled: false }), false);
});

test("malformed inputs return false and never throw", () => {
  for (const input of [
    null,
    undefined,
    42,
    "nope",
    true,
    { ...positive, runningCount: Number.NaN },
    { ...positive, runningCount: Number.POSITIVE_INFINITY },
    { ...positive, runningCount: Number.NEGATIVE_INFINITY },
    { ...positive, runningCount: "1" },
  ]) {
    assert.equal(shouldOpenPicker(input), false);
  }

  const arrayInput = Object.assign([], positive);
  assert.equal(shouldOpenPicker(arrayInput), false);

  const throwingInput = { ...positive };
  Object.defineProperty(throwingInput, "runningCount", {
    get() {
      throw new Error("malformed input");
    },
  });
  assert.equal(shouldOpenPicker(throwingInput), false);
});

test("resolvePickerEnabled is true unless downArrow is exactly false", () => {
  assert.equal(resolvePickerEnabled(), true);
  assert.equal(resolvePickerEnabled(null), true);
  assert.equal(resolvePickerEnabled({}), true);
  assert.equal(resolvePickerEnabled({ "vraj.subagents.picker": {} }), true);
  assert.equal(
    resolvePickerEnabled({ "vraj.subagents.picker": { downArrow: true } }),
    true,
  );
  assert.equal(
    resolvePickerEnabled({ "vraj.subagents.picker": { downArrow: false } }),
    false,
  );

  const throwingSettings = {};
  Object.defineProperty(throwingSettings, "vraj.subagents.picker", {
    get() {
      throw new Error("malformed settings");
    },
  });
  assert.equal(resolvePickerEnabled(throwingSettings), true);
});

test("the module imports no fs, child_process, or TUI/runtime packages", () => {
  const source = readFileSync(
    new URL("./src/picker-trigger.ts", import.meta.url),
    "utf8",
  );
  assert.doesNotMatch(source, /from\s+["']node:(fs|child_process)/);
  assert.doesNotMatch(source, /@earendil-works\/pi-(tui|coding-agent)/);
});
