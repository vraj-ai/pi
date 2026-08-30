#!/usr/bin/env node
/**
 * Verify that vendored code still says where it came from.
 *
 * Attribution rots silently: someone refactors a file, the header goes, and a
 * year later nobody can tell which lines are third-party. This turns that into
 * a failing check instead of an archaeology problem.
 *
 * Usage: node scripts/check-provenance.mjs
 */

import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/**
 * Each rule names a directory of vendored code, the marker every file in it
 * must carry, and the licence file that must sit alongside it.
 */
const RULES = [
  {
    label: "oh-my-pi (usage-stats)",
    directory: "extensions/usage-stats",
    // The port is a rewrite, so not every file is derived; these are.
    files: [
      "src/shared-types.ts",
      "src/parser.ts",
      "src/db.ts",
      "src/sync.ts",
      "src/usage-windows.ts",
      "src/gain.ts",
      "src/server.ts",
      "src/client.ts",
      "index.ts",
    ],
    marker: "github.com/can1357/oh-my-pi",
    licence: "extensions/usage-stats/LICENSE-oh-my-pi",
  },
  {
    label: "agent-stuff (no-sleep)",
    directory: "extensions/session-tools",
    files: ["src/no-sleep.ts", "index.ts"],
    marker: "agent-stuff",
    // Apache-2.0 redistribution requires the licence text to travel with the
    // code, so this is not optional the way an MIT courtesy copy would be.
    licence: "extensions/session-tools/LICENSE-agent-stuff",
  },
];

const problems = [];

const provenance = join(root, "PROVENANCE.md");
if (!existsSync(provenance)) {
  problems.push("PROVENANCE.md is missing");
}
const provenanceText = existsSync(provenance)
  ? readFileSync(provenance, "utf8")
  : "";

for (const rule of RULES) {
  if (!provenanceText.includes(rule.marker)) {
    problems.push(`PROVENANCE.md does not mention ${rule.marker}`);
  }
  if (rule.licence && !existsSync(join(root, rule.licence))) {
    problems.push(`missing vendored licence: ${rule.licence}`);
  }
  for (const file of rule.files) {
    const path = join(root, rule.directory, file);
    if (!existsSync(path)) {
      problems.push(`${rule.label}: listed file is gone: ${rule.directory}/${file}`);
      continue;
    }
    const text = readFileSync(path, "utf8");
    if (!text.includes(rule.marker)) {
      problems.push(
        `${rule.label}: ${rule.directory}/${file} lost its attribution header (expected "${rule.marker}")`,
      );
    }
  }
}

// A file that mentions an upstream but is not covered by a rule is attribution
// that PROVENANCE.md does not know about.
const covered = new Set(
  RULES.flatMap((rule) => rule.files.map((file) => join(rule.directory, file))),
);
const markers = RULES.map((rule) => rule.marker);

function walk(directory) {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === "node_modules" || entry.name === ".git") continue;
      walk(path);
      continue;
    }
    if (!entry.name.endsWith(".ts") && !entry.name.endsWith(".mjs")) continue;
    if (statSync(path).size > 2_000_000) continue;
    const relativePath = relative(root, path);
    if (covered.has(relativePath)) continue;
    const text = readFileSync(path, "utf8");
    for (const marker of markers) {
      if (text.includes(marker) && !relativePath.endsWith("check-provenance.mjs")) {
        problems.push(
          `${relativePath} references ${marker} but is not listed in scripts/check-provenance.mjs`,
        );
      }
    }
  }
}
walk(join(root, "extensions"));

if (problems.length > 0) {
  console.error("Provenance check failed:");
  for (const problem of problems) console.error(`  - ${problem}`);
  process.exitCode = 1;
} else {
  console.log(
    `Provenance OK: ${RULES.length} upstreams, ${covered.size} attributed files.`,
  );
}
