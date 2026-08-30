/**
 * Git context injection.
 *
 * Without this, the first thing a model does in a repo is spend a turn running
 * `git status` and `git log`. Injecting a compact snapshot before the turn
 * starts removes that round trip.
 *
 * It is injected only when the repository state has actually changed since the
 * last injection, so a long session does not pay for the same block every turn.
 */

const MAX_FILES = 30;
const MAX_COMMITS = 5;

export interface GitSnapshot {
  readonly isRepository: boolean;
  readonly branch?: string;
  readonly head?: string;
  /** `git status --porcelain=v1 --untracked-files=all` output. */
  readonly status?: string;
  /** `git log --oneline -n` output. */
  readonly log?: string;
  /** Upstream tracking summary, e.g. `origin/main [ahead 2, behind 1]`. */
  readonly upstream?: string;
}

export interface StatusEntry {
  readonly code: string;
  readonly path: string;
}

const PORCELAIN_LABEL: Record<string, string> = {
  M: "modified",
  A: "added",
  D: "deleted",
  R: "renamed",
  C: "copied",
  U: "conflicted",
  "?": "untracked",
  "!": "ignored",
};

/** Parse porcelain v1 into `{code, path}`, tolerating rename `old -> new`. */
export function parseStatus(status: string): StatusEntry[] {
  if (typeof status !== "string") return [];
  const entries: StatusEntry[] = [];
  for (const line of status.split("\n")) {
    if (line.length < 4) continue;
    const code = line.slice(0, 2);
    const rest = line.slice(3);
    // Renames report "old -> new"; the new path is the one worth naming.
    const arrow = rest.indexOf(" -> ");
    entries.push({ code, path: arrow >= 0 ? rest.slice(arrow + 4) : rest });
  }
  return entries;
}

function describe(code: string) {
  const primary = code.trim()[0] ?? "";
  return PORCELAIN_LABEL[primary] ?? "changed";
}

/**
 * A stable fingerprint of everything the block renders. Two snapshots with the
 * same fingerprint would produce identical text, so the second is not injected.
 */
export function fingerprintSnapshot(snapshot: GitSnapshot) {
  if (!snapshot.isRepository) return "no-repo";
  return [
    snapshot.branch ?? "",
    snapshot.head ?? "",
    snapshot.upstream ?? "",
    (snapshot.status ?? "").trim(),
    (snapshot.log ?? "").split("\n")[0] ?? "",
    // NUL as the separator: it cannot occur in a branch name, a path, or a commit
    // subject, so two different snapshots can never collide into one fingerprint.
    // Written as an escape - a literal NUL byte makes the source file read as
    // binary to `file(1)`, grep, and diff tooling.
  ].join("\u0000");
}

/**
 * Render the block. Returns `undefined` outside a repository - there is nothing
 * useful to say, and an "not a git repo" line every turn is pure noise.
 */
export function formatGitContext(snapshot: GitSnapshot): string | undefined {
  if (!snapshot.isRepository) return undefined;

  const lines = ["<git_context>"];
  const head = snapshot.head ? ` @ ${snapshot.head}` : "";
  lines.push(`branch: ${snapshot.branch ?? "(detached)"}${head}`);
  if (snapshot.upstream) lines.push(`upstream: ${snapshot.upstream}`);

  const entries = parseStatus(snapshot.status ?? "");
  if (entries.length === 0) {
    lines.push("working tree: clean");
  } else {
    lines.push(`working tree: ${entries.length} changed file(s)`);
    for (const entry of entries.slice(0, MAX_FILES)) {
      lines.push(`  ${describe(entry.code).padEnd(9)} ${entry.path}`);
    }
    if (entries.length > MAX_FILES) {
      lines.push(`  ... and ${entries.length - MAX_FILES} more`);
    }
  }

  const commits = (snapshot.log ?? "")
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .slice(0, MAX_COMMITS);
  if (commits.length > 0) {
    lines.push("recent commits:");
    for (const commit of commits) lines.push(`  ${commit}`);
  }

  lines.push("</git_context>");
  return lines.join("\n");
}

/**
 * Decide whether to inject. Injects on the first turn of a session and on any
 * subsequent change; `last` is the previous fingerprint, or `undefined`.
 */
export function shouldInject(
  snapshot: GitSnapshot,
  last: string | undefined,
): { inject: boolean; fingerprint: string } {
  const fingerprint = fingerprintSnapshot(snapshot);
  return {
    inject: snapshot.isRepository && fingerprint !== last,
    fingerprint,
  };
}
