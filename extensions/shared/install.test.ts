import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  cpSync,
  existsSync,
  lstatSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../../", import.meta.url));
const installer = join(root, "scripts", "install.mjs");
const setup = join(root, "SETUP.md");
const resources = [
  "node_modules",
  "extensions",
  "skills",
  "themes",
  "SYSTEM.md",
  "keybindings.json",
];

function runInstaller(
  args: string[],
  env = process.env,
  script = installer,
  cwd = root,
) {
  const result = spawnSync(process.execPath, [script, ...args], {
    cwd,
    env,
    encoding: "utf8",
  });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout;
}

function runInstallerFailure(
  args: string[],
  env = process.env,
  script = installer,
  cwd = root,
) {
  const result = spawnSync(process.execPath, [script, ...args], {
    cwd,
    env,
    encoding: "utf8",
  });
  assert.notEqual(result.status, 0, result.stdout);
  return result;
}

function createFixture({ packageJson = true, nodeModules = true } = {}) {
  const fixture = mkdtempSync(join(tmpdir(), "pi-agent-installer-fixture-"));
  mkdirSync(join(fixture, "scripts"));
  for (const directory of ["extensions", "skills", "themes"]) {
    mkdirSync(join(fixture, directory));
  }
  if (nodeModules) mkdirSync(join(fixture, "node_modules"));
  cpSync(installer, join(fixture, "scripts", "install.mjs"));
  cpSync(join(root, "SYSTEM.md"), join(fixture, "SYSTEM.md"));
  cpSync(join(root, "keybindings.json"), join(fixture, "keybindings.json"));
  if (packageJson) writeFileSync(join(fixture, "package.json"), "{}\n");
  return fixture;
}

test("installer dry-run reports every resource without creating its agent directory", () => {
  const temporary = join(
    tmpdir(),
    `pi-agent-dry-run-${process.pid}-${Date.now()}`,
  );

  try {
    const output = runInstaller(["--dry-run", "--agent-dir", temporary]);
    assert.equal(existsSync(temporary), false);
    for (const resource of resources)
      assert.match(output, new RegExp(`Would link .*${resource}`));
    const setupText = readFileSync(setup, "utf8");
    assert.match(setupText, /\.\\install\.ps1/);
    assert.match(
      setupText,
      /bin\/fd.*platform-specific.*never a committed binary/i,
    );
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
});

test("installer is idempotent and its forced symlink failure copies resources", () => {
  const temporary = join(
    tmpdir(),
    `pi-agent-install-${process.pid}-${Date.now()}`,
  );
  const agentDir = join(temporary, "agent with spaces");
  const fallbackDir = join(temporary, "copy fallback");

  try {
    mkdirSync(agentDir, { recursive: true });
    writeFileSync(
      join(agentDir, "settings.json"),
      JSON.stringify({ preserved: true, packages: ["npm:user-package"] }),
    );
    runInstaller(["--agent-dir", agentDir]);
    const once = readFileSync(join(agentDir, "settings.json"), "utf8");
    runInstaller(["--agent-dir", agentDir]);
    assert.equal(readFileSync(join(agentDir, "settings.json"), "utf8"), once);
    // The installer no longer declares a Pi package of its own: the local
    // skills repository owns that family, and declaring it in both places
    // installs it twice. The user's own packages are untouched.
    assert.deepEqual(JSON.parse(once).packages, ["npm:user-package"]);
    assert.equal(JSON.parse(once).preserved, true);

    const output = runInstaller(["--force-copy", "--agent-dir", fallbackDir]);
    assert.match(output, /Copied extensions/);
    assert.equal(
      lstatSync(join(fallbackDir, "extensions")).isSymbolicLink(),
      false,
    );
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
});

test("installer drops the retired workflow settings object", () => {
  const temporary = join(
    tmpdir(),
    `pi-agent-migrate-${process.pid}-${Date.now()}`,
  );
  const agentDir = join(temporary, "agent");

  try {
    mkdirSync(agentDir, { recursive: true });
    writeFileSync(
      join(agentDir, "settings.json"),
      JSON.stringify({
        preserved: true,
        workflow: {
          mode: "workflow",
          trackerPollMs: 10_000,
          routines: [{ name: "standup" }],
        },
      }),
    );

    runInstaller(["--agent-dir", agentDir]);
    const once = readFileSync(join(agentDir, "settings.json"), "utf8");
    const settings = JSON.parse(once);
    assert.equal(Object.hasOwn(settings, "workflow"), false);
    assert.equal(settings.preserved, true);

    runInstaller(["--agent-dir", agentDir]);
    assert.equal(readFileSync(join(agentDir, "settings.json"), "utf8"), once);
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
});

test("installer refuses checkout-internal targets and empty env paths safely", () => {
  const fixture = createFixture();
  const temporary = mkdtempSync(join(tmpdir(), "pi-agent-installer-target-"));
  const nested = join(fixture, "nested-agent");
  const alias = join(temporary, "nested-agent-link");
  mkdirSync(nested);
  symlinkSync(nested, alias);

  try {
    const fixtureInstaller = join(fixture, "scripts", "install.mjs");
    const result = runInstallerFailure(
      ["--agent-dir", alias],
      process.env,
      fixtureInstaller,
      fixture,
    );
    assert.match(result.stderr, /inside the checkout/i);
    assert.equal(existsSync(join(nested, "settings.json")), false);
    assert.equal(existsSync(join(nested, "extensions")), false);

    const output = runInstaller(["--dry-run"], {
      ...process.env,
      PI_CODING_AGENT_DIR: "",
    });
    assert.equal(
      output.includes(`Dry run: ${join(homedir(), ".pi", "agent")}`),
      true,
    );
  } finally {
    rmSync(temporary, { recursive: true, force: true });
    rmSync(fixture, { recursive: true, force: true });
  }
});

test("installer refuses a checkout missing package metadata before mutation", () => {
  const fixture = createFixture({ nodeModules: false, packageJson: false });
  const temporary = mkdtempSync(join(tmpdir(), "pi-agent-incomplete-"));
  const agentDir = join(temporary, "agent");
  mkdirSync(agentDir);
  const settings = join(agentDir, "settings.json");
  const original = JSON.stringify({ packages: ["npm:user-package"] });
  writeFileSync(settings, original);

  try {
    const fixtureInstaller = join(fixture, "scripts", "install.mjs");
    const result = runInstallerFailure(
      ["--agent-dir", agentDir],
      process.env,
      fixtureInstaller,
      fixture,
    );
    assert.match(result.stderr, /package\.json/);
    assert.equal(readFileSync(settings, "utf8"), original);
    assert.equal(existsSync(join(agentDir, "extensions")), false);
  } finally {
    rmSync(temporary, { recursive: true, force: true });
    rmSync(fixture, { recursive: true, force: true });
  }
});
