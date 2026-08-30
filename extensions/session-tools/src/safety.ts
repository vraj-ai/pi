/**
 * Safety guard for shell commands.
 *
 * This is a last line of defence, not a sandbox: it blocks a small set of
 * commands that are catastrophic *and* have no legitimate reason to be issued
 * by an agent unprompted. The rules deliberately err toward allowing - a guard
 * that fires on ordinary work gets switched off, and then guards nothing.
 *
 * Every rule states what it protects and why the pattern is specific enough to
 * avoid false positives. Blocking is advisory: `/safety off` disables it, and
 * the block message always says how to proceed deliberately.
 */

export type SafetyLevel = "block" | "warn";

export interface SafetyRule {
  readonly id: string;
  readonly level: SafetyLevel;
  readonly reason: string;
  readonly test: (command: string) => boolean;
}

/**
 * Normalize for matching: collapse whitespace and strip a leading `sudo` /
 * `env VAR=x` prefix so a wrapper cannot walk a command past a rule.
 */
export function normalizeCommand(command: string) {
  if (typeof command !== "string") return "";
  let text = command.replace(/\s+/g, " ").trim();
  for (;;) {
    const stripped = text
      .replace(/^sudo(\s+-[A-Za-z]+)*\s+/, "")
      .replace(/^env(\s+[A-Za-z_][A-Za-z0-9_]*=\S*)+\s+/, "")
      .replace(/^(nohup|time|nice(\s+-n\s*-?\d+)?)\s+/, "");
    if (stripped === text) return text;
    text = stripped;
  }
}

/** Split on shell separators so `safe && dangerous` is still inspected. */
export function splitCommands(command: string): string[] {
  return normalizeCommand(command)
    .split(/\s*(?:&&|\|\||;)\s*/)
    .map((part) => part.trim())
    .filter(Boolean);
}

/** Paths whose recursive removal is unrecoverable. */
const ROOT_PATHS =
  /(^|\s)(\/|\/\*|~|~\/\*|\$HOME|\$HOME\/\*|\/(bin|boot|dev|etc|home|lib|opt|proc|root|sbin|sys|usr|var|Users|System|Library|Applications)(\/\*)?)(\s|$)/;

export const SAFETY_RULES: readonly SafetyRule[] = [
  {
    id: "rm-rf-root",
    level: "block",
    reason:
      "Recursive delete of a root, home, or system path. This is not recoverable; delete a specific project path instead.",
    // Requires both -r and -f (in either order or combined) *and* a root-ish
    // target, so `rm -rf node_modules` and `rm -r ./build` are untouched.
    test: (command) =>
      /^rm\s+(-\S*[rR]\S*\s+)*-\S*[rR]/.test(command) &&
      /-\S*f/.test(command) &&
      ROOT_PATHS.test(command),
  },
  {
    id: "disk-write",
    level: "block",
    reason:
      "Writes directly to a block device. This destroys the filesystem on it.",
    test: (command) =>
      /^dd\s+.*\bof=\/dev\/(disk|sd|nvme|hd|rdisk)/.test(command) ||
      /^mkfs(\.\w+)?\s/.test(command) ||
      /^(diskutil\s+(eraseDisk|eraseVolume|zeroDisk)|fdisk\s+.*-d)/.test(
        command,
      ),
  },
  {
    id: "curl-pipe-shell",
    level: "block",
    reason:
      "Pipes a downloaded script straight into a shell. Download it, read it, then run it.",
    // The shell may be named bare (`sh`), by absolute path (`/bin/bash`), or
    // through an interpreter runner (`xargs bash`, `env sh`). Matching only the
    // bare name let `curl ... | /bin/bash` straight through.
    test: (command) =>
      /\b(curl|wget|fetch)\b[^|]*\|\s*(?:sudo(?:\s+-\S+)*\s+)?(?:env(?:\s+[A-Za-z_][A-Za-z0-9_]*=\S*)*\s+|xargs\s+(?:-\S+\s+)*|nohup\s+|command\s+|exec\s+)*(?:[\w./-]*\/)?(?:ba|z|k|da|a|c|tc|fi)?sh\d*\b/.test(
        command,
      ) ||
      /\b(curl|wget|fetch)\b[^|]*\|\s*(?:sudo(?:\s+-\S+)*\s+)?(?:[\w./-]*\/)?(?:python\d*|perl|ruby|node|bun|deno)\b/.test(
        command,
      ),
  },
  {
    id: "force-push-protected",
    level: "block",
    reason:
      "Force-pushes a protected branch. This rewrites history other people have. Push a branch and open a PR instead.",
    test: (command) =>
      /^git\s+push\b/.test(command) &&
      /(--force(?!-with-lease)|(^|\s)-f(\s|$))/.test(command) &&
      /\b(main|master|develop|release|trunk)\b/.test(command),
  },
  {
    id: "history-rewrite",
    level: "warn",
    reason:
      "Discards uncommitted work or rewrites history. Make sure the working tree is committed or stashed first.",
    test: (command) =>
      /^git\s+reset\s+(--hard|.*\s--hard)/.test(command) ||
      /^git\s+clean\s+-\S*[fd]/.test(command) ||
      /^git\s+checkout\s+--\s+\./.test(command),
  },
  {
    id: "world-writable-system",
    level: "block",
    reason:
      "Recursively makes a system path world-writable. This is a privilege-escalation footgun.",
    test: (command) =>
      /^chmod\s+(-\S*[rR]\S*\s+)+.*\b777\b/.test(command) &&
      ROOT_PATHS.test(command),
  },
  {
    id: "fork-bomb",
    level: "block",
    reason: "Fork bomb. This takes the machine down.",
    test: (command) => /:\(\)\s*\{.*\|.*&.*\}\s*;?\s*:/.test(command),
  },
];

export interface SafetyVerdict {
  readonly allowed: boolean;
  readonly rule?: SafetyRule;
  /** The specific sub-command that tripped the rule. */
  readonly matched?: string;
  readonly message?: string;
}

const ALLOWED: SafetyVerdict = { allowed: true };

export interface SafetyOptions {
  /** `warn` rules block too. Off by default: warnings are advisory. */
  readonly strict?: boolean;
  readonly rules?: readonly SafetyRule[];
}

/**
 * Inspect a shell command. Returns `allowed: false` with an actionable message
 * when a rule fires. Never throws - a guard that crashes blocks everything.
 */
export function inspectCommand(
  command: string,
  options: SafetyOptions = {},
): SafetyVerdict {
  const rules = options.rules ?? SAFETY_RULES;
  let parts: string[];
  try {
    parts = splitCommands(command);
  } catch {
    return ALLOWED;
  }

  for (const part of parts) {
    for (const rule of rules) {
      let fired = false;
      try {
        fired = rule.test(part);
      } catch {
        continue;
      }
      if (!fired) continue;
      if (rule.level === "warn" && !options.strict) continue;
      return {
        allowed: false,
        rule,
        matched: part,
        message:
          `Blocked by the ${rule.id} safety rule: ${rule.reason}\n` +
          `Command: ${part}\n` +
          "If you really need this, ask the user to run it, or turn the guard off with /safety off.",
      };
    }
  }
  return ALLOWED;
}

/** Warnings that did not block, for surfacing alongside an allowed command. */
export function collectWarnings(command: string): readonly SafetyRule[] {
  const warnings: SafetyRule[] = [];
  for (const part of splitCommands(command)) {
    for (const rule of SAFETY_RULES) {
      if (rule.level !== "warn") continue;
      try {
        if (rule.test(part)) warnings.push(rule);
      } catch {
        // A broken rule must not break the guard.
      }
    }
  }
  return warnings;
}
