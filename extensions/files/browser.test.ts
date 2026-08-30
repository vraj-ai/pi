import assert from "node:assert/strict";
import { join } from "node:path";
import { test } from "node:test";
import {
  browserTitle,
  isWithin,
  listDirectory,
  navigate,
  referenceFor,
  SKIP_DIRECTORIES,
  type BrowserRow,
} from "./src/browser.ts";

const ROOT = "/repo";

const TREE: Record<
  string,
  Array<{ name: string; isDirectory: boolean; size?: number }>
> = {
  "/repo": [
    { name: "src", isDirectory: true },
    { name: "docs", isDirectory: true },
    { name: "node_modules", isDirectory: true },
    { name: ".git", isDirectory: true },
    { name: ".env", isDirectory: false, size: 40 },
    { name: "README.md", isDirectory: false, size: 2_048 },
    { name: "package.json", isDirectory: false, size: 512 },
    { name: "big.bin", isDirectory: false, size: 5 * 1_024 * 1_024 },
  ],
  "/repo/src": [
    { name: "index.ts", isDirectory: false, size: 100 },
    { name: "util.ts", isDirectory: false, size: 200 },
  ],
};

const read = (directory: string) => {
  const entries = TREE[directory];
  if (!entries) throw new Error(`EACCES: ${directory}`);
  return entries;
};

test("the root lists directories first, then files, both alphabetical", () => {
  const rows = listDirectory(ROOT, ROOT, { read });
  assert.deepEqual(
    rows.map((row) => [row.kind, row.label]),
    [
      ["directory", "docs/"],
      ["directory", "src/"],
      // Locale-aware ordering: case-insensitive, so `big` precedes `README`.
      ["file", "big.bin  (5.0M)"],
      ["file", "package.json  (512B)"],
      ["file", "README.md  (2K)"],
    ],
  );
  assert.ok(!rows.some((row) => row.kind === "up"), "the root has no up row");
});

test("hidden files and heavy directories are skipped until asked for", () => {
  const visible = listDirectory(ROOT, ROOT, { read }).map((row) => row.label);
  assert.ok(!visible.some((label) => label.startsWith(".")));
  assert.ok(!visible.includes("node_modules/"));

  const all = listDirectory(ROOT, ROOT, { read, showHidden: true }).map(
    (row) => row.label,
  );
  assert.ok(all.includes("node_modules/"));
  assert.ok(all.includes(".git/"));
  assert.ok(all.includes(".env  (40B)"));
  assert.ok(SKIP_DIRECTORIES.has("node_modules"));
});

test("a filter narrows by name, case-insensitively", () => {
  const rows = listDirectory(ROOT, ROOT, { read, filter: "READ" });
  assert.deepEqual(
    rows.map((row) => row.label),
    ["README.md  (2K)"],
  );
  assert.deepEqual(listDirectory(ROOT, ROOT, { read, filter: "zzz" }), []);
});

test("a subdirectory gets an up row", () => {
  const rows = listDirectory("/repo/src", ROOT, { read });
  assert.equal(rows[0].kind, "up");
  assert.equal(rows[0].path, "/repo");
  assert.deepEqual(
    rows.slice(1).map((row) => row.label),
    ["index.ts  (100B)", "util.ts  (200B)"],
  );
});

test("an unreadable directory yields navigation, not an exception", () => {
  const rows = listDirectory("/repo/missing", ROOT, { read });
  assert.deepEqual(
    rows.map((row) => row.kind),
    ["up"],
    "the user must still be able to go back up",
  );
});

test("navigation refuses anything outside the root", () => {
  const escape: BrowserRow = { kind: "directory", path: "/etc", label: "etc/" };
  assert.equal(navigate(escape, ROOT), undefined);

  const escapeFile: BrowserRow = {
    kind: "file",
    path: "/etc/passwd",
    label: "passwd",
  };
  assert.equal(navigate(escapeFile, ROOT), undefined);

  // A sibling directory sharing a name prefix is still outside.
  const sibling: BrowserRow = {
    kind: "directory",
    path: "/repo-other/src",
    label: "src/",
  };
  assert.equal(navigate(sibling, ROOT), undefined);

  assert.deepEqual(
    navigate({ kind: "directory", path: "/repo/src", label: "src/" }, ROOT),
    { directory: "/repo/src" },
  );
  assert.deepEqual(
    navigate(
      { kind: "file", path: "/repo/README.md", label: "README.md" },
      ROOT,
    ),
    { file: "/repo/README.md" },
  );
});

test("isWithin is prefix-safe", () => {
  assert.equal(isWithin("/repo", "/repo"), true);
  assert.equal(isWithin("/repo/src/a.ts", "/repo"), true);
  assert.equal(isWithin("/repo-other/a.ts", "/repo"), false);
  assert.equal(isWithin("/rep", "/repo"), false);
});

test("the title shows where you are relative to the root", () => {
  assert.equal(browserTitle(ROOT, ROOT), "repo");
  assert.equal(browserTitle("/repo/src", ROOT), "repo/src");
  assert.equal(browserTitle(join(ROOT, "a", "b"), ROOT), "repo/a/b");
});

test("the inserted reference is repo-relative, falling back to absolute", () => {
  assert.equal(referenceFor("/repo/src/index.ts", ROOT), "src/index.ts");
  assert.equal(referenceFor("/repo", ROOT), "/repo");
  assert.equal(referenceFor("/elsewhere/x.ts", ROOT), "/elsewhere/x.ts");
});
