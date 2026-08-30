import assert from "node:assert/strict";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { stripAnsi, stripNoise } from "./src/ansi.ts";
import {
  collapseBlanks,
  collapseRuns,
  compressOutput,
  fingerprint,
  recoveryFooter,
} from "./src/compress.ts";
import { RawStore } from "./src/raw-store.ts";

const ESC = "\u001b";

test("ansi colour, OSC, and progress redraws are stripped", () => {
  assert.equal(stripAnsi(`${ESC}[31mred${ESC}[0m`), "red");
  assert.equal(stripAnsi(`${ESC}]8;;http://x${ESC}\\link`), "link");
  assert.equal(stripAnsi(`${ESC}]0;titlerest`), "rest");
  assert.equal(stripNoise("10%\r50%\r100% done"), "100% done");
  assert.equal(stripNoise("keep\nthese\nlines"), "keep\nthese\nlines");
  assert.equal(stripNoise("bell\u0007gone"), "bellgone");
});

test("fingerprints treat numbers and hashes as interchangeable", () => {
  assert.equal(
    fingerprint("Downloading foo-1.2.3.tgz (43%)"),
    fingerprint("Downloading foo-9.0.0.tgz (7%)"),
  );
  assert.equal(
    fingerprint("commit a1b2c3d4e5f"),
    fingerprint("commit ff00aa11bb2"),
  );
  assert.notEqual(fingerprint("compiling src"), fingerprint("linking src"));
});

test("runs collapse only at or above the threshold", () => {
  const lines = ["a 1", "a 2", "a 3", "b", "c 1", "c 2"];
  const collapsed = collapseRuns(lines, 3);
  assert.deepEqual(collapsed.lines, [
    "a 1",
    "    ... 2 more similar lines",
    "b",
    "c 1",
    "c 2",
  ]);
  assert.equal(collapsed.collapsed, 2);
  assert.deepEqual(collapseRuns(lines, 10).lines, lines);
  assert.deepEqual(collapseRuns([], 3).lines, []);
});

test("blank runs collapse to a single blank", () => {
  const result = collapseBlanks(["a", "", "", "", "b", "", "c"]);
  assert.deepEqual(result.lines, ["a", "", "b", "", "c"]);
  assert.equal(result.removed, 2);
});

test("small output is passed through untouched", () => {
  const small = "line one\nline two\n";
  const result = compressOutput(small);
  assert.equal(result.compressed, false);
  assert.equal(result.text, small);
  assert.deepEqual(result.applied, []);
  assert.equal(compressOutput("").text, "");
  assert.equal(compressOutput(undefined as never).text, "");
});

test("a noisy log compresses and reports what it did", () => {
  const noisy = [
    ...Array.from(
      { length: 500 },
      (_, i) => `Downloading pkg-${i}.tgz (${i % 100}%)`,
    ),
    "",
    "",
    "",
    `${ESC}[32mBuild succeeded${ESC}[0m`,
  ].join("\n");

  const result = compressOutput(noisy);
  assert.equal(result.compressed, true);
  assert.ok(
    result.outputChars < result.originalChars / 2,
    "must actually save",
  );
  assert.ok(result.outputLines < result.originalLines);
  assert.doesNotMatch(result.text, new RegExp(ESC));
  assert.match(result.text, /more similar lines/);
  assert.match(result.text, /Build succeeded/, "the tail must survive");
  assert.ok(result.applied.length > 0);
});

test("a large log elides its middle but keeps head and tail", () => {
  const lines = Array.from(
    { length: 400 },
    (_, i) => `distinct line ${i} ${"x".repeat(i % 7)}`,
  );
  const result = compressOutput(lines.join("\n"), { runThreshold: 999 });
  assert.equal(result.compressed, true);
  assert.match(result.text, /^distinct line 0/);
  assert.match(result.text, /distinct line 399/);
  assert.match(result.text, /lines elided from the middle/);
});

test("output that would not shrink is left alone", () => {
  // 100 genuinely distinct, dense lines: nothing to strip, nothing to collapse,
  // and under the head+tail budget, so compression must decline.
  const words = "alpha bravo charlie delta echo foxtrot golf hotel".split(" ");
  const dense = Array.from(
    { length: 100 },
    (_, i) =>
      `${words[i % 8]} ${words[(i * 3) % 8]} ${words[(i * 5 + 1) % 8]} ${words[(i * 7 + 2) % 8]} tail`,
  ).join("\n");
  const result = compressOutput(dense);
  assert.equal(result.compressed, false);
  assert.equal(result.text, dense);
});

test("the recovery footer names the handle and the saving", () => {
  const result = compressOutput(
    Array.from({ length: 300 }, () => "same line").join("\n"),
  );
  const footer = recoveryFooter(result, "raw-7");
  assert.match(footer, /read_raw_output\(handle: "raw-7"\)/);
  assert.match(footer, /300 lines ->/);
  assert.match(footer, /% smaller/);
});

test("the raw store round-trips, pages, and evicts oldest first", () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-raw-test-"));
  try {
    const store = new RawStore({ directory: dir, maxEntries: 2 });
    const first = store.put("bash", "a\nb\nc\nd");
    assert.ok(first);
    assert.equal(readFileSync(first.path, "utf8"), "a\nb\nc\nd");

    const all = store.read(first.handle);
    assert.equal(all?.text, "a\nb\nc\nd");
    assert.equal(all?.totalLines, 4);

    const page = store.read(first.handle, { offset: 1, limit: 2 });
    assert.equal(page?.text, "b\nc");
    assert.equal(page?.offset, 1);
    assert.equal(page?.returnedLines, 2);
    assert.equal(page?.totalLines, 4);

    assert.equal(store.read("nope"), undefined);

    const second = store.put("grep", "second");
    const third = store.put("find", "third");
    assert.ok(second && third);
    assert.equal(store.get(first.handle), undefined, "oldest evicted");
    assert.equal(existsSync(first.path), false, "evicted file deleted");
    assert.deepEqual(
      store.list().map((entry) => entry.handle),
      [third.handle, second.handle],
      "list is newest first",
    );

    store.clear();
    assert.equal(existsSync(dir), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a store that cannot write reports failure instead of losing output", () => {
  // A path whose parent is a file, so mkdir/write must fail.
  const dir = mkdtempSync(join(tmpdir(), "pi-raw-fail-"));
  try {
    const store = new RawStore({ directory: join(dir, "not-a-dir") });
    // Create a file where the directory would go.
    writeFileSync(join(dir, "not-a-dir"), "blocking", "utf8");
    assert.equal(store.put("bash", "content"), undefined);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("spilled output is readable only by its owner", () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-raw-perm-"));
  try {
    // The store lives in a shared temp directory and holds whole file contents
    // and command output, so group/other must not be able to read it.
    const store = new RawStore({ directory: join(dir, "spill") });
    const entry = store.put("bash", "secret build log");
    assert.ok(entry);

    assert.equal(statSync(entry.path).mode & 0o777, 0o600, "file must be 0600");
    assert.equal(
      statSync(join(dir, "spill")).mode & 0o777,
      0o700,
      "directory must be 0700",
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
