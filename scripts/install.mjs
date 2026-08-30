#!/usr/bin/env node

import {
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import {
  basename,
  dirname,
  isAbsolute,
  join,
  relative,
  resolve,
  sep,
} from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const resourceNames = [
  "extensions",
  "skills",
  "themes",
  "SYSTEM.md",
  "keybindings.json",
  "node_modules",
];

/**
 * `settings.json` is merged rather than linked, but it is still part of the
 * install transaction: a failed install must not leave a rewritten settings
 * file behind, and `--rollback` must put the old one back.
 */
const SETTINGS_NAME = "settings.json";
const manifestNames = [...resourceNames, SETTINGS_NAME];

/**
 * Previously declared as a Pi package here. The local skills repository now
 * owns this family, and declaring it in both places installs it twice under
 * colliding local names, so the installer no longer adds it. An entry a user
 * already has is left alone (settings are theirs), with a note.
 */
const ponytail = "git:github.com/DietrichGebert/ponytail";

function parseArguments(args) {
  let agentDir;
  let dryRun = false;
  let forceCopy = false;
  let rollback;

  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === "--agent-dir") {
      agentDir = args[++index];
      if (!agentDir) throw new Error("--agent-dir requires a path.");
    } else if (argument === "--dry-run") {
      dryRun = true;
    } else if (argument === "--force-copy") {
      forceCopy = true;
    } else if (argument === "--rollback") {
      // Optional value: a specific backup directory, else the newest one.
      const next = args[index + 1];
      rollback = next && !next.startsWith("--") ? args[++index] : "";
    } else {
      throw new Error(`Unknown argument: ${argument}`);
    }
  }

  return { agentDir, dryRun, forceCopy, rollback };
}

function resources() {
  return resourceNames.map((name) => ({ name, source: join(root, name) }));
}

function requireCheckout() {
  for (const { name, source } of resources()) {
    if (name !== "node_modules" && !existsSync(source)) {
      throw new Error(
        `Refusing to install incomplete checkout; missing ${source}`,
      );
    }
  }
  if (
    !existsSync(join(root, "node_modules")) &&
    !existsSync(join(root, "package.json"))
  ) {
    throw new Error(
      `Refusing to install incomplete checkout; missing ${join(root, "package.json")}`,
    );
  }
}

function realpathWithMissingTail(path) {
  const missing = [];
  let existing = path;
  while (!lstatSync(existing, { throwIfNoEntry: false })) {
    missing.unshift(basename(existing));
    const parent = dirname(existing);
    if (parent === existing)
      throw new Error(`Cannot resolve install path: ${path}`);
    existing = parent;
  }
  return join(realpathSync(existing), ...missing);
}

function requireSafeTarget(targetDir) {
  const targetRelative = relative(root, realpathWithMissingTail(targetDir));
  const isInsideCheckout =
    targetRelative !== "" &&
    targetRelative !== ".." &&
    !targetRelative.startsWith(`..${sep}`) &&
    !isAbsolute(targetRelative);
  if (isInsideCheckout) {
    throw new Error(
      `Refusing to install into a path inside the checkout: ${targetDir}`,
    );
  }
}

function installDependencies(dryRun) {
  if (existsSync(join(root, "node_modules"))) return;
  if (dryRun) {
    console.log("Would install repository dependencies.");
    return;
  }

  const command = process.platform === "win32" ? "npm.cmd" : "npm";
  const result = spawnSync(
    command,
    ["install", "--ignore-scripts", "--prefix", root],
    {
      stdio: "inherit",
    },
  );
  if (result.status !== 0)
    throw new Error("Could not install repository dependencies.");
}

function readSettings(path) {
  if (!existsSync(path)) return {};

  let settings;
  try {
    settings = JSON.parse(readFileSync(path, "utf8"));
  } catch {
    throw new Error(`Refusing to overwrite malformed settings: ${path}`);
  }
  if (!settings || Array.isArray(settings) || typeof settings !== "object") {
    throw new Error(`Refusing to overwrite non-object settings: ${path}`);
  }
  if (
    "packages" in settings &&
    (!Array.isArray(settings.packages) ||
      !settings.packages.every(
        (entry) =>
          typeof entry === "string" ||
          (entry !== null &&
            !Array.isArray(entry) &&
            typeof entry === "object"),
      ))
  ) {
    throw new Error(
      `Refusing to overwrite malformed packages setting: ${path}`,
    );
  }
  return settings;
}

/**
 * Drop the retired `workflow` settings object (tracker, routines, stage
 * picker). Re-running on already-clean settings is a no-op.
 */
function migrateWorkflowSettings(settings) {
  if (!Object.hasOwn(settings, "workflow")) return {};
  return { workflow: undefined };
}

/**
 * Values that are no longer valid, rewritten forward.
 *
 * This is deliberately *not* the same thing as seeding a default. Seeding fills
 * a gap and must never touch a value the user chose; a migration replaces a
 * value that the current schema no longer accepts, where leaving it alone would
 * leave a broken config. Keep this list tiny and specific for exactly that
 * reason - anything that is merely "not our preferred value" belongs in
 * SEEDED_SETTINGS, not here.
 */
function migrateLegacySettings(settings) {
  const next = {};

  // Pi dropped the "all" steering/follow-up mode; sessions carrying it behave
  // unpredictably rather than as the user expects.
  for (const key of ["steeringMode", "followUpMode"]) {
    if (settings[key] === "all") next[key] = "one-at-a-time";
  }

  // De-duplicate package declarations. Earlier installers appended their own
  // entry on every run, so long-lived configs accumulate repeats.
  const packages = settings.packages;
  if (Array.isArray(packages)) {
    const seen = new Set();
    const deduped = [];
    for (const entry of packages) {
      const key = typeof entry === "string" ? entry : JSON.stringify(entry);
      if (seen.has(key)) continue;
      seen.add(key);
      deduped.push(entry);
    }
    if (deduped.length !== packages.length) next.packages = deduped;
  }

  return next;
}

/**
 * Every setting this package seeds, host keys included.
 *
 * All of them are seeded *only when absent*. An install must never overwrite a
 * value the user chose: re-running `./install.sh` after switching model or
 * theme silently reverting that choice is the whole reason this table exists
 * instead of a spread of literals.
 */
export const SEEDED_SETTINGS = {
  theme: "cobalt-ink",
  defaultProvider: "openai-codex",
  defaultModel: "gpt-5.6-sol",
  defaultThinkingLevel: "high",
  quietStartup: true,
  hideThinkingBlock: true,
  collapseChangelog: true,
  enableInstallTelemetry: false,
  steeringMode: "one-at-a-time",
  followUpMode: "one-at-a-time",
  "vraj.tools.lean": true,
  "vraj.skills.disabled": [],
  "vraj.subagents.cli.agy": {},
  "vraj.subagents.cli.omp": {},
  "vraj.subagents.cli.grok": {},
  "vraj.usage.budgets": [],
};

/**
 * The subset of {@link SEEDED_SETTINGS} the target does not already define.
 */
function seededSettings(settings) {
  const next = {};
  for (const [key, value] of Object.entries(SEEDED_SETTINGS)) {
    if (!Object.hasOwn(settings, key)) next[key] = value;
  }
  return next;
}

function mergeSettings(path, dryRun) {
  const settingsPath =
    existsSync(path) && lstatSync(path).isSymbolicLink()
      ? realpathSync(path)
      : path;
  const settings = readSettings(settingsPath);
  // Seeded keys go first so an existing value in `settings` overrides them.
  // This ordering is the settings contract: the installer fills gaps, the user
  // owns everything they have already set.
  const next = {
    ...seededSettings(settings),
    ...settings,
    ...migrateWorkflowSettings(settings),
    ...migrateLegacySettings(settings),
  };
  delete next.workflow;

  if ((settings.packages ?? []).includes(ponytail)) {
    console.log(
      `Note: settings.packages still declares ${ponytail}. The local skills repository now ships that family; remove the entry to avoid installing it twice.`,
    );
  }

  if (dryRun) {
    console.log(`Would update settings ${settingsPath}`);
    for (const key of Object.keys(seededSettings(settings))) {
      console.log(`  Would seed ${key} (absent)`);
    }
    return;
  }

  mkdirSync(dirname(settingsPath), { recursive: true });
  const temporary = join(
    dirname(settingsPath),
    `.settings.${process.pid}.${Date.now()}.tmp`,
  );
  writeFileSync(temporary, `${JSON.stringify(next, null, 2)}\n`);
  renameSync(temporary, settingsPath);
}

function createBackup(agentDir) {
  const backups = join(agentDir, "backups");
  mkdirSync(backups, { recursive: true });
  let backup = join(backups, `pi-agent-${Date.now()}-${process.pid}`);
  let suffix = 0;
  while (existsSync(backup))
    backup = join(backups, `pi-agent-${Date.now()}-${process.pid}-${++suffix}`);
  mkdirSync(backup);
  return backup;
}

function hasEntry(path) {
  return (
    existsSync(path) || Boolean(lstatSync(path, { throwIfNoEntry: false }))
  );
}

function isUnchanged(source, target) {
  return (
    existsSync(target) &&
    existsSync(source) &&
    realpathSync(source) === realpathSync(target)
  );
}

function createRollbackManifest(agentDir, backup) {
  const manifest = join(backup, ".rollback-manifest");
  const temporary = join(
    backup,
    `.rollback-manifest.tmp-${process.pid}-${Date.now()}`,
  );
  mkdirSync(temporary);
  for (const { name, source } of resources()) {
    const target = join(agentDir, name);
    const state = !hasEntry(target)
      ? "absent"
      : isUnchanged(source, target)
        ? "unchanged"
        : "present";
    writeFileSync(join(temporary, `${name}.${state}`), "");
  }
  // settings.json is merged in place rather than linked, so it is never
  // "unchanged" in the link sense: it either existed before this install or it
  // did not.
  const settingsTarget = join(agentDir, SETTINGS_NAME);
  writeFileSync(
    join(temporary, `${SETTINGS_NAME}.${hasEntry(settingsTarget) ? "present" : "absent"}`),
    "",
  );
  renameSync(temporary, manifest);
}

/**
 * Copy the current settings into the backup before merging.
 *
 * A copy, not a move: `mergeSettings` has to read the live file. This is what
 * makes a settings rewrite undoable, which the resource loop's rename-into-
 * backup already gave every other managed entry.
 */
function backupSettings(agentDir, backup) {
  const target = join(agentDir, SETTINGS_NAME);
  const source =
    existsSync(target) && lstatSync(target).isSymbolicLink()
      ? realpathSync(target)
      : target;
  if (!hasEntry(source)) return;
  cpSync(source, join(backup, SETTINGS_NAME), { recursive: true });
}

function linkOrCopy(source, target, backup, forceCopy) {
  if (isUnchanged(source, target)) {
    return "unchanged";
  }

  const staged = join(
    dirname(target),
    `.${basename(target)}.pi-agent-${process.pid}-${Date.now()}`,
  );
  let copied = false;
  try {
    if (forceCopy) throw new Error("Simulated symlink failure.");
    symlinkSync(
      source,
      staged,
      process.platform === "win32" && lstatSync(source).isDirectory()
        ? "junction"
        : undefined,
    );
  } catch {
    copied = true;
  }
  if (copied) cpSync(source, staged, { recursive: true });

  if (existsSync(target) || lstatSync(target, { throwIfNoEntry: false })) {
    renameSync(target, join(backup, basename(target)));
  }
  renameSync(staged, target);
  return copied ? "copied" : "linked";
}

const BACKUP_NAME_PATTERN = /^pi-agent-\d+-\d+(?:-\d+)?$/;
const MANIFEST_STATES = new Set(["absent", "unchanged", "present"]);

/**
 * Refuse any rollback source that is not a direct child of the target's own
 * `backups/` directory.
 *
 * SETUP.md's shell procedures already enforce this. Without the same check
 * here, `--rollback <anything containing a manifest>` would let an arbitrary
 * directory drive `rmSync` over the agent directory's managed entries.
 */
export function assertBackupPath(agentDir, backup) {
  const backupsRoot = resolve(agentDir, "backups");
  const candidate = resolve(backup);
  if (dirname(candidate) !== backupsRoot) {
    throw new Error(
      `Refusing to roll back from outside ${backupsRoot}: ${candidate}`,
    );
  }
  if (!BACKUP_NAME_PATTERN.test(basename(candidate))) {
    throw new Error(
      `Not an installer backup directory: ${basename(candidate)} (expected pi-agent-<timestamp>-<pid>)`,
    );
  }
  return candidate;
}

/**
 * Read a rollback manifest into `{ name: "absent" | "unchanged" | "present" }`.
 *
 * Every entry must name a managed resource and a known state. An unrecognised
 * entry means the manifest was written by a different version or was tampered
 * with, and acting on half of it is worse than refusing.
 */
export function readRollbackManifest(backup) {
  const manifest = join(backup, ".rollback-manifest");
  const states = {};
  let entries;
  try {
    entries = readdirSync(manifest);
  } catch {
    throw new Error(`No rollback manifest in ${backup}`);
  }
  for (const entry of entries) {
    const separator = entry.lastIndexOf(".");
    if (separator <= 0) throw new Error(`Malformed manifest entry: ${entry}`);
    const name = entry.slice(0, separator);
    const state = entry.slice(separator + 1);
    if (!manifestNames.includes(name)) {
      throw new Error(`Manifest names an unmanaged entry: ${name}`);
    }
    if (!MANIFEST_STATES.has(state)) {
      throw new Error(`Manifest entry ${name} has unknown state: ${state}`);
    }
    if (Object.hasOwn(states, name)) {
      throw new Error(`Manifest records ${name} twice`);
    }
    states[name] = state;
  }
  if (Object.keys(states).length === 0) {
    throw new Error(`Rollback manifest in ${backup} is empty`);
  }
  return states;
}

/** Newest backup directory under `<agentDir>/backups`, or undefined. */
export function latestBackup(agentDir) {
  const backups = join(agentDir, "backups");
  let entries;
  try {
    entries = readdirSync(backups).filter((name) => {
      if (!BACKUP_NAME_PATTERN.test(name)) return false;
      if (!existsSync(join(backups, name, ".rollback-manifest"))) return false;
      try {
        readRollbackManifest(join(backups, name));
        return true;
      } catch {
        // A malformed backup is not a rollback candidate.
        return false;
      }
    });
  } catch {
    return undefined;
  }
  entries.sort();
  const newest = entries.at(-1);
  return newest ? join(backups, newest) : undefined;
}

/**
 * Put `agentDir` back the way the manifest says it was.
 *
 * `absent` entries are removed, `present` entries are moved back out of the
 * backup, and `unchanged` entries are left alone because the install never
 * touched them. Restoring is itself failure-tolerant: one entry that cannot be
 * restored must not abandon the rest half-restored, so failures are collected
 * and reported at the end.
 */
export function restore(agentDir, backup) {
  const states = readRollbackManifest(backup);
  const failures = [];
  const restored = [];

  for (const [name, state] of Object.entries(states)) {
    const target = join(agentDir, name);
    try {
      if (state === "unchanged") continue;
      if (hasEntry(target)) rmSync(target, { recursive: true, force: true });
      if (state === "present") {
        const saved = join(backup, name);
        if (hasEntry(saved)) {
          renameSync(saved, target);
          restored.push(name);
        }
      } else {
        restored.push(name);
      }
    } catch (error) {
      failures.push(`${name}: ${error instanceof Error ? error.message : error}`);
    }
  }

  return { restored, failures };
}

export function rollback({ agentDir, backup } = {}) {
  const targetDir = resolve(
    agentDir || process.env.PI_CODING_AGENT_DIR || join(homedir(), ".pi", "agent"),
  );
  const source = backup
    ? assertBackupPath(targetDir, backup)
    : latestBackup(targetDir);
  if (!source) throw new Error(`No backup to roll back to in ${targetDir}`);
  // Validate the manifest before touching anything.
  readRollbackManifest(source);
  const result = restore(targetDir, source);
  console.log(`Rolled back ${targetDir} from ${source}`);
  for (const name of result.restored) console.log(`  restored ${name}`);
  if (result.failures.length > 0) {
    throw new Error(`Rollback incomplete:\n  ${result.failures.join("\n  ")}`);
  }
  return result;
}

export function install({ agentDir, dryRun = false, forceCopy = false } = {}) {
  const configuredAgentDir = agentDir || process.env.PI_CODING_AGENT_DIR;
  const targetDir = resolve(
    configuredAgentDir || join(homedir(), ".pi", "agent"),
  );
  requireSafeTarget(targetDir);
  requireCheckout();
  installDependencies(dryRun);

  if (dryRun) {
    console.log(`Dry run: ${targetDir}`);
    for (const [index, { name, source }] of resources().entries()) {
      console.log(
        `Would ${forceCopy && index === 0 ? "copy" : "link"} ${source} -> ${join(targetDir, name)}`,
      );
    }
    mergeSettings(join(targetDir, SETTINGS_NAME), true);
    return;
  }

  mkdirSync(targetDir, { recursive: true });
  // Order matters: the manifest records the pre-install state, settings are
  // copied into the backup, and only then is anything modified. Everything
  // after this point is undoable.
  const backup = createBackup(targetDir);
  createRollbackManifest(targetDir, backup);
  backupSettings(targetDir, backup);

  let simulateSymlinkFailure = forceCopy;
  try {
    mergeSettings(join(targetDir, SETTINGS_NAME), false);
    for (const { name, source } of resources()) {
      const result = linkOrCopy(
        source,
        join(targetDir, name),
        backup,
        simulateSymlinkFailure,
      );
      simulateSymlinkFailure = false;
      if (result !== "unchanged")
        console.log(`${result === "copied" ? "Copied" : "Linked"} ${name}`);
    }
  } catch (error) {
    // Transactional: a half-installed agent directory is worse than no install
    // at all, so put everything back before reporting the failure.
    console.error("Install failed; rolling back.");
    const result = restore(targetDir, backup);
    for (const name of result.restored) console.error(`  restored ${name}`);
    const reason = error instanceof Error ? error.message : String(error);
    throw new Error(
      result.failures.length > 0
        ? `${reason}\nRollback incomplete:\n  ${result.failures.join("\n  ")}\nBackup kept at ${backup}`
        : `${reason}\nRolled back from ${backup}`,
    );
  }
  console.log(`Installed Vraj Pi from ${root}`);
  console.log(`Backup: ${backup}`);
  console.log("Restart Pi or run /reload.");
}

function isMainModule() {
  const entry = process.argv[1];
  if (!entry) return false;
  try {
    return realpathSync(fileURLToPath(import.meta.url)) === realpathSync(entry);
  } catch {
    return resolve(fileURLToPath(import.meta.url)) === resolve(entry);
  }
}

if (isMainModule()) {
  try {
    const options = parseArguments(process.argv.slice(2));
    if (options.rollback !== undefined) {
      rollback({
        agentDir: options.agentDir,
        backup: options.rollback || undefined,
      });
    } else {
      install(options);
    }
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
