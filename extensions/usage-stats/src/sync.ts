/**
 * Historical and live indexing of pi session logs.
 *
 * Ported from `packages/stats/src/aggregator.ts` / `sync-worker.ts` in oh-my-pi
 * (https://github.com/can1357/oh-my-pi), MIT, (c) Can Boluk and Stencil Labs, Inc.
 *
 * Two modes over the same machinery:
 * - historical: walk every session file once, from byte 0
 * - live: re-read only files whose size or mtime moved since the last pass,
 *   and only the bytes past the recorded offset
 *
 * A file that shrank (rotated, truncated, or edited) is re-read from the start,
 * because its recorded offset no longer means anything.
 */

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import type { StatsDatabase, SyncCounts } from "./db.ts";
import { parseSession } from "./parser.ts";

export interface SyncResult {
  /** Session files inspected. */
  files: number;
  /** Files that actually had new bytes to parse. */
  changed: number;
  counts: SyncCounts;
  /** Files that could not be read or parsed at all. */
  failed: number;
  skippedLines: number;
  durationMs: number;
}

export interface SessionFile {
  readonly path: string;
  readonly size: number;
  readonly mtimeMs: number;
}

/** Every `*.jsonl` under the sessions directory, one level of project dirs deep. */
export function listSessionFiles(sessionsDir: string): SessionFile[] {
  let projects: string[];
  try {
    projects = readdirSync(sessionsDir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => join(sessionsDir, entry.name));
  } catch {
    return [];
  }

  const files: SessionFile[] = [];
  for (const project of projects) {
    let names: string[];
    try {
      names = readdirSync(project);
    } catch {
      continue;
    }
    for (const name of names) {
      if (!name.endsWith(".jsonl")) continue;
      const path = join(project, name);
      try {
        const stats = statSync(path);
        if (!stats.isFile()) continue;
        files.push({ path, size: stats.size, mtimeMs: stats.mtimeMs });
      } catch {
        // Vanished between readdir and stat.
      }
    }
  }
  return files;
}

export interface SyncOptions {
  /** Re-read every file from byte 0, ignoring recorded offsets. */
  readonly full?: boolean;
  /** Called once per changed file; used for progress in the TUI. */
  readonly onProgress?: (done: number, total: number) => void;
  /** Injectable clock so tests do not depend on wall time. */
  readonly now?: () => number;
}

/**
 * Index everything new. Safe to call repeatedly and concurrently with pi
 * writing to the same logs: only whole lines are consumed, and the offset is
 * written in the same transaction as the rows it covers.
 */
export function sync(
  db: StatsDatabase,
  sessionsDir: string,
  options: SyncOptions = {},
): SyncResult {
  const now = options.now ?? Date.now;
  const startedAt = now();
  const files = listSessionFiles(sessionsDir);

  const result: SyncResult = {
    files: files.length,
    changed: 0,
    counts: { messages: 0, userMessages: 0, toolCalls: 0, toolResults: 0 },
    failed: 0,
    skippedLines: 0,
    durationMs: 0,
  };

  let done = 0;
  for (const file of files) {
    done += 1;
    const recorded = options.full ? null : db.getOffset(file.path);
    let offset = recorded?.offset ?? 0;

    // A file that shrank cannot be resumed from its old offset.
    if (offset > file.size) offset = 0;
    // `setOffset` stores a floored mtime, so compare at the same precision -
    // otherwise a fractional mtime always looks newer and every pass re-reads
    // the whole file, quietly turning incremental sync into a full scan.
    if (
      recorded &&
      offset === file.size &&
      recorded.lastModified >= Math.floor(file.mtimeMs)
    ) {
      continue;
    }

    let content: string;
    try {
      const buffer = readFileSync(file.path);
      content = buffer.subarray(offset).toString("utf8");
    } catch {
      result.failed += 1;
      continue;
    }

    let parsed;
    try {
      parsed = parseSession(file.path, content, { offset });
    } catch {
      result.failed += 1;
      continue;
    }

    try {
      const counts = db.insert(parsed);
      result.counts.messages += counts.messages;
      result.counts.userMessages += counts.userMessages;
      result.counts.toolCalls += counts.toolCalls;
      result.counts.toolResults += counts.toolResults;
      db.setOffset(file.path, parsed.offset, file.mtimeMs);
    } catch {
      // The insert rolled back; leaving the offset alone means the next pass
      // retries this file rather than skipping the rows it failed to write.
      result.failed += 1;
      continue;
    }

    result.changed += 1;
    result.skippedLines += parsed.skipped;
    options.onProgress?.(done, files.length);
  }

  result.durationMs = now() - startedAt;
  return result;
}
