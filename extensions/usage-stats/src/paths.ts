/**
 * Where PI Usage Statistics reads from and writes to.
 *
 * Everything is under the pi agent directory so the index is per-install and a
 * user with several pi homes gets several indexes rather than one confused one.
 * The database is a *cache*: deleting it costs nothing but a re-index, which is
 * why `/usage rebuild` is safe.
 */

import { homedir } from "node:os";
import { join } from "node:path";

export interface StatsPaths {
  readonly agentDir: string;
  readonly sessionsDir: string;
  readonly databaseFile: string;
  readonly gainLog: string;
  readonly authFile: string;
}

export function resolvePaths(home = homedir()): StatsPaths {
  const agentDir = process.env.PI_AGENT_DIR ?? join(home, ".pi", "agent");
  return {
    agentDir,
    sessionsDir: join(agentDir, "sessions"),
    databaseFile: join(agentDir, "usage-stats.sqlite"),
    gainLog: join(agentDir, "usage-gain.jsonl"),
    authFile: join(agentDir, "auth.json"),
  };
}

/**
 * Pi encodes the project directory into the session subdirectory name by
 * replacing separators with `-` and wrapping in `--`. Decode it back for the
 * per-project views. An unrecognised name is returned as-is rather than
 * guessed at.
 */
export function folderFromSessionDir(name: string) {
  const match = name.match(/^--(.*)--$/);
  if (!match) return name;
  const body = match[1];
  if (!body) return "/";
  return `/${body.replace(/^-+/, "").split("-").join("/")}`;
}

/**
 * A short, stable label for a project path: the last two segments, which is
 * enough to tell `work/api` from `work/web` without a full path in every row.
 */
export function projectLabel(folder: string) {
  const parts = folder.split("/").filter(Boolean);
  if (parts.length === 0) return folder || "/";
  return parts.slice(-2).join("/");
}
