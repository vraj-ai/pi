/**
 * Keep the machine awake while the agent is working.
 *
 * Adapted from `no-sleep.ts` in Armin Ronacher's "agent-stuff" Pi package
 * (Apache-2.0, https://github.com/mitsuhiko/agent-stuff), extended here with a
 * Linux `systemd-inhibit` path and a platform-agnostic interface.
 *
 * The inhibitor is tied to this process id so a hard crash cannot leave a
 * machine pinned awake forever.
 */

import { spawn, type ChildProcess } from "node:child_process";

export type NoSleepScope = "agent" | "session";

export interface NoSleepPlatform {
  readonly command: string;
  readonly args: readonly string[];
}

/**
 * Resolve the platform's inhibitor, or `undefined` where there is none. Windows
 * has no equivalent that works without a foreground window, so it degrades to
 * a no-op rather than pretending.
 */
export function resolvePlatform(
  platform: NodeJS.Platform,
  options: { pid: number; keepDisplayAwake?: boolean } = { pid: process.pid },
): NoSleepPlatform | undefined {
  if (platform === "darwin") {
    // -i: no idle sleep, -s: no sleep on AC, -d: keep the display on.
    // -w <pid>: hold the assertion only while that process lives.
    const args = ["-i", "-s"];
    if (options.keepDisplayAwake) args.push("-d");
    args.push("-w", String(options.pid));
    return { command: "caffeinate", args };
  }
  if (platform === "linux") {
    return {
      command: "systemd-inhibit",
      args: [
        "--what=idle:sleep",
        "--who=pi",
        "--why=agent is running",
        "--mode=block",
        "tail",
        "-f",
        "/dev/null",
      ],
    };
  }
  return undefined;
}

export interface NoSleepState {
  readonly enabled: boolean;
  readonly scope: NoSleepScope;
  readonly active: boolean;
  readonly supported: boolean;
  readonly lastError?: string;
}

export interface NoSleepOptions {
  readonly platform?: NodeJS.Platform;
  readonly enabled?: boolean;
  readonly scope?: NoSleepScope;
  readonly keepDisplayAwake?: boolean;
  /** Injectable spawn for tests. */
  readonly spawnProcess?: typeof spawn;
  readonly onError?: (message: string) => void;
}

export class NoSleep {
  #child: ChildProcess | undefined;
  #enabled: boolean;
  #scope: NoSleepScope;
  #agentActive = false;
  #lastError: string | undefined;
  readonly #platform: NoSleepPlatform | undefined;
  readonly #spawn: typeof spawn;
  readonly #onError: (message: string) => void;

  constructor(options: NoSleepOptions = {}) {
    this.#enabled = options.enabled ?? true;
    this.#scope = options.scope ?? "agent";
    this.#spawn = options.spawnProcess ?? spawn;
    this.#onError = options.onError ?? (() => {});
    this.#platform = resolvePlatform(options.platform ?? process.platform, {
      pid: process.pid,
      keepDisplayAwake: options.keepDisplayAwake,
    });
  }

  get state(): NoSleepState {
    return {
      enabled: this.#enabled,
      scope: this.#scope,
      active: this.#child !== undefined,
      supported: this.#platform !== undefined,
      ...(this.#lastError === undefined ? {} : { lastError: this.#lastError }),
    };
  }

  setEnabled(enabled: boolean) {
    this.#enabled = enabled;
    this.#reconcile();
  }

  setScope(scope: NoSleepScope) {
    this.#scope = scope;
    this.#reconcile();
  }

  setAgentActive(active: boolean) {
    this.#agentActive = active;
    this.#reconcile();
  }

  stop() {
    const child = this.#child;
    this.#child = undefined;
    if (!child) return;
    try {
      if (child.exitCode === null && !child.killed) child.kill("SIGTERM");
    } catch {
      // Already gone.
    }
  }

  #reconcile() {
    const wanted =
      this.#enabled &&
      this.#platform !== undefined &&
      (this.#scope === "session" || this.#agentActive);
    if (wanted) this.#start();
    else this.stop();
  }

  #start() {
    if (this.#child || !this.#platform) return;
    this.#lastError = undefined;
    let child: ChildProcess;
    try {
      child = this.#spawn(this.#platform.command, [...this.#platform.args], {
        stdio: "ignore",
      });
    } catch (error) {
      this.#lastError = error instanceof Error ? error.message : String(error);
      this.#onError(this.#lastError);
      return;
    }
    child.unref?.();
    this.#child = child;

    child.once("error", (error: Error) => {
      if (this.#child !== child) return;
      this.#child = undefined;
      this.#lastError = error.message;
      this.#onError(`no-sleep: ${error.message}`);
    });
    child.once("exit", (code: number | null, signal: string | null) => {
      if (this.#child !== child) return;
      this.#child = undefined;
      if (code && code !== 0) {
        this.#lastError = `${this.#platform?.command} exited with code ${code}`;
        this.#onError(`no-sleep: ${this.#lastError}`);
      } else if (signal && signal !== "SIGTERM") {
        this.#lastError = `${this.#platform?.command} exited on ${signal}`;
        this.#onError(`no-sleep: ${this.#lastError}`);
      }
    });
  }
}

export function describeNoSleep(state: NoSleepState) {
  if (!state.supported) {
    return `no-sleep: unsupported on ${process.platform} (macOS uses caffeinate, Linux uses systemd-inhibit)`;
  }
  return [
    `no-sleep: ${state.enabled ? "enabled" : "disabled"}`,
    `scope: ${state.scope} (agent = only while a turn runs, session = always)`,
    `state: ${state.active ? "holding the machine awake" : "idle"}`,
    state.lastError ? `last error: ${state.lastError}` : undefined,
  ]
    .filter(Boolean)
    .join("\n");
}
