import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  existsSync,
  lstatSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const installer = join(root, "scripts", "install.mjs");
const setup = join(root, "SETUP.md");
const resources = [
  "extensions",
  "skills",
  "themes",
  "SYSTEM.md",
  "keybindings.json",
  "node_modules",
];
const directories = new Set(["extensions", "skills", "themes", "node_modules"]);

function seedResource(agentDir, name) {
  const target = join(agentDir, name);
  const original = Buffer.from(`original ${name}\n\0bytes`, "utf8");
  if (directories.has(name)) {
    mkdirSync(target, { recursive: true });
    writeFileSync(join(target, "original.bin"), original);
  } else {
    writeFileSync(target, original);
  }
  return original;
}

function readResource(agentDir, name) {
  return readFileSync(
    directories.has(name)
      ? join(agentDir, name, "original.bin")
      : join(agentDir, name),
  );
}

test("install backup can be listed and the documented rollback restores isolated state", () => {
  const temporary = mkdtempSync(join(tmpdir(), "pi-agent-rollback-"));
  const home = join(temporary, "home");
  const agentDir = join(home, ".pi", "agent");
  const missingResource = "themes";
  const unchangedResource = "extensions";
  const interruptedResource = "skills";
  const existingResources = resources.filter(
    (name) => name !== missingResource,
  );
  const restorableResources = existingResources.filter(
    (name) => name !== unchangedResource,
  );
  mkdirSync(agentDir, { recursive: true });
  symlinkSync(
    join(root, unchangedResource),
    join(agentDir, unchangedResource),
    process.platform === "win32" ? "junction" : undefined,
  );
  const originals = new Map(
    restorableResources.map((name) => [name, seedResource(agentDir, name)]),
  );
  writeFileSync(join(agentDir, "settings.json"), '{"before":"settings"}\n');
  writeFileSync(join(agentDir, ".env"), "before env\n");
  writeFileSync(join(agentDir, "auth.json"), '{"before":"auth"}\n');
  writeFileSync(join(agentDir, "models.json"), '{"before":"models"}\n');
  mkdirSync(join(agentDir, "sessions"));
  writeFileSync(join(agentDir, "sessions", "before.json"), "before session\n");

  try {
    const output = execFileSync(
      process.execPath,
      [installer, "--agent-dir", agentDir],
      { cwd: root, encoding: "utf8" },
    );
    const backup = output.match(/^Backup: (.+)$/m)?.[1];
    assert.ok(backup);
    assert.equal(dirname(backup), join(agentDir, "backups"));
    assert.match(basename(backup), /^pi-agent-\d+-\d+(?:-\d+)?$/);
    assert.deepEqual(
      resources.filter((name) => existsSync(join(backup, name))),
      restorableResources,
    );
    const manifest = join(backup, ".rollback-manifest");
    for (const name of resources) {
      const state =
        name === unchangedResource
          ? "unchanged"
          : existingResources.includes(name)
            ? "present"
            : "absent";
      assert.equal(existsSync(join(manifest, `${name}.${state}`)), true);
    }
    const assertUnchangedResource = () => {
      const target = join(agentDir, unchangedResource);
      assert.equal(lstatSync(target).isSymbolicLink(), true);
      assert.equal(
        realpathSync(target),
        realpathSync(join(root, unchangedResource)),
      );
    };
    assertUnchangedResource();
    assert.notEqual(agentDir, join(process.env.HOME ?? "", ".pi", "agent"));

    const text = readFileSync(setup, "utf8");
    assert.match(text, /macOS\/Linux:[\s\S]*\.\/install\.sh/);
    assert.match(text, /Windows PowerShell:[\s\S]*\.\\install\.ps1/);
    assert.match(
      readFileSync(join(root, "install.ps1"), "utf8"),
      /\$PSScriptRoot[\s\S]*Join-Path \$root "scripts\/install\.mjs"/,
    );
    assert.match(
      text,
      /Get-ChildItem -LiteralPath \(Join-Path \$HOME "\.pi\\agent\\backups"\)/,
    );
    assert.match(text, /\$backupRoot = Join-Path \$agentDir "backups"/);
    assert.match(text, /Split-Path -Parent \$backup/);
    assert.match(text, /Remove-Item -LiteralPath \$target -Recurse -Force/);
    assert.match(text, /\.rollback-manifest/);
    assert.match(text, /\$name\.unchanged/);
    assert.match(text, /Rollback cannot resume/);

    if (process.platform !== "win32") {
      const listCommand = text.match(/```sh\n(ls -dt[\s\S]*?)\n```/)?.[1];
      const rollbackCommand = text.match(
        /```sh\n(agent_dir="\$HOME\/\.pi\/agent"[\s\S]*?)\n```/,
      )?.[1];
      assert.ok(listCommand);
      assert.ok(rollbackCommand);

      const listed = execFileSync("sh", ["-eu", "-c", listCommand], {
        cwd: root,
        env: { ...process.env, HOME: home },
        encoding: "utf8",
      });
      assert.equal(listed.trim(), backup);

      const runRollback = (backupName, command = rollbackCommand) =>
        execFileSync(
          "sh",
          [
            "-eu",
            "-c",
            command.replace("pi-agent-<timestamp>-<pid>", backupName),
          ],
          {
            cwd: root,
            env: { ...process.env, HOME: home },
            encoding: "utf8",
          },
        );

      assert.throws(() => runRollback(`${basename(backup)}/../../outside`));
      const interruptedRollback = rollbackCommand.replace(
        '      mv "$saved" "$target"\n',
        `      mv "$saved" "$target"\n      if [ "$name" = "${interruptedResource}" ]; then exit 73; fi\n`,
      );
      assert.notEqual(interruptedRollback, rollbackCommand);
      assert.throws(
        () => runRollback(basename(backup), interruptedRollback),
        (error) => error.status === 73,
      );
      assert.equal(existsSync(join(backup, interruptedResource)), false);
      assert.deepEqual(
        readResource(agentDir, interruptedResource),
        originals.get(interruptedResource),
      );
      assertUnchangedResource();
      runRollback(basename(backup));

      for (const name of restorableResources) {
        assert.deepEqual(readResource(agentDir, name), originals.get(name));
      }
      assertUnchangedResource();
      assert.equal(existsSync(join(agentDir, missingResource)), false);
      assert.equal(
        readFileSync(join(agentDir, ".env"), "utf8"),
        "before env\n",
      );
      assert.equal(
        readFileSync(join(agentDir, "auth.json"), "utf8"),
        '{"before":"auth"}\n',
      );
      assert.equal(
        readFileSync(join(agentDir, "models.json"), "utf8"),
        '{"before":"models"}\n',
      );
      assert.equal(
        readFileSync(join(agentDir, "sessions", "before.json"), "utf8"),
        "before session\n",
      );
      assert.equal(
        readFileSync(join(agentDir, "settings.json"), "utf8"),
        '{"before":"settings"}\n',
        "rollback must restore the pre-install settings, not the merged copy",
      );

      const afterFirstRollback = new Map(
        resources
          .filter((name) => name !== unchangedResource)
          .map((name) => [
            name,
            existsSync(join(agentDir, name))
              ? readResource(agentDir, name)
              : null,
          ]),
      );
      runRollback(basename(backup));
      for (const name of resources.filter(
        (name) => name !== unchangedResource,
      )) {
        const expected = afterFirstRollback.get(name);
        assert.equal(existsSync(join(agentDir, name)), expected !== null);
        if (expected) assert.deepEqual(readResource(agentDir, name), expected);
      }
      assertUnchangedResource();
    }

    assert.match(text, /## Backup and rollback/);
    assert.match(text, /\.pi[/\\]agent[/\\]backups[/\\]pi-agent-/);
    assert.match(
      text,
      /including the pre-install `settings\.json`/i,
    );
    assert.match(
      text,
      /does \*\*not\*\* restore[\s\S]*\.env[\s\S]*authentication[\s\S]*models[\s\S]*sessions/i,
    );
    assert.match(
      text,
      /git fetch origin[\s\S]*git rev-parse HEAD[\s\S]*git rev-parse "origin\/\$branch"[\s\S]*git ls-remote --exit-code origin "\$branch"/,
    );
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
});
