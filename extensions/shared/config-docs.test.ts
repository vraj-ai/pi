import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  cpSync,
  existsSync,
  lstatSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../../", import.meta.url));
const installer = join(root, "install.sh");
const installerScript = join(root, "scripts", "install.mjs");
const setup = join(root, "SETUP.md");
const readme = join(root, "README.md");
const system = join(root, "SYSTEM.md");
const settingsExample = join(root, "settings.example.json");
const terseOutput = join(root, "skills", "terse-output", "SKILL.md");
const runtimeSettings = join(
  root,
  "node_modules/@earendil-works/pi-coding-agent/docs/settings.md",
);

function readSettings(path: string) {
  return JSON.parse(readFileSync(path, "utf8"));
}

test("README documents alt+down and the running-only DOWN gate", () => {
  const readmeText = readFileSync(readme, "utf8");
  assert.match(readmeText, /alt\+down/);
  assert.match(
    readmeText,
    /DOWN opens the subagent picker only when a subagent is running/i,
  );
});

test("SYSTEM.md keeps the picker as open-view-only with explicit in-view send (PI-11, INV-20)", () => {
  const systemText = readFileSync(system, "utf8");
  assert.match(systemText, /picker opens a view only/i);
  assert.match(systemText, /explicit in-view send action/i);
  assert.match(systemText, /\(PI-11, INV-20\)/);
});

test("settings document Pi's accepted steering values and describe direct-only operation", () => {
  const runtime = readFileSync(runtimeSettings, "utf8");
  assert.match(runtime, /`steeringMode`[\s\S]*`"all"` or `"one-at-a-time"`/);
  assert.equal(readSettings(settingsExample).steeringMode, "one-at-a-time");
  assert.equal(readSettings(settingsExample).packages, undefined);
  assert.equal(readSettings(settingsExample).workflow, undefined);
  assert.match(
    readFileSync(terseOutput, "utf8"),
    /Security warnings, irreversible action confirmations, and multi-step sequences are never compressed\./i,
  );
  const text = readFileSync(setup, "utf8");
  assert.match(text, /"all".*"one-at-a-time"/);
  assert.doesNotMatch(text, /workflow send|workflow start/i);
  assert.doesNotMatch(
    readFileSync(readme, "utf8"),
    /coordinator-mediated question relay|`\/flow` or \*\*F6\*\*/i,
  );
  for (const path of [readme, system]) {
    const contents = readFileSync(path, "utf8");
    assert.doesNotMatch(contents, /workflow send|workflow start/);
    assert.match(contents, /Ponytail/i);
    assert.match(contents, /Caveman/i);
    assert.match(
      contents,
      /Security warnings, irreversible action confirmations, and multi-step sequences are never compressed\./i,
    );
  }
  for (const path of [
    installer,
    settingsExample,
    terseOutput,
    readme,
    system,
  ]) {
    assert.doesNotMatch(
      readFileSync(path, "utf8"),
      /(?:sk-[A-Za-z0-9]{20,}|gh[pousr]_[A-Za-z0-9]{20,}|xox[baprs]-[A-Za-z0-9-]{20,}|AKIA[0-9A-Z]{16}|Bearer\s+[A-Za-z0-9._~+/=-]{20,})/,
    );
  }
});

test("installer replaces legacy all steering mode and is idempotent", () => {
  const temporary = mkdtempSync(join(tmpdir(), "pi-agent-config-"));
  const agentDir = join(temporary, "agent with spaces");
  const settings = join(agentDir, "settings.json");
  mkdirSync(agentDir);
  writeFileSync(
    settings,
    JSON.stringify({
      steeringMode: "all",
      preserved: true,
      packages: [
        "npm:example",
        { source: "pi-skills", skills: ["brave-search"] },
        "git:github.com/DietrichGebert/ponytail",
        "git:github.com/DietrichGebert/ponytail",
      ],
    }),
  );

  try {
    const install = () =>
      execFileSync("bash", [installer], {
        cwd: root,
        env: { ...process.env, PI_CODING_AGENT_DIR: agentDir },
        stdio: "pipe",
      });

    install();
    const once = readSettings(settings);
    assert.equal(once.steeringMode, "one-at-a-time");
    assert.equal(once.preserved, true);
    assert.deepEqual(once.packages, [
      "npm:example",
      { source: "pi-skills", skills: ["brave-search"] },
      "git:github.com/DietrichGebert/ponytail",
    ]);

    for (let run = 0; run < 3; run += 1) install();
    assert.deepEqual(readSettings(settings), once);
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
});

test("installer refuses malformed settings without overwriting them", () => {
  const temporary = mkdtempSync(join(tmpdir(), "pi-agent-malformed-"));
  const agentDir = join(temporary, "agent");
  const settings = join(agentDir, "settings.json");
  const original = '{"steeringMode": "all"';
  mkdirSync(agentDir);
  writeFileSync(settings, original);

  try {
    assert.throws(() =>
      execFileSync("bash", [installer], {
        cwd: root,
        env: { ...process.env, PI_CODING_AGENT_DIR: agentDir },
        stdio: "pipe",
      }),
    );
    assert.equal(readFileSync(settings, "utf8"), original);
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
});

test("installer updates a symlinked settings target without replacing the link", () => {
  const temporary = mkdtempSync(join(tmpdir(), "pi-agent-settings-link-"));
  const agentDir = join(temporary, "agent");
  const target = join(temporary, "settings-target.json");
  const settings = join(agentDir, "settings.json");
  mkdirSync(agentDir);
  writeFileSync(target, JSON.stringify({ packages: ["npm:example"] }));
  symlinkSync(target, settings);

  try {
    execFileSync("bash", [installer], {
      cwd: root,
      env: { ...process.env, PI_CODING_AGENT_DIR: agentDir },
      stdio: "pipe",
    });
    assert.equal(lstatSync(settings).isSymbolicLink(), true);
    assert.deepEqual(readSettings(target).packages, ["npm:example"]);
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
});

test("installer refuses an incomplete checkout before changing settings", () => {
  const temporary = mkdtempSync(join(tmpdir(), "pi-agent-incomplete-"));
  const repository = join(temporary, "repo");
  const agentDir = join(temporary, "agent");
  const settings = join(agentDir, "settings.json");
  mkdirSync(join(repository, "node_modules"), { recursive: true });
  mkdirSync(join(repository, "extensions"));
  mkdirSync(join(repository, "themes"));
  mkdirSync(agentDir);
  mkdirSync(join(repository, "scripts"));
  cpSync(installer, join(repository, "install.sh"));
  cpSync(installerScript, join(repository, "scripts", "install.mjs"));
  writeFileSync(join(repository, "SYSTEM.md"), "system");
  writeFileSync(join(repository, "keybindings.json"), "{}");
  const original = JSON.stringify({ packages: ["npm:example"] });
  writeFileSync(settings, original);

  try {
    assert.throws(() =>
      execFileSync("bash", [join(repository, "install.sh")], {
        cwd: repository,
        env: { ...process.env, PI_CODING_AGENT_DIR: agentDir },
        stdio: "pipe",
      }),
    );
    assert.equal(readFileSync(settings, "utf8"), original);
    assert.equal(existsSync(join(agentDir, "skills")), false);
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
});
