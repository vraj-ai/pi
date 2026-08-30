#!/usr/bin/env node
/**
 * Re-fetch a vendored upstream and report what changed since the port.
 *
 * This deliberately does *not* apply anything. The ports here are adaptations,
 * not copies, so a mechanical merge would either clobber the adaptation or
 * produce a conflict nobody can resolve without reading both sides anyway. What
 * actually helps is a precise diff of the upstream files a port is based on, so
 * a human can decide what is worth carrying over.
 *
 * Usage:
 *   node scripts/update-upstream.mjs                 # report all upstreams
 *   node scripts/update-upstream.mjs oh-my-pi        # one upstream
 *   node scripts/update-upstream.mjs --cache <dir>   # reuse an existing clone
 *   node scripts/update-upstream.mjs --pr            # also write a draft PR body
 */

import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

const UPSTREAMS = {
  "oh-my-pi": {
    repository: "https://github.com/can1357/oh-my-pi.git",
    /** Upstream paths this port is derived from. */
    paths: [
      "packages/stats/src/shared-types.ts",
      "packages/stats/src/parser.ts",
      "packages/stats/src/db.ts",
      "packages/stats/src/aggregator.ts",
      "packages/stats/src/sync-worker.ts",
      "packages/stats/src/usage-windows.ts",
      "packages/stats/src/gain-aggregator.ts",
      "packages/stats/src/user-metrics.ts",
      "packages/stats/src/server.ts",
      "packages/stats/src/client",
    ],
    /** Where the port lives, for the report. */
    port: "extensions/usage-stats",
  },
  "agent-stuff": {
    repository: "https://github.com/mitsuhiko/agent-stuff.git",
    paths: ["extensions/no-sleep.ts", "extensions/continue.ts"],
    port: "extensions/session-tools",
  },
};

/** Records the upstream commit each port was taken from. */
const PINS_FILE = join(root, "scripts", "upstream-pins.json");

function readPins() {
  try {
    return JSON.parse(readFileSync(PINS_FILE, "utf8"));
  } catch {
    return {};
  }
}

function writePins(pins) {
  writeFileSync(PINS_FILE, `${JSON.stringify(pins, null, 2)}\n`, "utf8");
}

function git(args, cwd) {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  });
}

function parseArguments(argv) {
  const names = [];
  let cache;
  let writePr = false;
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--cache") {
      cache = argv[++index];
      if (!cache) throw new Error("--cache requires a directory");
    } else if (argument === "--pr") {
      writePr = true;
    } else if (argument.startsWith("--")) {
      throw new Error(`Unknown argument: ${argument}`);
    } else {
      names.push(argument);
    }
  }
  return { names, cache, writePr };
}

function cloneOrUpdate(name, upstream, cacheDir) {
  const target = cacheDir
    ? join(cacheDir, name)
    : join(mkdtempSync(join(tmpdir(), "pi-upstream-")), name);
  if (existsSync(join(target, ".git"))) {
    git(["fetch", "--depth", "200", "origin"], target);
    git(["checkout", "--force", "FETCH_HEAD"], target);
    return target;
  }
  mkdirSync(dirname(target), { recursive: true });
  git(["clone", "--depth", "200", upstream.repository, target]);
  return target;
}

function report(name, upstream, checkout, pins) {
  const head = git(["rev-parse", "HEAD"], checkout).trim();
  const pinned = pins[name]?.commit;
  const lines = [`## ${name}`, "", `- port: \`${upstream.port}\``, `- upstream HEAD: \`${head.slice(0, 12)}\``];

  if (!pinned) {
    lines.push(
      `- no pinned commit recorded yet; pinning \`${head.slice(0, 12)}\` as the baseline`,
      "",
      "Nothing to compare against on this run. Re-run after the next upstream release.",
    );
    return { head, body: lines.join("\n"), changed: false };
  }

  lines.push(`- pinned at: \`${pinned.slice(0, 12)}\``);
  if (pinned === head) {
    lines.push("", "Up to date.");
    return { head, body: lines.join("\n"), changed: false };
  }

  let stat = "";
  let log = "";
  try {
    stat = git(["diff", "--stat", pinned, head, "--", ...upstream.paths], checkout).trim();
    log = git(
      ["log", "--oneline", "--no-decorate", `${pinned}..${head}`, "--", ...upstream.paths],
      checkout,
    ).trim();
  } catch (error) {
    lines.push("", `Could not diff: ${error instanceof Error ? error.message : error}`);
    return { head, body: lines.join("\n"), changed: true };
  }

  if (!stat) {
    lines.push("", "Upstream moved, but none of the ported paths changed.");
    return { head, body: lines.join("\n"), changed: false };
  }

  lines.push(
    "",
    "### Commits touching ported paths",
    "",
    "```",
    log || "(none)",
    "```",
    "",
    "### Changed files",
    "",
    "```",
    stat,
    "```",
    "",
    `Review each change against \`${upstream.port}\` and \`PROVENANCE.md\`, then update`,
    "the pin in `scripts/upstream-pins.json` once the port is reconciled.",
  );
  return { head, body: lines.join("\n"), changed: true };
}

function main() {
  const { names, cache, writePr } = parseArguments(process.argv.slice(2));
  const selected = names.length > 0 ? names : Object.keys(UPSTREAMS);
  for (const name of selected) {
    if (!UPSTREAMS[name]) throw new Error(`Unknown upstream: ${name}`);
  }

  const pins = readPins();
  const sections = [];
  let anyChanged = false;

  for (const name of selected) {
    const upstream = UPSTREAMS[name];
    let checkout;
    try {
      checkout = cloneOrUpdate(name, upstream, cache);
    } catch (error) {
      sections.push(
        `## ${name}\n\nCould not fetch: ${error instanceof Error ? error.message : error}`,
      );
      continue;
    }
    const result = report(name, upstream, checkout, pins);
    sections.push(result.body);
    anyChanged ||= result.changed;
    // Record the baseline on first sight; an actual update is a human decision,
    // so an existing pin is never advanced automatically.
    if (!pins[name]) pins[name] = { commit: result.head, port: upstream.port };
  }

  writePins(pins);

  const body = [
    "# Upstream update report",
    "",
    "Generated by `scripts/update-upstream.mjs`. Nothing was applied.",
    "",
    sections.join("\n\n"),
  ].join("\n");

  console.log(body);

  if (writePr) {
    const path = join(root, "UPSTREAM-UPDATE.md");
    writeFileSync(path, `${body}\n`, "utf8");
    console.log(`\nDraft PR body written to ${path}`);
    console.log(
      "Open it with:\n  gh pr create --draft --title 'chore: review upstream changes' --body-file UPSTREAM-UPDATE.md",
    );
  }

  process.exitCode = anyChanged ? 1 : 0;
}

try {
  main();
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 2;
}
