import assert from "node:assert/strict";
import {
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
  mkdirSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  auditContext,
  estimateTokens,
  formatAudit,
  WARN_TOKENS,
} from "./src/context-audit.ts";
import { classifyScope, groupByScope, parseSkills } from "./src/discovery.ts";
import { buildRows, DONE_LABEL, summarize } from "./src/picker.ts";
import { filterSkills } from "./src/prompt-filter.ts";
import {
  DISABLED_KEY,
  SkillToggleState,
  readDisabled,
  settingsPathFor,
  writeDisabled,
} from "./src/state.ts";

const HOME = "/home/vraj";
const CWD = "/home/vraj/work/repo";

function skillXml(name: string, description: string, location: string) {
  return [
    "  <skill>",
    `    <name>${name}</name>`,
    `    <description>${description}</description>`,
    `    <location>${location}</location>`,
    "  </skill>",
  ].join("\n");
}

function prompt(...entries: string[]) {
  return [
    "You are pi.",
    "",
    "The following skills provide specialized instructions for specific tasks.",
    "Use the read tool to load a skill's file when the task matches its description.",
    "",
    "<available_skills>",
    ...entries,
    "</available_skills>",
  ].join("\n");
}

const GLOBAL = skillXml(
  "commit",
  "Write good commits",
  `${HOME}/.pi/agent/skills/commit/SKILL.md`,
);
const AGENTS = skillXml(
  "github",
  "Use gh",
  `${HOME}/.agents/skills/github/SKILL.md`,
);
const PROJECT = skillXml(
  "deploy",
  "Ship it",
  `${CWD}/.pi/skills/deploy/SKILL.md`,
);
const SESSION = skillXml(
  "adhoc",
  "One-off",
  "/opt/shared/skills/adhoc/SKILL.md",
);

// --- discovery -------------------------------------------------------------

test("skills are parsed out of the system prompt with their scope", () => {
  const skills = parseSkills(prompt(GLOBAL, AGENTS, PROJECT, SESSION), {
    home: HOME,
    cwd: CWD,
  });
  assert.deepEqual(
    skills.map((s) => [s.name, s.scope]),
    [
      ["commit", "global"],
      ["github", "global"],
      ["deploy", "project"],
      ["adhoc", "session"],
    ],
  );
  assert.equal(skills[0].description, "Write good commits");
});

test("xml entities in names and descriptions round-trip", () => {
  const skills = parseSkills(
    prompt(skillXml("a&amp;b", "&lt;tag&gt; &quot;q&quot;", "/x/SKILL.md")),
    { home: HOME, cwd: CWD },
  );
  assert.equal(skills[0].name, "a&b");
  assert.equal(skills[0].description, '<tag> "q"');
});

test("a prompt with no skills block yields nothing", () => {
  assert.deepEqual(parseSkills("You are pi.", {}), []);
  assert.deepEqual(parseSkills(undefined as never, {}), []);
});

test("scope classification does not match sibling directories by prefix", () => {
  const roots = { home: HOME, cwd: CWD };
  assert.equal(
    classifyScope(`${HOME}/.pi/agent/skills/x/SKILL.md`, roots),
    "global",
  );
  // `${CWD}-other` must not count as inside `${CWD}`.
  assert.equal(
    classifyScope(`${CWD}-other/skills/x/SKILL.md`, roots),
    "session",
  );
  assert.equal(classifyScope("/opt/x/SKILL.md", roots), "session");
});

test("grouping sorts by name within scope", () => {
  const skills = parseSkills(prompt(AGENTS, GLOBAL, PROJECT), {
    home: HOME,
    cwd: CWD,
  });
  const groups = groupByScope(skills);
  assert.deepEqual(
    groups.get("global")?.map((s) => s.name),
    ["commit", "github"],
  );
  assert.deepEqual(
    groups.get("project")?.map((s) => s.name),
    ["deploy"],
  );
  assert.deepEqual(groups.get("session"), []);
});

// --- prompt filter ---------------------------------------------------------

test("disabling a skill removes exactly that entry", () => {
  const source = prompt(GLOBAL, PROJECT, SESSION);
  const { prompt: filtered, removed } = filterSkills(
    source,
    new Set(["deploy"]),
  );
  assert.deepEqual(removed, ["deploy"]);
  assert.doesNotMatch(filtered, /deploy/);
  assert.match(filtered, /<name>commit<\/name>/);
  assert.match(filtered, /<name>adhoc<\/name>/);
  assert.equal(parseSkills(filtered, { home: HOME, cwd: CWD }).length, 2);
});

test("disabling every skill drops the block and its preamble", () => {
  const source = prompt(GLOBAL, PROJECT);
  const { prompt: filtered, removed } = filterSkills(
    source,
    new Set(["commit", "deploy"]),
  );
  assert.deepEqual([...removed].sort(), ["commit", "deploy"]);
  assert.doesNotMatch(filtered, /available_skills/);
  assert.doesNotMatch(filtered, /The following skills provide/);
  assert.match(filtered, /^You are pi\./);
});

test("filtering is a no-op when nothing is disabled or nothing matches", () => {
  const source = prompt(GLOBAL);
  assert.equal(filterSkills(source, new Set()).prompt, source);
  assert.equal(filterSkills(source, new Set(["nope"])).prompt, source);
  assert.deepEqual(filterSkills(source, new Set(["nope"])).removed, []);
  assert.equal(
    filterSkills("no skills here", new Set(["commit"])).prompt,
    "no skills here",
  );
});

// --- persisted state -------------------------------------------------------

test("toggles persist per scope and preserve unrelated settings", () => {
  const home = mkdtempSync(join(tmpdir(), "pi-skills-home-"));
  const cwd = mkdtempSync(join(tmpdir(), "pi-skills-cwd-"));
  try {
    const globalPath = settingsPathFor("global", { home })!;
    mkdirSync(join(home, ".pi", "agent"), { recursive: true });
    writeFileSync(globalPath, JSON.stringify({ theme: "cobalt-ink" }), "utf8");

    const state = new SkillToggleState({ home, cwd });
    assert.equal(state.isDisabled("commit"), false);

    assert.equal(state.toggle("commit", "global"), false); // now disabled
    assert.equal(state.isDisabled("commit"), true);

    const saved = JSON.parse(readFileSync(globalPath, "utf8"));
    assert.equal(saved.theme, "cobalt-ink", "unrelated settings must survive");
    assert.deepEqual(saved[DISABLED_KEY], ["commit"]);

    assert.equal(state.toggle("commit", "global"), true); // re-enabled
    assert.equal(
      Object.hasOwn(JSON.parse(readFileSync(globalPath, "utf8")), DISABLED_KEY),
      false,
      "an empty disabled list is removed, not left as []",
    );

    // Project scope writes to its own file.
    state.toggle("deploy", "project");
    assert.deepEqual([...readDisabled("project", { home, cwd })], ["deploy"]);
    assert.deepEqual([...readDisabled("global", { home, cwd })], []);

    // Session scope never touches disk.
    state.toggle("adhoc", "session");
    assert.equal(state.isDisabled("adhoc"), true);
    assert.deepEqual([...readDisabled("session", { home, cwd })], []);
    state.clearSession();
    assert.equal(state.isDisabled("adhoc"), false);
    assert.equal(state.isDisabled("deploy"), true, "project toggle survives");
  } finally {
    rmSync(home, { recursive: true, force: true });
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("a corrupt settings file reads as nothing disabled", () => {
  const home = mkdtempSync(join(tmpdir(), "pi-skills-bad-"));
  try {
    mkdirSync(join(home, ".pi", "agent"), { recursive: true });
    writeFileSync(settingsPathFor("global", { home })!, "{ not json", "utf8");
    assert.deepEqual([...readDisabled("global", { home })], []);
    // And writing still works, replacing the corrupt file.
    assert.equal(writeDisabled("global", ["x"], { home }), true);
    assert.deepEqual([...readDisabled("global", { home })], ["x"]);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("session scope has no settings path", () => {
  assert.equal(settingsPathFor("session", { home: HOME, cwd: CWD }), undefined);
});

// --- picker ----------------------------------------------------------------

test("rows are grouped, checkboxed, and end with Done", () => {
  const skills = parseSkills(prompt(GLOBAL, PROJECT, SESSION), {
    home: HOME,
    cwd: CWD,
  });
  const { labels, byLabel } = buildRows(skills, new Set(["deploy"]));

  assert.equal(labels.at(-1), DONE_LABEL);
  assert.ok(labels.some((l) => l.startsWith("-- Global (1/1)")));
  assert.ok(labels.some((l) => l.startsWith("-- Project (0/1)")));
  assert.ok(labels.some((l) => l.includes("[x] commit")));
  assert.ok(labels.some((l) => l.includes("[ ] deploy")));

  // Headers and Done are not selectable rows.
  assert.equal(byLabel.size, 3);
  assert.equal(byLabel.get(DONE_LABEL), undefined);
  const deploy = [...byLabel.values()].find((row) => row.name === "deploy");
  assert.deepEqual(
    { scope: deploy?.scope, enabled: deploy?.enabled },
    { scope: "project", enabled: false },
  );
});

test("summary counts enabled skills and names the disabled ones", () => {
  const skills = parseSkills(prompt(GLOBAL, PROJECT), { home: HOME, cwd: CWD });
  assert.equal(summarize(skills, new Set()), "2 skills enabled");
  assert.equal(
    summarize(skills, new Set(["deploy"])),
    "1/2 skills enabled (deploy off)",
  );
});

// --- context audit ---------------------------------------------------------

test("audit ranks contributors and warns only above 5k tokens", () => {
  const bigDescription = "x".repeat(WARN_TOKENS * 4 + 400);
  const source = prompt(
    GLOBAL,
    skillXml("huge", bigDescription, `${CWD}/.pi/skills/huge/SKILL.md`),
  );
  const report = auditContext({
    systemPrompt: source,
    conversationTokens: 1_200,
    contextWindow: 200_000,
    roots: { home: HOME, cwd: CWD },
  });

  assert.equal(report.entries[0].label, "skill: huge");
  assert.ok(report.entries[0].tokens > WARN_TOKENS);
  assert.ok(report.warnings.some((w) => w.label === "skill: huge"));
  assert.ok(
    !report.warnings.some((w) => w.label === "skill: commit"),
    "a small skill must not be flagged",
  );
  assert.ok(report.entries.some((e) => e.label === "conversation so far"));
  assert.equal(report.contextWindow, 200_000);
  assert.ok(report.percent !== null && report.percent > 0);

  const text = formatAudit(report);
  assert.match(text, /over 5k/);
  assert.match(text, /Warning: /);
});

test("a disabled skill is excluded from the audit it no longer costs", () => {
  const report = auditContext({
    systemPrompt: prompt(GLOBAL, PROJECT),
    disabled: new Set(["deploy"]),
    roots: { home: HOME, cwd: CWD },
  });
  assert.ok(!report.entries.some((e) => e.label === "skill: deploy"));
  assert.ok(report.entries.some((e) => e.label === "skill: commit"));
});

test("audit degrades gracefully with no usage data and no skills", () => {
  const report = auditContext({ systemPrompt: "You are pi." });
  assert.equal(report.contextWindow, null);
  assert.equal(report.percent, null);
  assert.deepEqual(report.warnings, []);
  assert.equal(report.entries.length, 1);
  assert.match(formatAudit(report), /Context audit/);
});

test("token estimate is 4 characters per token", () => {
  assert.equal(estimateTokens("abcd"), 1);
  assert.equal(estimateTokens("abcde"), 2);
  assert.equal(estimateTokens(""), 0);
  assert.equal(estimateTokens(undefined as never), 0);
});
