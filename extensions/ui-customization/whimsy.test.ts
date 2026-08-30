import assert from "node:assert/strict";
import { test } from "node:test";
import {
  cleanWhimsy,
  MAX_WHIMSY_WIDTH,
  pickWhimsy,
  renderWhimsy,
  WHIMSY_LINES,
  type WhimsyLine,
} from "./whimsy.ts";

test("every curated line is clean and fits the header budget", () => {
  assert.ok(WHIMSY_LINES.length >= 20);
  for (const line of WHIMSY_LINES) {
    assert.equal(line.text, cleanWhimsy(line.text), `not clean: ${line.text}`);
    assert.ok(
      line.text.length <= MAX_WHIMSY_WIDTH,
      `too wide (${line.text.length}): ${line.text}`,
    );
    // Plain ASCII only: no emoji, no box drawing, no smart quotes.
    assert.match(line.text, /^[\x20-\x7e]+$/, `non-ascii: ${line.text}`);
  }
  const both = new Set(WHIMSY_LINES.map((line) => line.kind));
  assert.deepEqual([...both].sort(), ["fact", "joke"]);
});

test("clean strips control bytes and collapses whitespace", () => {
  assert.equal(cleanWhimsy("  ab\n\tc  "), "a b c");
  assert.equal(cleanWhimsy(undefined), "");
  assert.equal(cleanWhimsy(42), "");
});

test("a seed yields a stable pick and different seeds spread out", () => {
  const first = pickWhimsy({ seed: "session-a" });
  assert.deepEqual(pickWhimsy({ seed: "session-a" }), first);
  const picks = new Set(
    Array.from({ length: 40 }, (_, i) => pickWhimsy({ seed: `s${i}` })?.text),
  );
  assert.ok(picks.size > 5, `seeded picks collapsed to ${picks.size}`);
});

test("avoid never repeats the previous line when alternatives exist", () => {
  for (const line of WHIMSY_LINES) {
    const next = pickWhimsy({ seed: "fixed", avoid: line.text });
    assert.notEqual(next?.text, line.text);
  }
});

test("a single-entry pool still returns that entry even when avoided", () => {
  const only: WhimsyLine[] = [{ kind: "fact", text: "only one" }];
  assert.deepEqual(pickWhimsy({ lines: only, avoid: "only one" }), only[0]);
});

test("kind filters the pool", () => {
  for (let i = 0; i < 20; i += 1) {
    assert.equal(pickWhimsy({ seed: `k${i}`, kind: "fact" })?.kind, "fact");
    assert.equal(pickWhimsy({ seed: `k${i}`, kind: "joke" })?.kind, "joke");
  }
});

test("an empty pool yields nothing rather than a placeholder", () => {
  assert.equal(pickWhimsy({ lines: [] }), undefined);
});

test("a throwing or out-of-range rng degrades to the first candidate", () => {
  const lines: WhimsyLine[] = [
    { kind: "fact", text: "alpha" },
    { kind: "fact", text: "beta" },
  ];
  const boom = () => {
    throw new Error("rng down");
  };
  assert.equal(pickWhimsy({ lines, random: boom })?.text, "alpha");
  assert.equal(pickWhimsy({ lines, random: () => Number.NaN })?.text, "alpha");
  assert.equal(pickWhimsy({ lines, random: () => 1 })?.text, "alpha");
  assert.equal(pickWhimsy({ lines, random: () => 0.99 })?.text, "beta");
});

test("render drops the line rather than truncating it", () => {
  const line: WhimsyLine = { kind: "joke", text: "abcdefghij" };
  assert.equal(renderWhimsy(line, 10), "abcdefghij");
  assert.equal(renderWhimsy(line, 9), "");
  assert.equal(renderWhimsy(line, 0), "");
  assert.equal(renderWhimsy(line, Number.NaN), "");
  assert.equal(renderWhimsy(undefined, 80), "");
});
