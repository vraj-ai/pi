/**
 * The installer's settings contract.
 *
 * The rule it has to keep: seed what is missing, never overwrite what is there.
 * A reinstall silently resetting someone's model or theme is the exact failure
 * these tests exist to catch.
 */

import assert from "node:assert/strict";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { install, SEEDED_SETTINGS } from "./install.mjs";

function tempAgentDir() {
  return join(mkdtempSync(join(tmpdir(), "pi-settings-")), "agent");
}

function settingsOf(agentDir) {
  return JSON.parse(readFileSync(join(agentDir, "settings.json"), "utf8"));
}

function writeSettings(agentDir, value) {
  mkdirSync(agentDir, { recursive: true });
  writeFileSync(
    join(agentDir, "settings.json"),
    JSON.stringify(value, null, 2),
    "utf8",
  );
}

test("a fresh install seeds every key this package reads", () => {
  const agentDir = tempAgentDir();
  try {
    install({ agentDir });
    const settings = settingsOf(agentDir);
    for (const [key, value] of Object.entries(SEEDED_SETTINGS)) {
      assert.deepEqual(settings[key], value, `${key} was not seeded`);
    }
    assert.equal(settings.theme, "cobalt-ink");
    assert.equal(settings["vraj.tools.lean"], true, "lean tools by default");
  } finally {
    rmSync(agentDir, { recursive: true, force: true });
  }
});

test("reinstalling never overwrites a host setting the user chose", () => {
  const agentDir = tempAgentDir();
  try {
    // Every host key the installer used to write unconditionally.
    const chosen = {
      theme: "my-theme",
      defaultProvider: "my-provider",
      defaultModel: "my-model",
      defaultThinkingLevel: "low",
      quietStartup: false,
      hideThinkingBlock: false,
      collapseChangelog: false,
      enableInstallTelemetry: true,
      steeringMode: "one-at-a-time",
      followUpMode: "one-at-a-time",
      "vraj.tools.lean": false,
      unrelated: { deep: [1, 2, 3] },
    };
    writeSettings(agentDir, chosen);

    install({ agentDir });
    const first = settingsOf(agentDir);
    for (const [key, value] of Object.entries(chosen)) {
      assert.deepEqual(first[key], value, `${key} was clobbered by install`);
    }

    // And again, because idempotence is where drift usually shows up.
    install({ agentDir });
    const second = settingsOf(agentDir);
    for (const [key, value] of Object.entries(chosen)) {
      assert.deepEqual(second[key], value, `${key} was clobbered by reinstall`);
    }
  } finally {
    rmSync(agentDir, { recursive: true, force: true });
  }
});

test("absent keys are still seeded alongside preserved ones", () => {
  const agentDir = tempAgentDir();
  try {
    writeSettings(agentDir, { theme: "my-theme" });
    install({ agentDir });
    const settings = settingsOf(agentDir);
    assert.equal(settings.theme, "my-theme", "the chosen value survives");
    assert.equal(settings.defaultModel, SEEDED_SETTINGS.defaultModel);
    assert.equal(settings["vraj.tools.lean"], true);
  } finally {
    rmSync(agentDir, { recursive: true, force: true });
  }
});

test("a falsy chosen value is a choice, not an absent key", () => {
  const agentDir = tempAgentDir();
  try {
    // `false` and `""` must not be treated as "unset" and re-seeded.
    writeSettings(agentDir, {
      quietStartup: false,
      hideThinkingBlock: false,
      theme: "",
      "vraj.tools.lean": false,
    });
    install({ agentDir });
    const settings = settingsOf(agentDir);
    assert.equal(settings.quietStartup, false);
    assert.equal(settings.hideThinkingBlock, false);
    assert.equal(settings.theme, "");
    assert.equal(settings["vraj.tools.lean"], false);
  } finally {
    rmSync(agentDir, { recursive: true, force: true });
  }
});

test("the installer declares no Pi package of its own", () => {
  const agentDir = tempAgentDir();
  try {
    install({ agentDir });
    assert.equal(
      settingsOf(agentDir).packages,
      undefined,
      "the local skills repository owns the ponytail family",
    );

    // A user's own packages are preserved, and a pre-existing duplicate left by
    // an earlier installer is collapsed rather than grown.
    writeSettings(agentDir, {
      packages: [
        "npm:mine",
        "git:github.com/DietrichGebert/ponytail",
        "git:github.com/DietrichGebert/ponytail",
      ],
    });
    install({ agentDir });
    assert.deepEqual(settingsOf(agentDir).packages, [
      "npm:mine",
      "git:github.com/DietrichGebert/ponytail",
    ]);
  } finally {
    rmSync(agentDir, { recursive: true, force: true });
  }
});

test("a value the current schema no longer accepts is still migrated", () => {
  const agentDir = tempAgentDir();
  try {
    // Migration is not the same as clobbering: "all" is not a valid mode any
    // more, so leaving it alone would leave a broken config.
    writeSettings(agentDir, { steeringMode: "all", followUpMode: "all" });
    install({ agentDir });
    const settings = settingsOf(agentDir);
    assert.equal(settings.steeringMode, "one-at-a-time");
    assert.equal(settings.followUpMode, "one-at-a-time");
  } finally {
    rmSync(agentDir, { recursive: true, force: true });
  }
});

test("the shipped example matches what the installer seeds", () => {
  const agentDir = tempAgentDir();
  try {
    install({ agentDir });
    const seeded = settingsOf(agentDir);
    const example = JSON.parse(
      readFileSync(new URL("../settings.example.json", import.meta.url), "utf8"),
    );
    for (const key of Object.keys(SEEDED_SETTINGS)) {
      if (!Object.hasOwn(example, key)) continue;
      assert.deepEqual(
        seeded[key],
        example[key],
        `${key} drifted between settings.example.json and the installer`,
      );
    }
    assert.equal(
      Object.hasOwn(example, "packages"),
      false,
      "the example must not re-declare the ponytail package",
    );
  } finally {
    rmSync(agentDir, { recursive: true, force: true });
  }
});
