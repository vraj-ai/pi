import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import {
  fingerprintSnapshot,
  formatGitContext,
  parseStatus,
  shouldInject,
  type GitSnapshot,
} from "./src/injection.ts";

const clean: GitSnapshot = {
  isRepository: true,
  branch: "main",
  head: "0e31887",
  status: "",
  log: "0e31887 fix: drop no-op self-copy\n4334bcf feat: omp Roles",
  upstream: "main...origin/main [ahead 2]",
};

test("porcelain status parses codes, paths, and renames", () => {
  const entries = parseStatus(
    [
      " M src/a.ts",
      "?? new.txt",
      "A  added.ts",
      "R  old.ts -> new.ts",
      " D gone.ts",
      "",
      "xx",
    ].join("\n"),
  );
  assert.deepEqual(entries, [
    { code: " M", path: "src/a.ts" },
    { code: "??", path: "new.txt" },
    { code: "A ", path: "added.ts" },
    { code: "R ", path: "new.ts" },
    { code: " D", path: "gone.ts" },
  ]);
  assert.deepEqual(parseStatus(""), []);
  assert.deepEqual(parseStatus(undefined as never), []);
});

test("a clean tree renders branch, upstream, and recent commits", () => {
  const text = formatGitContext(clean) ?? "";
  assert.match(text, /^<git_context>/);
  assert.match(text, /branch: main @ 0e31887/);
  assert.match(text, /upstream: main\.\.\.origin\/main \[ahead 2\]/);
  assert.match(text, /working tree: clean/);
  assert.match(text, /recent commits:/);
  assert.match(text, /0e31887 fix: drop no-op self-copy/);
  assert.match(text, /<\/git_context>$/);
});

test("a dirty tree names files with human-readable states", () => {
  const text =
    formatGitContext({
      ...clean,
      status: " M src/a.ts\n?? notes.md\n D removed.ts",
    }) ?? "";
  assert.match(text, /working tree: 3 changed file\(s\)/);
  assert.match(text, /modified\s+src\/a\.ts/);
  assert.match(text, /untracked\s+notes\.md/);
  assert.match(text, /deleted\s+removed\.ts/);
});

test("a huge diff is bounded rather than dumped into context", () => {
  const status = Array.from({ length: 200 }, (_, i) => ` M f${i}.ts`).join(
    "\n",
  );
  const text = formatGitContext({ ...clean, status }) ?? "";
  assert.match(text, /working tree: 200 changed file\(s\)/);
  assert.match(text, /\.\.\. and 170 more/);
  assert.ok(text.split("\n").length < 45, "the block must stay compact");
});

test("outside a repository nothing is injected", () => {
  assert.equal(formatGitContext({ isRepository: false }), undefined);
  assert.equal(shouldInject({ isRepository: false }, undefined).inject, false);
});

test("injection happens on first sight and only again on real change", () => {
  const first = shouldInject(clean, undefined);
  assert.equal(first.inject, true);

  const again = shouldInject(clean, first.fingerprint);
  assert.equal(again.inject, false, "an unchanged repo must not re-inject");

  const dirty = shouldInject(
    { ...clean, status: " M x.ts" },
    first.fingerprint,
  );
  assert.equal(dirty.inject, true);

  const branched = shouldInject(
    { ...clean, branch: "feature" },
    first.fingerprint,
  );
  assert.equal(branched.inject, true);

  const newCommit = shouldInject(
    { ...clean, log: "aaaaaaa new commit\n0e31887 fix: drop no-op self-copy" },
    first.fingerprint,
  );
  assert.equal(newCommit.inject, true);

  // An older commit scrolling off the tail is not a state change worth a block.
  const trimmedLog = shouldInject(
    { ...clean, log: "0e31887 fix: drop no-op self-copy" },
    first.fingerprint,
  );
  assert.equal(trimmedLog.inject, false);
});

test("fingerprints are stable for identical snapshots", () => {
  assert.equal(fingerprintSnapshot(clean), fingerprintSnapshot({ ...clean }));
  assert.equal(fingerprintSnapshot({ isRepository: false }), "no-repo");
});

test("the fingerprint uses NUL as a separator without putting a NUL in the source file", () => {
  const source = readFileSync(
    fileURLToPath(new URL("./src/injection.ts", import.meta.url)),
  );
  assert.equal(source.includes(0), false, "source must stay text, not binary");
  assert.ok(
    fingerprintSnapshot(clean).includes("\u0000"),
    "runtime fingerprints still separate fields with NUL",
  );
});
