import assert from "node:assert/strict";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { Effect, Stream } from "effect";
import {
  BACKEND_NAMES,
  type SpawnTask,
  type SubagentEvent,
} from "./src/domain.ts";
import {
  assertReadOnlyArgv,
  buildArgv,
  CLI_PROFILES,
  makeCliBackend,
  READ_ONLY_PROFILES,
  readOnlyProfileFor,
  resolveProfile,
} from "./src/backends/cli.ts";

test("the Herdr fleet is exactly the six locked slugs", () => {
  assert.deepEqual(
    [...BACKEND_NAMES],
    ["pi", "claude", "codex", "agy", "omp", "grok"],
  );
});

test("every CLI slug has a code-owned read-only profile", () => {
  for (const [slug, profile] of Object.entries(CLI_PROFILES)) {
    assert.equal(profile.backend, slug);
    assert.ok(profile.binaries.length > 0, `${slug}: no binaries`);
    assert.ok(
      profile.args.some((a) => a.includes("{prompt}")),
      `${slug}: argv never passes the prompt`,
    );
    const readOnly = readOnlyProfileFor(slug);
    assert.ok(readOnly, `${slug}: no read-only profile`);
    assert.ok(readOnly.argv.length > 0, `${slug}: empty read-only argv`);
    assert.ok(
      readOnly.rationale.length > 20,
      `${slug}: read-only rationale must say what the flags do`,
    );
  }
  assert.deepEqual(Object.keys(CLI_PROFILES).sort(), ["agy", "grok", "omp"]);
  assert.deepEqual(Object.keys(READ_ONLY_PROFILES).sort(), [
    "agy",
    "grok",
    "omp",
  ]);
});

test("read-only enforcement is not part of the overridable profile", () => {
  for (const profile of Object.values(CLI_PROFILES)) {
    assert.equal(
      Object.hasOwn(profile, "readOnlyArgs"),
      false,
      "enforcement must not live on the settings-overridable profile",
    );
  }
  // And the tables are frozen, so nothing can mutate them at runtime.
  assert.throws(() => {
    (READ_ONLY_PROFILES as Record<string, unknown>).agy = { argv: [] };
  });
  assert.throws(() => {
    (READ_ONLY_PROFILES.agy.argv as string[]).push("--yolo");
  });
});

test("argv verification catches enforcement flags going missing", () => {
  const good = ["--print", "do it", ...READ_ONLY_PROFILES.agy.argv];
  assert.deepEqual(assertReadOnlyArgv("agy", good), { ok: true });

  const stripped = assertReadOnlyArgv("agy", ["--print", "do it"]);
  assert.equal(stripped.ok, false);
  assert.match(stripped.ok === false ? stripped.reason : "", /read-only flags/);

  // Present but not at the tail is still a refusal: order is what we assert.
  const misplaced = assertReadOnlyArgv("agy", [
    ...READ_ONLY_PROFILES.agy.argv,
    "do it",
  ]);
  assert.equal(misplaced.ok, false);

  const unknown = assertReadOnlyArgv("nope", ["anything"]);
  assert.equal(unknown.ok, false);
  assert.match(
    unknown.ok === false ? unknown.reason : "",
    /no code-owned read-only profile/,
  );
});

test("argv substitutes values and drops flags whose value is unset", () => {
  const template = [
    "--print",
    "--model",
    "{model}",
    "--effort",
    "{effort}",
    "{prompt}",
  ];
  assert.deepEqual(
    buildArgv(template, {
      prompt: "do it",
      cwd: "/repo",
      model: "m1",
      effort: "high",
    }),
    ["--print", "--model", "m1", "--effort", "high", "do it"],
  );
  assert.deepEqual(buildArgv(template, { prompt: "do it", cwd: "/repo" }), [
    "--print",
    "do it",
  ]);
  // A prompt is never optional; an empty prompt drops the argument, which the
  // caller must never produce - assert the mechanism rather than pretend.
  assert.deepEqual(buildArgv(["{prompt}"], { prompt: "", cwd: "/repo" }), []);
  assert.deepEqual(buildArgv([], { prompt: "p", cwd: "/repo" }), []);
});

test("settings may retune the invocation but never the enforcement", () => {
  const base = CLI_PROFILES.grok;
  const { profile, refused } = resolveProfile("grok", base, {
    "vraj.subagents.cli.grok": {
      binaries: ["grok-beta"],
      contextWindow: 1_000,
      defaultModelLabel: "grok-4",
    },
  });
  assert.deepEqual(profile.binaries, ["grok-beta"]);
  assert.equal(profile.contextWindow, 1_000);
  assert.deepEqual(profile.args, base.args, "unset fields keep the default");
  assert.deepEqual(refused, []);
});

test("an attempt to weaken read-only is refused and reported", () => {
  const base = CLI_PROFILES.grok;
  for (const key of ["readOnlyArgs", "readonlyArgs", "readOnly"]) {
    const { profile, refused } = resolveProfile("grok", base, {
      "vraj.subagents.cli.grok": { [key]: ["--safe"] },
    });
    assert.deepEqual(
      refused,
      [key],
      `${key} must be refused, not silently ignored`,
    );
    assert.equal(
      Object.hasOwn(profile, "readOnlyArgs"),
      false,
      "a refused key must not reach the profile",
    );
    // The real enforcement is untouched.
    assert.deepEqual(readOnlyProfileFor("grok")?.argv, ["--no-tools"]);
  }
});

test("an args override that drops the prompt is refused", () => {
  const base = CLI_PROFILES.grok;
  const { profile, refused } = resolveProfile("grok", base, {
    "vraj.subagents.cli.grok": { args: ["--print"] },
  });
  assert.deepEqual(refused, ["args"]);
  assert.deepEqual(profile.args, base.args, "the default argv is kept");
});

test("malformed override blocks fall back to the shipped profile", () => {
  const base = CLI_PROFILES.grok;
  for (const junk of [
    {},
    { "vraj.subagents.cli.grok": "nope" },
    { "vraj.subagents.cli.grok": { binaries: [1, 2], contextWindow: -5 } },
  ]) {
    assert.deepEqual(resolveProfile("grok", base, junk).profile, base);
  }
});

test("an unknown slug is a programming error, not a silent no-op", () => {
  assert.throws(() => makeCliBackend("nope"), /Unknown CLI harness/);
});

test("a missing binary reports unavailable rather than throwing", async () => {
  const backend = makeCliBackend("agy", { findBinary: () => undefined });
  assert.equal(await Effect.runPromise(backend.available), false);
  assert.equal(backend.name, "agy");
  assert.equal(
    backend.capabilities.steering,
    false,
    "no steering, no takeover",
  );
});

/** Collect a backend session's events until it settles. */
async function collect(
  backend: ReturnType<typeof makeCliBackend>,
  task: SpawnTask,
) {
  return Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const session = yield* backend.spawn(task);
        return yield* Stream.runCollect(
          session.events.pipe(
            Stream.takeUntil(
              (event: SubagentEvent) => event._tag === "RunSettled",
            ),
          ),
        );
      }),
    ),
  );
}

/** Collect a session's events until it settles. */
async function runScript(script: string, task: SpawnTask) {
  const dir = mkdtempSync(join(tmpdir(), "pi-cli-backend-"));
  const binary = join(dir, "fake-agent");
  writeFileSync(binary, script, "utf8");
  chmodSync(binary, 0o755);

  const backend = makeCliBackend("agy", { findBinary: () => binary });
  try {
    return await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const session = yield* backend.spawn(task);
          return yield* Stream.runCollect(
            session.events.pipe(
              Stream.takeUntil(
                (event: SubagentEvent) => event._tag === "RunSettled",
              ),
            ),
          );
        }),
      ),
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const baseTask = (prompt: string): SpawnTask => ({
  prompt,
  readOnly: true,
  title: "cli backend test",
  cwd: process.cwd(),
  parent: { parentCwd: process.cwd(), projectTrusted: false },
});

test("a successful run streams stdout and settles Completed", async () => {
  const events = [
    ...(await runScript(
      '#!/bin/sh\necho "hello from the agent"\n',
      baseTask("q"),
    )),
  ];
  const settled = events.at(-1);
  assert.equal(settled?._tag, "RunSettled");
  assert.equal(
    settled?._tag === "RunSettled" ? settled.outcome._tag : undefined,
    "Completed",
  );
  assert.equal(
    settled?._tag === "RunSettled" && settled.outcome._tag === "Completed"
      ? settled.outcome.finalText.trim()
      : "",
    "hello from the agent",
  );
  assert.ok(
    events.some(
      (e) => e._tag === "AssistantDelta" && e.delta.includes("hello from"),
    ),
    "stdout must stream as assistant text",
  );
  assert.ok(events.some((e) => e._tag === "MetaChanged"));
});

test("a non-zero exit settles Failed and carries stderr", async () => {
  const events = [
    ...(await runScript('#!/bin/sh\necho "boom" >&2\nexit 3\n', baseTask("q"))),
  ];
  const settled = events.at(-1);
  assert.equal(settled?._tag, "RunSettled");
  const outcome = settled?._tag === "RunSettled" ? settled.outcome : undefined;
  assert.equal(outcome?._tag, "Failed");
  assert.match(
    outcome?._tag === "Failed" ? outcome.errorText : "",
    /exited with code 3/,
  );
  assert.match(outcome?._tag === "Failed" ? outcome.errorText : "", /boom/);
});

test("the read-only argv is appended to every invocation", async () => {
  // The fake agent prints its own argv, so the assertion sees what was passed.
  const events = [
    ...(await runScript('#!/bin/sh\nprintf "%s\\n" "$@"\n', baseTask("q"))),
  ];
  const settled = events.at(-1);
  const text =
    settled?._tag === "RunSettled" && settled.outcome._tag === "Completed"
      ? settled.outcome.finalText
      : "";
  for (const argument of READ_ONLY_PROFILES.agy.argv) {
    assert.ok(
      text.split("\n").includes(argument),
      `read-only argv missing: ${argument}`,
    );
  }
  assert.ok(text.split("\n").includes("q"), "prompt must reach the CLI");
});

test("a settings edit cannot spawn a writable child", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-cli-ro-"));
  const home = mkdtempSync(join(tmpdir(), "pi-cli-home-"));
  try {
    const binary = join(dir, "fake-agent");
    // Prints its own argv so the assertion sees exactly what was passed.
    writeFileSync(binary, '#!/bin/sh\nprintf "%s\\n" "$@"\n', "utf8");
    chmodSync(binary, 0o755);

    const agentDir = join(home, ".pi", "agent");
    mkdirSync(agentDir, { recursive: true });
    writeFileSync(
      join(agentDir, "settings.json"),
      JSON.stringify({
        "vraj.subagents.cli.agy": { readOnlyArgs: [], args: ["{prompt}"] },
      }),
      "utf8",
    );

    const warnings: string[] = [];
    const backend = makeCliBackend("agy", {
      findBinary: () => binary,
      home,
      onWarning: (message) => warnings.push(message),
    });
    assert.equal(warnings.length, 1, "the refusal must be visible");
    assert.match(warnings[0], /readOnlyArgs/);

    // The child still runs, and still runs read-only.
    const events = [...(await collect(backend, baseTask("q")))];
    const settled = events.at(-1);
    const text =
      settled?._tag === "RunSettled" && settled.outcome._tag === "Completed"
        ? settled.outcome.finalText
        : "";
    const passed = text.split("\n");
    for (const argument of READ_ONLY_PROFILES.agy.argv) {
      assert.ok(
        passed.includes(argument),
        `settings stripped read-only argv: ${argument}`,
      );
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
  }
});

test("a slug with no read-only profile is refused at registration", () => {
  // `makeCliBackend` fails closed before any process can exist.
  assert.throws(() => makeCliBackend("nope"), /Unknown CLI harness/);
});
