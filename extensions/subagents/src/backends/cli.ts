/**
 * Generic one-shot CLI backend, used for the `agy`, `omp`, and `grok`
 * harnesses.
 *
 * These three agents all expose a non-interactive "run this prompt and print
 * the answer" mode, but none of them speaks a streaming protocol we can rely
 * on across versions the way pi/claude/codex do. So this backend drives them
 * the way a shell would: spawn once per run, feed the prompt, stream stdout as
 * assistant text, and settle when the process exits.
 *
 * The argv template is *data*, not code: each slug ships a default, and
 * `vraj.subagents.cli.<slug>` in `~/.pi/agent/settings.json` overrides it. That
 * matters because these CLIs change their flags faster than this repo ships,
 * and a wrong flag should be a one-line settings fix rather than a patch.
 *
 * Read-only enforcement is the one thing settings cannot touch: the argv that
 * makes a child read-only lives in `READ_ONLY_PROFILES` in this file, is
 * verified immediately before spawn, and a slug without one is refused at
 * registration. Everything else about the invocation is data.
 */

import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { accessSync, constants, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { delimiter, join } from "node:path";
import type { Cause, Scope } from "effect";
import { Effect, Queue, Ref, Stream } from "effect";
import type { SubagentBackend, SubagentSession } from "../backend.ts";
import type {
  BackendName,
  SpawnTask,
  SubagentEvent,
  SubagentMeta,
} from "../domain.ts";
import { SendError, SpawnError } from "../domain.ts";

const KILL_GRACE_MS = 2_000;
const OUTPUT_MAX_BYTES = 1_024 * 1_024;

/**
 * Read-only enforcement for one CLI, owned by this file.
 *
 * This is deliberately **not** configurable. The Herdr prompt tells the model
 * every subagent is read-only; if settings could supply the enforcement argv,
 * a one-line settings edit (`readOnlyArgs: ["--safe"]`) would spawn a fully
 * writable child while the prompt kept making the same promise. Enforcement is
 * code, the rest of the profile is data.
 *
 * A slug with no entry here cannot run at all - fail closed, never "probably
 * read-only".
 */
export interface ReadOnlyProfile {
  /** argv appended to every invocation. Verified present before spawning. */
  readonly argv: readonly string[];
  /** What the flags actually do, for the refusal message and the docs. */
  readonly rationale: string;
}

export const READ_ONLY_PROFILES: Readonly<Record<string, ReadOnlyProfile>> =
  Object.freeze({
    agy: Object.freeze({
      argv: Object.freeze(["--read-only"]),
      rationale: "agy --read-only refuses every mutating tool",
    }),
    omp: Object.freeze({
      argv: Object.freeze([
        "--exclude-tools",
        "edit,write,multiedit,bash,apply_patch,notebook_edit",
      ]),
      rationale: "omp excludes every tool that can write or run a command",
    }),
    grok: Object.freeze({
      argv: Object.freeze(["--no-tools"]),
      rationale: "grok --no-tools disables tool use entirely",
    }),
  });

export interface CliProfile {
  readonly backend: BackendName;
  /** Executable names tried in PATH order. */
  readonly binaries: readonly string[];
  readonly defaultModelLabel: string;
  readonly contextWindow: number;
  /**
   * argv after the binary. Placeholders are substituted verbatim:
   * `{prompt}`, `{model}`, `{cwd}`, `{effort}`. An argument containing an
   * unset placeholder is dropped entirely, so optional flags disappear
   * cleanly rather than passing an empty string.
   */
  readonly args: readonly string[];
}

/** Shipped defaults. `binaries` and `args` are overridable; enforcement is not. */
export const CLI_PROFILES: Readonly<Record<string, CliProfile>> = {
  agy: {
    backend: "agy" as BackendName,
    binaries: ["agy", "antigravity"],
    defaultModelLabel: "agy-default",
    contextWindow: 200_000,
    args: ["--print", "--model", "{model}", "{prompt}"],
  },
  omp: {
    backend: "omp" as BackendName,
    binaries: ["omp"],
    defaultModelLabel: "omp-default",
    contextWindow: 200_000,
    args: ["--print", "--model", "{model}", "{prompt}"],
  },
  grok: {
    backend: "grok" as BackendName,
    binaries: ["grok"],
    defaultModelLabel: "grok-default",
    contextWindow: 128_000,
    args: ["--print", "--model", "{model}", "{prompt}"],
  },
};

/** The read-only profile for a slug, or `undefined` when there is none. */
export function readOnlyProfileFor(slug: string): ReadOnlyProfile | undefined {
  return READ_ONLY_PROFILES[slug];
}

/**
 * Assert the built argv still carries every enforcement token, in order.
 *
 * Belt and braces: `buildArgv` drops arguments with unset placeholders, and a
 * future edit to that logic must not be able to silently drop the read-only
 * flags along with them.
 */
export function assertReadOnlyArgv(
  slug: string,
  argv: readonly string[],
): { ok: true } | { ok: false; reason: string } {
  const profile = readOnlyProfileFor(slug);
  if (!profile) {
    return {
      ok: false,
      reason: `${slug} has no code-owned read-only profile; refusing to spawn a subagent that cannot be proven read-only.`,
    };
  }
  const tokens = [...profile.argv];
  // Find the enforcement argv as a contiguous run at the end of the argv.
  const tail = argv.slice(argv.length - tokens.length);
  const present =
    tail.length === tokens.length &&
    tokens.every((token, index) => tail[index] === token);
  if (!present) {
    return {
      ok: false,
      reason: `${slug} argv lost its read-only flags (${tokens.join(" ")}); refusing to spawn.`,
    };
  }
  return { ok: true };
}

// --- profile resolution ------------------------------------------------------

function readSettings(home: string): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(
      readFileSync(join(home, ".pi", "agent", "settings.json"), "utf8"),
    );
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

function stringArray(value: unknown) {
  return Array.isArray(value) &&
    value.every((entry) => typeof entry === "string")
    ? (value as string[])
    : undefined;
}

export interface ResolveResult {
  readonly profile: CliProfile;
  /** Override keys that were refused, for a visible warning. */
  readonly refused: readonly string[];
}

/**
 * Merge the shipped profile with `vraj.subagents.cli.<slug>` from settings.
 *
 * Only `binaries`, `args`, `defaultModelLabel`, and `contextWindow` are
 * overridable, because those are the parts that drift with CLI releases.
 * Read-only enforcement is never taken from settings; an attempt to set it is
 * refused and reported rather than silently ignored. An `args` override that
 * would drop the prompt is refused too - it would otherwise spawn an agent
 * with no task.
 */
export function resolveProfile(
  slug: string,
  base: CliProfile,
  settings: Record<string, unknown>,
): ResolveResult {
  const raw = settings[`vraj.subagents.cli.${slug}`];
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return { profile: base, refused: [] };
  }
  const override = raw as Record<string, unknown>;
  const refused: string[] = [];

  for (const key of ["readOnlyArgs", "readonlyArgs", "readOnly"]) {
    if (Object.hasOwn(override, key)) refused.push(key);
  }

  let args = stringArray(override.args);
  if (args && !args.some((argument) => argument.includes("{prompt}"))) {
    refused.push("args");
    args = undefined;
  }

  return {
    profile: {
      ...base,
      binaries: stringArray(override.binaries) ?? base.binaries,
      args: args ?? base.args,
      defaultModelLabel:
        typeof override.defaultModelLabel === "string"
          ? override.defaultModelLabel
          : base.defaultModelLabel,
      contextWindow:
        typeof override.contextWindow === "number" &&
        Number.isFinite(override.contextWindow) &&
        override.contextWindow > 0
          ? override.contextWindow
          : base.contextWindow,
    },
    refused,
  };
}

// --- argv building -----------------------------------------------------------

export interface ArgvValues {
  readonly prompt: string;
  readonly cwd: string;
  readonly model?: string;
  readonly effort?: string;
}

const PLACEHOLDER = /\{(prompt|cwd|model|effort)\}/g;

/**
 * Substitute placeholders. An argument referencing an unset value is dropped,
 * together with an immediately preceding flag-looking argument, so
 * `["--model", "{model}"]` collapses to nothing when no model was requested.
 */
export function buildArgv(
  template: readonly string[],
  values: ArgvValues,
): string[] {
  const lookup: Record<string, string | undefined> = {
    prompt: values.prompt,
    cwd: values.cwd,
    model: values.model,
    effort: values.effort,
  };

  const argv: string[] = [];
  for (const argument of template) {
    let missing = false;
    const substituted = argument.replace(PLACEHOLDER, (_match, key: string) => {
      const value = lookup[key];
      if (value === undefined || value === "") {
        missing = true;
        return "";
      }
      return value;
    });
    if (missing) {
      // Drop the flag this value belonged to, if any.
      const previous = argv.at(-1);
      if (previous !== undefined && previous.startsWith("-")) argv.pop();
      continue;
    }
    argv.push(substituted);
  }
  return argv;
}

function resolveBinary(names: readonly string[]) {
  const suffixes = process.platform === "win32" ? [".exe", ".cmd", ""] : [""];
  for (const directory of (process.env.PATH ?? "").split(delimiter)) {
    if (!directory) continue;
    for (const name of names) {
      for (const suffix of suffixes) {
        const candidate = join(directory, `${name}${suffix}`);
        try {
          accessSync(candidate, constants.X_OK);
          return candidate;
        } catch {
          // Not this one.
        }
      }
    }
  }
  return undefined;
}

// --- backend -----------------------------------------------------------------

export interface CliBackendOptions {
  /** Injectable for tests. Defaults to PATH lookup. */
  readonly findBinary?: (names: readonly string[]) => string | undefined;
  readonly home?: string;
  /** Where refused settings overrides are reported. Defaults to console.warn. */
  readonly onWarning?: (message: string) => void;
}

export function makeCliBackend(
  slug: string,
  options: CliBackendOptions = {},
): SubagentBackend {
  const base = CLI_PROFILES[slug];
  if (!base) throw new Error(`Unknown CLI harness: ${slug}`);
  if (!readOnlyProfileFor(slug)) {
    // Fail closed at construction: a harness with no code-owned enforcement is
    // never offered at all, rather than offered and refused later.
    throw new Error(
      `CLI harness ${slug} has no read-only profile; refusing to register it.`,
    );
  }
  const findBinary = options.findBinary ?? resolveBinary;
  // Read settings once per process: these backends are constructed at layer
  // build time, and a settings read per spawn would be pointless syscalls.
  const { profile, refused } = resolveProfile(
    slug,
    base,
    readSettings(options.home ?? homedir()),
  );
  if (refused.length > 0) {
    const warn =
      options.onWarning ?? ((message: string) => console.warn(message));
    warn(
      `subagents: ignored ${refused.join(", ")} in vraj.subagents.cli.${slug} - read-only enforcement and the prompt argument are owned by the harness, not by settings.`,
    );
  }

  return {
    name: profile.backend,
    capabilities: {
      // One-shot processes: no steering, and no model/effort control beyond
      // what the argv template exposes.
      steering: false,
      modelSelection: profile.args.some((a) => a.includes("{model}")),
      reasoningEffort: profile.args.some((a) => a.includes("{effort}")),
    },
    available: Effect.sync(() => findBinary(profile.binaries) !== undefined),
    spawn: (task) => makeCliSession(slug, profile, task, findBinary),
  };
}

const makeCliSession = (
  slug: string,
  profile: CliProfile,
  task: SpawnTask,
  findBinary: (names: readonly string[]) => string | undefined,
): Effect.Effect<SubagentSession, SpawnError, Scope.Scope> =>
  Effect.gen(function* () {
    const binary = findBinary(profile.binaries);
    if (!binary) {
      return yield* new SpawnError({
        message: `${profile.backend} is not installed: none of ${profile.binaries.join(", ")} is on PATH.`,
      });
    }
    const readOnly = readOnlyProfileFor(slug);
    if (!readOnly) {
      // Unreachable via makeCliBackend, which fails closed at construction.
      // Kept because this is the last gate before a child process exists.
      return yield* new SpawnError({
        message: `${profile.backend} has no code-owned read-only profile; refusing to spawn.`,
      });
    }

    const meta: SubagentMeta = {
      backend: profile.backend,
      modelLabel: task.model ?? profile.defaultModelLabel,
      contextWindow: profile.contextWindow,
    };

    const events = yield* Queue.make<SubagentEvent, Cause.Done>();
    const inbox = yield* Queue.make<string, Cause.Done>();
    const active = yield* Ref.make<ChildProcessWithoutNullStreams | undefined>(
      undefined,
    );
    const closed = yield* Ref.make(false);

    const emit = (event: SubagentEvent) =>
      Queue.offer(events, event).pipe(Effect.asVoid);

    const runOnce = (prompt: string) =>
      Effect.callback<void>((resume) => {
        const argv = [
          ...buildArgv(profile.args, {
            prompt,
            cwd: task.cwd,
            model: task.model,
            effort: task.reasoningEffort,
          }),
          ...readOnly.argv,
        ];

        // Verify rather than assume: the flags are appended a few lines above,
        // but this is the last point before a real process exists, and a child
        // that is not provably read-only must not be one.
        const verdict = assertReadOnlyArgv(slug, argv);
        if (!verdict.ok) {
          Effect.runFork(
            emit({
              _tag: "RunSettled",
              outcome: { _tag: "Failed", errorText: verdict.reason },
            }),
          );
          resume(Effect.void);
          return;
        }

        let child: ChildProcessWithoutNullStreams;
        try {
          child = spawn(binary, argv, {
            cwd: task.cwd,
            stdio: ["pipe", "pipe", "pipe"],
            env: process.env,
          });
        } catch (error) {
          Effect.runFork(
            emit({
              _tag: "RunSettled",
              outcome: {
                _tag: "Failed",
                errorText: `Failed to start ${profile.backend}: ${
                  error instanceof Error ? error.message : String(error)
                }`,
              },
            }),
          );
          resume(Effect.void);
          return;
        }

        Effect.runFork(Ref.set(active, child));
        // Nothing to write: the prompt travels in argv. Closing stdin stops
        // CLIs that would otherwise wait for interactive input forever.
        child.stdin.end();

        let output = "";
        let stderr = "";
        let truncated = false;

        child.stdout.setEncoding("utf8");
        child.stdout.on("data", (chunk: string) => {
          if (output.length >= OUTPUT_MAX_BYTES) {
            truncated = true;
            return;
          }
          output += chunk;
          Effect.runFork(
            emit({ _tag: "AssistantDelta", kind: "text", delta: chunk }),
          );
        });
        child.stderr.setEncoding("utf8");
        child.stderr.on("data", (chunk: string) => {
          if (stderr.length < OUTPUT_MAX_BYTES) stderr += chunk;
        });

        const settle = (event: SubagentEvent) => {
          Effect.runFork(Ref.set(active, undefined));
          Effect.runFork(emit(event));
          resume(Effect.void);
        };

        child.on("error", (error) =>
          settle({
            _tag: "RunSettled",
            outcome: {
              _tag: "Failed",
              errorText: `${profile.backend} failed: ${error.message}`,
            },
          }),
        );

        child.on("close", (code, signal) => {
          const finalText = truncated
            ? `${output}\n\n[output truncated at ${OUTPUT_MAX_BYTES} bytes]`
            : output;
          if (signal) {
            settle({ _tag: "RunSettled", outcome: { _tag: "Interrupted" } });
            return;
          }
          if (code === 0) {
            if (finalText.trim()) {
              Effect.runFork(
                emit({
                  _tag: "AssistantMessage",
                  parts: [{ type: "text", text: finalText }],
                }),
              );
            }
            settle({
              _tag: "RunSettled",
              outcome: { _tag: "Completed", finalText },
            });
            return;
          }
          settle({
            _tag: "RunSettled",
            outcome: {
              _tag: "Failed",
              errorText:
                `${profile.backend} exited with code ${code}.` +
                (stderr.trim() ? `\n${stderr.trim().slice(0, 4_000)}` : ""),
            },
          });
        });
      });

    /**
     * Sequential driver: one child process at a time, forked once into the
     * session scope. Keeping the fork here (rather than inside `send`) is what
     * lets `send` be a plain `Effect<void, SendError>` with no Scope
     * requirement, matching the backend interface.
     */
    const driver = Effect.gen(function* () {
      while (true) {
        const text = yield* Queue.take(inbox);
        yield* emit({ _tag: "RunStarted" });
        yield* emit({ _tag: "UserMessage", text });
        yield* runOnce(text);
      }
    });
    yield* Effect.forkScoped(driver.pipe(Effect.ignore));

    const submit = (text: string) =>
      Effect.gen(function* () {
        if (yield* Ref.get(closed)) {
          return yield* new SendError({
            message: "Subagent session is closed.",
          });
        }
        if ((yield* Ref.get(active)) !== undefined) {
          // One-shot processes cannot be steered mid-run, and this fleet is
          // read-only/no-takeover by design, so say so instead of queueing.
          return yield* new SendError({
            message: `${profile.backend} subagents run one prompt at a time and cannot be steered mid-run.`,
          });
        }
        yield* Queue.offer(inbox, text);
      }).pipe(Effect.asVoid);

    const kill = Effect.gen(function* () {
      const child = yield* Ref.get(active);
      if (!child) return;
      try {
        child.kill("SIGTERM");
      } catch {
        // Already gone.
      }
      yield* Effect.sleep(`${KILL_GRACE_MS} millis`);
      const still = yield* Ref.get(active);
      if (still) {
        try {
          still.kill("SIGKILL");
        } catch {
          // Already gone.
        }
      }
    });

    yield* Effect.addFinalizer(() =>
      Effect.gen(function* () {
        yield* Ref.set(closed, true);
        yield* Queue.end(inbox).pipe(Effect.ignore);
        yield* kill.pipe(Effect.ignore);
        yield* Queue.end(events).pipe(Effect.ignore);
      }),
    );

    yield* emit({ _tag: "MetaChanged", meta });
    yield* submit(task.prompt).pipe(Effect.orDie);

    return {
      meta: Effect.succeed(meta),
      events: Stream.fromQueue(events),
      send: submit,
      interrupt: kill,
    } satisfies SubagentSession;
  });
