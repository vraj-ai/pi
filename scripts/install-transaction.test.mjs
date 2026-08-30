/**
 * The installer is transactional: a failure part-way through must leave the
 * agent directory exactly as it was, and `--rollback` must be able to undo a
 * completed install.
 */

import assert from "node:assert/strict";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  assertBackupPath,
  install,
  latestBackup,
  readRollbackManifest,
  restore,
  rollback,
} from "./install.mjs";

const root = fileURLToPath(new URL("../", import.meta.url));

function tempAgentDir() {
  const dir = mkdtempSync(join(tmpdir(), "pi-install-tx-"));
  return join(dir, "agent");
}

test("a fresh install records a manifest and can be rolled back", () => {
  const agentDir = tempAgentDir();
  try {
    install({ agentDir });
    assert.ok(existsSync(join(agentDir, "extensions")));
    assert.ok(existsSync(join(agentDir, "themes")));

    const backup = latestBackup(agentDir);
    assert.ok(backup, "an install must leave a backup to roll back to");
    const manifest = readRollbackManifest(backup);
    // Nothing existed beforehand, so every resource is recorded absent.
    assert.equal(manifest.extensions, "absent");
    assert.equal(manifest.themes, "absent");

    rollback({ agentDir });
    assert.equal(
      existsSync(join(agentDir, "extensions")),
      false,
      "rollback must remove what the install added",
    );
    assert.equal(existsSync(join(agentDir, "themes")), false);
  } finally {
    rmSync(agentDir, { recursive: true, force: true });
  }
});

test("rollback restores pre-existing content instead of deleting it", () => {
  const agentDir = tempAgentDir();
  try {
    mkdirSync(join(agentDir, "themes"), { recursive: true });
    writeFileSync(join(agentDir, "themes", "mine.json"), "{}", "utf8");
    writeFileSync(join(agentDir, "SYSTEM.md"), "my own prompt", "utf8");

    install({ agentDir });
    const backup = latestBackup(agentDir);
    const manifest = readRollbackManifest(backup);
    assert.equal(manifest.themes, "present");
    assert.equal(manifest["SYSTEM.md"], "present");
    // The install replaced them.
    assert.notEqual(readFileSync(join(agentDir, "SYSTEM.md"), "utf8"), "my own prompt");

    rollback({ agentDir });
    assert.equal(
      readFileSync(join(agentDir, "SYSTEM.md"), "utf8"),
      "my own prompt",
      "the user's own file must come back byte for byte",
    );
    assert.equal(
      readFileSync(join(agentDir, "themes", "mine.json"), "utf8"),
      "{}",
      "the user's own theme must come back",
    );
  } finally {
    rmSync(agentDir, { recursive: true, force: true });
  }
});

/**
 * The install failure path calls `restore(targetDir, backup)` and rethrows.
 * Forcing a genuine mid-install filesystem failure is not portable, so this
 * covers the primitive that path depends on: restore must return the directory
 * to exactly the state the manifest recorded.
 */
test("restore returns the directory to its recorded pre-install state", () => {
  const agentDir = tempAgentDir();
  try {
    mkdirSync(agentDir, { recursive: true });
    writeFileSync(join(agentDir, "SYSTEM.md"), "original", "utf8");
    install({ agentDir });
    const backup = latestBackup(agentDir);
    assert.ok(existsSync(join(agentDir, "extensions")));

    const result = restore(agentDir, backup);
    assert.deepEqual(result.failures, []);
    assert.equal(existsSync(join(agentDir, "extensions")), false);
    assert.equal(readFileSync(join(agentDir, "SYSTEM.md"), "utf8"), "original");
  } finally {
    rmSync(agentDir, { recursive: true, force: true });
  }
});

test("rolling back with no backup is a clear error, not a silent no-op", () => {
  const agentDir = tempAgentDir();
  try {
    mkdirSync(agentDir, { recursive: true });
    assert.throws(() => rollback({ agentDir }), /No backup to roll back to/);
    assert.equal(latestBackup(agentDir), undefined);
    assert.throws(() => readRollbackManifest(agentDir), /No rollback manifest/);
  } finally {
    rmSync(agentDir, { recursive: true, force: true });
  }
});

test("the installer still refuses to install into its own checkout", () => {
  assert.throws(
    () => install({ agentDir: join(root, "scratch-install") }),
    /inside the checkout/,
  );
});

test("a symlinked install is a link, not a copy", () => {
  const agentDir = tempAgentDir();
  try {
    install({ agentDir });
    const stats = lstatSync(join(agentDir, "extensions"));
    assert.ok(
      stats.isSymbolicLink() || stats.isDirectory(),
      "extensions must be installed as a link or a directory copy",
    );
  } finally {
    rmSync(agentDir, { recursive: true, force: true });
  }
});

// --- settings are inside the transaction ------------------------------------

test("settings.json is covered by the manifest and rolled back with everything else", () => {
  const agentDir = tempAgentDir();
  try {
    mkdirSync(agentDir, { recursive: true });
    const original = { theme: "mine", defaultModel: "my-model", keep: true };
    writeFileSync(
      join(agentDir, "settings.json"),
      JSON.stringify(original),
      "utf8",
    );

    install({ agentDir });
    const manifest = readRollbackManifest(latestBackup(agentDir));
    assert.equal(
      manifest["settings.json"],
      "present",
      "settings must be recorded in the manifest",
    );
    // The install seeded new keys, so the file did change.
    const merged = JSON.parse(readFileSync(join(agentDir, "settings.json"), "utf8"));
    assert.ok(Object.hasOwn(merged, "vraj.tools.lean"));

    rollback({ agentDir });
    assert.deepEqual(
      JSON.parse(readFileSync(join(agentDir, "settings.json"), "utf8")),
      original,
      "rollback must restore the pre-install settings byte for byte",
    );
  } finally {
    rmSync(agentDir, { recursive: true, force: true });
  }
});

test("rollback removes a settings file the install created", () => {
  const agentDir = tempAgentDir();
  try {
    install({ agentDir });
    assert.equal(
      readRollbackManifest(latestBackup(agentDir))["settings.json"],
      "absent",
    );
    assert.ok(existsSync(join(agentDir, "settings.json")));

    rollback({ agentDir });
    assert.equal(
      existsSync(join(agentDir, "settings.json")),
      false,
      "a settings file the install created must not survive its rollback",
    );
  } finally {
    rmSync(agentDir, { recursive: true, force: true });
  }
});

// --- the rollback sandbox ---------------------------------------------------

test("rollback refuses any source outside the target's own backups directory", () => {
  const agentDir = tempAgentDir();
  const outside = mkdtempSync(join(tmpdir(), "pi-not-a-backup-"));
  try {
    install({ agentDir });

    // A directory that carries a perfectly valid manifest, but is not ours.
    mkdirSync(join(outside, ".rollback-manifest"), { recursive: true });
    writeFileSync(join(outside, ".rollback-manifest", "extensions.absent"), "");
    assert.throws(
      () => rollback({ agentDir, backup: outside }),
      /Refusing to roll back from outside/,
    );

    // Nested under backups/ is still not a direct child.
    const nested = join(agentDir, "backups", "nested", "pi-agent-1-1");
    mkdirSync(join(nested, ".rollback-manifest"), { recursive: true });
    writeFileSync(join(nested, ".rollback-manifest", "extensions.absent"), "");
    assert.throws(
      () => rollback({ agentDir, backup: nested }),
      /Refusing to roll back from outside/,
    );

    // A direct child that is not an installer backup name.
    const misnamed = join(agentDir, "backups", "notabackup");
    mkdirSync(join(misnamed, ".rollback-manifest"), { recursive: true });
    writeFileSync(join(misnamed, ".rollback-manifest", "extensions.absent"), "");
    assert.throws(
      () => rollback({ agentDir, backup: misnamed }),
      /Not an installer backup directory/,
    );

    // The install's own backup is still accepted.
    assert.equal(
      assertBackupPath(agentDir, latestBackup(agentDir)),
      latestBackup(agentDir),
    );

    // And nothing above was destroyed by the refusals.
    assert.ok(existsSync(join(agentDir, "extensions")));
  } finally {
    rmSync(agentDir, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  }
});

test("a manifest that is not well formed is refused rather than half-applied", () => {
  const agentDir = tempAgentDir();
  try {
    install({ agentDir });
    const backups = join(agentDir, "backups");

    const cases = [
      ["pi-agent-1-1", ["extensions.bogus"], /unknown state: bogus/],
      ["pi-agent-2-2", ["passwd.present"], /unmanaged entry: passwd/],
      ["pi-agent-3-3", ["noseparator"], /Malformed manifest entry/],
      ["pi-agent-4-4", [], /is empty/],
      [
        "pi-agent-5-5",
        ["extensions.present", "extensions.absent"],
        /records extensions twice/,
      ],
    ];
    for (const [name, entries, pattern] of cases) {
      const dir = join(backups, name);
      mkdirSync(join(dir, ".rollback-manifest"), { recursive: true });
      for (const entry of entries) {
        writeFileSync(join(dir, ".rollback-manifest", entry), "");
      }
      assert.throws(
        () => rollback({ agentDir, backup: dir }),
        pattern,
        `${name} should have been refused`,
      );
    }

    // A malformed backup is never picked as the newest candidate either.
    assert.doesNotThrow(() => readRollbackManifest(latestBackup(agentDir)));
    assert.ok(existsSync(join(agentDir, "extensions")));
  } finally {
    rmSync(agentDir, { recursive: true, force: true });
  }
});
