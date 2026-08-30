import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

const themesDir = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "themes",
);

const HEX = /^#[0-9a-fA-F]{6}$/;

/**
 * Guards every shipped theme: a var must be a literal hex colour, and every
 * `colors`/`export` entry must be either a literal hex colour or the name of a
 * declared var. A typo'd hex (the kind that renders as a black smear at
 * runtime) fails here instead of in the terminal.
 */
test("every shipped theme resolves to real colours", () => {
  const files = readdirSync(themesDir).filter((name) => name.endsWith(".json"));
  assert.ok(files.length > 0, "no themes found");

  for (const file of files) {
    const theme = JSON.parse(readFileSync(join(themesDir, file), "utf8"));
    const where = (key: string) => `${file}:${key}`;

    assert.equal(
      theme.name,
      file.replace(/\.json$/, ""),
      `${file}: name must match filename`,
    );

    const vars: Record<string, unknown> = theme.vars ?? {};
    for (const [key, value] of Object.entries(vars)) {
      assert.match(String(value), HEX, where(`vars.${key}`));
    }

    for (const section of ["colors", "export"] as const) {
      for (const [key, value] of Object.entries(theme[section] ?? {})) {
        const text = String(value);
        const resolved = text.startsWith("#")
          ? HEX.test(text)
          : Object.hasOwn(vars, text);
        assert.ok(resolved, `${where(`${section}.${key}`)} = ${text}`);
      }
    }
  }
});

test("cobalt-ink is shipped and covers the same keys as vraj-ink", () => {
  const read = (name: string) =>
    JSON.parse(readFileSync(join(themesDir, `${name}.json`), "utf8"));
  const cobalt = read("cobalt-ink");
  const ink = read("vraj-ink");
  for (const section of ["colors", "export"] as const) {
    assert.deepEqual(
      Object.keys(cobalt[section]).sort(),
      Object.keys(ink[section]).sort(),
      `cobalt-ink is missing ${section} keys`,
    );
  }
});
