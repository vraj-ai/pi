import assert from "node:assert/strict";
import { test } from "node:test";
import {
  collectSections,
  defaultExportName,
  extensionFor,
  extractCodeBlocks,
  formatSections,
  parseForce,
  parseFormat,
  parsePath,
  resolveExportTarget,
  textFromContent,
} from "./src/export.ts";

const message = (role: string, content: unknown) => ({
  type: "message",
  message: { role, content },
});

test("collect flattens text and image blocks and drops empties", () => {
  const branch = [
    message("user", "hello"),
    message("assistant", [
      { type: "text", text: "world" },
      { type: "image", data: "..." },
    ]),
    message("assistant", [{ type: "text", text: "   " }]),
    message("system", "ignored"),
    { type: "compaction" },
    null,
  ];
  assert.deepEqual(collectSections(branch), [
    { role: "user", text: "hello" },
    { role: "assistant", text: "world\n[image]" },
  ]);
});

test("collect redacts secrets before anything leaves the session", () => {
  const branch = [
    message("assistant", "export GITHUB_TOKEN=ghp_abcdefghijklmnop1234"),
    message("user", "curl -H 'Authorization: Bearer sk-liveKey01234567890'"),
    message("assistant", "api_key: swordfish-please-do-not-leak"),
  ];
  const text = formatSections(collectSections(branch), { format: "text" });
  assert.doesNotMatch(text, /ghp_abcdefghijklmnop1234/);
  assert.doesNotMatch(text, /sk-liveKey01234567890/);
  assert.doesNotMatch(text, /swordfish/);
  assert.match(text, /\[REDACTED\]/);
});

test("collect survives a malformed entry instead of losing the export", () => {
  const exploding = {
    type: "message",
    message: {
      role: "assistant",
      get content() {
        throw new Error("entry is corrupt");
      },
    },
  };
  assert.deepEqual(collectSections([exploding, message("user", "kept")]), [
    { role: "user", text: "kept" },
  ]);
  assert.deepEqual(collectSections([]), []);
  assert.deepEqual(collectSections(undefined as never), []);
});

test("textFromContent tolerates junk", () => {
  assert.equal(textFromContent(42), "");
  assert.equal(textFromContent([null, { type: "unknown" }, 7]), "");
});

test("code blocks are extracted with language and unterminated fences kept", () => {
  const text = [
    "intro",
    "```ts",
    "const a = 1;",
    "```",
    "middle",
    "~~~python",
    "x = 2",
    "~~~",
    "```",
    "no language, unterminated",
  ].join("\n");
  assert.deepEqual(extractCodeBlocks(text), [
    { language: "ts", code: "const a = 1;" },
    { language: "python", code: "x = 2" },
    { language: "", code: "no language, unterminated" },
  ]);
  assert.deepEqual(extractCodeBlocks(""), []);
  assert.deepEqual(extractCodeBlocks(undefined as never), []);
  assert.deepEqual(extractCodeBlocks("```\n\n```"), []);
});

test("markdown, json, and text formats each carry every section", () => {
  const sections = collectSections([
    message("user", "q"),
    message("assistant", "a"),
  ]);

  const md = formatSections(sections, { format: "markdown", title: "T" });
  assert.match(md, /^# T/);
  assert.match(md, /## User\n\nq/);
  assert.match(md, /## Assistant\n\na/);

  const json = JSON.parse(
    formatSections(sections, { format: "json", exportedAt: 0 }),
  );
  assert.equal(json.redacted, true);
  assert.equal(json.exportedAt, "1970-01-01T00:00:00.000Z");
  assert.deepEqual(json.messages, sections);

  assert.equal(
    formatSections(sections, { format: "text" }),
    "USER:\nq\n\n---\n\nASSISTANT:\na",
  );
});

test("argument parsing picks format and path independently", () => {
  assert.equal(parseFormat(""), "markdown");
  assert.equal(parseFormat("--json"), "json");
  assert.equal(parseFormat("out.txt --text"), "text");
  assert.equal(parseFormat("--nonsense"), "markdown");

  assert.equal(parsePath("--json"), undefined);
  assert.equal(parsePath("docs/out.md --json"), "docs/out.md");
  assert.equal(parsePath(""), undefined);
});

test("default export names are filesystem-safe and match the format", () => {
  assert.equal(extensionFor("json"), "json");
  assert.equal(extensionFor("text"), "txt");
  assert.equal(extensionFor("markdown"), "md");
  const name = defaultExportName("markdown", Date.UTC(2026, 7, 30, 17, 42, 1));
  assert.equal(name, "pi-transcript-2026-08-30T17-42-01.md");
  assert.doesNotMatch(name, /[:/\\]/);
});

test("export stays inside the working directory by default", () => {
  const cwd = "/repo";
  const call = (requested: string | undefined, force = false) =>
    resolveExportTarget({ requested, cwd, defaultName: "out.md", force });

  // No path: the default lands in the working directory.
  assert.equal(call(undefined).path, "/repo/out.md");
  // Relative paths resolve inside it.
  assert.equal(call("docs/x.md").path, "/repo/docs/x.md");
  assert.equal(call("./x.md").path, "/repo/x.md");

  // Escapes are refused with an actionable message rather than written.
  for (const escape of [
    "../outside.md",
    "../../etc/notes.md",
    "/etc/passwd",
    "docs/../../outside.md",
    "/repo-other/x.md",
  ]) {
    const result = call(escape);
    assert.equal(result.path, undefined, `should refuse ${escape}`);
    assert.match(result.error ?? "", /Refusing to export outside \/repo/);
    assert.match(result.error ?? "", /--force/);
  }
});

test("--force is the explicit way out of the fence", () => {
  const result = resolveExportTarget({
    requested: "/tmp/elsewhere.md",
    cwd: "/repo",
    defaultName: "out.md",
    force: true,
  });
  assert.equal(result.path, "/tmp/elsewhere.md");
  assert.equal(result.error, undefined);
});

test("--force is a flag, not an output path", () => {
  assert.equal(parseForce("--force"), true);
  assert.equal(parseForce("out.md --force"), true);
  assert.equal(parseForce(""), false);
  assert.equal(parseForce("--forced"), false);
  assert.equal(parsePath("--force"), undefined);
  assert.equal(parsePath("out.md --force --json"), "out.md");
});
